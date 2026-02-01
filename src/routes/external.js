import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import multer from 'multer';
import pool from '../database/connection.js';
import { authenticateApiKey } from '../middleware/auth.js';

const router = Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }
});

// All routes use API key authentication
router.use(authenticateApiKey);

// Send message
router.post('/send', [
  body('to').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { to, message } = req.body;
    const deviceId = req.deviceId;
    const whatsappManager = req.app.get('whatsappManager');

    if (!whatsappManager.isConnected(deviceId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Device not connected' 
      });
    }

    const result = await whatsappManager.sendMessage(deviceId, to, message);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('External API send error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to send message' 
    });
  }
});

// Send media
router.post('/send-media', upload.single('media'), async (req, res) => {
  try {
    const { to, caption } = req.body;
    const deviceId = req.deviceId;

    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No media file provided' 
      });
    }

    const whatsappManager = req.app.get('whatsappManager');

    if (!whatsappManager.isConnected(deviceId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Device not connected' 
      });
    }

    const mediaData = {
      mimetype: req.file.mimetype,
      data: req.file.buffer.toString('base64'),
      filename: req.file.originalname,
    };

    const result = await whatsappManager.sendMessage(deviceId, to, caption || '', {
      media: mediaData,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('External API send media error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to send media' 
    });
  }
});

// Send bulk/broadcast
router.post('/broadcast', [
  body('recipients').isArray({ min: 1 }),
  body('message').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { recipients, message, delay = 1000 } = req.body;
    const deviceId = req.deviceId;
    const whatsappManager = req.app.get('whatsappManager');

    if (!whatsappManager.isConnected(deviceId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Device not connected' 
      });
    }

    const results = await whatsappManager.sendBroadcast(deviceId, recipients, message);

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.json({
      success: true,
      summary: {
        total: recipients.length,
        successful,
        failed,
      },
      results,
    });
  } catch (error) {
    console.error('External API broadcast error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to send broadcast' 
    });
  }
});

// Check number exists on WhatsApp
router.get('/check-number/:number', async (req, res) => {
  try {
    const { number } = req.params;
    const deviceId = req.deviceId;
    const whatsappManager = req.app.get('whatsappManager');

    const client = whatsappManager.getClient(deviceId);
    if (!client) {
      return res.status(400).json({ 
        success: false, 
        error: 'Device not connected' 
      });
    }

    const formattedNumber = number.replace(/\D/g, '') + '@c.us';
    const isRegistered = await client.isRegisteredUser(formattedNumber);

    res.json({
      success: true,
      number,
      isRegistered,
    });
  } catch (error) {
    console.error('Check number error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to check number' 
    });
  }
});

// Get device status
router.get('/status', async (req, res) => {
  try {
    const deviceId = req.deviceId;
    const whatsappManager = req.app.get('whatsappManager');

    const isConnected = whatsappManager.isConnected(deviceId);
    let deviceInfo = null;

    if (isConnected) {
      deviceInfo = await whatsappManager.getDeviceInfo(deviceId);
    }

    res.json({
      success: true,
      isConnected,
      deviceInfo,
    });
  } catch (error) {
    console.error('Get status error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to get status' 
    });
  }
});

// Get profile picture
router.get('/profile-pic/:number', async (req, res) => {
  try {
    const { number } = req.params;
    const deviceId = req.deviceId;
    const whatsappManager = req.app.get('whatsappManager');

    const client = whatsappManager.getClient(deviceId);
    if (!client) {
      return res.status(400).json({ 
        success: false, 
        error: 'Device not connected' 
      });
    }

    const formattedNumber = number.replace(/\D/g, '') + '@c.us';
    const contact = await client.getContactById(formattedNumber);
    const profilePicUrl = await contact.getProfilePicUrl();

    res.json({
      success: true,
      number,
      profilePicUrl,
    });
  } catch (error) {
    console.error('Get profile pic error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to get profile picture' 
    });
  }
});

export default router;
