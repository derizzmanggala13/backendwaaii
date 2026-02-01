import bcrypt from 'bcryptjs';
import pool from './connection.js';

const seed = async () => {
  const client = await pool.connect();
  
  try {
    console.log('🌱 Starting database seeding...');
    
    // Create admin user
    const hashedPassword = await bcrypt.hash('admin123', 10);
    
    const result = await client.query(`
      INSERT INTO users (email, password, name, role)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `, ['admin@example.com', hashedPassword, 'Administrator', 'admin']);
    
    if (result.rows.length > 0) {
      console.log('✅ Admin user created');
      console.log('   Email: admin@example.com');
      console.log('   Password: admin123');
    } else {
      console.log('ℹ️  Admin user already exists');
    }
    
    // Create sample templates
    const templates = [
      { name: 'Greeting', body: 'Halo {name}! Terima kasih telah menghubungi kami. Ada yang bisa kami bantu?', category: 'greeting' },
      { name: 'Thank You', body: 'Terima kasih atas pesanan Anda, {name}. Pesanan Anda sedang diproses.', category: 'order' },
      { name: 'Follow Up', body: 'Halo {name}, bagaimana kabar Anda? Apakah ada yang bisa kami bantu lebih lanjut?', category: 'follow-up' },
    ];
    
    for (const template of templates) {
      await client.query(`
        INSERT INTO templates (user_id, name, body, category)
        SELECT id, $2, $3, $4 FROM users WHERE email = $1
        ON CONFLICT DO NOTHING
      `, ['admin@example.com', template.name, template.body, template.category]);
    }
    
    console.log('✅ Sample templates created');
    console.log('🎉 Database seeding completed!');
    
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

seed();
