import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import pool from '../database/connection.js';

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwt.secret);
    
    const result = await pool.query(
      'SELECT id, email, name, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    if (!result.rows[0].is_active) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }
    
    req.user = result.rows[0];
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

export const authenticateApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({ error: 'No API key provided' });
    }
    
    const result = await pool.query(`
      SELECT ak.*, u.id as user_id, u.email, u.name, u.role, u.is_active
      FROM api_keys ak
      JOIN users u ON ak.user_id = u.id
      WHERE ak.api_key = $1 AND ak.is_active = true
    `, [apiKey]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const apiKeyData = result.rows[0];
    
    if (!apiKeyData.is_active) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }
    
    // Update last used
    await pool.query(
      'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
      [apiKeyData.id]
    );
    
    req.user = {
      id: apiKeyData.user_id,
      email: apiKeyData.email,
      name: apiKeyData.name,
      role: apiKeyData.role,
    };
    req.deviceId = apiKeyData.device_id;
    
    next();
  } catch (error) {
    console.error('API key auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

export const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

export const ownsDevice = async (req, res, next) => {
  try {
    const deviceId = req.params.deviceId || req.body.deviceId;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID required' });
    }
    
    const result = await pool.query(
      'SELECT * FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );
    
    if (result.rows.length === 0 && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied to this device' });
    }
    
    req.device = result.rows[0];
    next();
  } catch (error) {
    console.error('Device ownership check error:', error);
    res.status(500).json({ error: 'Failed to verify device ownership' });
  }
};
