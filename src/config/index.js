import dotenv from 'dotenv';
dotenv.config();

// Support Railway DATABASE_URL format
const getDatabaseConfig = () => {
  // Railway provides DATABASE_URL
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    };
  }
  
  // Fallback to individual env vars
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'whatsapp_gateway',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  };
};

export default {
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  database: getDatabaseConfig(),
  
  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret-change-this',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  
  whatsapp: {
    sessionPath: process.env.WHATSAPP_SESSION_PATH || './sessions',
    puppeteerHeadless: process.env.PUPPETEER_HEADLESS !== 'false', // Default true in production
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
  },
  
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
};
