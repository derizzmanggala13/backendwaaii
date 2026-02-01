import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import pool from '../database/connection.js';
import config from '../config/index.js';

// Web version cache to speed up loading
const wwebVersion = '2.2412.54';

class WhatsAppManager {
  constructor(io) {
    this.clients = new Map(); // Map<deviceId, Client>
    this.io = io;
    this.userSettings = new Map(); // Cache user settings
  }

  // Get user settings with caching
  async getUserSettings(userId) {
    // Check cache first (cache for 5 minutes)
    const cached = this.userSettings.get(userId);
    if (cached && Date.now() - cached.timestamp < 300000) {
      return cached.settings;
    }

    try {
      let result = await pool.query(
        'SELECT * FROM user_settings WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        // Create default settings
        result = await pool.query(`
          INSERT INTO user_settings (user_id)
          VALUES ($1)
          RETURNING *
        `, [userId]);
      }

      const settings = result.rows[0];
      this.userSettings.set(userId, { settings, timestamp: Date.now() });
      return settings;
    } catch (error) {
      console.error('Error getting user settings:', error);
      // Return defaults
      return {
        daily_message_limit: 200,
        message_delay_seconds: 3,
        broadcast_delay_seconds: 5,
        auto_reply_delay_seconds: 2,
        max_broadcast_recipients: 100,
        enable_rate_limiting: true,
      };
    }
  }

  // Check and update daily usage
  async checkAndUpdateUsage(userId, deviceId, type = 'message') {
    const today = new Date().toISOString().split('T')[0];
    
    try {
      // Get or create daily usage record
      let result = await pool.query(`
        INSERT INTO daily_usage (user_id, device_id, date)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, device_id, date) DO NOTHING
        RETURNING *
      `, [userId, deviceId, today]);

      // Get current usage
      const usageResult = await pool.query(`
        SELECT 
          COALESCE(SUM(messages_sent), 0) as total_messages,
          COALESCE(SUM(broadcasts_sent), 0) as total_broadcasts,
          COALESCE(SUM(auto_replies_sent), 0) as total_auto_replies
        FROM daily_usage
        WHERE user_id = $1 AND date = $2
      `, [userId, today]);

      const usage = usageResult.rows[0];
      const settings = await this.getUserSettings(userId);

      // Check if rate limiting is enabled
      if (settings.enable_rate_limiting) {
        const totalSent = parseInt(usage.total_messages) + parseInt(usage.total_broadcasts);
        if (totalSent >= settings.daily_message_limit) {
          throw new Error(`Daily message limit reached (${settings.daily_message_limit}). Try again tomorrow.`);
        }
      }

      // Update usage based on type
      const updateField = type === 'broadcast' ? 'broadcasts_sent' : 
                          type === 'auto_reply' ? 'auto_replies_sent' : 'messages_sent';
      
      await pool.query(`
        UPDATE daily_usage 
        SET ${updateField} = ${updateField} + 1, updated_at = NOW()
        WHERE user_id = $1 AND device_id = $2 AND date = $3
      `, [userId, deviceId, today]);

      return {
        allowed: true,
        remaining: settings.daily_message_limit - totalSent - 1,
        settings,
      };
    } catch (error) {
      if (error.message.includes('Daily message limit')) {
        throw error;
      }
      console.error('Error checking usage:', error);
      // Allow on error but log it
      return { allowed: true, remaining: -1, settings: await this.getUserSettings(userId) };
    }
  }

  // Clear settings cache for user
  clearSettingsCache(userId) {
    this.userSettings.delete(userId);
  }

  // Helper to get client - ensures deviceId is integer
  getClient(deviceId) {
    const id = parseInt(deviceId);
    return this.clients.get(id);
  }

  // Helper to check if device has client
  hasClient(deviceId) {
    const id = parseInt(deviceId);
    return this.clients.has(id);
  }

  async initializeDevice(deviceId, userId) {
    if (this.hasClient(deviceId)) {
      console.log(`Device ${deviceId} is already initialized`);
      return this.getClient(deviceId);
    }

    const sessionPath = path.join(config.whatsapp.sessionPath, `session-${deviceId}`);
    
    // Ensure session directory exists
    if (!fs.existsSync(config.whatsapp.sessionPath)) {
      fs.mkdirSync(config.whatsapp.sessionPath, { recursive: true });
    }

    console.log(`🔄 Initializing device ${deviceId}...`);

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: `device-${deviceId}`,
        dataPath: config.whatsapp.sessionPath,
      }),
      puppeteer: {
        headless: false, // Show browser for debugging
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--safebrowsing-disable-auto-update',
        ],
        timeout: 60000,
      },
      qrMaxRetries: 5,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000,
    });

    this.setupClientEvents(client, deviceId, userId);
    this.clients.set(deviceId, client);

    try {
      await client.initialize();
      console.log(`✅ Device ${deviceId} initialized`);
    } catch (error) {
      console.error(`❌ Failed to initialize device ${deviceId}:`, error);
      this.clients.delete(deviceId);
      throw error;
    }

    return client;
  }

  setupClientEvents(client, deviceId, userId) {
    // QR Code event
    client.on('qr', async (qr) => {
      console.log(`📱 QR Code received for device ${deviceId}`);
      
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        
        // Update device with QR code
        await pool.query(
          'UPDATE devices SET qr_code = $1, status = $2, updated_at = NOW() WHERE id = $3',
          [qrDataUrl, 'awaiting_scan', deviceId]
        );
        
        // Emit to specific user's room
        this.io.to(`user-${userId}`).emit('qr', { deviceId, qr: qrDataUrl });
      } catch (error) {
        console.error('Error generating QR code:', error);
      }
    });

    // Authenticated event
    client.on('authenticated', async () => {
      console.log(`✅ Device ${deviceId} authenticated`);
      
      await pool.query(
        'UPDATE devices SET status = $1, qr_code = NULL, updated_at = NOW() WHERE id = $2',
        ['authenticated', deviceId]
      );
      
      this.io.to(`user-${userId}`).emit('authenticated', { deviceId });
    });

    // Ready event
    client.on('ready', async () => {
      console.log(`✅ Device ${deviceId} is ready`);
      
      try {
        const info = client.info;
        
        await pool.query(
          'UPDATE devices SET status = $1, phone_number = $2, last_seen = NOW(), updated_at = NOW() WHERE id = $3',
          ['connected', info.wid.user, deviceId]
        );
        
        this.io.to(`user-${userId}`).emit('ready', { 
          deviceId, 
          phoneNumber: info.wid.user,
          name: info.pushname 
        });
        
        // Sync contacts
        this.syncContacts(client, deviceId);
      } catch (error) {
        console.error('Error on ready event:', error);
      }
    });

    // Message received event
    client.on('message', async (msg) => {
      try {
        await this.handleIncomingMessage(msg, deviceId, userId);
      } catch (error) {
        console.error('Error handling incoming message:', error);
      }
    });

    // Message sent event
    client.on('message_create', async (msg) => {
      if (msg.fromMe) {
        try {
          await this.saveMessage(msg, deviceId, true);
        } catch (error) {
          console.error('Error saving sent message:', error);
        }
      }
    });

    // Message acknowledgment
    client.on('message_ack', async (msg, ack) => {
      try {
        await pool.query(
          'UPDATE messages SET ack = $1, status = $2 WHERE message_id = $3 AND device_id = $4',
          [ack, this.getAckStatus(ack), msg.id.id, deviceId]
        );
        
        this.io.to(`user-${userId}`).emit('message_ack', { 
          deviceId, 
          messageId: msg.id.id, 
          ack,
          status: this.getAckStatus(ack)
        });
      } catch (error) {
        console.error('Error updating message ack:', error);
      }
    });

    // Disconnected event
    client.on('disconnected', async (reason) => {
      console.log(`⚠️ Device ${deviceId} disconnected: ${reason}`);
      
      await pool.query(
        'UPDATE devices SET status = $1, updated_at = NOW() WHERE id = $2',
        ['disconnected', deviceId]
      );
      
      this.io.to(`user-${userId}`).emit('disconnected', { deviceId, reason });
      this.clients.delete(deviceId);
    });

    // Auth failure
    client.on('auth_failure', async (msg) => {
      console.error(`❌ Device ${deviceId} auth failure: ${msg}`);
      
      await pool.query(
        'UPDATE devices SET status = $1, updated_at = NOW() WHERE id = $2',
        ['auth_failure', deviceId]
      );
      
      this.io.to(`user-${userId}`).emit('auth_failure', { deviceId, message: msg });
    });

    // Loading screen
    client.on('loading_screen', (percent, message) => {
      this.io.to(`user-${userId}`).emit('loading', { deviceId, percent, message });
    });
  }

  async handleIncomingMessage(msg, deviceId, userId) {
    // Save message to database
    await this.saveMessage(msg, deviceId, false);
    
    // Check for auto replies (keyword-based)
    const autoReplied = await this.checkAutoReply(msg, deviceId);
    
    // If no auto-reply matched, check for AI auto-reply
    if (!autoReplied) {
      await this.checkAIAutoReply(msg, deviceId, userId);
    }
    
    // Emit to user
    const messageData = {
      deviceId,
      messageId: msg.id.id,
      from: msg.from,
      to: msg.to,
      body: msg.body,
      type: msg.type,
      timestamp: msg.timestamp,
      isFromMe: msg.fromMe,
      hasMedia: msg.hasMedia,
    };
    
    this.io.to(`user-${userId}`).emit('message', messageData);
  }

  async saveMessage(msg, deviceId, isFromMe) {
    try {
      let mediaUrl = null;
      let mediaMimeType = null;
      
      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media) {
          mediaMimeType = media.mimetype;
          // You could save media to storage here and get URL
        }
      }
      
      await pool.query(`
        INSERT INTO messages (device_id, message_id, chat_id, from_number, to_number, body, type, media_url, media_mime_type, is_from_me, is_forwarded, timestamp, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12), $13)
        ON CONFLICT (device_id, message_id) DO NOTHING
      `, [
        deviceId,
        msg.id.id,
        msg.from,
        msg.from,
        msg.to,
        msg.body,
        msg.type,
        mediaUrl,
        mediaMimeType,
        isFromMe,
        msg.isForwarded || false,
        msg.timestamp,
        'received'
      ]);
    } catch (error) {
      console.error('Error saving message:', error);
    }
  }

  async checkAutoReply(msg, deviceId) {
    if (msg.fromMe) return false;
    
    try {
      const result = await pool.query(
        'SELECT * FROM auto_replies WHERE device_id = $1 AND is_active = true',
        [deviceId]
      );
      
      for (const rule of result.rows) {
        let shouldReply = false;
        
        switch (rule.match_type) {
          case 'exact':
            shouldReply = msg.body.toLowerCase() === rule.trigger_keyword.toLowerCase();
            break;
          case 'contains':
            shouldReply = msg.body.toLowerCase().includes(rule.trigger_keyword.toLowerCase());
            break;
          case 'starts_with':
            shouldReply = msg.body.toLowerCase().startsWith(rule.trigger_keyword.toLowerCase());
            break;
          case 'ends_with':
            shouldReply = msg.body.toLowerCase().endsWith(rule.trigger_keyword.toLowerCase());
            break;
        }
        
        if (shouldReply) {
          const client = this.clients.get(deviceId);
          if (client) {
            await client.sendMessage(msg.from, rule.reply_message);
          }
          return true; // Auto-reply was sent
        }
      }
      return false; // No auto-reply matched
    } catch (error) {
      console.error('Error checking auto reply:', error);
      return false;
    }
  }

  // AI Auto-Reply using Gemini
  async checkAIAutoReply(msg, deviceId, userId) {
    if (msg.fromMe) return;
    if (!msg.body || msg.body.trim() === '') return;
    
    try {
      // Get AI settings for this device
      const settingsResult = await pool.query(
        'SELECT * FROM ai_settings WHERE device_id = $1',
        [deviceId]
      );
      
      if (settingsResult.rows.length === 0) return;
      
      const settings = settingsResult.rows[0];
      
      // Check if AI is enabled
      if (!settings.is_enabled || !settings.api_key) return;
      
      // Check if should ignore groups
      const isGroup = msg.from.includes('@g.us');
      if (isGroup && settings.ignore_groups) return;
      
      // Check excluded contacts
      if (settings.excluded_contacts) {
        const excluded = settings.excluded_contacts.split(',').map(c => c.trim());
        const senderNumber = msg.from.split('@')[0];
        if (excluded.some(e => senderNumber.includes(e))) return;
      }
      
      // Check if message should only be processed when containing specific keyword
      if (settings.only_when_contains) {
        const keywords = settings.only_when_contains.split(',').map(k => k.trim().toLowerCase());
        const messageBody = msg.body.toLowerCase();
        if (!keywords.some(k => messageBody.includes(k))) return;
      }
      
      // Get conversation history for context
      const historyResult = await pool.query(`
        SELECT role, content FROM ai_conversations
        WHERE device_id = $1 AND chat_id = $2
        ORDER BY created_at DESC
        LIMIT 10
      `, [deviceId, msg.from]);
      
      const history = historyResult.rows.reverse();
      
      // Call appropriate AI API based on provider
      const provider = settings.ai_provider || 'gemini';
      let aiResponse;
      
      if (provider === 'openai') {
        aiResponse = await this.callOpenAIAPI(
          settings.api_key,
          settings.model,
          settings.system_prompt,
          msg.body,
          history,
          settings.max_tokens,
          parseFloat(settings.temperature)
        );
      } else {
        aiResponse = await this.callGeminiAPI(
          settings.api_key,
          settings.model,
          settings.system_prompt,
          msg.body,
          history,
          settings.max_tokens,
          parseFloat(settings.temperature)
        );
      }
      
      if (aiResponse) {
        // Save conversation to history
        await pool.query(`
          INSERT INTO ai_conversations (device_id, chat_id, role, content)
          VALUES ($1, $2, 'user', $3)
        `, [deviceId, msg.from, msg.body]);
        
        await pool.query(`
          INSERT INTO ai_conversations (device_id, chat_id, role, content)
          VALUES ($1, $2, 'assistant', $3)
        `, [deviceId, msg.from, aiResponse]);
        
        // Clean up old conversations (keep last 50 per chat)
        await pool.query(`
          DELETE FROM ai_conversations 
          WHERE id IN (
            SELECT id FROM ai_conversations 
            WHERE device_id = $1 AND chat_id = $2
            ORDER BY created_at DESC
            OFFSET 50
          )
        `, [deviceId, msg.from]);
        
        // Add delay before replying
        if (settings.reply_delay_seconds > 0) {
          await new Promise(resolve => setTimeout(resolve, settings.reply_delay_seconds * 1000));
        }
        
        // Send AI response
        const client = this.clients.get(deviceId);
        if (client) {
          await client.sendMessage(msg.from, aiResponse);
          
          // Update usage
          try {
            await this.checkAndUpdateUsage(userId, deviceId, 'auto_reply');
          } catch (e) {
            console.error('Usage update error:', e);
          }
          
          console.log(`🤖 AI replied to ${msg.from}: ${aiResponse.substring(0, 50)}...`);
        }
      }
    } catch (error) {
      console.error('Error in AI auto-reply:', error);
      
      // Try to send fallback message if enabled
      try {
        const settingsResult = await pool.query(
          'SELECT fallback_message FROM ai_settings WHERE device_id = $1',
          [deviceId]
        );
        if (settingsResult.rows[0]?.fallback_message) {
          const client = this.clients.get(deviceId);
          if (client) {
            await client.sendMessage(msg.from, settingsResult.rows[0].fallback_message);
          }
        }
      } catch (e) {
        console.error('Error sending fallback:', e);
      }
    }
  }

  // Gemini API caller
  async callGeminiAPI(apiKey, model, systemPrompt, userMessage, history = [], maxTokens = 500, temperature = 0.7) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    // Build conversation history
    const contents = [];
    
    // Add history
    for (const msg of history) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      });
    }
    
    // Add current user message
    contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });
    
    const requestBody = {
      contents,
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        topP: 0.95,
        topK: 40,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      ]
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Gemini API error');
    }
    
    const data = await response.json();
    
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('No response from AI');
    }
    
    return data.candidates[0].content.parts[0].text;
  }

  // OpenAI API caller
  async callOpenAIAPI(apiKey, model, systemPrompt, userMessage, history = [], maxTokens = 500, temperature = 0.7) {
    const url = 'https://api.openai.com/v1/chat/completions';
    
    // Build messages array
    const messages = [
      { role: 'system', content: systemPrompt }
    ];
    
    // Add history
    for (const msg of history) {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }
    
    // Add current user message
    messages.push({
      role: 'user',
      content: userMessage
    });
    
    const requestBody = {
      model: model,
      messages: messages,
      max_tokens: maxTokens,
      temperature: temperature,
      top_p: 0.95,
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'OpenAI API error');
    }
    
    const data = await response.json();
    
    if (!data.choices || data.choices.length === 0) {
      throw new Error('No response from AI');
    }
    
    return data.choices[0].message.content;
  }

  async syncContacts(client, deviceId) {
    try {
      const contacts = await client.getContacts();
      
      for (const contact of contacts) {
        if (contact.isWAContact) {
          let profilePicUrl = null;
          try {
            profilePicUrl = await contact.getProfilePicUrl();
          } catch (e) {
            // Profile pic not available
          }
          
          await pool.query(`
            INSERT INTO contacts (device_id, wa_id, name, phone_number, profile_pic_url, is_business, is_group)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (device_id, wa_id) 
            DO UPDATE SET name = $3, phone_number = $4, profile_pic_url = $5, updated_at = NOW()
          `, [
            deviceId,
            contact.id._serialized,
            contact.name || contact.pushname,
            contact.number,
            profilePicUrl,
            contact.isBusiness,
            contact.isGroup
          ]);
        }
      }
      
      console.log(`✅ Synced ${contacts.length} contacts for device ${deviceId}`);
    } catch (error) {
      console.error('Error syncing contacts:', error);
    }
  }

  getAckStatus(ack) {
    const statuses = {
      '-1': 'error',
      '0': 'pending',
      '1': 'sent',
      '2': 'delivered',
      '3': 'read',
      '4': 'played',
    };
    return statuses[ack] || 'unknown';
  }

  async sendMessage(deviceId, to, message, options = {}) {
    // Ensure deviceId is integer
    const id = parseInt(deviceId);
    const client = this.getClient(id);
    if (!client) {
      throw new Error('Device not connected');
    }

    // Get user ID for this device
    const deviceResult = await pool.query(
      'SELECT user_id FROM devices WHERE id = $1',
      [id]
    );
    const userId = deviceResult.rows[0]?.user_id;

    // Check rate limiting if userId exists and not skipping (for internal calls like auto-reply)
    if (userId && !options.skipRateLimit) {
      const usageCheck = await this.checkAndUpdateUsage(userId, deviceId, options.messageType || 'message');
      if (!usageCheck.allowed) {
        throw new Error('Rate limit exceeded');
      }
    }

    // Format number
    let chatId = to;
    if (!to.includes('@')) {
      chatId = to.replace(/\D/g, '') + '@c.us';
    }

    try {
      // Process template placeholders
      let processedMessage = message;
      
      // Get contact info to replace placeholders
      try {
        const contact = await client.getContactById(chatId);
        if (contact) {
          const contactName = contact.pushname || contact.name || contact.number || to.replace(/\D/g, '');
          processedMessage = processedMessage
            .replace(/\{name\}/gi, contactName)
            .replace(/\{phone\}/gi, contact.number || to.replace(/\D/g, ''))
            .replace(/\{pushname\}/gi, contact.pushname || contactName);
        }
      } catch (contactError) {
        // If can't get contact, just use the number
        console.log('Could not get contact info, using number as name');
        const phoneNumber = to.replace(/\D/g, '');
        processedMessage = processedMessage
          .replace(/\{name\}/gi, phoneNumber)
          .replace(/\{phone\}/gi, phoneNumber)
          .replace(/\{pushname\}/gi, phoneNumber);
      }
      
      let sentMessage;
      
      if (options.media) {
        const media = new MessageMedia(
          options.media.mimetype,
          options.media.data,
          options.media.filename
        );
        sentMessage = await client.sendMessage(chatId, media, {
          caption: processedMessage,
          ...options
        });
      } else {
        sentMessage = await client.sendMessage(chatId, processedMessage, options);
      }
      
      return {
        success: true,
        messageId: sentMessage.id.id,
        timestamp: sentMessage.timestamp,
      };
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }

  async sendBroadcast(deviceId, recipients, message, options = {}) {
    // Get user ID and settings for this device
    const deviceResult = await pool.query(
      'SELECT user_id FROM devices WHERE id = $1',
      [deviceId]
    );
    const userId = deviceResult.rows[0]?.user_id;
    
    if (!userId) {
      throw new Error('Device not found');
    }

    const settings = await this.getUserSettings(userId);
    
    // Check max recipients
    if (settings.enable_rate_limiting && recipients.length > settings.max_broadcast_recipients) {
      throw new Error(`Too many recipients. Maximum allowed: ${settings.max_broadcast_recipients}`);
    }

    // Check if enough quota remaining
    const today = new Date().toISOString().split('T')[0];
    const usageResult = await pool.query(`
      SELECT COALESCE(SUM(messages_sent), 0) + COALESCE(SUM(broadcasts_sent), 0) as total
      FROM daily_usage
      WHERE user_id = $1 AND date = $2
    `, [userId, today]);
    
    const currentUsage = parseInt(usageResult.rows[0]?.total || 0);
    const remaining = settings.daily_message_limit - currentUsage;
    
    if (settings.enable_rate_limiting && recipients.length > remaining) {
      throw new Error(`Not enough daily quota. Remaining: ${remaining}, Required: ${recipients.length}`);
    }

    const results = [];
    const delayMs = (settings.broadcast_delay_seconds || 5) * 1000;
    
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      try {
        const result = await this.sendMessage(deviceId, recipient, message, {
          ...options,
          skipRateLimit: true, // Skip individual rate limit check, we checked bulk above
          messageType: 'broadcast',
        });
        results.push({ recipient, ...result });
        
        // Update broadcast count
        await pool.query(`
          INSERT INTO daily_usage (user_id, device_id, date, broadcasts_sent)
          VALUES ($1, $2, $3, 1)
          ON CONFLICT (user_id, device_id, date) 
          DO UPDATE SET broadcasts_sent = daily_usage.broadcasts_sent + 1, updated_at = NOW()
        `, [userId, deviceId, today]);
        
        // Add delay between messages (except for last one)
        if (i < recipients.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } catch (error) {
        results.push({ recipient, success: false, error: error.message });
      }
    }
    
    return results;
  }

  async disconnectDevice(deviceId) {
    const client = this.clients.get(deviceId);
    if (client) {
      await client.destroy();
      this.clients.delete(deviceId);
      
      await pool.query(
        'UPDATE devices SET status = $1, updated_at = NOW() WHERE id = $2',
        ['disconnected', deviceId]
      );
    }
  }

  async logoutDevice(deviceId) {
    const client = this.clients.get(deviceId);
    if (client) {
      await client.logout();
      this.clients.delete(deviceId);
      
      await pool.query(
        'UPDATE devices SET status = $1, session_data = NULL, updated_at = NOW() WHERE id = $2',
        ['logged_out', deviceId]
      );
      
      // Remove session folder
      const sessionPath = path.join(config.whatsapp.sessionPath, `session-device-${deviceId}`);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true });
      }
    }
  }

  getClient(deviceId) {
    return this.clients.get(deviceId);
  }

  isConnected(deviceId) {
    const client = this.clients.get(deviceId);
    return client && client.info;
  }

  async getDeviceInfo(deviceId) {
    const client = this.clients.get(deviceId);
    if (!client || !client.info) {
      return null;
    }
    
    return {
      phoneNumber: client.info.wid.user,
      pushname: client.info.pushname,
      platform: client.info.platform,
    };
  }
}

export default WhatsAppManager;
