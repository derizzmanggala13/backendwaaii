import pool from '../database/connection.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Save outgoing message to history
 * @param {Object} options
 * @param {number} options.deviceId - Device ID
 * @param {string} options.to - Recipient number (format: 62xxx@c.us or 62xxx)
 * @param {string} options.body - Message body
 * @param {string} options.type - Message type (chat, receipt, broadcast, etc.)
 * @param {string} options.messageId - WhatsApp message ID (if available)
 * @param {string} options.status - Message status (sent, pending, failed)
 * @param {Object} options.metadata - Additional metadata
 * @returns {Promise<Object>} Saved message record
 */
export async function saveOutgoingMessage({
  deviceId,
  to,
  body,
  type = 'chat',
  messageId = null,
  status = 'sent',
  metadata = {},
}) {
  try {
    // Format the recipient number
    let chatId = to;
    if (!chatId.includes('@')) {
      chatId = chatId + '@c.us';
    }
    
    // Generate a message ID if not provided
    const msgId = messageId || `OUT_${uuidv4()}`;
    
    // Get device phone number for from_number
    const deviceResult = await pool.query(
      'SELECT phone_number FROM devices WHERE id = $1',
      [deviceId]
    );
    const fromNumber = deviceResult.rows[0]?.phone_number || '';
    
    // Extract just the number from chat ID
    const toNumber = chatId.replace('@c.us', '').replace('@g.us', '');
    
    // Insert message
    const result = await pool.query(
      `INSERT INTO messages (
        device_id, message_id, chat_id, from_number, to_number, 
        body, type, is_from_me, timestamp, status, ack
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (device_id, message_id) DO UPDATE SET
        status = EXCLUDED.status,
        ack = EXCLUDED.ack
      RETURNING *`,
      [
        deviceId,
        msgId,
        chatId,
        fromNumber,
        toNumber,
        body,
        type,
        true, // is_from_me = true for outgoing messages
        new Date(),
        status,
        status === 'sent' ? 1 : 0, // ack: 0=pending, 1=sent, 2=delivered, 3=read
      ]
    );
    
    // If there's metadata, we can log it
    if (Object.keys(metadata).length > 0) {
      console.log(`Message saved with metadata:`, { msgId, type, metadata });
    }
    
    return result.rows[0];
  } catch (error) {
    console.error('Error saving outgoing message:', error);
    throw error;
  }
}

/**
 * Update message status
 * @param {number} deviceId - Device ID
 * @param {string} messageId - Message ID
 * @param {string} status - New status
 * @param {number} ack - ACK level (0=pending, 1=sent, 2=delivered, 3=read, 4=played)
 */
export async function updateMessageStatus(deviceId, messageId, status, ack = null) {
  try {
    const updates = ['status = $3'];
    const params = [deviceId, messageId, status];
    
    if (ack !== null) {
      updates.push(`ack = $${params.length + 1}`);
      params.push(ack);
    }
    
    await pool.query(
      `UPDATE messages SET ${updates.join(', ')} WHERE device_id = $1 AND message_id = $2`,
      params
    );
  } catch (error) {
    console.error('Error updating message status:', error);
  }
}

/**
 * Get ACK status text
 * @param {number} ack - ACK level
 * @returns {string} Status text
 */
export function getAckStatusText(ack) {
  const statuses = {
    0: 'pending',
    1: 'sent',
    2: 'delivered', 
    3: 'read',
    4: 'played',
  };
  return statuses[ack] || 'unknown';
}

export default {
  saveOutgoingMessage,
  updateMessageStatus,
  getAckStatusText,
};
