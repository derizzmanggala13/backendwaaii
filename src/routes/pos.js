import express from 'express';
import pool from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import { saveOutgoingMessage } from '../services/MessageLogger.js';

const router = express.Router();

// ==================== STORE SETTINGS ====================

// Get store settings
router.get('/settings', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM store_settings WHERE user_id = $1',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      // Create default settings
      const newSettings = await pool.query(
        `INSERT INTO store_settings (user_id) VALUES ($1) RETURNING *`,
        [req.user.id]
      );
      return res.json(newSettings.rows[0]);
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get store settings error:', error);
    res.status(500).json({ error: 'Failed to get store settings' });
  }
});

// Update store settings
router.put('/settings', authenticate, async (req, res) => {
  try {
    const {
      store_name,
      store_address,
      store_phone,
      store_email,
      receipt_header,
      receipt_footer,
      tax_enabled,
      tax_percent,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO store_settings (user_id, store_name, store_address, store_phone, store_email, receipt_header, receipt_footer, tax_enabled, tax_percent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id) DO UPDATE SET
         store_name = EXCLUDED.store_name,
         store_address = EXCLUDED.store_address,
         store_phone = EXCLUDED.store_phone,
         store_email = EXCLUDED.store_email,
         receipt_header = EXCLUDED.receipt_header,
         receipt_footer = EXCLUDED.receipt_footer,
         tax_enabled = EXCLUDED.tax_enabled,
         tax_percent = EXCLUDED.tax_percent,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [req.user.id, store_name, store_address, store_phone, store_email, receipt_header, receipt_footer, tax_enabled, tax_percent]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update store settings error:', error);
    res.status(500).json({ error: 'Failed to update store settings' });
  }
});

// ==================== PRODUCTS ====================

// Get all products
router.get('/products', authenticate, async (req, res) => {
  try {
    const { category, search, active_only } = req.query;
    
    let query = 'SELECT * FROM products WHERE user_id = $1';
    const params = [req.user.id];
    let paramIndex = 2;

    if (active_only === 'true') {
      query += ` AND is_active = true`;
    }

    if (category) {
      query += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (search) {
      query += ` AND (name ILIKE $${paramIndex} OR sku ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ' ORDER BY name ASC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

// Get product categories
router.get('/products/categories', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT category FROM products WHERE user_id = $1 AND category IS NOT NULL ORDER BY category',
      [req.user.id]
    );
    res.json(result.rows.map(r => r.category));
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to get categories' });
  }
});

// Get single product
router.get('/products/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM products WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to get product' });
  }
});

// Create product
router.post('/products', authenticate, async (req, res) => {
  try {
    const {
      sku,
      name,
      description,
      category,
      price,
      discount_percent,
      discount_amount,
      stock,
      unit,
    } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const result = await pool.query(
      `INSERT INTO products (user_id, sku, name, description, category, price, discount_percent, discount_amount, stock, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.id, sku, name, description, category, price, discount_percent || 0, discount_amount || 0, stock || 0, unit || 'pcs']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product
router.put('/products/:id', authenticate, async (req, res) => {
  try {
    const {
      sku,
      name,
      description,
      category,
      price,
      discount_percent,
      discount_amount,
      stock,
      unit,
      is_active,
    } = req.body;

    const result = await pool.query(
      `UPDATE products SET
        sku = COALESCE($1, sku),
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        category = COALESCE($4, category),
        price = COALESCE($5, price),
        discount_percent = COALESCE($6, discount_percent),
        discount_amount = COALESCE($7, discount_amount),
        stock = COALESCE($8, stock),
        unit = COALESCE($9, unit),
        is_active = COALESCE($10, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $11 AND user_id = $12
       RETURNING *`,
      [sku, name, description, category, price, discount_percent, discount_amount, stock, unit, is_active, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
router.delete('/products/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product deleted' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ==================== TRANSACTIONS ====================

// Generate receipt number
function generateReceiptNumber() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `INV-${dateStr}-${random}`;
}

// Get all transactions
router.get('/transactions', authenticate, async (req, res) => {
  try {
    const { start_date, end_date, status, search, limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT t.*, 
        (SELECT COUNT(*) FROM transaction_items WHERE transaction_id = t.id) as item_count
      FROM transactions t 
      WHERE t.user_id = $1
    `;
    const params = [req.user.id];
    let paramIndex = 2;

    if (start_date) {
      query += ` AND t.transaction_date >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND t.transaction_date <= $${paramIndex}`;
      params.push(end_date + ' 23:59:59');
      paramIndex++;
    }

    if (status) {
      query += ` AND t.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (search) {
      query += ` AND (t.receipt_number ILIKE $${paramIndex} OR t.customer_name ILIKE $${paramIndex} OR t.customer_phone ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY t.transaction_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM transactions WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// Get single transaction with items
router.get('/transactions/:id', authenticate, async (req, res) => {
  try {
    const transResult = await pool.query(
      'SELECT * FROM transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (transResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const itemsResult = await pool.query(
      'SELECT * FROM transaction_items WHERE transaction_id = $1 ORDER BY id',
      [req.params.id]
    );

    res.json({
      ...transResult.rows[0],
      items: itemsResult.rows,
    });
  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({ error: 'Failed to get transaction' });
  }
});

// Create transaction
router.post('/transactions', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const {
      device_id,
      customer_name,
      customer_phone,
      items,
      discount_amount = 0,
      tax_percent = 0,
      payment_method = 'cash',
      payment_amount = 0,
      notes,
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Transaction must have at least one item' });
    }

    // Calculate subtotal
    let subtotal = 0;
    for (const item of items) {
      const itemDiscount = item.discount_amount || (item.price * (item.discount_percent || 0) / 100);
      const itemSubtotal = (item.price - itemDiscount) * item.quantity;
      subtotal += itemSubtotal;
    }

    // Calculate tax and total
    const taxAmount = subtotal * (tax_percent / 100);
    const total = subtotal - discount_amount + taxAmount;
    const changeAmount = payment_amount - total;

    // Create transaction
    const receiptNumber = generateReceiptNumber();
    const transResult = await client.query(
      `INSERT INTO transactions (user_id, device_id, receipt_number, customer_name, customer_phone, subtotal, discount_amount, tax_percent, tax_amount, total, payment_method, payment_amount, change_amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [req.user.id, device_id, receiptNumber, customer_name, customer_phone, subtotal, discount_amount, tax_percent, taxAmount, total, payment_method, payment_amount, changeAmount, notes]
    );

    const transaction = transResult.rows[0];

    // Insert items and update stock
    const insertedItems = [];
    for (const item of items) {
      const itemDiscount = item.discount_amount || (item.price * (item.discount_percent || 0) / 100);
      const itemSubtotal = (item.price - itemDiscount) * item.quantity;

      const itemResult = await client.query(
        `INSERT INTO transaction_items (transaction_id, product_id, product_name, product_sku, price, quantity, discount_percent, discount_amount, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [transaction.id, item.product_id, item.product_name, item.product_sku, item.price, item.quantity, item.discount_percent || 0, itemDiscount, itemSubtotal]
      );
      insertedItems.push(itemResult.rows[0]);

      // Update stock if product_id exists
      if (item.product_id) {
        await client.query(
          'UPDATE products SET stock = stock - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [item.quantity, item.product_id]
        );
      }
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...transaction,
      items: insertedItems,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create transaction error:', error);
    res.status(500).json({ error: 'Failed to create transaction' });
  } finally {
    client.release();
  }
});

// Cancel/void transaction
router.put('/transactions/:id/cancel', authenticate, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Check transaction exists and belongs to user
    const transResult = await client.query(
      'SELECT * FROM transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (transResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (transResult.rows[0].status === 'cancelled') {
      return res.status(400).json({ error: 'Transaction already cancelled' });
    }

    // Get items to restore stock
    const itemsResult = await client.query(
      'SELECT * FROM transaction_items WHERE transaction_id = $1',
      [req.params.id]
    );

    // Restore stock
    for (const item of itemsResult.rows) {
      if (item.product_id) {
        await client.query(
          'UPDATE products SET stock = stock + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [item.quantity, item.product_id]
        );
      }
    }

    // Update transaction status
    const updateResult = await client.query(
      `UPDATE transactions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    await client.query('COMMIT');

    res.json(updateResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Cancel transaction error:', error);
    res.status(500).json({ error: 'Failed to cancel transaction' });
  } finally {
    client.release();
  }
});

// ==================== RECEIPT ====================

// Generate receipt text
router.get('/transactions/:id/receipt', authenticate, async (req, res) => {
  try {
    // Get transaction
    const transResult = await pool.query(
      'SELECT * FROM transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (transResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const transaction = transResult.rows[0];

    // Get items
    const itemsResult = await pool.query(
      'SELECT * FROM transaction_items WHERE transaction_id = $1 ORDER BY id',
      [req.params.id]
    );

    // Get store settings
    const settingsResult = await pool.query(
      'SELECT * FROM store_settings WHERE user_id = $1',
      [req.user.id]
    );

    const settings = settingsResult.rows[0] || {
      store_name: 'Toko Saya',
      store_address: '',
      store_phone: '',
      receipt_footer: 'Terima kasih atas kunjungan Anda!',
    };

    // Generate receipt text
    const receipt = generateReceiptText(transaction, itemsResult.rows, settings);

    res.json({ receipt, transaction, items: itemsResult.rows, settings });
  } catch (error) {
    console.error('Get receipt error:', error);
    res.status(500).json({ error: 'Failed to generate receipt' });
  }
});

// Send receipt via WhatsApp
router.post('/transactions/:id/send-receipt', authenticate, async (req, res) => {
  try {
    const { device_id } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    // Get transaction
    const transResult = await pool.query(
      'SELECT * FROM transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (transResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const transaction = transResult.rows[0];

    if (!transaction.customer_phone) {
      return res.status(400).json({ error: 'Customer phone number is required' });
    }

    // Get items
    const itemsResult = await pool.query(
      'SELECT * FROM transaction_items WHERE transaction_id = $1 ORDER BY id',
      [req.params.id]
    );

    // Get store settings
    const settingsResult = await pool.query(
      'SELECT * FROM store_settings WHERE user_id = $1',
      [req.user.id]
    );

    const settings = settingsResult.rows[0] || {
      store_name: 'Toko Saya',
      receipt_footer: 'Terima kasih atas kunjungan Anda!',
    };

    // Generate receipt text
    const receipt = generateReceiptText(transaction, itemsResult.rows, settings);

    // Get WhatsApp manager
    const whatsappManager = req.app.get('whatsappManager');
    
    // Format phone number - expecting format 62xxx
    let phone = transaction.customer_phone.replace(/\D/g, '');
    
    // Handle various formats
    if (phone.startsWith('0')) {
      phone = '62' + phone.substring(1);
    } else if (phone.startsWith('8') && !phone.startsWith('62')) {
      phone = '62' + phone;
    }
    // If already starts with 62, keep it as is
    
    if (!phone.endsWith('@c.us')) {
      phone = phone + '@c.us';
    }

    // Send message
    const result = await whatsappManager.sendMessage(device_id, phone, receipt);

    // Save to message history
    await saveOutgoingMessage({
      deviceId: parseInt(device_id),
      to: phone,
      body: receipt,
      type: 'receipt',
      messageId: result?.messageId || null,
      status: 'sent',
      metadata: {
        receipt_number: transaction.receipt_number,
        transaction_id: transaction.id,
        total: transaction.total,
      },
    });

    // Log activity
    await pool.query(
      'INSERT INTO activity_logs (user_id, device_id, action, details) VALUES ($1, $2, $3, $4)',
      [req.user.id, device_id, 'receipt_sent', JSON.stringify({ 
        to: phone, 
        receipt_number: transaction.receipt_number,
        messageId: result?.messageId,
      })]
    );

    // Update receipt_sent status
    await pool.query(
      'UPDATE transactions SET receipt_sent = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [req.params.id]
    );

    res.json({ message: 'Receipt sent successfully', receipt, messageId: result?.messageId });
  } catch (error) {
    console.error('Send receipt error:', error);
    res.status(500).json({ error: error.message || 'Failed to send receipt' });
  }
});

// Helper function to generate receipt text
function generateReceiptText(transaction, items, settings) {
  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const formatDate = (date) => {
    return new Date(date).toLocaleString('id-ID', {
      dateStyle: 'long',
      timeStyle: 'short',
    });
  };

  const LINE = '━'.repeat(32);
  const DASH_LINE = '─'.repeat(32);

  let receipt = '';

  // Header
  if (settings.receipt_header) {
    receipt += settings.receipt_header + '\n\n';
  }

  receipt += `🏪 *${settings.store_name}*\n`;
  if (settings.store_address) {
    receipt += `📍 ${settings.store_address}\n`;
  }
  if (settings.store_phone) {
    receipt += `📞 ${settings.store_phone}\n`;
  }
  
  receipt += `\n${LINE}\n`;
  receipt += `🧾 *STRUK PEMBAYARAN*\n`;
  receipt += `${LINE}\n\n`;

  // Transaction info
  receipt += `No: *${transaction.receipt_number}*\n`;
  receipt += `📅 ${formatDate(transaction.transaction_date)}\n`;
  if (transaction.customer_name) {
    receipt += `👤 ${transaction.customer_name}\n`;
  }
  
  receipt += `\n${DASH_LINE}\n`;
  receipt += `*ITEM PEMBELIAN*\n`;
  receipt += `${DASH_LINE}\n\n`;

  // Items
  items.forEach((item, index) => {
    receipt += `${index + 1}. ${item.product_name}\n`;
    receipt += `   ${item.quantity} x ${formatCurrency(item.price)}`;
    if (item.discount_amount > 0) {
      receipt += ` (-${formatCurrency(item.discount_amount)})`;
    }
    receipt += `\n   = ${formatCurrency(item.subtotal)}\n\n`;
  });

  receipt += `${DASH_LINE}\n`;

  // Totals
  receipt += `Subtotal: ${formatCurrency(transaction.subtotal)}\n`;
  
  if (transaction.discount_amount > 0) {
    receipt += `Diskon: -${formatCurrency(transaction.discount_amount)}\n`;
  }
  
  if (transaction.tax_amount > 0) {
    receipt += `Pajak (${transaction.tax_percent}%): ${formatCurrency(transaction.tax_amount)}\n`;
  }

  receipt += `${DASH_LINE}\n`;
  receipt += `*TOTAL: ${formatCurrency(transaction.total)}*\n`;
  receipt += `${DASH_LINE}\n\n`;

  // Payment info
  receipt += `💳 Pembayaran: ${transaction.payment_method.toUpperCase()}\n`;
  receipt += `💵 Bayar: ${formatCurrency(transaction.payment_amount)}\n`;
  if (transaction.change_amount > 0) {
    receipt += `💰 Kembalian: ${formatCurrency(transaction.change_amount)}\n`;
  }

  receipt += `\n${LINE}\n`;

  // Footer
  if (settings.receipt_footer) {
    receipt += `\n${settings.receipt_footer}\n`;
  }

  // Status
  if (transaction.status === 'cancelled') {
    receipt += `\n⚠️ *TRANSAKSI DIBATALKAN*\n`;
  }

  return receipt;
}

// ==================== REPORTS ====================

// Get sales summary
router.get('/reports/summary', authenticate, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    let dateFilter = '';
    const params = [req.user.id];
    
    if (start_date && end_date) {
      dateFilter = 'AND transaction_date >= $2 AND transaction_date <= $3';
      params.push(start_date, end_date + ' 23:59:59');
    }

    // Total sales
    const salesResult = await pool.query(
      `SELECT 
        COUNT(*) as total_transactions,
        COALESCE(SUM(total), 0) as total_sales,
        COALESCE(SUM(discount_amount), 0) as total_discount,
        COALESCE(SUM(tax_amount), 0) as total_tax
       FROM transactions 
       WHERE user_id = $1 AND status = 'completed' ${dateFilter}`,
      params
    );

    // Items sold
    const itemsResult = await pool.query(
      `SELECT COALESCE(SUM(ti.quantity), 0) as total_items_sold
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       WHERE t.user_id = $1 AND t.status = 'completed' ${dateFilter}`,
      params
    );

    // Top products
    const topProductsResult = await pool.query(
      `SELECT ti.product_name, SUM(ti.quantity) as total_qty, SUM(ti.subtotal) as total_sales
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       WHERE t.user_id = $1 AND t.status = 'completed' ${dateFilter}
       GROUP BY ti.product_name
       ORDER BY total_qty DESC
       LIMIT 10`,
      params
    );

    res.json({
      ...salesResult.rows[0],
      ...itemsResult.rows[0],
      top_products: topProductsResult.rows,
    });
  } catch (error) {
    console.error('Get reports error:', error);
    res.status(500).json({ error: 'Failed to get reports' });
  }
});

export default router;
