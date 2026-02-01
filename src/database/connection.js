import pg from 'pg';
import config from '../config/index.js';

const { Pool } = pg;

// Support both connectionString (Railway) and individual params
const pool = new Pool(config.database);

pool.on('connect', () => {
  console.log('📦 Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export default pool;
