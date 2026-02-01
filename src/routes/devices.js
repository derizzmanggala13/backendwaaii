import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/connection.js';
import { authenticate, ownsDevice } from '../middleware/auth.js';
import multer from 'multer';
import * as XLSX from 'xlsx';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Get all devices for user
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, device_name, phone_number, status, qr_code, last_seen, created_at FROM devices WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ devices: result.rows });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ error: 'Failed to get devices' });
  }
});

// Create new device
router.post('/', authenticate, [
  body('deviceName').trim().isLength({ min: 1, max: 255 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { deviceName } = req.body;

    const result = await pool.query(
      'INSERT INTO devices (user_id, device_name) VALUES ($1, $2) RETURNING *',
      [req.user.id, deviceName]
    );

    // Log activity
    await pool.query(
      'INSERT INTO activity_logs (user_id, device_id, action, details) VALUES ($1, $2, $3, $4)',
      [req.user.id, result.rows[0].id, 'device_created', JSON.stringify({ deviceName })]
    );

    res.status(201).json({
      message: 'Device created',
      device: result.rows[0],
    });
  } catch (error) {
    console.error('Create device error:', error);
    res.status(500).json({ error: 'Failed to create device' });
  }
});

// Get device by ID
router.get('/:deviceId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const whatsappManager = req.app.get('whatsappManager');
    
    const result = await pool.query(
      'SELECT * FROM devices WHERE id = $1',
      [deviceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const device = result.rows[0];
    const isConnected = whatsappManager.isConnected(parseInt(deviceId));
    const deviceInfo = isConnected ? await whatsappManager.getDeviceInfo(parseInt(deviceId)) : null;

    res.json({
      device: {
        ...device,
        isConnected,
        deviceInfo,
      },
    });
  } catch (error) {
    console.error('Get device error:', error);
    res.status(500).json({ error: 'Failed to get device' });
  }
});

// Initialize/Connect device
router.post('/:deviceId/connect', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const whatsappManager = req.app.get('whatsappManager');

    // Update status
    await pool.query(
      'UPDATE devices SET status = $1, updated_at = NOW() WHERE id = $2',
      ['connecting', deviceId]
    );

    // Initialize in background
    whatsappManager.initializeDevice(parseInt(deviceId), req.user.id)
      .catch(error => {
        console.error('Device initialization error:', error);
        pool.query(
          'UPDATE devices SET status = $1, updated_at = NOW() WHERE id = $2',
          ['error', deviceId]
        );
      });

    res.json({
      message: 'Device connection initiated',
      status: 'connecting',
    });
  } catch (error) {
    console.error('Connect device error:', error);
    res.status(500).json({ error: 'Failed to connect device' });
  }
});

// Disconnect device
router.post('/:deviceId/disconnect', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const whatsappManager = req.app.get('whatsappManager');

    await whatsappManager.disconnectDevice(parseInt(deviceId));

    res.json({ message: 'Device disconnected' });
  } catch (error) {
    console.error('Disconnect device error:', error);
    res.status(500).json({ error: 'Failed to disconnect device' });
  }
});

// Logout device (clear session)
router.post('/:deviceId/logout', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const whatsappManager = req.app.get('whatsappManager');

    await whatsappManager.logoutDevice(parseInt(deviceId));

    // Log activity
    await pool.query(
      'INSERT INTO activity_logs (user_id, device_id, action) VALUES ($1, $2, $3)',
      [req.user.id, deviceId, 'device_logout']
    );

    res.json({ message: 'Device logged out' });
  } catch (error) {
    console.error('Logout device error:', error);
    res.status(500).json({ error: 'Failed to logout device' });
  }
});

// Delete device
router.delete('/:deviceId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const whatsappManager = req.app.get('whatsappManager');

    // Disconnect first
    await whatsappManager.disconnectDevice(parseInt(deviceId));

    // Delete from database
    await pool.query('DELETE FROM devices WHERE id = $1', [deviceId]);

    // Log activity
    await pool.query(
      'INSERT INTO activity_logs (user_id, action, details) VALUES ($1, $2, $3)',
      [req.user.id, 'device_deleted', JSON.stringify({ deviceId })]
    );

    res.json({ message: 'Device deleted' });
  } catch (error) {
    console.error('Delete device error:', error);
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// Update device
router.put('/:deviceId', authenticate, ownsDevice, [
  body('deviceName').optional().trim().isLength({ min: 1, max: 255 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { deviceId } = req.params;
    const { deviceName } = req.body;

    const result = await pool.query(
      'UPDATE devices SET device_name = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [deviceName, deviceId]
    );

    res.json({
      message: 'Device updated',
      device: result.rows[0],
    });
  } catch (error) {
    console.error('Update device error:', error);
    res.status(500).json({ error: 'Failed to update device' });
  }
});

// Get device contacts from database
router.get('/:deviceId/contacts', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { search, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT * FROM contacts WHERE device_id = $1';
    const params = [deviceId];
    let paramCount = 2;

    if (search) {
      query += ` AND (name ILIKE $${paramCount} OR phone_number ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    query += ` ORDER BY name ASC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM contacts WHERE device_id = $1';
    const countParams = [deviceId];
    if (search) {
      countQuery += ' AND (name ILIKE $2 OR phone_number ILIKE $2)';
      countParams.push(`%${search}%`);
    }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      contacts: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

// Get device contacts from WhatsApp directly (live)
router.get('/:deviceId/contacts-live', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const whatsappManager = req.app.get('whatsappManager');

    const client = whatsappManager.getClient(parseInt(deviceId));
    if (!client) {
      return res.status(400).json({ error: 'Device not connected' });
    }

    const contacts = await client.getContacts();
    
    const formattedContacts = contacts
      .filter(c => c.isWAContact && !c.isGroup && !c.isBusiness)
      .map(contact => ({
        id: contact.id._serialized,
        number: contact.number,
        name: contact.name,
        pushname: contact.pushname,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
        isBusiness: contact.isBusiness,
      }));

    res.json({ contacts: formattedContacts });
  } catch (error) {
    console.error('Get live contacts error:', error);
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

// Sync device contacts
router.post('/:deviceId/sync-contacts', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const whatsappManager = req.app.get('whatsappManager');

    const client = whatsappManager.getClient(parseInt(deviceId));
    if (!client) {
      return res.status(400).json({ error: 'Device not connected' });
    }

    // Trigger sync in background
    whatsappManager.syncContacts(client, parseInt(deviceId));

    res.json({ message: 'Contact sync initiated' });
  } catch (error) {
    console.error('Sync contacts error:', error);
    res.status(500).json({ error: 'Failed to sync contacts' });
  }
});

// Add single contact manually
router.post('/:deviceId/contacts', authenticate, ownsDevice, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('phone_number').trim().isLength({ min: 10, max: 20 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { deviceId } = req.params;
    const { name, phone_number, notes } = req.body;

    // Normalize phone number (remove +, spaces, dashes)
    const normalizedPhone = phone_number.replace(/[\s\-\+]/g, '');
    const waId = normalizedPhone + '@c.us';

    const result = await pool.query(`
      INSERT INTO contacts (device_id, wa_id, name, phone_number, notes)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (device_id, wa_id) 
      DO UPDATE SET name = $3, phone_number = $4, notes = $5, updated_at = NOW()
      RETURNING *
    `, [deviceId, waId, name, normalizedPhone, notes || null]);

    res.json({ contact: result.rows[0] });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// Update contact
router.put('/:deviceId/contacts/:contactId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId, contactId } = req.params;
    const { name, phone_number, notes } = req.body;

    const result = await pool.query(`
      UPDATE contacts 
      SET name = COALESCE($1, name), 
          phone_number = COALESCE($2, phone_number),
          notes = COALESCE($3, notes),
          updated_at = NOW()
      WHERE id = $4 AND device_id = $5
      RETURNING *
    `, [name, phone_number, notes, contactId, deviceId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({ contact: result.rows[0] });
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// Delete contact
router.delete('/:deviceId/contacts/:contactId', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId, contactId } = req.params;

    const result = await pool.query(
      'DELETE FROM contacts WHERE id = $1 AND device_id = $2 RETURNING *',
      [contactId, deviceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({ message: 'Contact deleted' });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// Delete multiple contacts
router.post('/:deviceId/contacts/delete-bulk', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { contactIds } = req.body;

    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'No contacts specified' });
    }

    const result = await pool.query(
      'DELETE FROM contacts WHERE id = ANY($1) AND device_id = $2 RETURNING id',
      [contactIds, deviceId]
    );

    res.json({ 
      message: 'Contacts deleted',
      deleted: result.rowCount 
    });
  } catch (error) {
    console.error('Delete bulk contacts error:', error);
    res.status(500).json({ error: 'Failed to delete contacts' });
  }
});

// Download Excel template
router.get('/:deviceId/contacts/template', authenticate, ownsDevice, (req, res) => {
  try {
    // Create workbook with template
    const wb = XLSX.utils.book_new();
    
    // Sample data
    const data = [
      ['name', 'phone_number', 'notes'],
      ['John Doe', '628123456789', 'Customer VIP'],
      ['Jane Smith', '628987654321', 'Supplier'],
      ['Ahmad Rizki', '6281234567890', ''],
    ];
    
    const ws = XLSX.utils.aoa_to_sheet(data);
    
    // Set column widths
    ws['!cols'] = [
      { wch: 25 }, // name
      { wch: 20 }, // phone_number
      { wch: 30 }, // notes
    ];
    
    XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
    
    // Generate buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts_template.xlsx');
    res.send(buffer);
  } catch (error) {
    console.error('Download template error:', error);
    res.status(500).json({ error: 'Failed to generate template' });
  }
});

// Export contacts to Excel
router.get('/:deviceId/contacts/export', authenticate, ownsDevice, async (req, res) => {
  try {
    const { deviceId } = req.params;

    const result = await pool.query(
      'SELECT name, phone_number, notes, created_at FROM contacts WHERE device_id = $1 ORDER BY name ASC',
      [deviceId]
    );

    // Create workbook
    const wb = XLSX.utils.book_new();
    
    // Convert data to sheet
    const data = [
      ['name', 'phone_number', 'notes', 'created_at'],
      ...result.rows.map(c => [c.name, c.phone_number, c.notes || '', c.created_at])
    ];
    
    const ws = XLSX.utils.aoa_to_sheet(data);
    
    // Set column widths
    ws['!cols'] = [
      { wch: 25 },
      { wch: 20 },
      { wch: 30 },
      { wch: 20 },
    ];
    
    XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
    
    // Generate buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=contacts_export_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
  } catch (error) {
    console.error('Export contacts error:', error);
    res.status(500).json({ error: 'Failed to export contacts' });
  }
});

// Import contacts from Excel
router.post('/:deviceId/contacts/import', authenticate, ownsDevice, upload.single('file'), async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse Excel file
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    if (data.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 2; // Excel row number (1-indexed + header)
      
      // Get name and phone from various possible column names
      const name = row.name || row.Name || row.nama || row.Nama || '';
      let phone = row.phone_number || row.phone || row.Phone || row.nomor || row.Nomor || row['Phone Number'] || '';
      const notes = row.notes || row.Notes || row.catatan || row.Catatan || '';

      // Validate
      if (!name || !phone) {
        skipped++;
        errors.push(`Row ${rowNum}: Missing name or phone number`);
        continue;
      }

      // Normalize phone number
      phone = String(phone).replace(/[\s\-\+\.]/g, '');
      
      // Add country code if not present (assuming Indonesia)
      if (phone.startsWith('0')) {
        phone = '62' + phone.substring(1);
      }

      // Validate phone format
      if (!/^\d{10,15}$/.test(phone)) {
        skipped++;
        errors.push(`Row ${rowNum}: Invalid phone number format`);
        continue;
      }

      const waId = phone + '@c.us';

      try {
        await pool.query(`
          INSERT INTO contacts (device_id, wa_id, name, phone_number, notes)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (device_id, wa_id) 
          DO UPDATE SET name = $3, phone_number = $4, notes = COALESCE($5, contacts.notes), updated_at = NOW()
        `, [deviceId, waId, name.trim(), phone, notes?.trim() || null]);
        
        imported++;
      } catch (err) {
        skipped++;
        errors.push(`Row ${rowNum}: Database error - ${err.message}`);
      }
    }

    res.json({
      message: `Import completed: ${imported} imported, ${skipped} skipped`,
      imported,
      skipped,
      total: data.length,
      errors: errors.slice(0, 10), // Only return first 10 errors
    });
  } catch (error) {
    console.error('Import contacts error:', error);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

export default router;
