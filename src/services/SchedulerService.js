import cron from 'node-cron';
import pool from '../database/connection.js';

class SchedulerService {
  constructor(whatsappManager) {
    this.whatsappManager = whatsappManager;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    
    // Check for scheduled messages every minute
    cron.schedule('* * * * *', async () => {
      await this.processScheduledMessages();
    });
    
    this.isRunning = true;
    console.log('📅 Scheduler service started');
  }

  async processScheduledMessages() {
    try {
      const result = await pool.query(`
        SELECT sm.*, d.user_id 
        FROM scheduled_messages sm
        JOIN devices d ON sm.device_id = d.id
        WHERE sm.status = 'pending' 
        AND sm.scheduled_at <= NOW()
        ORDER BY sm.scheduled_at ASC
        LIMIT 10
      `);

      for (const message of result.rows) {
        try {
          // Check if device is connected
          if (!this.whatsappManager.isConnected(message.device_id)) {
            await pool.query(
              'UPDATE scheduled_messages SET status = $1, error_message = $2 WHERE id = $3',
              ['failed', 'Device not connected', message.id]
            );
            continue;
          }

          // Send message
          const options = {};
          if (message.media_url) {
            // Handle media if exists
          }

          await this.whatsappManager.sendMessage(
            message.device_id,
            message.to_number,
            message.body,
            options
          );

          // Update status
          await pool.query(
            'UPDATE scheduled_messages SET status = $1, sent_at = NOW() WHERE id = $2',
            ['sent', message.id]
          );

          console.log(`✅ Scheduled message ${message.id} sent successfully`);
        } catch (error) {
          await pool.query(
            'UPDATE scheduled_messages SET status = $1, error_message = $2 WHERE id = $3',
            ['failed', error.message, message.id]
          );
          console.error(`❌ Failed to send scheduled message ${message.id}:`, error);
        }
      }
    } catch (error) {
      console.error('Error processing scheduled messages:', error);
    }
  }

  async scheduleMessage(deviceId, toNumber, body, scheduledAt, mediaUrl = null, mediaType = null) {
    const result = await pool.query(`
      INSERT INTO scheduled_messages (device_id, to_number, body, media_url, media_type, scheduled_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [deviceId, toNumber, body, mediaUrl, mediaType, scheduledAt]);

    return result.rows[0];
  }

  async cancelScheduledMessage(messageId, deviceId) {
    const result = await pool.query(`
      UPDATE scheduled_messages 
      SET status = 'cancelled' 
      WHERE id = $1 AND device_id = $2 AND status = 'pending'
      RETURNING *
    `, [messageId, deviceId]);

    return result.rows[0];
  }

  async getScheduledMessages(deviceId, status = null) {
    let query = 'SELECT * FROM scheduled_messages WHERE device_id = $1';
    const params = [deviceId];

    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }

    query += ' ORDER BY scheduled_at ASC';

    const result = await pool.query(query, params);
    return result.rows;
  }
}

export default SchedulerService;
