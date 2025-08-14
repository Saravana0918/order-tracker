/***************************
 * server.js (Optimized with Sync Orders)
 ***************************/
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// App
const app = express();

// ENV
const {
  DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT,
  SHOPIFY_STORE, SHOPIFY_ADMIN_API_TOKEN
} = process.env;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static('/uploads'));

// DB Connection Pool
const pool = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  port: DB_PORT || 3306,
  connectionLimit: 10
});
console.log('✅ Connected to MySQL');

// Multer (upload design image)
const storage = multer.diskStorage({
  destination: '/uploads/design',
  filename: (_, file, cb) => cb(null, `design_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// Test DB Route
app.get('/api/test-db', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT NOW() AS currentTime');
    res.json({ success: true, message: 'Database connected!', time: rows[0].currentTime });
  } catch (error) {
    console.error('DB Test Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/* -------- Upload Design + Notify -------- */
app.post('/api/upload-design', upload.single('image'), async (req, res) => {
  try {
    const { orderId } = req.body;
    const fileName = req.file.filename;

    await pool.execute(
      `UPDATE order_progress
         SET design_done = 1,
             design_image = ?,
             updated_at = NOW()
       WHERE order_id = ?`,
      [fileName, orderId]
    );

    res.json({ success: true, file: fileName });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

app.post('/api/set-dispatch-date', async (req, res) => {
  try {
    const { order_id, dispatch_date } = req.body;
    if (!order_id || !dispatch_date) {
      return res.status(400).json({ success: false, error: 'Missing order_id or dispatch_date' });
    }

    const id = String(order_id);
    const [result] = await pool.query(
      'UPDATE `order_progress` SET `dispatch_date` = ? WHERE `order_id` = ? OR `order_name` = ?',
      [dispatch_date, id, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Order not found in order_progress' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('set-dispatch-date error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


/* -------- Assign designer -------- */
app.post('/api/assign-designer', async (req, res) => {
  const { order_id, designer } = req.body;

  if (!order_id || !designer)
    return res.status(400).json({ error: 'Missing order_id or designer' });

  try {
    const [rows] = await pool.execute(
      'SELECT id FROM users WHERE username = ? AND role = "design"',
      [designer]
    );

    if (!rows.length)
      return res.status(400).json({ error: 'Not a valid designer username' });

    await pool.execute(
      `UPDATE order_progress SET design_assignee = ?, updated_at = NOW() WHERE order_id = ?`,
      [designer, order_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Assign error:', err);
    res.status(500).json({ error: 'DB update failed' });
  }
});

/* -------- Mark Stage Done -------- */
app.post('/api/mark-stage-done', async (req, res) => {
  const { orderId, stage } = req.body;
  const allowedStages = ['design', 'printing', 'fusing', 'stitching', 'shipping'];

  if (!orderId || !allowedStages.includes(stage)) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  try {
    await pool.execute(
      `UPDATE order_progress SET ${stage}_done = 1, updated_at = NOW() WHERE order_id = ?`,
      [orderId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Stage-done error:', err);
    res.status(500).json({ error: 'DB update failed' });
  }
});

/* -------- Fetch Orders (Fast) -------- */
app.get('/api/orders', async (req, res) => {
  const role = req.headers['x-user-role'];
  const user = req.headers['x-user-name'];

  try {
    let sql = `
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
        created_at,                -- Shopify created_at
        design_image,
        design_assignee,
        DATE_FORMAT(dispatch_date, '%Y-%m-%d') AS dispatch_date   -- ✅ add this line
      FROM order_progress
      WHERE 1=1
    `;

    const params = [];

    if (role === 'design') {
      sql += `
        AND design_done = 0
        AND (design_assignee = ? OR (design_assignee IS NULL AND DATE(CONVERT_TZ(created_at, '+00:00', '+05:30')) = DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30'))))
      `;
      params.push(user);
    } else if (role === 'printing') {
      sql += ` AND design_done = 1 AND printing_done = 0 `;
    } else if (role === 'fusing') {
      sql += ` AND design_done = 1 AND printing_done = 1 AND fusing_done = 0 `;
    } else if (role === 'stitching') {
      sql += ` AND design_done = 1 AND printing_done = 1 AND fusing_done = 1 AND stitching_done = 0 `;
    } else if (role === 'shipping') {
      sql += ` AND design_done = 1 AND printing_done = 1 AND fusing_done = 1 AND stitching_done = 1 AND shipping_done = 0 `;
    }

    sql += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json({ orders: rows });

  } catch (err) {
    console.error('❌ Error loading orders:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});


/* -------- Sync Shopify Orders (Manual Refresh) -------- */
app.post('/api/sync-orders', async (req, res) => {
  try {
    const shopifyRes = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/orders.json`,
      {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_TOKEN },
        params: { status: 'any', limit: 50 }
      }
    );

    let imported = 0;

    for (const o of shopifyRes.data.orders) {
      const orderId = o.id.toString();
      const [exists] = await pool.execute(
        'SELECT 1 FROM order_progress WHERE order_id = ?',
        [orderId]
      );

      const customerName = `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim();
      const address = o.shipping_address
        ? `${o.shipping_address.address1 || ''}, ${o.shipping_address.city || ''}, ${o.shipping_address.province || ''}, ${o.shipping_address.country || ''}, ${o.shipping_address.zip || ''}`
        : '';

      if (!exists.length) {
        const shopifyCreatedAt = new Date(o.created_at);

        await pool.execute(
          `INSERT INTO order_progress (
            order_id, order_name, customer_name,
            total_price, fulfillment_status, payment_status,
            shipping_method, item_count, tags, address, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId, o.name, customerName,
            o.total_price || 0,
            o.fulfillment_status || '',
            o.financial_status || '',
            o.shipping_lines?.[0]?.title || '',
            o.line_items?.length || 0,
            o.tags || '',
            address,
            shopifyCreatedAt,
            shopifyCreatedAt
          ]
        );
        imported++;
      }
    }

    res.json({ success: true, imported });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ success: false, error: 'Shopify sync failed' });
  }
});


/* -------- Login -------- */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.execute(
      'SELECT role FROM users WHERE username = ? AND password = ?',
      [username, password]
    );

    if (!rows.length) return res.json({ success: false, message: 'Invalid creds' });

    res.json({ success: true, role: rows[0].role, username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

app.post('/api/quick-done', async (req, res) => {
  const { order_id, role } = req.body;

  const allowed = ['printing', 'fusing', 'stitching', 'shipping'];
  if (!order_id || !allowed.includes(role))
    return res.status(400).json({ error: 'Invalid request' });

  try {
    // use pool (not db), and set to 1 (tinyint) instead of 'Done'
    await pool.execute(
      `UPDATE order_progress SET ${role}_done = 1, updated_at = NOW() WHERE order_id = ? OR order_name = ?`,
      [String(order_id), String(order_id)]
    );

    // (optional) send WhatsApp here if you want; you had a call to sendWhatsAppToCustomer.
    res.json({ success: true });
  } catch (err) {
    console.error('Quick done error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});


app.get('/api/get-order/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const shortName = `#${id}`;
    const [rows] = await pool.execute(
      'SELECT * FROM order_progress WHERE order_name = ? OR order_id = ?',
      [shortName, id]
    );

    if (!rows.length) return res.json({ error: 'Order not found' });
    res.json({ order: rows[0] });
  } catch (err) {
    console.error('Get-order error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// SUPER FAST: date + total for last 7 days, single query
app.get('/api/dispatch-summary-totals', async (req, res) => {
  try {
    // One grouped query
    const [rows] = await pool.query(`
      SELECT DATE_FORMAT(dispatch_date, '%Y-%m-%d') AS date, COUNT(*) AS total
      FROM order_progress
      WHERE dispatch_date BETWEEN (CURDATE() - INTERVAL 6 DAY) AND CURDATE()
      GROUP BY date
      ORDER BY date ASC
    `);

    // Fill missing days with 0 (so table always has 7 rows)
    const map = Object.fromEntries(rows.map(r => [r.date, Number(r.total)]));
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0,10);
      out.push({ date: key, total: map[key] || 0 });
    }

    res.json(out);
  } catch (err) {
    console.error('dispatch totals error:', err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// ---------------- DISPATCH SUMMARY (UPCOMING 7 DAYS) ----------------
app.get('/api/dispatch-summary-upcoming', async (req, res) => {
  try {
    // Build 7-day calendar (today .. +6)
    const [calendar] = await pool.query(`
      SELECT DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL seq DAY), '%Y-%m-%d') AS date
      FROM (
        SELECT 0 AS seq UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL
        SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
      ) AS days
      ORDER BY seq
    `);

    // Aggregate in one scan for the whole 7-day window
    const [agg] = await pool.query(`
  SELECT
    DATE_FORMAT(dispatch_date, '%Y-%m-%d') AS date,
    COUNT(*) AS total,

    -- per-designer (edit names if needed)
    SUM(CASE WHEN design_assignee = 'srikanth'   THEN 1 ELSE 0 END) AS srikanth,
    SUM(CASE WHEN design_assignee = 'kushi'      THEN 1 ELSE 0 END) AS kushi,
    SUM(CASE WHEN design_assignee = 'shravanthi' THEN 1 ELSE 0 END) AS shravanthi,
    SUM(CASE WHEN design_assignee = 'mahesh'     THEN 1 ELSE 0 END) AS mahesh,
    SUM(CASE WHEN design_assignee = 'pawan'      THEN 1 ELSE 0 END) AS pawan,

    -- stage-wise pending for that dispatch date
    SUM(CASE WHEN design_done=1 AND printing_done=0 THEN 1 ELSE 0 END) AS printing_user,
    SUM(CASE WHEN design_done=1 AND printing_done=1 AND fusing_done=0 THEN 1 ELSE 0 END) AS fusing_user,
    SUM(CASE WHEN design_done=1 AND printing_done=1 AND fusing_done=1 AND stitching_done=0 THEN 1 ELSE 0 END) AS stitching_user,
    SUM(CASE WHEN design_done=1 AND printing_done=1 AND fusing_done=1 AND stitching_done=1 AND shipping_done=0 THEN 1 ELSE 0 END) AS shipping_user

  FROM order_progress
  WHERE dispatch_date BETWEEN CURDATE() AND (CURDATE() + INTERVAL 6 DAY)

  -- 👇 use the exact same expression as in SELECT
  GROUP BY DATE_FORMAT(dispatch_date, '%Y-%m-%d')
  ORDER BY DATE_FORMAT(dispatch_date, '%Y-%m-%d') ASC
`);


    // Map and fill zeros for days without records
    const map = Object.fromEntries(agg.map(r => [r.date, r]));
    const rows = calendar.map(c => ({
      date: c.date,
      total: Number(map[c.date]?.total || 0),
      srikanth:   Number(map[c.date]?.srikanth   || 0),
      kushi:      Number(map[c.date]?.kushi      || 0),
      shravanthi: Number(map[c.date]?.shravanthi || 0),
      mahesh:     Number(map[c.date]?.mahesh     || 0),
      pawan:      Number(map[c.date]?.pawan      || 0),
      printing_user:  Number(map[c.date]?.printing_user  || 0),
      fusing_user:    Number(map[c.date]?.fusing_user    || 0),
      stitching_user: Number(map[c.date]?.stitching_user || 0),
      shipping_user:  Number(map[c.date]?.shipping_user  || 0),
    }));

    res.json(rows);
  } catch (err) {
    console.error('Dispatch upcoming summary error:', err);
    res.status(500).json({ error: 'DB Error' });
  }
});


app.get('/api/weekly-summary', async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT username, role FROM users WHERE role NOT IN ('admin', 'customer')`
    );

    const summary = [];

    for (const user of users) {
      let query = '';
      let params = [];

      if (user.role === 'design') {
        query = `
          SELECT COUNT(*) AS orderCount
          FROM order_progress
          WHERE design_assignee = ?
          AND (design_done IS NULL OR design_done = 0)
        `;
        params = [user.username];
      } else if (user.role === 'printing') {
        query = `
          SELECT COUNT(*) AS orderCount
          FROM order_progress
          WHERE design_done = 1
          AND (printing_done IS NULL OR printing_done = 0)
        `;
      } else if (user.role === 'fusing') {
        query = `
          SELECT COUNT(*) AS orderCount
          FROM order_progress
          WHERE design_done = 1 AND printing_done = 1
          AND (fusing_done IS NULL OR fusing_done = 0)
        `;
      } else if (user.role === 'stitching') {
        query = `
          SELECT COUNT(*) AS orderCount
          FROM order_progress
          WHERE design_done = 1 AND printing_done = 1 AND fusing_done = 1
          AND (stitching_done IS NULL OR stitching_done = 0)
        `;
      } else if (user.role === 'shipping') {
        query = `
          SELECT COUNT(*) AS orderCount
          FROM order_progress
          WHERE design_done = 1 AND printing_done = 1 AND fusing_done = 1 AND stitching_done = 1
          AND (shipping_done IS NULL OR shipping_done = 0)
        `;
      }

      const [rows] = await pool.query(query, params);
      summary.push({ username: user.username, count: rows[0].orderCount || 0 });
    }

    res.json({ users: summary });
  } catch (err) {
    console.error('Weekly summary error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});




// ---------------- WEEKLY SUMMARY TABLE ----------------
app.get('/api/weekly-summary-table', async (req, res) => {
  try {
    const today = new Date();
    const results = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(today.getDate() - i);
      const formattedDate = date.toISOString().split('T')[0]; // yyyy-mm-dd

      const [designers] = await pool.query(
        `SELECT username FROM users WHERE role='design'`
      );

      const dayData = { date: formattedDate };

      // Designer-wise pending for that exact date
      for (const designer of designers) {
        const [rows] = await pool.query(
          `SELECT COUNT(*) AS cnt FROM order_progress
           WHERE design_assignee = ? 
           AND design_done = 0 
           AND DATE(CONVERT_TZ(created_at, '+00:00', '+05:30')) = ?`,
          [designer.username, formattedDate]
        );
        dayData[designer.username] = rows[0].cnt;
      }

      // Stage-wise pending for that exact date
      const stages = [
        { name: 'printing', condition: 'design_done = 1 AND printing_done = 0' },
        { name: 'fusing', condition: 'design_done = 1 AND printing_done = 1 AND fusing_done = 0' },
        { name: 'stitching', condition: 'design_done = 1 AND printing_done = 1 AND fusing_done = 1 AND stitching_done = 0' },
        { name: 'shipping', condition: 'design_done = 1 AND printing_done = 1 AND fusing_done = 1 AND stitching_done = 1 AND shipping_done = 0' }
      ];

      for (const stage of stages) {
        const [rows] = await pool.query(
          `SELECT COUNT(*) AS cnt FROM order_progress
           WHERE ${stage.condition}
           AND DATE(CONVERT_TZ(created_at, '+00:00', '+05:30')) = ?`,
          [formattedDate]
        );
        dayData[`${stage.name}_user`] = rows[0].cnt;
      }

      results.push(dayData);
    }

    res.json(results.reverse());
  } catch (err) {
    console.error('Error fetching weekly summary:', err);
    res.status(500).json({ error: 'DB Error' });
  }
});


// Get pending orders for a specific user in last 7 days
app.get('/api/user-orders/:username', async (req, res) => {
  try {
    const { username } = req.params;

    const [roleData] = await pool.query(
      `SELECT role FROM users WHERE username = ?`,
      [username]
    );

    if (!roleData.length) return res.json({ orders: [] });

    const role = roleData[0].role;

    let query = '';
    let params = [];

    if (role === 'design') {
      query = `
        SELECT order_id, order_name, customer_name, 
               IF(design_done = 1, 'Done', 'Pending') AS status,
               updated_at
        FROM order_progress
        WHERE design_assignee = ? AND design_done = 0
        ORDER BY updated_at DESC`;
      params = [username];

    } else if (role === 'printing') {
      query = `
        SELECT order_id, order_name, customer_name, 
               IF(printing_done = 1, 'Done', 'Pending') AS status,
               updated_at
        FROM order_progress
        WHERE design_done = 1 AND printing_done = 0
        ORDER BY updated_at DESC`;

    } else if (role === 'fusing') {
      query = `
        SELECT order_id, order_name, customer_name, 
               IF(fusing_done = 1, 'Done', 'Pending') AS status,
               updated_at
        FROM order_progress
        WHERE design_done = 1 AND printing_done = 1 AND fusing_done = 0
        ORDER BY updated_at DESC`;

    } else if (role === 'stitching') {
      query = `
        SELECT order_id, order_name, customer_name, 
               IF(stitching_done = 1, 'Done', 'Pending') AS status,
               updated_at
        FROM order_progress
        WHERE design_done = 1 AND printing_done = 1 AND fusing_done = 1 AND stitching_done = 0
        ORDER BY updated_at DESC`;

    } else if (role === 'shipping') {
      query = `
        SELECT order_id, order_name, customer_name, 
               IF(shipping_done = 1, 'Done', 'Pending') AS status,
               updated_at
        FROM order_progress
        WHERE design_done = 1 AND printing_done = 1 AND fusing_done = 1 AND stitching_done = 1 AND shipping_done = 0
        ORDER BY updated_at DESC`;
    }

    const [orders] = await pool.query(query, params);
    res.json({ orders });
  } catch (err) {
    console.error('User orders fetch error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});



app.post('/api/pending-summary', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Date is required' });

  try {
    const [rows] = await pool.query(`
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

/* -------- Static login page -------- */
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* -------- Start server -------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

