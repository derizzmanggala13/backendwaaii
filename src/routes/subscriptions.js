import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// =====================================================
// PACKAGES MANAGEMENT
// =====================================================

// Get all packages
router.get('/packages', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM subscription_packages 
      ORDER BY price ASC
    `);
    res.json({ packages: result.rows });
  } catch (error) {
    console.error('Get packages error:', error);
    res.status(500).json({ error: 'Failed to get packages' });
  }
});

// Get active packages (for display)
router.get('/packages/active', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM subscription_packages 
      WHERE is_active = true
      ORDER BY price ASC
    `);
    res.json({ packages: result.rows });
  } catch (error) {
    console.error('Get active packages error:', error);
    res.status(500).json({ error: 'Failed to get packages' });
  }
});

// Create package (admin only)
router.post('/packages', authenticate, [
  body('name').trim().isLength({ min: 2 }),
  body('price').isFloat({ min: 0 }),
  body('duration_days').isInt({ min: 1 }),
  body('max_devices').isInt({ min: 1 }),
  body('daily_message_limit').isInt({ min: 1 }),
  body('max_broadcast_recipients').isInt({ min: 1 }),
], async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      name, description, price, duration_days,
      max_devices, daily_message_limit, max_broadcast_recipients,
      features = []
    } = req.body;

    const result = await pool.query(`
      INSERT INTO subscription_packages 
      (name, description, price, duration_days, max_devices, daily_message_limit, max_broadcast_recipients, features)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [name, description, price, duration_days, max_devices, daily_message_limit, max_broadcast_recipients, JSON.stringify(features)]);

    res.status(201).json({
      message: 'Package created',
      package: result.rows[0],
    });
  } catch (error) {
    console.error('Create package error:', error);
    res.status(500).json({ error: 'Failed to create package' });
  }
});

// Update package (admin only)
router.put('/packages/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;
    const {
      name, description, price, duration_days,
      max_devices, daily_message_limit, max_broadcast_recipients,
      features, is_active
    } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (price !== undefined) { updates.push(`price = $${paramCount++}`); values.push(price); }
    if (duration_days !== undefined) { updates.push(`duration_days = $${paramCount++}`); values.push(duration_days); }
    if (max_devices !== undefined) { updates.push(`max_devices = $${paramCount++}`); values.push(max_devices); }
    if (daily_message_limit !== undefined) { updates.push(`daily_message_limit = $${paramCount++}`); values.push(daily_message_limit); }
    if (max_broadcast_recipients !== undefined) { updates.push(`max_broadcast_recipients = $${paramCount++}`); values.push(max_broadcast_recipients); }
    if (features !== undefined) { updates.push(`features = $${paramCount++}`); values.push(JSON.stringify(features)); }
    if (is_active !== undefined) { updates.push(`is_active = $${paramCount++}`); values.push(is_active); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');
    values.push(id);

    const result = await pool.query(`
      UPDATE subscription_packages 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    res.json({
      message: 'Package updated',
      package: result.rows[0],
    });
  } catch (error) {
    console.error('Update package error:', error);
    res.status(500).json({ error: 'Failed to update package' });
  }
});

// Delete package (admin only)
router.delete('/packages/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;

    // Check if package is in use
    const usageCheck = await pool.query(
      'SELECT COUNT(*) FROM users WHERE package_id = $1',
      [id]
    );

    if (parseInt(usageCheck.rows[0].count) > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete package that is in use by users' 
      });
    }

    await pool.query('DELETE FROM subscription_packages WHERE id = $1', [id]);
    res.json({ message: 'Package deleted' });
  } catch (error) {
    console.error('Delete package error:', error);
    res.status(500).json({ error: 'Failed to delete package' });
  }
});

// =====================================================
// USER SUBSCRIPTION MANAGEMENT (Admin)
// =====================================================

// Get all users with subscription info
router.get('/users', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await pool.query(`
      SELECT 
        u.id, u.name, u.email, u.role, u.is_active,
        u.package_id, u.subscription_started_at, u.subscription_expires_at,
        u.created_at,
        sp.name as package_name,
        sp.price as package_price,
        sp.daily_message_limit,
        sp.max_devices,
        (SELECT COUNT(*) FROM devices WHERE user_id = u.id) as device_count,
        CASE 
          WHEN u.role = 'admin' THEN 'admin'
          WHEN u.subscription_expires_at IS NULL THEN 'no_subscription'
          WHEN u.subscription_expires_at < NOW() THEN 'expired'
          WHEN u.subscription_expires_at < NOW() + INTERVAL '7 days' THEN 'expiring_soon'
          ELSE 'active'
        END as subscription_status,
        CASE 
          WHEN u.subscription_expires_at IS NOT NULL THEN
            EXTRACT(DAY FROM u.subscription_expires_at - NOW())::INTEGER
          ELSE NULL
        END as days_remaining
      FROM users u
      LEFT JOIN subscription_packages sp ON u.package_id = sp.id
      WHERE u.role != 'admin'
      ORDER BY u.created_at DESC
    `);

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Get subscription users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Assign package to user
router.post('/users/:userId/assign', authenticate, [
  body('package_id').isInt({ min: 1 }),
  body('duration_days').optional().isInt({ min: 1 }),
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
    const { package_id, duration_days, notes } = req.body;

    // Get package info
    const packageResult = await pool.query(
      'SELECT * FROM subscription_packages WHERE id = $1',
      [package_id]
    );

    if (packageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    const pkg = packageResult.rows[0];
    const actualDuration = duration_days || pkg.duration_days;

    // Get current user info
    const userResult = await pool.query(
      'SELECT subscription_expires_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const previousExpires = userResult.rows[0].subscription_expires_at;
    const now = new Date();
    const newExpires = new Date(now.getTime() + (actualDuration * 24 * 60 * 60 * 1000));

    // Update user subscription
    await pool.query(`
      UPDATE users 
      SET package_id = $1, 
          subscription_started_at = NOW(),
          subscription_expires_at = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [package_id, newExpires, userId]);

    // Update user settings based on package
    await pool.query(`
      INSERT INTO user_settings (user_id, daily_message_limit, max_broadcast_recipients)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE SET
        daily_message_limit = $2,
        max_broadcast_recipients = $3,
        updated_at = NOW()
    `, [userId, pkg.daily_message_limit, pkg.max_broadcast_recipients]);

    // Record history
    await pool.query(`
      INSERT INTO subscription_history 
      (user_id, package_id, admin_id, action, previous_expires_at, new_expires_at, duration_days, notes)
      VALUES ($1, $2, $3, 'assign', $4, $5, $6, $7)
    `, [userId, package_id, req.user.id, previousExpires, newExpires, actualDuration, notes]);

    res.json({
      message: 'Package assigned successfully',
      expires_at: newExpires,
    });
  } catch (error) {
    console.error('Assign package error:', error);
    res.status(500).json({ error: 'Failed to assign package' });
  }
});

// Extend user subscription
router.post('/users/:userId/extend', authenticate, [
  body('duration_days').isInt({ min: 1 }),
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
    const { duration_days, notes } = req.body;

    // Get current user info
    const userResult = await pool.query(
      'SELECT package_id, subscription_expires_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    if (!user.package_id) {
      return res.status(400).json({ error: 'User has no active package. Assign a package first.' });
    }

    const previousExpires = user.subscription_expires_at;
    const baseDate = previousExpires && new Date(previousExpires) > new Date() 
      ? new Date(previousExpires) 
      : new Date();
    const newExpires = new Date(baseDate.getTime() + (duration_days * 24 * 60 * 60 * 1000));

    // Update user subscription
    await pool.query(`
      UPDATE users 
      SET subscription_expires_at = $1,
          updated_at = NOW()
      WHERE id = $2
    `, [newExpires, userId]);

    // Record history
    await pool.query(`
      INSERT INTO subscription_history 
      (user_id, package_id, admin_id, action, previous_expires_at, new_expires_at, duration_days, notes)
      VALUES ($1, $2, $3, 'extend', $4, $5, $6, $7)
    `, [userId, user.package_id, req.user.id, previousExpires, newExpires, duration_days, notes]);

    res.json({
      message: 'Subscription extended successfully',
      previous_expires_at: previousExpires,
      new_expires_at: newExpires,
      days_added: duration_days,
    });
  } catch (error) {
    console.error('Extend subscription error:', error);
    res.status(500).json({ error: 'Failed to extend subscription' });
  }
});

// Revoke/cancel user subscription
router.post('/users/:userId/revoke', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;
    const { notes } = req.body;

    // Get current user info
    const userResult = await pool.query(
      'SELECT package_id, subscription_expires_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const previousExpires = user.subscription_expires_at;

    // Revoke subscription (set expires to now)
    await pool.query(`
      UPDATE users 
      SET subscription_expires_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `, [userId]);

    // Record history
    await pool.query(`
      INSERT INTO subscription_history 
      (user_id, package_id, admin_id, action, previous_expires_at, new_expires_at, notes)
      VALUES ($1, $2, $3, 'revoke', $4, NOW(), $5)
    `, [userId, user.package_id, req.user.id, previousExpires, notes]);

    res.json({ message: 'Subscription revoked successfully' });
  } catch (error) {
    console.error('Revoke subscription error:', error);
    res.status(500).json({ error: 'Failed to revoke subscription' });
  }
});

// Get subscription history for a user
router.get('/users/:userId/history', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;

    const result = await pool.query(`
      SELECT 
        sh.*,
        sp.name as package_name,
        a.name as admin_name
      FROM subscription_history sh
      LEFT JOIN subscription_packages sp ON sh.package_id = sp.id
      LEFT JOIN users a ON sh.admin_id = a.id
      WHERE sh.user_id = $1
      ORDER BY sh.created_at DESC
    `, [userId]);

    res.json({ history: result.rows });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// Get my subscription (for users)
router.get('/my-subscription', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.package_id, u.subscription_started_at, u.subscription_expires_at,
        sp.name as package_name,
        sp.description as package_description,
        sp.price,
        sp.duration_days,
        sp.max_devices,
        sp.daily_message_limit,
        sp.max_broadcast_recipients,
        sp.features,
        CASE 
          WHEN u.role = 'admin' THEN 'admin'
          WHEN u.subscription_expires_at IS NULL THEN 'no_subscription'
          WHEN u.subscription_expires_at < NOW() THEN 'expired'
          ELSE 'active'
        END as status,
        CASE 
          WHEN u.subscription_expires_at IS NOT NULL THEN
            GREATEST(0, EXTRACT(DAY FROM u.subscription_expires_at - NOW())::INTEGER)
          ELSE 0
        END as days_remaining
      FROM users u
      LEFT JOIN subscription_packages sp ON u.package_id = sp.id
      WHERE u.id = $1
    `, [req.user.id]);

    res.json({ subscription: result.rows[0] });
  } catch (error) {
    console.error('Get my subscription error:', error);
    res.status(500).json({ error: 'Failed to get subscription' });
  }
});

// Dashboard stats (admin)
router.get('/stats', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users WHERE role != 'admin') as total_users,
        (SELECT COUNT(*) FROM users WHERE role != 'admin' AND subscription_expires_at > NOW()) as active_subscriptions,
        (SELECT COUNT(*) FROM users WHERE role != 'admin' AND subscription_expires_at < NOW()) as expired_subscriptions,
        (SELECT COUNT(*) FROM users WHERE role != 'admin' AND subscription_expires_at IS NULL) as no_subscription,
        (SELECT COUNT(*) FROM users WHERE role != 'admin' AND subscription_expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days') as expiring_soon,
        (SELECT COUNT(*) FROM subscription_packages WHERE is_active = true) as active_packages
    `);

    // Package distribution
    const packageStats = await pool.query(`
      SELECT 
        sp.name,
        sp.price,
        COUNT(u.id) as user_count
      FROM subscription_packages sp
      LEFT JOIN users u ON u.package_id = sp.id AND u.role != 'admin'
      WHERE sp.is_active = true
      GROUP BY sp.id, sp.name, sp.price
      ORDER BY sp.price
    `);

    res.json({
      stats: stats.rows[0],
      package_distribution: packageStats.rows,
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

export default router;
