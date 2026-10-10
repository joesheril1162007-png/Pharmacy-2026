require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "pharmacy_db",
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true
});

app.use(express.json({ limit: "1mb" }));
app.use(session({
  name: "pharmacy.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const requireAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: "Please sign in to continue." });
const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function init() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(80) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, role ENUM('admin','pharmacist') NOT NULL DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query(`CREATE TABLE IF NOT EXISTS medicines (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(150) NOT NULL, generic_name VARCHAR(150) DEFAULT '',
      category VARCHAR(80) DEFAULT 'General', batch_no VARCHAR(80) NOT NULL, manufacturer VARCHAR(150) DEFAULT '',
      quantity INT NOT NULL DEFAULT 0, reorder_level INT NOT NULL DEFAULT 10, unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
      expiry_date DATE NOT NULL, prescription_required BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY unique_batch (name, batch_no))`);
    await conn.query(`CREATE TABLE IF NOT EXISTS sales (
      id INT AUTO_INCREMENT PRIMARY KEY, invoice_no VARCHAR(40) NOT NULL UNIQUE,
      customer_name VARCHAR(150) DEFAULT 'Walk-in customer', subtotal DECIMAL(10,2) NOT NULL,
      tax DECIMAL(10,2) NOT NULL DEFAULT 0, total DECIMAL(10,2) NOT NULL,
      sold_by INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_sales_user FOREIGN KEY (sold_by) REFERENCES users(id) ON DELETE SET NULL)`);
    await conn.query(`CREATE TABLE IF NOT EXISTS sale_items (
      id INT AUTO_INCREMENT PRIMARY KEY, sale_id INT NOT NULL, medicine_id INT NOT NULL,
      medicine_name VARCHAR(150) NOT NULL, quantity INT NOT NULL, unit_price DECIMAL(10,2) NOT NULL,
      line_total DECIMAL(10,2) NOT NULL,
      CONSTRAINT fk_item_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      CONSTRAINT fk_item_medicine FOREIGN KEY (medicine_id) REFERENCES medicines(id))`);
    const [users] = await conn.query("SELECT id FROM users WHERE username = ?", ["admin"]);
    if (!users.length) {
      const hash = await bcrypt.hash("Admin@123", 12);
      await conn.query("INSERT INTO users (username,password_hash,role) VALUES (?,?,?)", ["admin", hash, "admin"]);
      console.log("Created first login: admin / Admin@123 — change it after signing in.");
    }
  } finally {
    conn.release();
  }
}

app.post("/api/login", asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!username || !password) return res.status(400).json({ error: "Enter username and password." });
  const [rows] = await pool.query("SELECT id, username, password_hash, role FROM users WHERE username = ?", [username]);
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  req.session.user = { id: rows[0].id, username: rows[0].username, role: rows[0].role };
  res.json({ user: req.session.user });
}));
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json({ user: req.session.user || null }));

app.get("/api/dashboard", requireAuth, asyncRoute(async (req, res) => {
  const [[medicine]] = await pool.query("SELECT COUNT(*) AS medicineCount, COALESCE(SUM(quantity),0) AS units FROM medicines");
  const [[sales]] = await pool.query("SELECT COUNT(*) AS salesCount, COALESCE(SUM(total),0) AS revenue FROM sales WHERE DATE(created_at)=CURDATE()");
  const [[low]] = await pool.query("SELECT COUNT(*) AS count FROM medicines WHERE quantity <= reorder_level");
  const [[expired]] = await pool.query("SELECT COUNT(*) AS count FROM medicines WHERE expiry_date < CURDATE()");
  const [[expiring]] = await pool.query("SELECT COUNT(*) AS count FROM medicines WHERE expiry_date >= CURDATE() AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 90 DAY)");
  const [recent] = await pool.query("SELECT id, invoice_no, customer_name, total, created_at FROM sales ORDER BY id DESC LIMIT 6");
  res.json({ medicineCount: medicine.medicineCount, units: medicine.units, salesCount: sales.salesCount,
    revenue: sales.revenue, lowStock: low.count, expired: expired.count, expiring: expiring.count, recent });
}));

app.get("/api/medicines", requireAuth, asyncRoute(async (req, res) => {
  const q = `%${String(req.query.q || "").trim()}%`;
  const [rows] = await pool.query(
    `SELECT *, CASE WHEN expiry_date < CURDATE() THEN 'Expired'
      WHEN expiry_date <= DATE_ADD(CURDATE(), INTERVAL 90 DAY) THEN 'Expiring soon'
      WHEN quantity <= reorder_level THEN 'Low stock' ELSE 'In stock' END AS status
     FROM medicines WHERE name LIKE ? OR generic_name LIKE ? OR batch_no LIKE ? OR category LIKE ?
     ORDER BY name ASC`, [q,q,q,q]);
  res.json(rows);
}));

app.post("/api/medicines", requireAuth, asyncRoute(async (req, res) => {
  const m = req.body || {};
  const name = String(m.name || "").trim();
  const batch = String(m.batch_no || "").trim();
  const qty = Number(m.quantity);
  const price = Number(m.unit_price);
  const reorder = Number(m.reorder_level ?? 10);
  if (!name || !batch || !m.expiry_date || !Number.isInteger(qty) || qty < 0 ||
      !Number.isFinite(price) || price < 0 || !Number.isInteger(reorder) || reorder < 0) {
    return res.status(400).json({ error: "Enter a medicine name, batch, valid expiry date, quantity and price." });
  }
  const values = [name, String(m.generic_name||"").trim(), String(m.category||"General").trim(),
    batch, String(m.manufacturer||"").trim(), qty, reorder, money(price), m.expiry_date,
    Boolean(m.prescription_required)];
  try {
    const [result] = await pool.query(`INSERT INTO medicines
      (name,generic_name,category,batch_no,manufacturer,quantity,reorder_level,unit_price,expiry_date,prescription_required)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, values);
    const [rows] = await pool.query("SELECT * FROM medicines WHERE id=?", [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "This medicine and batch already exist." });
    throw e;
  }
}));

app.put("/api/medicines/:id", requireAuth, asyncRoute(async (req, res) => {
  const m = req.body || {};
  const qty = Number(m.quantity), price = Number(m.unit_price), reorder = Number(m.reorder_level ?? 10);
  if (!String(m.name||"").trim() || !String(m.batch_no||"").trim() || !m.expiry_date ||
      !Number.isInteger(qty) || qty < 0 || !Number.isFinite(price) || price < 0 ||
      !Number.isInteger(reorder) || reorder < 0) return res.status(400).json({ error: "Please check the required fields." });
  try {
    const [result] = await pool.query(`UPDATE medicines SET name=?,generic_name=?,category=?,batch_no=?,manufacturer=?,
      quantity=?,reorder_level=?,unit_price=?,expiry_date=?,prescription_required=? WHERE id=?`,
      [String(m.name).trim(),String(m.generic_name||""),String(m.category||"General"),String(m.batch_no).trim(),
       String(m.manufacturer||""),qty,reorder,money(price),m.expiry_date,Boolean(m.prescription_required),req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Medicine not found." });
    const [rows] = await pool.query("SELECT * FROM medicines WHERE id=?", [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "This medicine and batch already exist." });
    throw e;
  }
}));

app.delete("/api/medicines/:id", requireAuth, asyncRoute(async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM medicines WHERE id=?", [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Medicine not found." });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "ER_ROW_IS_REFERENCED_2") return res.status(409).json({ error: "This medicine has sales history and cannot be deleted." });
    throw e;
  }
}));

app.post("/api/sales", requireAuth, asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const customer = String(req.body.customer_name || "Walk-in customer").trim().slice(0,150);
  const taxRate = Number(req.body.tax_rate || 0);
  if (!items.length || items.length > 100 || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 28) {
    return res.status(400).json({ error: "Add at least one medicine and use a valid tax rate (0–28%)." });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let subtotal = 0;
    const normalized = [];
    for (const item of items) {
      const id = Number(item.medicine_id), quantity = Number(item.quantity);
      if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1) throw new Error("Each item needs a valid medicine and quantity.");
      const [rows] = await conn.query("SELECT * FROM medicines WHERE id=? FOR UPDATE", [id]);
      if (!rows.length) throw new Error("A selected medicine could not be found.");
      const m = rows[0];
      if (m.expiry_date < new Date().toISOString().slice(0,10)) throw new Error(`${m.name} is expired and cannot be sold.`);
      if (m.quantity < quantity) throw new Error(`Not enough stock for ${m.name}. Available: ${m.quantity}.`);
      if (m.prescription_required && !req.body.prescription_confirmed) throw new Error(`${m.name} requires prescription verification before sale.`);
      const price = Number(m.unit_price), line = money(price * quantity);
      subtotal = money(subtotal + line);
      normalized.push({ m, quantity, price, line });
    }
    const tax = money(subtotal * taxRate / 100), total = money(subtotal + tax);
    const invoice = "INV-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
    const [sale] = await conn.query("INSERT INTO sales (invoice_no,customer_name,subtotal,tax,total,sold_by) VALUES (?,?,?,?,?,?)",
      [invoice, customer || "Walk-in customer", subtotal, tax, total, req.session.user.id]);
    for (const item of normalized) {
      await conn.query("INSERT INTO sale_items (sale_id,medicine_id,medicine_name,quantity,unit_price,line_total) VALUES (?,?,?,?,?,?)",
        [sale.insertId,item.m.id,item.m.name,item.quantity,item.price,item.line]);
      await conn.query("UPDATE medicines SET quantity=quantity-? WHERE id=?", [item.quantity,item.m.id]);
    }
    await conn.commit();
    res.status(201).json({ id: sale.insertId, invoice_no: invoice, customer_name: customer || "Walk-in customer", subtotal, tax, total, items: normalized.map(i=>({name:i.m.name,quantity:i.quantity,unit_price:i.price,line_total:i.line})), created_at: new Date().toISOString() });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message || "Unable to complete sale." });
  } finally { conn.release(); }
}));

app.get("/api/sales", requireAuth, asyncRoute(async (req, res) => {
  const [rows] = await pool.query("SELECT id,invoice_no,customer_name,subtotal,tax,total,created_at FROM sales ORDER BY id DESC LIMIT 300");
  res.json(rows);
}));
app.get("/api/reports", requireAuth, asyncRoute(async (req, res) => {
  const [daily] = await pool.query(`SELECT DATE(created_at) AS day, COUNT(*) AS bills, COALESCE(SUM(total),0) AS revenue
    FROM sales WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY) GROUP BY DATE(created_at) ORDER BY day DESC`);
  const [top] = await pool.query(`SELECT medicine_name AS name, SUM(quantity) AS quantity, SUM(line_total) AS revenue
    FROM sale_items GROUP BY medicine_id,medicine_name ORDER BY quantity DESC LIMIT 8`);
  res.json({ daily, top });
}));

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Server error. Check the terminal and database configuration." });
});

init().then(() => app.listen(PORT, () => console.log(`Pharmacy Management System running at http://localhost:${PORT}`)))
  .catch(err => { console.error("Startup failed. Check MySQL and .env settings.", err); process.exit(1); });
