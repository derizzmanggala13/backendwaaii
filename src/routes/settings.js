import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get user settings
router.get('/', authenticate, async (req, res) => {
  try {
    // Get or create default settings
    let result = await pool.query(
      'SELECT * FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      // Create default settings
      result = await pool.query(`
        INSERT INTO user_settings (user_id)
        VALUES ($1)
        RETURNING *
      `, [req.user.id]);
    }

    res.json({ settings: result.rows[0] });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Update user settings (Admin only for rate limits)
router.put('/', authenticate, [
  body('daily_message_limit').optional().isInt({ min: 10, max: 10000 }),
  body('message_delay_seconds').optional().isInt({ min: 1, max: 60 }),
  body('broadcast_delay_seconds').optional().isInt({ min: 1, max: 120 }),
  body('auto_reply_delay_seconds').optional().isInt({ min: 0, max: 30 }),
  body('max_broadcast_recipients').optional().isInt({ min: 1, max: 1000 }),
  body('enable_rate_limiting').optional().isBoolean(),
  body('target_user_id').optional().isInt(), // Admin can set for specific user
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Only admin can update rate limit settings
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can update rate limit settings' });
    }

    const {
      daily_message_limit,
      message_delay_seconds,
      broadcast_delay_seconds,
      auto_reply_delay_seconds,
      max_broadcast_recipients,
      enable_rate_limiting,
      target_user_id,
    } = req.body;

    // Determine which user to update (admin can set for other users)
    const userId = target_user_id || req.user.id;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (daily_message_limit !== undefined) {
      updates.push(`daily_message_limit = $${paramCount++}`);
      values.push(daily_message_limit);
    }
    if (message_delay_seconds !== undefined) {
      updates.push(`message_delay_seconds = $${paramCount++}`);
      values.push(message_delay_seconds);
    }
    if (broadcast_delay_seconds !== undefined) {
      updates.push(`broadcast_delay_seconds = $${paramCount++}`);
      values.push(broadcast_delay_seconds);
    }
    if (auto_reply_delay_seconds !== undefined) {
      updates.push(`auto_reply_delay_seconds = $${paramCount++}`);
      values.push(auto_reply_delay_seconds);
    }
    if (max_broadcast_recipients !== undefined) {
      updates.push(`max_broadcast_recipients = $${paramCount++}`);
      values.push(max_broadcast_recipients);
    }
    if (enable_rate_limiting !== undefined) {
      updates.push(`enable_rate_limiting = $${paramCount++}`);
      values.push(enable_rate_limiting);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');
    values.push(userId);

    // First, ensure settings exist
    await pool.query(`
      INSERT INTO user_settings (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `, [userId]);

    // Then update
    const result = await pool.query(`
      UPDATE user_settings 
      SET ${updates.join(', ')}
      WHERE user_id = $${paramCount}
      RETURNING *
    `, values);

    res.json({
      message: 'Settings updated',
      settings: result.rows[0],
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Get daily usage statistics
router.get('/usage', authenticate, async (req, res) => {
  try {
    const { deviceId, date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    let query = `
      SELECT 
        du.*,
        d.device_name
      FROM daily_usage du
      JOIN devices d ON du.device_id = d.id
      WHERE du.user_id = $1 AND du.date = $2
    `;
    const params = [req.user.id, targetDate];

    if (deviceId) {
      query += ' AND du.device_id = $3';
      params.push(deviceId);
    }

    const result = await pool.query(query, params);

    // Get settings for limits
    const settingsResult = await pool.query(
      'SELECT daily_message_limit FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );
    const dailyLimit = settingsResult.rows[0]?.daily_message_limit || 200;

    // Calculate total for all devices
    const totalResult = await pool.query(`
      SELECT 
        COALESCE(SUM(messages_sent), 0) as total_messages,
        COALESCE(SUM(broadcasts_sent), 0) as total_broadcasts,
        COALESCE(SUM(auto_replies_sent), 0) as total_auto_replies
      FROM daily_usage
      WHERE user_id = $1 AND date = $2
    `, [req.user.id, targetDate]);

    res.json({
      date: targetDate,
      usage: result.rows,
      totals: totalResult.rows[0],
      daily_limit: dailyLimit,
      remaining: Math.max(0, dailyLimit - (totalResult.rows[0]?.total_messages || 0)),
    });
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to get usage statistics' });
  }
});

// Get usage history (last 7 days)
router.get('/usage/history', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        date,
        SUM(messages_sent) as messages_sent,
        SUM(broadcasts_sent) as broadcasts_sent,
        SUM(auto_replies_sent) as auto_replies_sent
      FROM daily_usage
      WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY date
      ORDER BY date DESC
    `, [req.user.id]);

    res.json({ history: result.rows });
  } catch (error) {
    console.error('Get usage history error:', error);
    res.status(500).json({ error: 'Failed to get usage history' });
  }
});

// =====================================================
// ADMIN ROUTES - Manage settings for all users
// =====================================================

// Get all users with their settings (admin only)
router.get('/admin/users', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await pool.query(`
      SELECT 
        u.id,
        u.name,
        u.email,
        u.role,
        u.is_active,
        u.created_at,
        COALESCE(us.daily_message_limit, 200) as daily_message_limit,
        COALESCE(us.message_delay_seconds, 3) as message_delay_seconds,
        COALESCE(us.broadcast_delay_seconds, 5) as broadcast_delay_seconds,
        COALESCE(us.auto_reply_delay_seconds, 2) as auto_reply_delay_seconds,
        COALESCE(us.max_broadcast_recipients, 100) as max_broadcast_recipients,
        COALESCE(us.enable_rate_limiting, true) as enable_rate_limiting,
        (
          SELECT COALESCE(SUM(messages_sent), 0)
          FROM daily_usage
          WHERE user_id = u.id AND date = CURRENT_DATE
        ) as today_messages,
        (
          SELECT COUNT(*)
          FROM devices
          WHERE user_id = u.id
        ) as device_count
      FROM users u
      LEFT JOIN user_settings us ON u.id = us.user_id
      ORDER BY u.created_at DESC
    `);

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Get users settings error:', error);
    res.status(500).json({ error: 'Failed to get users settings' });
  }
});

// Get specific user settings (admin only)
router.get('/admin/users/:userId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;

    // Get user info
    const userResult = await pool.query(
      'SELECT id, name, email, role, is_active, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get or create settings
    let settingsResult = await pool.query(
      'SELECT * FROM user_settings WHERE user_id = $1',
      [userId]
    );

    if (settingsResult.rows.length === 0) {
      settingsResult = await pool.query(`
        INSERT INTO user_settings (user_id)
        VALUES ($1)
        RETURNING *
      `, [userId]);
    }

    // Get today's usage
    const usageResult = await pool.query(`
      SELECT 
        COALESCE(SUM(messages_sent), 0) as total_messages,
        COALESCE(SUM(broadcasts_sent), 0) as total_broadcasts,
        COALESCE(SUM(auto_replies_sent), 0) as total_auto_replies
      FROM daily_usage
      WHERE user_id = $1 AND date = CURRENT_DATE
    `, [userId]);

    // Get usage history
    const historyResult = await pool.query(`
      SELECT 
        date,
        SUM(messages_sent) as messages_sent,
        SUM(broadcasts_sent) as broadcasts_sent,
        SUM(auto_replies_sent) as auto_replies_sent
      FROM daily_usage
      WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY date
      ORDER BY date DESC
    `, [userId]);

    res.json({
      user: userResult.rows[0],
      settings: settingsResult.rows[0],
      usage: usageResult.rows[0],
      history: historyResult.rows,
    });
  } catch (error) {
    console.error('Get user settings error:', error);
    res.status(500).json({ error: 'Failed to get user settings' });
  }
});

// Update specific user settings (admin only)
router.put('/admin/users/:userId', authenticate, [
  body('daily_message_limit').optional().isInt({ min: 1, max: 100000 }),
  body('message_delay_seconds').optional().isInt({ min: 0, max: 300 }),
  body('broadcast_delay_seconds').optional().isInt({ min: 0, max: 600 }),
  body('auto_reply_delay_seconds').optional().isInt({ min: 0, max: 60 }),
  body('max_broadcast_recipients').optional().isInt({ min: 1, max: 10000 }),
  body('enable_rate_limiting').optional().isBoolean(),
], async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId } = req.params;

    // Check user exists
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const {
      daily_message_limit,
      message_delay_seconds,
      broadcast_delay_seconds,
      auto_reply_delay_seconds,
      max_broadcast_recipients,
      enable_rate_limiting,
    } = req.body;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (daily_message_limit !== undefined) {
      updates.push(`daily_message_limit = $${paramCount++}`);
      values.push(daily_message_limit);
    }
    if (message_delay_seconds !== undefined) {
      updates.push(`message_delay_seconds = $${paramCount++}`);
      values.push(message_delay_seconds);
    }
    if (broadcast_delay_seconds !== undefined) {
      updates.push(`broadcast_delay_seconds = $${paramCount++}`);
      values.push(broadcast_delay_seconds);
    }
    if (auto_reply_delay_seconds !== undefined) {
      updates.push(`auto_reply_delay_seconds = $${paramCount++}`);
      values.push(auto_reply_delay_seconds);
    }
    if (max_broadcast_recipients !== undefined) {
      updates.push(`max_broadcast_recipients = $${paramCount++}`);
      values.push(max_broadcast_recipients);
    }
    if (enable_rate_limiting !== undefined) {
      updates.push(`enable_rate_limiting = $${paramCount++}`);
      values.push(enable_rate_limiting);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');
    values.push(userId);

    // Ensure settings exist
    await pool.query(`
      INSERT INTO user_settings (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `, [userId]);

    // Update settings
    const result = await pool.query(`
      UPDATE user_settings 
      SET ${updates.join(', ')}
      WHERE user_id = $${paramCount}
      RETURNING *
    `, values);

    res.json({
      message: 'User settings updated',
      settings: result.rows[0],
    });
  } catch (error) {
    console.error('Update user settings error:', error);
    res.status(500).json({ error: 'Failed to update user settings' });
  }
});

// Reset user's daily usage (admin only)
router.post('/admin/users/:userId/reset-usage', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;

    await pool.query(`
      DELETE FROM daily_usage 
      WHERE user_id = $1 AND date = CURRENT_DATE
    `, [userId]);

    res.json({ message: 'Daily usage reset successfully' });
  } catch (error) {
    console.error('Reset usage error:', error);
    res.status(500).json({ error: 'Failed to reset usage' });
  }
});

// Bulk update settings for multiple users (admin only)
router.put('/admin/bulk-update', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userIds, settings } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'User IDs required' });
    }

    const {
      daily_message_limit,
      message_delay_seconds,
      broadcast_delay_seconds,
      auto_reply_delay_seconds,
      max_broadcast_recipients,
      enable_rate_limiting,
    } = settings;

    // Build update parts
    const updates = [];
    if (daily_message_limit !== undefined) updates.push(`daily_message_limit = ${daily_message_limit}`);
    if (message_delay_seconds !== undefined) updates.push(`message_delay_seconds = ${message_delay_seconds}`);
    if (broadcast_delay_seconds !== undefined) updates.push(`broadcast_delay_seconds = ${broadcast_delay_seconds}`);
    if (auto_reply_delay_seconds !== undefined) updates.push(`auto_reply_delay_seconds = ${auto_reply_delay_seconds}`);
    if (max_broadcast_recipients !== undefined) updates.push(`max_broadcast_recipients = ${max_broadcast_recipients}`);
    if (enable_rate_limiting !== undefined) updates.push(`enable_rate_limiting = ${enable_rate_limiting}`);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No settings to update' });
    }

    updates.push('updated_at = NOW()');

    // Ensure settings exist for all users
    for (const userId of userIds) {
      await pool.query(`
        INSERT INTO user_settings (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
      `, [userId]);
    }

    // Update all users
    await pool.query(`
      UPDATE user_settings 
      SET ${updates.join(', ')}
      WHERE user_id = ANY($1)
    `, [userIds]);

    res.json({ 
      message: `Settings updated for ${userIds.length} users`,
      updatedCount: userIds.length,
    });
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({ error: 'Failed to bulk update settings' });
  }
});

export default router;
