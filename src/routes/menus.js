import { Router } from 'express';
import pool from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get menus for current user (based on role permissions)
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user's role
    const userResult = await pool.query(
      'SELECT role_id, role FROM users WHERE id = $1',
      [userId]
    );
    
    const user = userResult.rows[0];
    
    // If user is admin (either by role column or by role_id), get all menus with full permissions
    if (user.role === 'admin') {
      const menusResult = await pool.query(`
        SELECT m.*
        FROM menus m
        WHERE m.is_active = true
        ORDER BY m.sort_order, m.name
      `);
      
      const menus = buildMenuTree(menusResult.rows.map(m => ({
        ...m,
        can_view: true,
        can_create: true,
        can_edit: true,
        can_delete: true
      })));
      
      return res.json({ menus });
    }
    
    if (!user.role_id) {
      return res.json({ menus: [] });
    }
    
    // Get menus with permissions for user's role
    const menusResult = await pool.query(`
      SELECT 
        m.*,
        rp.can_view,
        rp.can_create,
        rp.can_edit,
        rp.can_delete
      FROM menus m
      INNER JOIN role_permissions rp ON m.id = rp.menu_id
      WHERE rp.role_id = $1 
        AND rp.can_view = true 
        AND m.is_active = true
      ORDER BY m.sort_order, m.name
    `, [user.role_id]);
    
    const menus = buildMenuTree(menusResult.rows);
    
    res.json({ menus });
  } catch (error) {
    console.error('Get menus error:', error);
    res.status(500).json({ error: 'Failed to get menus' });
  }
});

// Get all menus (admin only)
router.get('/all', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const result = await pool.query(`
      SELECT m.*, 
        (SELECT COUNT(*) FROM menus WHERE parent_id = m.id) as children_count
      FROM menus m
      ORDER BY m.parent_id NULLS FIRST, m.sort_order, m.name
    `);
    
    res.json({ menus: result.rows });
  } catch (error) {
    console.error('Get all menus error:', error);
    res.status(500).json({ error: 'Failed to get menus' });
  }
});

// Create menu (admin only)
router.post('/', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { name, slug, icon, href, parent_id, sort_order, is_active, is_group } = req.body;
    
    const result = await pool.query(`
      INSERT INTO menus (name, slug, icon, href, parent_id, sort_order, is_active, is_group)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [name, slug, icon, href, parent_id || null, sort_order || 0, is_active !== false, is_group || false]);
    
    res.status(201).json({ menu: result.rows[0] });
  } catch (error) {
    console.error('Create menu error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Menu slug already exists' });
    }
    res.status(500).json({ error: 'Failed to create menu' });
  }
});

// Update menu (admin only)
router.put('/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { name, slug, icon, href, parent_id, sort_order, is_active, is_group } = req.body;
    
    const result = await pool.query(`
      UPDATE menus 
      SET name = $1, slug = $2, icon = $3, href = $4, parent_id = $5, 
          sort_order = $6, is_active = $7, is_group = $8, updated_at = NOW()
      WHERE id = $9
      RETURNING *
    `, [name, slug, icon, href, parent_id || null, sort_order || 0, is_active, is_group, req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Menu not found' });
    }
    
    res.json({ menu: result.rows[0] });
  } catch (error) {
    console.error('Update menu error:', error);
    res.status(500).json({ error: 'Failed to update menu' });
  }
});

// Delete menu (admin only)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const result = await pool.query(
      'DELETE FROM menus WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Menu not found' });
    }
    
    res.json({ message: 'Menu deleted' });
  } catch (error) {
    console.error('Delete menu error:', error);
    res.status(500).json({ error: 'Failed to delete menu' });
  }
});

// Get all roles
router.get('/roles', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const result = await pool.query(`
      SELECT r.*, 
        (SELECT COUNT(*) FROM users WHERE role_id = r.id) as users_count
      FROM roles r
      WHERE r.is_active = true
      ORDER BY r.name
    `);
    
    res.json({ roles: result.rows });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ error: 'Failed to get roles' });
  }
});

// Create role
router.post('/roles', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { name, description } = req.body;
    
    const result = await pool.query(`
      INSERT INTO roles (name, description)
      VALUES ($1, $2)
      RETURNING *
    `, [name, description]);
    
    res.status(201).json({ role: result.rows[0] });
  } catch (error) {
    console.error('Create role error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Role name already exists' });
    }
    res.status(500).json({ error: 'Failed to create role' });
  }
});

// Update role
router.put('/roles/:roleId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { name, description } = req.body;
    const roleId = req.params.roleId;
    
    const result = await pool.query(`
      UPDATE roles SET name = $1, description = $2
      WHERE id = $3
      RETURNING *
    `, [name, description, roleId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }
    
    res.json({ role: result.rows[0] });
  } catch (error) {
    console.error('Update role error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Role name already exists' });
    }
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// Delete role
router.delete('/roles/:roleId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const roleId = req.params.roleId;
    
    // Check if role is 'admin' - cannot delete
    const roleCheck = await pool.query('SELECT name FROM roles WHERE id = $1', [roleId]);
    if (roleCheck.rows[0]?.name === 'admin') {
      return res.status(400).json({ error: 'Cannot delete admin role' });
    }
    
    // Check if any users are using this role
    const usersCheck = await pool.query('SELECT COUNT(*) FROM users WHERE role_id = $1', [roleId]);
    if (parseInt(usersCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete role that has users assigned' });
    }
    
    const result = await pool.query('DELETE FROM roles WHERE id = $1 RETURNING *', [roleId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }
    
    res.json({ message: 'Role deleted' });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ error: 'Failed to delete role' });
  }
});

// Get role permissions
router.get('/roles/:roleId/permissions', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const result = await pool.query(`
      SELECT 
        m.id as menu_id,
        m.name as menu_name,
        m.slug,
        m.parent_id,
        m.is_group,
        COALESCE(rp.can_view, false) as can_view,
        COALESCE(rp.can_create, false) as can_create,
        COALESCE(rp.can_edit, false) as can_edit,
        COALESCE(rp.can_delete, false) as can_delete
      FROM menus m
      LEFT JOIN role_permissions rp ON m.id = rp.menu_id AND rp.role_id = $1
      WHERE m.is_active = true
      ORDER BY m.sort_order, m.name
    `, [req.params.roleId]);
    
    res.json({ permissions: result.rows });
  } catch (error) {
    console.error('Get role permissions error:', error);
    res.status(500).json({ error: 'Failed to get permissions' });
  }
});

// Update role permissions
router.put('/roles/:roleId/permissions', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { permissions } = req.body; // Array of { menu_id, can_view, can_create, can_edit, can_delete }
    const roleId = req.params.roleId;
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Delete existing permissions for this role
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      
      // Insert new permissions
      for (const perm of permissions) {
        if (perm.can_view) {
          await client.query(`
            INSERT INTO role_permissions (role_id, menu_id, can_view, can_create, can_edit, can_delete)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [roleId, perm.menu_id, perm.can_view, perm.can_create, perm.can_edit, perm.can_delete]);
        }
      }
      
      await client.query('COMMIT');
      res.json({ message: 'Permissions updated' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Update permissions error:', error);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
});

// Helper function to build menu tree
function buildMenuTree(flatMenus) {
  const menuMap = new Map();
  const rootMenus = [];
  
  // First pass: create map of all menus
  flatMenus.forEach(menu => {
    menuMap.set(menu.id, { ...menu, children: [] });
  });
  
  // Second pass: build tree
  flatMenus.forEach(menu => {
    const menuItem = menuMap.get(menu.id);
    if (menu.parent_id && menuMap.has(menu.parent_id)) {
      menuMap.get(menu.parent_id).children.push(menuItem);
    } else if (!menu.parent_id) {
      rootMenus.push(menuItem);
    }
  });
  
  // Sort children
  rootMenus.forEach(menu => {
    menu.children.sort((a, b) => a.sort_order - b.sort_order);
  });
  
  return rootMenus.sort((a, b) => a.sort_order - b.sort_order);
}

export default router;
