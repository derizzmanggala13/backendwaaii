import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get AI settings for a device
router.get('/settings/:deviceId', authenticate, async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    // Verify device ownership
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );
    
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    // Get or create settings
    let result = await pool.query(
      'SELECT * FROM ai_settings WHERE device_id = $1',
      [deviceId]
    );
    
    if (result.rows.length === 0) {
      // Create default settings
      result = await pool.query(`
        INSERT INTO ai_settings (device_id)
        VALUES ($1)
        RETURNING *
      `, [deviceId]);
    }
    
    // Mask API key for security
    const settings = result.rows[0];
    if (settings.api_key) {
      settings.api_key_masked = settings.api_key.substring(0, 10) + '...' + settings.api_key.substring(settings.api_key.length - 4);
      settings.has_api_key = true;
    } else {
      settings.has_api_key = false;
    }
    delete settings.api_key;
    
    res.json({ settings });
  } catch (error) {
    console.error('Get AI settings error:', error);
    res.status(500).json({ error: 'Failed to get AI settings' });
  }
});

// Update AI settings
router.put('/settings/:deviceId', authenticate, [
  body('is_enabled').optional().isBoolean(),
  body('ai_provider').optional().isIn(['gemini', 'openai']),
  body('api_key').optional().isString(),
  body('model').optional().isString(),
  body('system_prompt').optional().isString(),
  body('max_tokens').optional().isInt({ min: 50, max: 4096 }),
  body('temperature').optional().isNumeric(),
  body('reply_delay_seconds').optional().isInt({ min: 0, max: 30 }),
  body('ignore_groups').optional().isBoolean(),
  body('only_when_contains').optional(),
  body('excluded_contacts').optional(),
  body('welcome_message').optional(),
  body('fallback_message').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { deviceId } = req.params;
    console.log('Updating AI settings for device:', deviceId, 'Body:', req.body);
    
    // Verify device ownership
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );
    
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    const {
      is_enabled,
      ai_provider,
      api_key,
      model,
      system_prompt,
      max_tokens,
      temperature,
      reply_delay_seconds,
      ignore_groups,
      only_when_contains,
      excluded_contacts,
      welcome_message,
      fallback_message,
    } = req.body;
    
    // Ensure settings record exists
    await pool.query(`
      INSERT INTO ai_settings (device_id)
      VALUES ($1)
      ON CONFLICT (device_id) DO NOTHING
    `, [deviceId]);
    
    // Build dynamic update
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (is_enabled !== undefined) {
      updates.push(`is_enabled = $${paramCount++}`);
      values.push(is_enabled);
    }
    if (ai_provider !== undefined) {
      updates.push(`ai_provider = $${paramCount++}`);
      values.push(ai_provider);
    }
    if (api_key !== undefined && api_key !== '') {
      updates.push(`api_key = $${paramCount++}`);
      values.push(api_key);
    }
    if (model !== undefined) {
      updates.push(`model = $${paramCount++}`);
      values.push(model);
    }
    if (system_prompt !== undefined) {
      updates.push(`system_prompt = $${paramCount++}`);
      values.push(system_prompt);
    }
    if (max_tokens !== undefined) {
      updates.push(`max_tokens = $${paramCount++}`);
      values.push(max_tokens);
    }
    if (temperature !== undefined) {
      updates.push(`temperature = $${paramCount++}`);
      values.push(temperature);
    }
    if (reply_delay_seconds !== undefined) {
      updates.push(`reply_delay_seconds = $${paramCount++}`);
      values.push(reply_delay_seconds);
    }
    if (ignore_groups !== undefined) {
      updates.push(`ignore_groups = $${paramCount++}`);
      values.push(ignore_groups);
    }
    if (only_when_contains !== undefined) {
      updates.push(`only_when_contains = $${paramCount++}`);
      values.push(only_when_contains || null);
    }
    if (excluded_contacts !== undefined) {
      updates.push(`excluded_contacts = $${paramCount++}`);
      values.push(excluded_contacts || null);
    }
    if (welcome_message !== undefined) {
      updates.push(`welcome_message = $${paramCount++}`);
      values.push(welcome_message || null);
    }
    if (fallback_message !== undefined) {
      updates.push(`fallback_message = $${paramCount++}`);
      values.push(fallback_message);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    updates.push('updated_at = NOW()');
    values.push(deviceId);
    
    const result = await pool.query(`
      UPDATE ai_settings
      SET ${updates.join(', ')}
      WHERE device_id = $${paramCount}
      RETURNING *
    `, values);
    
    // Mask API key in response
    const settings = result.rows[0];
    if (settings.api_key) {
      settings.api_key_masked = settings.api_key.substring(0, 10) + '...' + settings.api_key.substring(settings.api_key.length - 4);
      settings.has_api_key = true;
    }
    delete settings.api_key;
    
    res.json({
      message: 'AI settings updated',
      settings,
    });
  } catch (error) {
    console.error('Update AI settings error:', error);
    res.status(500).json({ error: 'Failed to update AI settings' });
  }
});

// Test AI connection
router.post('/test/:deviceId', authenticate, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { message } = req.body;
    
    // Verify device ownership
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );
    
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    // Get settings
    const settingsResult = await pool.query(
      'SELECT * FROM ai_settings WHERE device_id = $1',
      [deviceId]
    );
    
    if (settingsResult.rows.length === 0 || !settingsResult.rows[0].api_key) {
      return res.status(400).json({ error: 'API key not configured' });
    }
    
    const settings = settingsResult.rows[0];
    const provider = settings.ai_provider || 'gemini';
    
    // Test with appropriate AI provider
    let response;
    if (provider === 'openai') {
      response = await callOpenAIAPI(
        settings.api_key,
        settings.model,
        settings.system_prompt,
        message || 'Halo, ini pesan test',
        [],
        settings.max_tokens,
        settings.temperature
      );
    } else {
      response = await callGeminiAPI(
        settings.api_key,
        settings.model,
        settings.system_prompt,
        message || 'Halo, ini pesan test',
        [],
        settings.max_tokens,
        settings.temperature
      );
    }
    
    res.json({
      success: true,
      response,
      model: settings.model,
      provider: provider,
    });
  } catch (error) {
    console.error('Test AI error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Failed to test AI' 
    });
  }
});

// Get conversation history
router.get('/conversations/:deviceId/:chatId', authenticate, async (req, res) => {
  try {
    const { deviceId, chatId } = req.params;
    const { limit = 20 } = req.query;
    
    // Verify device ownership
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );
    
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    const result = await pool.query(`
      SELECT * FROM ai_conversations
      WHERE device_id = $1 AND chat_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `, [deviceId, chatId, limit]);
    
    res.json({ conversations: result.rows.reverse() });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// Clear conversation history for a chat
router.delete('/conversations/:deviceId/:chatId', authenticate, async (req, res) => {
  try {
    const { deviceId, chatId } = req.params;
    
    // Verify device ownership
    const deviceCheck = await pool.query(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );
    
    if (deviceCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    await pool.query(
      'DELETE FROM ai_conversations WHERE device_id = $1 AND chat_id = $2',
      [deviceId, chatId]
    );
    
    res.json({ message: 'Conversation history cleared' });
  } catch (error) {
    console.error('Clear conversations error:', error);
    res.status(500).json({ error: 'Failed to clear conversations' });
  }
});

// Gemini API caller
async function callGeminiAPI(apiKey, model, systemPrompt, userMessage, history = [], maxTokens = 500, temperature = 0.7) {
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
async function callOpenAIAPI(apiKey, model, systemPrompt, userMessage, history = [], maxTokens = 500, temperature = 0.7) {
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

// Export for use in WhatsApp handler
export { callGeminiAPI, callOpenAIAPI };
export default router;
