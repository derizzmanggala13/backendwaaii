import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get all templates for user
router.get('/', authenticate, async (req, res) => {
  try {
    const { category } = req.query;

    let query = 'SELECT * FROM templates WHERE user_id = $1';
    const params = [req.user.id];

    if (category) {
      query += ' AND category = $2';
      params.push(category);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json({ templates: result.rows });
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'Failed to get templates' });
  }
});

// Create template
router.post('/', authenticate, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('body').trim().isLength({ min: 1 }),
  body('category').optional().trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, body: templateBody, category } = req.body;

    const result = await pool.query(`
      INSERT INTO templates (user_id, name, body, category)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.user.id, name, templateBody, category]);

    res.status(201).json({
      message: 'Template created',
      template: result.rows[0],
    });
  } catch (error) {
    console.error('Create template error:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// Update template
router.put('/:templateId', authenticate, [
  body('name').optional().trim().isLength({ min: 1, max: 255 }),
  body('body').optional().trim().isLength({ min: 1 }),
  body('category').optional().trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { templateId } = req.params;
    const { name, body: templateBody, category } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (templateBody) {
      updates.push(`body = $${paramCount++}`);
      values.push(templateBody);
    }
    if (category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(category);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push('updated_at = NOW()');
    values.push(templateId, req.user.id);

    const result = await pool.query(
      `UPDATE templates SET ${updates.join(', ')} WHERE id = $${paramCount} AND user_id = $${paramCount + 1} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({
      message: 'Template updated',
      template: result.rows[0],
    });
  } catch (error) {
    console.error('Update template error:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// Delete template
router.delete('/:templateId', authenticate, async (req, res) => {
  try {
    const { templateId } = req.params;

    const result = await pool.query(
      'DELETE FROM templates WHERE id = $1 AND user_id = $2 RETURNING *',
      [templateId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({ message: 'Template deleted' });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// Get template categories
router.get('/categories', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT category FROM templates WHERE user_id = $1 AND category IS NOT NULL ORDER BY category',
      [req.user.id]
    );

    res.json({ categories: result.rows.map(r => r.category) });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to get categories' });
  }
});

export default router;
