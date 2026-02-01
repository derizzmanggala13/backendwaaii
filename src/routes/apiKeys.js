import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import pool from '../database/connection.js';
import { authenticate, ownsDevice } from '../middleware/auth.js';

const router = Router();

// Get all API keys for user
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ak.id, ak.api_key, ak.name, ak.is_active, ak.last_used_at, ak.created_at,
             d.device_name, d.phone_number
      FROM api_keys ak
      LEFT JOIN devices d ON ak.device_id = d.id
      WHERE ak.user_id = $1
      ORDER BY ak.created_at DESC
    `, [req.user.id]);

    res.json({ apiKeys: result.rows });
  } catch (error) {
    console.error('Get API keys error:', error);
    res.status(500).json({ error: 'Failed to get API keys' });
  }
});

// Create API key
router.post('/', authenticate, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('deviceId').isInt(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, deviceId } = req.body;

    // Verify device ownership
    const deviceResult = await pool.query(
      'SELECT * FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this device' });
    }

    const apiKey = `wag_${uuidv4().replace(/-/g, '')}`;

    const result = await pool.query(`
      INSERT INTO api_keys (user_id, device_id, api_key, name)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.user.id, deviceId, apiKey, name]);

    res.status(201).json({
      message: 'API key created',
      apiKey: result.rows[0],
    });
  } catch (error) {
    console.error('Create API key error:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Delete API key
router.delete('/:keyId', authenticate, async (req, res) => {
  try {
    const { keyId } = req.params;

    const result = await pool.query(
      'DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING *',
      [keyId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key deleted' });
  } catch (error) {
    console.error('Delete API key error:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Toggle API key status
router.patch('/:keyId/toggle', authenticate, async (req, res) => {
  try {
    const { keyId } = req.params;

    const result = await pool.query(
      'UPDATE api_keys SET is_active = NOT is_active WHERE id = $1 AND user_id = $2 RETURNING *',
      [keyId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({
      message: 'API key toggled',
      apiKey: result.rows[0],
    });
  } catch (error) {
    console.error('Toggle API key error:', error);
    res.status(500).json({ error: 'Failed to toggle API key' });
  }
});

export default router;
