import pool from '../connection.js';

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create menus table
    await client.query(`
      CREATE TABLE IF NOT EXISTS menus (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        icon VARCHAR(100),
        href VARCHAR(255),
        parent_id INTEGER REFERENCES menus(id) ON DELETE CASCADE,
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        is_group BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create roles table
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        description VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create role_permissions table (role to menu access)
    await client.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id SERIAL PRIMARY KEY,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
        can_view BOOLEAN DEFAULT true,
        can_create BOOLEAN DEFAULT false,
        can_edit BOOLEAN DEFAULT false,
        can_delete BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(role_id, menu_id)
      )
    `);

    // Add role_id to users table if not exists
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'users' AND column_name = 'role_id') THEN
          ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id);
        END IF;
      END $$;
    `);

    // Insert default roles
    await client.query(`
      INSERT INTO roles (name, description) VALUES
        ('admin', 'Administrator dengan akses penuh'),
        ('manager', 'Manager dengan akses terbatas'),
        ('operator', 'Operator kasir dan messaging'),
        ('viewer', 'Hanya dapat melihat data')
      ON CONFLICT (name) DO NOTHING
    `);

    // Insert default menus
    await client.query(`
      INSERT INTO menus (name, slug, icon, href, parent_id, sort_order, is_group) VALUES
        -- Main menus
        ('Dashboard', 'dashboard', 'HomeIcon', '/dashboard', NULL, 1, false),
        ('Devices', 'devices', 'DevicePhoneMobileIcon', '/devices', NULL, 2, false),
        
        -- Messaging group
        ('Messaging', 'messaging', 'ChatBubbleLeftRightIcon', NULL, NULL, 3, true),
        ('Send Message', 'send-message', 'ChatBubbleLeftRightIcon', '/messages', 3, 1, false),
        ('Broadcast', 'broadcast', 'MegaphoneIcon', '/broadcast', 3, 2, false),
        ('Auto Replies', 'auto-replies', 'ArrowPathIcon', '/auto-replies', 3, 3, false),
        ('Templates', 'templates', 'DocumentTextIcon', '/templates', 3, 4, false),
        ('History', 'history', 'ClockIcon', '/history', 3, 5, false),
        
        -- Contacts group
        ('Contacts', 'contacts-group', 'UserGroupIcon', NULL, NULL, 4, true),
        ('Contacts', 'contacts', 'UserGroupIcon', '/contacts', 9, 1, false),
        ('Contact Groups', 'contact-groups', 'FolderIcon', '/contact-groups', 9, 2, false),
        
        -- POS group
        ('Point of Sale', 'pos', 'ShoppingCartIcon', NULL, NULL, 5, true),
        ('Kasir', 'kasir', 'ShoppingCartIcon', '/pos/cashier', 12, 1, false),
        ('Produk', 'produk', 'CubeIcon', '/pos/products', 12, 2, false),
        ('Transaksi', 'transaksi', 'ReceiptPercentIcon', '/pos/transactions', 12, 3, false),
        ('Pengaturan Toko', 'store-settings', 'BuildingStorefrontIcon', '/pos/settings', 12, 4, false),
        
        -- Settings group
        ('Settings', 'settings-group', 'Cog6ToothIcon', NULL, NULL, 6, true),
        ('API Keys', 'api-keys', 'KeyIcon', '/api-keys', 17, 1, false),
        ('Settings', 'settings', 'Cog6ToothIcon', '/settings', 17, 2, false),
        
        -- Admin group
        ('Admin', 'admin', 'UsersIcon', NULL, NULL, 7, true),
        ('User Management', 'user-management', 'UsersIcon', '/users', 20, 1, false),
        ('Subscriptions', 'subscriptions', 'CreditCardIcon', '/subscriptions', 20, 2, false),
        ('Menu Management', 'menu-management', 'Bars3Icon', '/admin/menus', 20, 3, false),
        ('Role Permissions', 'role-permissions', 'ShieldCheckIcon', '/admin/permissions', 20, 4, false)
      ON CONFLICT (slug) DO NOTHING
    `);

    // Assign all permissions to admin role
    await client.query(`
      INSERT INTO role_permissions (role_id, menu_id, can_view, can_create, can_edit, can_delete)
      SELECT 
        (SELECT id FROM roles WHERE name = 'admin'),
        m.id,
        true, true, true, true
      FROM menus m
      ON CONFLICT (role_id, menu_id) DO NOTHING
    `);

    // Assign manager permissions (no admin menus)
    await client.query(`
      INSERT INTO role_permissions (role_id, menu_id, can_view, can_create, can_edit, can_delete)
      SELECT 
        (SELECT id FROM roles WHERE name = 'manager'),
        m.id,
        true, true, true, false
      FROM menus m
      WHERE m.slug NOT IN ('admin', 'user-management', 'subscriptions', 'menu-management', 'role-permissions')
      ON CONFLICT (role_id, menu_id) DO NOTHING
    `);

    -- Assign operator permissions (messaging, POS, contacts only)
    await client.query(`
      INSERT INTO role_permissions (role_id, menu_id, can_view, can_create, can_edit, can_delete)
      SELECT 
        (SELECT id FROM roles WHERE name = 'operator'),
        m.id,
        true, true, true, false
      FROM menus m
      WHERE m.slug IN (
        'dashboard', 'devices', 
        'messaging', 'send-message', 'broadcast', 'auto-replies', 'templates', 'history',
        'contacts-group', 'contacts', 'contact-groups',
        'pos', 'kasir', 'produk', 'transaksi', 'store-settings'
      )
      ON CONFLICT (role_id, menu_id) DO NOTHING
    `);

    -- Assign viewer permissions (view only)
    await client.query(`
      INSERT INTO role_permissions (role_id, menu_id, can_view, can_create, can_edit, can_delete)
      SELECT 
        (SELECT id FROM roles WHERE name = 'viewer'),
        m.id,
        true, false, false, false
      FROM menus m
      WHERE m.slug IN (
        'dashboard', 'history', 'transaksi'
      )
      ON CONFLICT (role_id, menu_id) DO NOTHING
    `);

    -- Update existing admin users to have admin role
    await client.query(`
      UPDATE users 
      SET role_id = (SELECT id FROM roles WHERE name = 'admin')
      WHERE role = 'admin' AND role_id IS NULL
    `);

    -- Update existing non-admin users to have operator role
    await client.query(`
      UPDATE users 
      SET role_id = (SELECT id FROM roles WHERE name = 'operator')
      WHERE role != 'admin' AND role_id IS NULL
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 008_menus_permissions completed');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 008_menus_permissions failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

export async function down() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS role_id');
    await client.query('DROP TABLE IF EXISTS role_permissions');
    await client.query('DROP TABLE IF EXISTS menus');
    await client.query('DROP TABLE IF EXISTS roles');
    await client.query('COMMIT');
    console.log('✅ Rollback 008_menus_permissions completed');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
