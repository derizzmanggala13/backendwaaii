import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/connection.js';
import { authenticate, ownsDevice } from '../middleware/auth.js';

const router = Router();

// Get auto replies for device
router.get('/:deviceId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;

    const result = await pool.query(
      'SELECT * FROM auto_replies WHERE device_id = $1 ORDER BY created_at DESC',
      [deviceId]
    );

    res.json({ autoReplies: result.rows });
  } catch (error) {
    console.error('Get auto replies error:', error);
    res.status(500).json({ error: 'Failed to get auto replies' });
  }
});

// Create auto reply
router.post('/:deviceId', authenticate, ownsDevice, [
  body('triggerKeyword').trim().isLength({ min: 1 }),
  body('matchType').isIn(['exact', 'contains', 'starts_with', 'ends_with']),
  body('replyMessage').trim().isLength({ min: 1 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { deviceId } = req.params;
    const { triggerKeyword, matchType, replyMessage, isActive = true } = req.body;

    const result = await pool.query(`
      INSERT INTO auto_replies (device_id, trigger_keyword, match_type, reply_message, is_active)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [deviceId, triggerKeyword, matchType, replyMessage, isActive]);

    res.status(201).json({
      message: 'Auto reply created',
      autoReply: result.rows[0],
    });
  } catch (error) {
    console.error('Create auto reply error:', error);
    res.status(500).json({ error: 'Failed to create auto reply' });
  }
});

// Update auto reply
router.put('/:deviceId/:replyId', authenticate, ownsDevice, [
  body('triggerKeyword').optional().trim().isLength({ min: 1 }),
  body('matchType').optional().isIn(['exact', 'contains', 'starts_with', 'ends_with']),
  body('replyMessage').optional().trim().isLength({ min: 1 }),
  body('isActive').optional().isBoolean(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { deviceId, replyId } = req.params;
    const { triggerKeyword, matchType, replyMessage, isActive } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (triggerKeyword !== undefined) {
      updates.push(`trigger_keyword = $${paramCount++}`);
      values.push(triggerKeyword);
    }
    if (matchType !== undefined) {
      updates.push(`match_type = $${paramCount++}`);
      values.push(matchType);
    }
    if (replyMessage !== undefined) {
      updates.push(`reply_message = $${paramCount++}`);
      values.push(replyMessage);
    }
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      values.push(isActive);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push('updated_at = NOW()');
    values.push(replyId, deviceId);

    const result = await pool.query(
      `UPDATE auto_replies SET ${updates.join(', ')} WHERE id = $${paramCount} AND device_id = $${paramCount + 1} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Auto reply not found' });
    }

    res.json({
      message: 'Auto reply updated',
      autoReply: result.rows[0],
    });
  } catch (error) {
    console.error('Update auto reply error:', error);
    res.status(500).json({ error: 'Failed to update auto reply' });
  }
});

// Delete auto reply
router.delete('/:deviceId/:replyId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId, replyId } = req.params;

    const result = await pool.query(
      'DELETE FROM auto_replies WHERE id = $1 AND device_id = $2 RETURNING *',
      [replyId, deviceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Auto reply not found' });
    }

    res.json({ message: 'Auto reply deleted' });
  } catch (error) {
    console.error('Delete auto reply error:', error);
    res.status(500).json({ error: 'Failed to delete auto reply' });
  }
});

// Toggle auto reply status
router.patch('/:deviceId/:replyId/toggle', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId, replyId } = req.params;

    const result = await pool.query(
      'UPDATE auto_replies SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 AND device_id = $2 RETURNING *',
      [replyId, deviceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Auto reply not found' });
    }

    res.json({
      message: 'Auto reply toggled',
      autoReply: result.rows[0],
    });
  } catch (error) {
    console.error('Toggle auto reply error:', error);
    res.status(500).json({ error: 'Failed to toggle auto reply' });
  }
});

export default router;
