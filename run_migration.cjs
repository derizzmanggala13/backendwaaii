const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'whatsapp_gateway',
  user: 'postgres',
  password: '123456'
});

async function run() {
  const client = await pool.connect();
  try {
    // Create menus table
    await client.query(`
      CREATE TABLE IF NOT EXISTS menus (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
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
    console.log('✅ Created menus table');

    // Create roles table
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Created roles table');

    // Create role_permissions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id SERIAL PRIMARY KEY,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
        can_view BOOLEAN DEFAULT false,
        can_create BOOLEAN DEFAULT false,
        can_edit BOOLEAN DEFAULT false,
        can_delete BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(role_id, menu_id)
      )
    `);
    console.log('✅ Created role_permissions table');

    // Add role_id to users table
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'role_id'
    `);
    if (colCheck.rows.length === 0) {
      await client.query('ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id)');
      console.log('✅ Added role_id to users table');
    } else {
      console.log('⏭️ role_id column already exists');
    }

    // Insert default roles
    await client.query(`
      INSERT INTO roles (name, description) VALUES
        ('admin', 'Full access to all features'),
        ('manager', 'Access to most features except admin'),
        ('operator', 'Access to messaging and POS'),
        ('viewer', 'View only access')
      ON CONFLICT (name) DO NOTHING
    `);
    console.log('✅ Inserted default roles');

    // Insert default menus
    await client.query(`
      INSERT INTO menus (name, slug, icon, href, parent_id, sort_order, is_active, is_group) VALUES
        ('Dashboard', 'dashboard', 'HomeIcon', '/dashboard', NULL, 1, true, false),
        ('Devices', 'devices', 'DevicePhoneMobileIcon', '/devices', NULL, 2, true, false),
        ('Messaging', 'messaging', 'ChatBubbleLeftRightIcon', NULL, NULL, 3, true, true),
        ('Contacts', 'contacts', 'UserGroupIcon', NULL, NULL, 4, true, true),
        ('POS', 'pos', 'ShoppingCartIcon', NULL, NULL, 5, true, true),
        ('Settings', 'settings', 'Cog6ToothIcon', NULL, NULL, 6, true, true),
        ('Admin', 'admin', 'ShieldCheckIcon', NULL, NULL, 7, true, true)
      ON CONFLICT (slug) DO NOTHING
    `);
    console.log('✅ Inserted parent menus');

    // Get parent IDs
    const parents = await client.query('SELECT id, slug FROM menus WHERE parent_id IS NULL');
    const parentMap = {};
    parents.rows.forEach(r => parentMap[r.slug] = r.id);

    // Insert child menus
    const childMenus = [
      ['Send Message', 'send-message', 'ChatBubbleLeftRightIcon', '/messages', parentMap['messaging'], 1],
      ['Broadcast', 'broadcast', 'MegaphoneIcon', '/broadcast', parentMap['messaging'], 2],
      ['Auto Reply', 'auto-reply', 'ArrowPathIcon', '/auto-replies', parentMap['messaging'], 3],
      ['Templates', 'templates', 'DocumentTextIcon', '/templates', parentMap['messaging'], 4],
      ['Message History', 'history', 'ClockIcon', '/history', parentMap['messaging'], 5],
      ['Contact List', 'contact-list', 'UsersIcon', '/contacts', parentMap['contacts'], 1],
      ['Contact Groups', 'contact-groups', 'FolderIcon', '/contact-groups', parentMap['contacts'], 2],
      ['Products', 'products', 'CubeIcon', '/pos/products', parentMap['pos'], 1],
      ['Cashier', 'cashier', 'CreditCardIcon', '/pos/cashier', parentMap['pos'], 2],
      ['Transactions', 'transactions', 'ReceiptPercentIcon', '/pos/transactions', parentMap['pos'], 3],
      ['Store Settings', 'store-settings', 'BuildingStorefrontIcon', '/pos/settings', parentMap['pos'], 4],
      ['API Keys', 'api-keys', 'KeyIcon', '/api-keys', parentMap['settings'], 1],
      ['Subscriptions', 'subscriptions', 'CreditCardIcon', '/subscriptions', parentMap['settings'], 2],
      ['General', 'general-settings', 'Cog6ToothIcon', '/settings', parentMap['settings'], 3],
      ['User Management', 'user-management', 'UsersIcon', '/users', parentMap['admin'], 1],
      ['Menu Management', 'menu-management', 'Bars3Icon', '/admin/menus', parentMap['admin'], 2],
      ['Role Permissions', 'role-permissions', 'ShieldCheckIcon', '/admin/permissions', parentMap['admin'], 3]
    ];

    for (const m of childMenus) {
      await client.query(`
        INSERT INTO menus (name, slug, icon, href, parent_id, sort_order, is_active, is_group) 
        VALUES ($1, $2, $3, $4, $5, $6, true, false)
        ON CONFLICT (slug) DO NOTHING
      `, [m[0], m[1], m[2], m[3], m[4], m[5]]);
    }
    console.log('✅ Inserted child menus');

    // Get all menus and roles for permissions
    const allMenus = await client.query('SELECT id FROM menus');
    const allRoles = await client.query('SELECT id, name FROM roles');
    
    // Set permissions for admin - full access
    const adminRole = allRoles.rows.find(r => r.name === 'admin');
    for (const menu of allMenus.rows) {
      await client.query(`
        INSERT INTO role_permissions (role_id, menu_id, can_view, can_create, can_edit, can_delete)
        VALUES ($1, $2, true, true, true, true)
        ON CONFLICT (role_id, menu_id) DO NOTHING
      `, [adminRole.id, menu.id]);
    }
    console.log('✅ Set admin permissions');

    // Set default role for existing admin users
    await client.query('UPDATE users SET role_id = $1 WHERE role_id IS NULL', [adminRole.id]);
    console.log('✅ Updated existing users with admin role');

    console.log('\n🎉 Migration completed successfully!');
  } finally {
    client.release();
    pool.end();
  }
}

run().catch(console.error);
