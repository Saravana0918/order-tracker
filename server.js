/***************************
 * server.js (Customer-Specific Push)
 ***************************/
import dotenv from 'dotenv';
import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import axios from 'axios';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);



// App
const app = express();

// ENV
const {
  DB_HOST, DB_USER, DB_PASSWORD, DB_NAME,
  SHOPIFY_STORE, SHOPIFY_ADMIN_API_TOKEN
} = process.env;


// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// MySQL Connection Pool
const db = mysql.createPool(process.env.MYSQL_PUBLIC_URL);


console.log('✅  Connected to MySQL');

// Multer storage config
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'public', 'uploads'),
  filename: (_, file, cb) => cb(null, `design_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });


/* -------- Upload Design + Notify -------- */
app.post('/api/upload-design', upload.single('image'), async (req, res) => {
  try {
    const { orderId } = req.body;
    const fileName = req.file.filename;

    // Update the order with the uploaded design image
    await db.execute(
      `UPDATE order_progress
         SET design_done = 1,
             design_image = ?,
             updated_at = NOW()
       WHERE order_id = ?`,
      [fileName, orderId]
    );

    // Response after successful upload
    res.json({ success: true, file: fileName });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});



/* ── 2.  Assign designer (customer role) ───────────────────── */
app.post('/api/assign-designer', async (req, res) => {
  const { order_id, designer } = req.body;

  if (!order_id || !designer)
    return res.status(400).json({ error: 'Missing order_id or designer' });

  try {
    // ✅ Optional validation (ensure username exists in users table)
    const [rows] = await db.execute(
      'SELECT id FROM users WHERE username = ? AND role = "design"',
      [designer]
    );

    if (!rows.length)
      return res.status(400).json({ error: 'Not a valid designer username' });

    // ✅ Save username (not ID)
    await db.execute(
      `UPDATE order_progress SET design_assignee = ?, updated_at = NOW() WHERE order_id = ?`,
      [designer, order_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Assign error:', err);
    res.status(500).json({ error: 'DB update failed' });
  }
});


/* -------- Mark Stage Done + Notify -------- */
app.post('/api/mark-stage-done', async (req, res) => {
  const { orderId, stage } = req.body;
  const allowedStages = ['design', 'printing', 'fusing', 'stitching', 'shipping'];

  if (!orderId || !allowedStages.includes(stage)) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  try {
    await db.execute(
      `UPDATE order_progress SET ${stage}_done = 1, updated_at = NOW() WHERE order_id = ?`,
      [orderId]
    );

    const capitalized = stage.charAt(0).toUpperCase() + stage.slice(1);

    const [rows] = await db.query(
      'SELECT customer_phone FROM order_progress WHERE order_id = ?',
      [orderId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Stage-done error:', err);
    res.status(500).json({ error: 'DB update failed' });
  }
});


/* ── 4.  Fetch + sync Shopify orders, then return list ─────── */
app.get('/api/orders', async (req, res) => {
  const role = req.headers['x-user-role'];
  const user = req.headers['x-user-name'];

  try {
    if (role === 'admin' || role === 'customer') {
      // Shopify sync + full load (keep as-is)
      const shopifyRes = await axios.get(`https://${SHOPIFY_STORE}/admin/api/2023-10/orders.json`, {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_TOKEN },
        params: { status: 'any', limit: 50 }
      });

      const orders = shopifyRes.data.orders;
      for (const o of orders) {
        const orderId = o.id.toString();
        const [exists] = await db.execute('SELECT 1 FROM order_progress WHERE order_id = ?', [orderId]);
       const customerName = `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim();
const address = o.shipping_address
  ? `${o.shipping_address.address1 || ''}, ${o.shipping_address.city || ''}, ${o.shipping_address.province || ''}, ${o.shipping_address.country || ''}, ${o.shipping_address.zip || ''}`
  : '';

if (!exists.length) {
  await db.execute(
    `INSERT INTO order_progress (
      order_id, order_name, customer_name,
      total_price, fulfillment_status, payment_status,
      shipping_method, item_count, tags, address, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      orderId, o.name, customerName,
      o.total_price || 0,
      o.fulfillment_status || '',
      o.financial_status || '',
      o.shipping_lines?.[0]?.title || '',
      o.line_items?.length || 0,
      o.tags || '',
      address
    ]
  );
} else {
  // 💥 This part updates old records with latest data
  await db.execute(
    `UPDATE order_progress SET
      customer_name     = ?,
      total_price       = ?,
      fulfillment_status= ?,
      payment_status    = ?,
      shipping_method   = ?,
      item_count        = ?,
      tags              = ?,
      address           = ?,
      updated_at        = NOW()
     WHERE order_id     = ?`,
    [
      customerName,
      o.total_price || 0,
      o.fulfillment_status || '',
      o.financial_status || '',
      o.shipping_lines?.[0]?.title || '',
      o.line_items?.length || 0,
      o.tags || '',
      address,
      orderId
    ]
  );
}
      }

      const [rows] = await db.execute(`
        SELECT
          order_id,
          order_name,
          customer_name,
          total_price        AS price,
          fulfillment_status AS fulfillment,
          payment_status     AS payment,
          shipping_method    AS shiptype,
          item_count         AS items,
          tags,
          address,
          design_done,
          printing_done,
          fusing_done,
          stitching_done,
          shipping_done,
          updated_at,
          design_image,
          design_assignee
        FROM order_progress
        ORDER BY updated_at DESC
      `);
      return res.json({ orders: rows });
    }

    // 🎯 Designer role — only show assigned orders not done
    let sql = 'SELECT * FROM order_progress WHERE 1=1';
    const params = [];

    if (role === 'design') {
        sql += ' AND (design_done IS NULL OR design_done = 0) AND design_assignee = ?';
        params.push(user);
      } else if (role === 'printing') {
        sql += ' AND design_done = 1 AND printing_done = 0';
      } else if (role === 'fusing') {
        sql += ' AND design_done = 1 AND printing_done = 1 AND fusing_done = 0';
      } else if (role === 'stitching') {
        sql += ' AND design_done = 1 AND printing_done = 1 AND fusing_done = 1 AND stitching_done = 0';
      } else if (role === 'shipping') {
        sql += ' AND design_done = 1 AND printing_done = 1 AND fusing_done = 1 AND stitching_done = 1 AND shipping_done = 0';
      }

    sql += ' ORDER BY updated_at DESC';
    const [rows] = await db.execute(sql, params);
    res.json({ orders: rows });

  } catch (err) {
    console.error('❌ Error loading orders:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

/* ── 5.  Manual “import Shopify” button (if you still need it) ─ */
app.post('/api/fetch-shopify-orders', async (_, res) => {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/orders.json`,
      {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_TOKEN },
        params : { status:'any', limit:50 }
      }
    );

    let imported = 0;
    for (const o of response.data.orders) {
      const orderId = o.id.toString();
      const [r] = await db.execute(
        `INSERT IGNORE INTO order_progress
           (order_id, order_name, customer_name, updated_at)
         VALUES (?,?,?,NOW())`,
        [
          orderId,
          o.name,
          `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim()
        ]
      );
      if (r.affectedRows) imported++;
    }

    res.json({ success:true, imported });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error:'Shopify fetch failed' });
  }
});

/* ── 6. Simple login ───────────── */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const [rows] = await db.execute(
      'SELECT role FROM users WHERE username = ? AND password = ?',
      [username, password]
    );
    if (!rows.length) {
      return res.json({ success:false, message:'Invalid credentials' });
    }
    res.json({ success:true, role:rows[0].role, username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});


app.post('/api/quick-done', async (req, res) => {
  const { order_id, role } = req.body;

  const allowed = ['printing', 'fusing', 'stitching', 'shipping'];
  if (!order_id || !allowed.includes(role))
    return res.status(400).json({ error: 'Invalid request' });

  try {
    await db.execute(
      `UPDATE order_progress SET ${role}_done = 'Done', updated_at = NOW() WHERE order_id = ?`,
      [order_id]
    );

    // 🔔 Send push
    const cap = role.charAt(0).toUpperCase() + role.slice(1);
   await sendWhatsAppToCustomer(order_id, '🎨 Design Completed! Order is now moved to Printing.');

    res.json({ success: true });
  } catch (err) {
    console.error('Quick done error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.get('/api/get-order/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Check order_name (Shopify short number with #)
    const shortName = `#${id}`;
    const [rows] = await db.execute(
    'SELECT * FROM order_progress WHERE order_name = ? OR order_id = ?',
      [`#${id}`, id]
    );

    if (!rows.length) {
      return res.json({ error: 'Order not found' });
    }

    res.json({ order: rows[0] });
  } catch (err) {
    console.error('Get-order error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


app.post('/api/pending-summary', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Date is required' });

  try {
    const [rows] = await db.query(`
      SELECT 
        SUM(CASE WHEN design_done = 0 THEN 1 ELSE 0 END) AS design_pending,
        SUM(CASE WHEN printing_done = 0 THEN 1 ELSE 0 END) AS printing_pending,
        SUM(CASE WHEN fusing_done = 0 THEN 1 ELSE 0 END) AS fusing_pending,
        SUM(CASE WHEN stitching_done = 0 THEN 1 ELSE 0 END) AS stitching_pending,
        SUM(CASE WHEN shipping_done = 0 THEN 1 ELSE 0 END) AS shipping_pending
      FROM order_progress
      WHERE DATE(updated_at) = ?
    `, [date]);

    const summary = rows[0];
    const total = Object.values(summary).reduce((sum, val) => sum + val, 0);

    res.json({ ...summary, total });
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ── 8.  Static login page ─────────────────────────────────── */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* ── 9.  Start server ──────────────────────────────────────── */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
