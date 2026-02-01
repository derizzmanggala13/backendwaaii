import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

import config from './config/index.js';
import pool from './database/connection.js';
import WhatsAppManager from './services/WhatsAppManager.js';
import SchedulerService from './services/SchedulerService.js';

// Routes
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import messageRoutes from './routes/messages.js';
import autoReplyRoutes from './routes/autoReplies.js';
import apiKeyRoutes from './routes/apiKeys.js';
import templateRoutes from './routes/templates.js';
import externalRoutes from './routes/external.js';
import contactGroupRoutes from './routes/contactGroups.js';
import settingsRoutes from './routes/settings.js';
import subscriptionRoutes from './routes/subscriptions.js';
import aiRoutes from './routes/ai.js';
import posRoutes from './routes/pos.js';
import menuRoutes from './routes/menus.js';

const app = express();
const httpServer = createServer(app);

// Socket.IO setup
const io = new Server(httpServer, {
  cors: {
    origin: config.frontendUrl,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize WhatsApp Manager
const whatsappManager = new WhatsAppManager(io);
app.set('whatsappManager', whatsappManager);

// Initialize Scheduler
const schedulerService = new SchedulerService(whatsappManager);
// schedulerService.start(); // Uncomment when node-cron is installed

// Socket.IO Authentication
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    const result = await pool.query(
      'SELECT id, email, name, role FROM users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return next(new Error('User not found'));
    }

    socket.user = result.rows[0];
    next();
  } catch (error) {
    next(new Error('Authentication error'));
  }
});

// Socket.IO Connection
io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.user.email}`);
  
  // Join user-specific room
  socket.join(`user-${socket.user.id}`);

  // Handle device subscription
  socket.on('subscribe-device', (deviceId) => {
    socket.join(`device-${deviceId}`);
    console.log(`User ${socket.user.email} subscribed to device ${deviceId}`);
  });

  socket.on('unsubscribe-device', (deviceId) => {
    socket.leave(`device-${deviceId}`);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${socket.user.email}`);
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/auto-replies', autoReplyRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/external', externalRoutes);
app.use('/api/contact-groups', contactGroupRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/menus', menuRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const PORT = config.port;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp Gateway API ready`);
  console.log(`🔗 Frontend URL: ${config.frontendUrl}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  
  // Disconnect all WhatsApp clients
  for (const [deviceId, client] of whatsappManager.clients) {
    try {
      await client.destroy();
    } catch (error) {
      console.error(`Error destroying client ${deviceId}:`, error);
    }
  }
  
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
