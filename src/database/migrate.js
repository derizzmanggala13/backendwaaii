import pool from './connection.js';

const migrate = async () => {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Starting database migration...');
    
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'user',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Users table created');
    
    // WhatsApp devices/sessions
    await client.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        device_name VARCHAR(255) NOT NULL,
        phone_number VARCHAR(50),
        status VARCHAR(50) DEFAULT 'disconnected',
        session_data TEXT,
        qr_code TEXT,
        last_seen TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Devices table created');
    
    // Contacts
    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        wa_id VARCHAR(100) NOT NULL,
        name VARCHAR(255),
        phone_number VARCHAR(50),
        profile_pic_url TEXT,
        is_business BOOLEAN DEFAULT false,
        is_group BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(device_id, wa_id)
      );
    `);
    console.log('✅ Contacts table created');
    
    // Messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        message_id VARCHAR(255) NOT NULL,
        chat_id VARCHAR(255) NOT NULL,
        from_number VARCHAR(100),
        to_number VARCHAR(100),
        body TEXT,
        type VARCHAR(50) DEFAULT 'chat',
        media_url TEXT,
        media_mime_type VARCHAR(100),
        is_from_me BOOLEAN DEFAULT false,
        is_forwarded BOOLEAN DEFAULT false,
        timestamp TIMESTAMP,
        status VARCHAR(50) DEFAULT 'pending',
        ack INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(device_id, message_id)
      );
    `);
    console.log('✅ Messages table created');
    
    // Scheduled messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id SERIAL PRIMARY KEY,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        to_number VARCHAR(100) NOT NULL,
        body TEXT NOT NULL,
        media_url TEXT,
        media_type VARCHAR(50),
        scheduled_at TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        sent_at TIMESTAMP,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Scheduled messages table created');
    
    // Broadcast lists
    await client.query(`
      CREATE TABLE IF NOT EXISTS broadcasts (
        id SERIAL PRIMARY KEY,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Broadcasts table created');
    
    // Broadcast recipients
    await client.query(`
      CREATE TABLE IF NOT EXISTS broadcast_recipients (
        id SERIAL PRIMARY KEY,
        broadcast_id INTEGER REFERENCES broadcasts(id) ON DELETE CASCADE,
        phone_number VARCHAR(50) NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Broadcast recipients table created');
    
    // Auto replies
    await client.query(`
      CREATE TABLE IF NOT EXISTS auto_replies (
        id SERIAL PRIMARY KEY,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        trigger_keyword VARCHAR(255) NOT NULL,
        match_type VARCHAR(50) DEFAULT 'contains',
        reply_message TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Auto replies table created');
    
    // Message templates
    await client.query(`
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        category VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Templates table created');
    
    // API Keys for external integrations
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        api_key VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        last_used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ API Keys table created');
    
    // Activity logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
        action VARCHAR(255) NOT NULL,
        details JSONB,
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Activity logs table created');
    
    // Contact Groups
    await client.query(`
      CREATE TABLE IF NOT EXISTS contact_groups (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        color VARCHAR(20) DEFAULT '#25D366',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Contact groups table created');
    
    // Contact Group Members
    await client.query(`
      CREATE TABLE IF NOT EXISTS contact_group_members (
        id SERIAL PRIMARY KEY,
        group_id INTEGER REFERENCES contact_groups(id) ON DELETE CASCADE,
        phone_number VARCHAR(50) NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, phone_number)
      );
    `);
    console.log('✅ Contact group members table created');
    
    // User Settings (for rate limiting etc)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        daily_message_limit INTEGER DEFAULT 200,
        message_delay_seconds INTEGER DEFAULT 3,
        broadcast_delay_seconds INTEGER DEFAULT 5,
        auto_reply_delay_seconds INTEGER DEFAULT 2,
        max_broadcast_recipients INTEGER DEFAULT 100,
        enable_rate_limiting BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ User settings table created');
    
    // Daily Usage Tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_usage (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        messages_sent INTEGER DEFAULT 0,
        broadcasts_sent INTEGER DEFAULT 0,
        auto_replies_sent INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, device_id, date)
      );
    `);
    console.log('✅ Daily usage table created');
    
    // Subscription Packages
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_packages (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        price DECIMAL(12,2) DEFAULT 0,
        duration_days INTEGER DEFAULT 30,
        max_devices INTEGER DEFAULT 1,
        daily_message_limit INTEGER DEFAULT 200,
        max_broadcast_recipients INTEGER DEFAULT 100,
        features JSONB DEFAULT '[]',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Subscription packages table created');
    
    // Add subscription fields to users if not exists
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'package_id') THEN
          ALTER TABLE users ADD COLUMN package_id INTEGER REFERENCES subscription_packages(id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'subscription_expires_at') THEN
          ALTER TABLE users ADD COLUMN subscription_expires_at TIMESTAMP;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'subscription_started_at') THEN
          ALTER TABLE users ADD COLUMN subscription_started_at TIMESTAMP;
        END IF;
      END $$;
    `);
    console.log('✅ User subscription fields added');
    
    // Subscription History
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        package_id INTEGER REFERENCES subscription_packages(id),
        admin_id INTEGER REFERENCES users(id),
        action VARCHAR(50) NOT NULL,
        previous_expires_at TIMESTAMP,
        new_expires_at TIMESTAMP,
        duration_days INTEGER,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Subscription history table created');
    
    // AI Auto Reply Settings per Device
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id SERIAL PRIMARY KEY,
        device_id INTEGER UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
        is_enabled BOOLEAN DEFAULT false,
        ai_provider VARCHAR(50) DEFAULT 'gemini',
        api_key TEXT,
        model VARCHAR(100) DEFAULT 'gemini-2.0-flash',
        system_prompt TEXT DEFAULT 'Kamu adalah asisten virtual yang ramah dan membantu. Jawab pertanyaan dengan singkat, jelas, dan sopan dalam bahasa Indonesia.',
        max_tokens INTEGER DEFAULT 500,
        temperature NUMERIC(3,2) DEFAULT 0.7,
        reply_delay_seconds INTEGER DEFAULT 2,
        ignore_groups BOOLEAN DEFAULT true,
        only_when_contains TEXT,
        excluded_contacts TEXT,
        welcome_message TEXT,
        fallback_message TEXT DEFAULT 'Maaf, saya tidak bisa memproses permintaan Anda saat ini. Silakan coba lagi nanti.',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ AI settings table created');

    // AI Conversation History for context
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id SERIAL PRIMARY KEY,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        chat_id VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ AI conversations table created');

    // Insert default packages if not exists
    await client.query(`
      INSERT INTO subscription_packages (name, description, price, duration_days, max_devices, daily_message_limit, max_broadcast_recipients, features)
      SELECT 'Free Trial', 'Paket percobaan gratis 7 hari', 0, 7, 1, 50, 20, '["Basic messaging", "1 Device"]'
      WHERE NOT EXISTS (SELECT 1 FROM subscription_packages WHERE name = 'Free Trial');
      
      INSERT INTO subscription_packages (name, description, price, duration_days, max_devices, daily_message_limit, max_broadcast_recipients, features)
      SELECT 'Basic', 'Paket dasar untuk penggunaan personal', 99000, 30, 2, 200, 50, '["200 messages/day", "2 Devices", "Auto Reply"]'
      WHERE NOT EXISTS (SELECT 1 FROM subscription_packages WHERE name = 'Basic');
      
      INSERT INTO subscription_packages (name, description, price, duration_days, max_devices, daily_message_limit, max_broadcast_recipients, features)
      SELECT 'Professional', 'Paket untuk bisnis kecil menengah', 299000, 30, 5, 1000, 200, '["1000 messages/day", "5 Devices", "Auto Reply", "Broadcast", "Templates"]'
      WHERE NOT EXISTS (SELECT 1 FROM subscription_packages WHERE name = 'Professional');
      
      INSERT INTO subscription_packages (name, description, price, duration_days, max_devices, daily_message_limit, max_broadcast_recipients, features)
      SELECT 'Enterprise', 'Paket enterprise tanpa batas', 999000, 30, 999, 10000, 1000, '["Unlimited messages", "Unlimited Devices", "Priority Support", "API Access", "All Features"]'
      WHERE NOT EXISTS (SELECT 1 FROM subscription_packages WHERE name = 'Enterprise');
    `);
    console.log('✅ Default packages inserted');
    
    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_device_id ON messages(device_id);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_contacts_device_id ON contacts(device_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_scheduled_at ON scheduled_messages(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_auto_replies_trigger ON auto_replies(trigger_keyword);
      CREATE INDEX IF NOT EXISTS idx_subscription_history_user ON subscription_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_users_package ON users(package_id);
      CREATE INDEX IF NOT EXISTS idx_users_expires ON users(subscription_expires_at);
    `);
    console.log('✅ Indexes created');
    
    console.log('🎉 Database migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();
