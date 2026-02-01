import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get all contact groups for user
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cg.*, 
        (SELECT COUNT(*) FROM contact_group_members WHERE group_id = cg.id) as member_count
      FROM contact_groups cg 
      WHERE user_id = $1 
      ORDER BY name ASC
    `, [req.user.id]);
    
    res.json({ groups: result.rows });
  } catch (error) {
    console.error('Get contact groups error:', error);
    res.status(500).json({ error: 'Failed to get contact groups' });
  }
});

// Create contact group
router.post('/', authenticate, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('color').optional().isString(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, description, color } = req.body;

    const result = await pool.query(`
      INSERT INTO contact_groups (user_id, name, description, color)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.user.id, name, description || null, color || '#25D366']);

    res.status(201).json({
      message: 'Contact group created',
      group: result.rows[0],
    });
  } catch (error) {
    console.error('Create contact group error:', error);
    res.status(500).json({ error: 'Failed to create contact group' });
  }
});

// Get single contact group with members
router.get('/:groupId', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;

    const groupResult = await pool.query(
      'SELECT * FROM contact_groups WHERE id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contact group not found' });
    }

    const membersResult = await pool.query(
      'SELECT * FROM contact_group_members WHERE group_id = $1 ORDER BY name ASC, phone_number ASC',
      [groupId]
    );

    res.json({
      group: groupResult.rows[0],
      members: membersResult.rows,
    });
  } catch (error) {
    console.error('Get contact group error:', error);
    res.status(500).json({ error: 'Failed to get contact group' });
  }
});

// Update contact group
router.put('/:groupId', authenticate, [
  body('name').optional().trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('color').optional().isString(),
], async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name, description, color } = req.body;

    // Check ownership
    const checkResult = await pool.query(
      'SELECT * FROM contact_groups WHERE id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contact group not found' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (color) {
      updates.push(`color = $${paramCount++}`);
      values.push(color);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');
    values.push(groupId);

    const result = await pool.query(
      `UPDATE contact_groups SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json({
      message: 'Contact group updated',
      group: result.rows[0],
    });
  } catch (error) {
    console.error('Update contact group error:', error);
    res.status(500).json({ error: 'Failed to update contact group' });
  }
});

// Delete contact group
router.delete('/:groupId', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;

    const result = await pool.query(
      'DELETE FROM contact_groups WHERE id = $1 AND user_id = $2 RETURNING *',
      [groupId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact group not found' });
    }

    res.json({ message: 'Contact group deleted' });
  } catch (error) {
    console.error('Delete contact group error:', error);
    res.status(500).json({ error: 'Failed to delete contact group' });
  }
});

// Add member to group
router.post('/:groupId/members', authenticate, [
  body('phoneNumber').notEmpty(),
  body('name').optional().trim(),
], async (req, res) => {
  try {
    const { groupId } = req.params;
    const { phoneNumber, name } = req.body;

    // Check ownership
    const checkResult = await pool.query(
      'SELECT * FROM contact_groups WHERE id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contact group not found' });
    }

    // Clean phone number
    const cleanNumber = phoneNumber.replace(/\D/g, '');

    const result = await pool.query(`
      INSERT INTO contact_group_members (group_id, phone_number, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (group_id, phone_number) DO UPDATE SET name = $3
      RETURNING *
    `, [groupId, cleanNumber, name || null]);

    res.status(201).json({
      message: 'Member added',
      member: result.rows[0],
    });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// Add multiple members to group
router.post('/:groupId/members/bulk', authenticate, [
  body('members').isArray({ min: 1 }),
], async (req, res) => {
  try {
    const { groupId } = req.params;
    const { members } = req.body;

    // Check ownership
    const checkResult = await pool.query(
      'SELECT * FROM contact_groups WHERE id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contact group not found' });
    }

    const added = [];
    for (const member of members) {
      const cleanNumber = member.phoneNumber?.replace(/\D/g, '') || member.phone_number?.replace(/\D/g, '');
      if (cleanNumber) {
        try {
          const result = await pool.query(`
            INSERT INTO contact_group_members (group_id, phone_number, name)
            VALUES ($1, $2, $3)
            ON CONFLICT (group_id, phone_number) DO UPDATE SET name = $3
            RETURNING *
          `, [groupId, cleanNumber, member.name || null]);
          added.push(result.rows[0]);
        } catch (e) {
          console.error('Error adding member:', e);
        }
      }
    }

    res.json({
      message: `${added.length} members added`,
      members: added,
    });
  } catch (error) {
    console.error('Bulk add members error:', error);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove member from group
router.delete('/:groupId/members/:memberId', authenticate, async (req, res) => {
  try {
    const { groupId, memberId } = req.params;

    // Check ownership
    const checkResult = await pool.query(
      'SELECT * FROM contact_groups WHERE id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contact group not found' });
    }

    await pool.query(
      'DELETE FROM contact_group_members WHERE id = $1 AND group_id = $2',
      [memberId, groupId]
    );

    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

export default router;
