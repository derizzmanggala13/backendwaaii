import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import multer from 'multer';
import pool from '../database/connection.js';
import { authenticate, ownsDevice } from '../middleware/auth.js';
import { saveOutgoingMessage } from '../services/MessageLogger.js';

const router = Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 } // 16MB limit
});

// Send message
router.post('/send', authenticate, [
  body('deviceId').isInt(),
  body('to').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { deviceId, to, message } = req.body;
    
    // Verify device ownership
    const deviceResult = await pool.query(
      'SELECT * FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this device' });
    }

    const whatsappManager = req.app.get('whatsappManager');

    if (!whatsappManager.isConnected(deviceId)) {
      return res.status(400).json({ error: 'Device not connected' });
    }

    const result = await whatsappManager.sendMessage(deviceId, to, message);

    // Save to message history
    await saveOutgoingMessage({
      deviceId: parseInt(deviceId),
      to,
      body: message,
      type: 'chat',
      messageId: result?.messageId || null,
      status: 'sent',
    });

    // Log activity
    await pool.query(
      'INSERT INTO activity_logs (user_id, device_id, action, details) VALUES ($1, $2, $3, $4)',
      [req.user.id, deviceId, 'message_sent', JSON.stringify({ to, messageId: result.messageId })]
    );

    res.json({
      message: 'Message sent',
      ...result,
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: error.message || 'Failed to send message' });
  }
});

// Send message with media
router.post('/send-media', authenticate, upload.single('media'), async (req, res) => {
  try {
    const { deviceId, to, caption } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No media file provided' });
    }

    // Verify device ownership
    const deviceResult = await pool.query(
      'SELECT * FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this device' });
    }

    const whatsappManager = req.app.get('whatsappManager');

    if (!whatsappManager.isConnected(parseInt(deviceId))) {
      return res.status(400).json({ error: 'Device not connected' });
    }

    const mediaData = {
      mimetype: req.file.mimetype,
      data: req.file.buffer.toString('base64'),
      filename: req.file.originalname,
    };

    const result = await whatsappManager.sendMessage(parseInt(deviceId), to, caption || '', {
      media: mediaData,
    });

    // Save to message history
    await saveOutgoingMessage({
      deviceId: parseInt(deviceId),
      to,
      body: caption || `[Media: ${req.file.originalname}]`,
      type: 'media',
      messageId: result?.messageId || null,
      status: 'sent',
      metadata: {
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
      },
    });

    res.json({
      message: 'Media sent',
      ...result,
    });
  } catch (error) {
    console.error('Send media error:', error);
    res.status(500).json({ error: error.message || 'Failed to send media' });
  }
});

// Get chat messages
router.get('/chat/:deviceId/:chatId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId, chatId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await pool.query(`
      SELECT * FROM messages 
      WHERE device_id = $1 AND chat_id = $2 
      ORDER BY timestamp DESC 
      LIMIT $3 OFFSET $4
    `, [deviceId, chatId, limit, offset]);

    res.json({
      messages: result.rows,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('Get chat messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Get all chats for device
router.get('/chats/:deviceId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const whatsappManager = req.app.get('whatsappManager');

    const client = whatsappManager.getClient(parseInt(deviceId));
    if (!client) {
      return res.status(400).json({ error: 'Device not connected' });
    }

    const chats = await client.getChats();
    const formattedChats = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
      lastMessage: chat.lastMessage ? {
        body: chat.lastMessage.body,
        timestamp: chat.lastMessage.timestamp,
        fromMe: chat.lastMessage.fromMe,
      } : null,
    }));

    res.json({ chats: formattedChats });
  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({ error: 'Failed to get chats' });
  }
});

// Send broadcast message
router.post('/broadcast', authenticate, [
  body('deviceId').isInt(),
  body('recipients').isArray({ min: 1 }),
  body('message').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { deviceId, recipients, message } = req.body;

    // Verify device ownership
    const deviceResult = await pool.query(
      'SELECT * FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this device' });
    }

    const whatsappManager = req.app.get('whatsappManager');

    if (!whatsappManager.isConnected(deviceId)) {
      return res.status(400).json({ error: 'Device not connected' });
    }

    const results = await whatsappManager.sendBroadcast(deviceId, recipients, message);

    // Save each broadcast message to history
    for (const result of results) {
      await saveOutgoingMessage({
        deviceId: parseInt(deviceId),
        to: result.recipient,
        body: message,
        type: 'broadcast',
        messageId: result.messageId || null,
        status: result.success ? 'sent' : 'failed',
        metadata: {
          broadcast: true,
          error: result.error || null,
        },
      });
    }

    // Log activity
    await pool.query(
      'INSERT INTO activity_logs (user_id, device_id, action, details) VALUES ($1, $2, $3, $4)',
      [req.user.id, deviceId, 'broadcast_sent', JSON.stringify({ recipientCount: recipients.length })]
    );

    res.json({
      message: 'Broadcast sent',
      results,
    });
  } catch (error) {
    console.error('Broadcast error:', error);
    res.status(500).json({ error: error.message || 'Failed to send broadcast' });
  }
});

// Schedule message
router.post('/schedule', authenticate, [
  body('deviceId').isInt(),
  body('to').notEmpty(),
  body('message').notEmpty(),
  body('scheduledAt').isISO8601(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { deviceId, to, message, scheduledAt } = req.body;

    // Verify device ownership
    const deviceResult = await pool.query(
      'SELECT * FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this device' });
    }

    const result = await pool.query(`
      INSERT INTO scheduled_messages (device_id, to_number, body, scheduled_at)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [deviceId, to, message, scheduledAt]);

    res.status(201).json({
      message: 'Message scheduled',
      scheduledMessage: result.rows[0],
    });
  } catch (error) {
    console.error('Schedule message error:', error);
    res.status(500).json({ error: 'Failed to schedule message' });
  }
});

// Get scheduled messages
router.get('/scheduled/:deviceId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { status } = req.query;

    let query = 'SELECT * FROM scheduled_messages WHERE device_id = $1';
    const params = [deviceId];

    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }

    query += ' ORDER BY scheduled_at ASC';

    const result = await pool.query(query, params);
    res.json({ scheduledMessages: result.rows });
  } catch (error) {
    console.error('Get scheduled messages error:', error);
    res.status(500).json({ error: 'Failed to get scheduled messages' });
  }
});

// Cancel scheduled message
router.delete('/scheduled/:messageId', authenticate, async (req, res) => {
  try {
    const { messageId } = req.params;

    const result = await pool.query(`
      UPDATE scheduled_messages 
      SET status = 'cancelled' 
      WHERE id = $1 
      AND device_id IN (SELECT id FROM devices WHERE user_id = $2)
      AND status = 'pending'
      RETURNING *
    `, [messageId, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Scheduled message not found or cannot be cancelled' });
    }

    res.json({
      message: 'Scheduled message cancelled',
      scheduledMessage: result.rows[0],
    });
  } catch (error) {
    console.error('Cancel scheduled message error:', error);
    res.status(500).json({ error: 'Failed to cancel scheduled message' });
  }
});

// Get message history from database
router.get('/history/:deviceId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { limit = 100, offset = 0, search } = req.query;

    let query = `
      SELECT * FROM messages 
      WHERE device_id = $1 
    `;
    const params = [deviceId];

    if (search) {
      query += ` AND (body ILIKE $${params.length + 1} OR to_number ILIKE $${params.length + 1} OR from_number ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM messages WHERE device_id = $1',
      [deviceId]
    );

    res.json({
      messages: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('Get message history error:', error);
    res.status(500).json({ error: 'Failed to get message history' });
  }
});

// Get chat messages from WhatsApp directly (live)
router.get('/live/:deviceId/:chatId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId, chatId } = req.params;
    const { limit = 50 } = req.query;
    
    const whatsappManager = req.app.get('whatsappManager');
    const client = whatsappManager.getClient(parseInt(deviceId));
    
    if (!client) {
      return res.status(400).json({ error: 'Device not connected' });
    }

    const chat = await client.getChatById(chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const messages = await chat.fetchMessages({ limit: parseInt(limit) });
    
    const formattedMessages = messages.map(msg => ({
      id: msg.id.id,
      body: msg.body,
      type: msg.type,
      timestamp: msg.timestamp * 1000,
      is_from_me: msg.fromMe,
      from: msg.from,
      to: msg.to,
      hasMedia: msg.hasMedia,
      ack: msg.ack,
    }));

    res.json({ messages: formattedMessages });
  } catch (error) {
    console.error('Get live messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

export default router;
