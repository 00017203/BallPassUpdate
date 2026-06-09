// ============================================================
//  BallPass – server.js
//  Production-ready backend using PostgreSQL (via pg library).
//  Connects to DATABASE_URL environment variable on Render,
//  falls back to local SQLite-style logic for local dev via pg.
// ============================================================

const express   = require("express");
const bcrypt    = require("bcryptjs");
const session   = require("express-session");
const path      = require("path");
const { Pool }  = require("pg");           // PostgreSQL client

const app  = express();
const PORT = process.env.PORT || 3000;     // Render sets PORT automatically

// ── DATABASE SETUP ────────────────────────────────────────────
// On Render: DATABASE_URL is set automatically when you attach a PostgreSQL DB.
// Locally: set DATABASE_URL in a .env file or use the fallback below.

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }   // Required for Render's managed PostgreSQL
    : false                           // No SSL needed for local development
});

// ── Helper: run a query ───────────────────────────────────────
// All database calls go through this function.
// It borrows a connection from the pool, runs the query, and releases it.
async function query(sql, params = []) {
  const client = await pool.connect();  // Get a connection from the pool
  try {
    const result = await client.query(sql, params);  // Run the SQL
    return result;                                   // Return full result object
  } finally {
    client.release();  // Always release the connection back to the pool
  }
}

// ── Helper: get first row or null ────────────────────────────
async function queryOne(sql, params = []) {
  const result = await query(sql, params);
  return result.rows.length ? result.rows[0] : null;  // First row or null
}

// ── Helper: get all rows ──────────────────────────────────────
async function queryAll(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;  // Array of row objects
}

// ── Helper: INSERT and return the new row ─────────────────────
async function run(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;  // Returns the RETURNING clause row
}

// ── CREATE TABLES ─────────────────────────────────────────────
// PostgreSQL syntax — $1, $2 placeholders instead of ?
// SERIAL = auto-incrementing integer (PostgreSQL equivalent of AUTOINCREMENT)
// ON CONFLICT DO NOTHING = safe to run multiple times

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      name       TEXT    NOT NULL,
      email      TEXT    NOT NULL UNIQUE,
      password   TEXT    NOT NULL,
      role       TEXT    NOT NULL DEFAULT 'buyer',
      verified   INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id          SERIAL PRIMARY KEY,
      match       TEXT    NOT NULL,
      price       NUMERIC NOT NULL,
      location    TEXT    NOT NULL,
      stadium     TEXT    NOT NULL DEFAULT 'General Stadium',
      match_date  DATE    NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
      section     TEXT    NOT NULL DEFAULT 'A',
      seat_number TEXT    NOT NULL DEFAULT '-',
      seller_id   INTEGER NOT NULL REFERENCES users(id),
      status      TEXT    NOT NULL DEFAULT 'available',
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id          SERIAL PRIMARY KEY,
      ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
      buyer_id    INTEGER NOT NULL REFERENCES users(id),
      match       TEXT    NOT NULL,
      price       NUMERIC NOT NULL,
      location    TEXT    NOT NULL,
      seat_number TEXT    NOT NULL DEFAULT '-',
      status      TEXT    NOT NULL DEFAULT 'completed',
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS verify_codes (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      code       TEXT    NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Seed demo data only if no tickets exist yet
  const count = await queryOne("SELECT COUNT(*) as c FROM tickets");
  if (parseInt(count.c) === 0) {
    const hashed = bcrypt.hashSync("demo1234", 10);
    // ON CONFLICT DO NOTHING prevents error if demo account already exists
    await query(
      "INSERT INTO users (name, email, password, verified) VALUES ($1, $2, $3, 1) ON CONFLICT (email) DO NOTHING",
      ["Demo Seller", "demo@ballpass.com", hashed]
    );

    const seller = await queryOne("SELECT id FROM users WHERE email = 'demo@ballpass.com'");
    const sid = seller.id;

    const seeds = [
      ["Arsenal vs Chelsea",       120, "London",    "Emirates Stadium",  "2026-06-15", "B", "B-14"],
      ["Barcelona vs Real Madrid", 200, "Barcelona", "Camp Nou",          "2026-06-22", "C", "C-07"],
      ["AC Milan vs Inter",        150, "Milan",     "San Siro",          "2026-07-01", "A", "A-22"],
      ["Lokomotiv vs Pakhtakor",    45, "Tashkent",  "Lokomotiv Stadium", "2026-06-18", "D", "D-05"],
      ["PSG vs Marseille",         180, "Paris",     "Parc des Princes",  "2026-07-10", "A", "A-31"],
      ["Liverpool vs Man City",    220, "Liverpool", "Anfield",           "2026-07-05", "B", "B-09"],
    ];

    for (const s of seeds) {
      await query(
        `INSERT INTO tickets (match, price, location, stadium, match_date, section, seat_number, seller_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [...s, sid]
      );
    }
    console.log("Demo data seeded.");
  }

  // Always ensure demo account is verified
  await query("UPDATE users SET verified=1 WHERE email='demo@ballpass.com'");
  console.log("Database ready.");
}

// ── MIDDLEWARE ────────────────────────────────────────────────
// Root route BEFORE static so landing.html serves at /
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "ballpass-secret-2024",
  // SESSION_SECRET should be set as an environment variable on Render
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 86400000,  // 24 hours
    secure: process.env.NODE_ENV === "production",
    // secure:true sends cookie only over HTTPS — correct for Render production
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax"
    // sameSite:none required when secure:true on cross-origin deployments
  }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ message: "Please log in first." });
  next();
}

// ── AUTH ROUTES ───────────────────────────────────────────────

app.get("/me", (req, res) => res.json({ user: req.session.user || null }));

app.post("/register", async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: "All fields are required." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ message: "Invalid email address." });
  if (password.length < 6)
    return res.status(400).json({ message: "Password must be at least 6 characters." });

  const exists = await queryOne("SELECT id FROM users WHERE email=$1", [email]);
  if (exists) return res.status(400).json({ message: "Email already registered." });

  const hashed = bcrypt.hashSync(password, 10);
  const user = await run(
    "INSERT INTO users (name, email, password, role) VALUES ($1,$2,$3,$4) RETURNING id, name, email, role",
    [name, email, hashed, role || "buyer"]
  );

  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.status(201).json({ message: "Account created! Choose your mode.", user: req.session.user });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: "Email and password required." });

  const user = await queryOne("SELECT * FROM users WHERE email=$1", [email]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ message: "Invalid email or password." });

  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.json({ message: "Login successful.", user: req.session.user });
});

app.post("/logout", (req, res) => req.session.destroy(() => res.json({ message: "Logged out." })));

app.post("/set-mode", (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: "Not logged in." });
  const { mode } = req.body;
  if (!["buyer", "seller"].includes(mode)) return res.status(400).json({ message: "Invalid mode." });
  req.session.user.mode = mode;
  res.json({ mode });
});

// ── TICKET ROUTES ─────────────────────────────────────────────

app.get("/tickets", async (req, res) => {
  const tickets = await queryAll(
    `SELECT t.*, u.name AS seller_name FROM tickets t
     JOIN users u ON u.id = t.seller_id
     WHERE t.status = 'available' ORDER BY t.id DESC`
  );
  res.json(tickets);
});

app.get("/tickets/:id", async (req, res) => {
  const ticket = await queryOne(
    `SELECT t.*, u.name AS seller_name FROM tickets t
     JOIN users u ON u.id = t.seller_id WHERE t.id = $1`,
    [req.params.id]
  );
  if (!ticket) return res.status(404).json({ message: "Ticket not found." });
  res.json(ticket);
});

app.post("/tickets", requireAuth, async (req, res) => {
  const seller = await queryOne("SELECT verified FROM users WHERE id=$1", [req.session.user.id]);
  if (!seller || !seller.verified)
    return res.status(403).json({ message: "You must verify your account before listing tickets.", requiresVerification: true });

  const { match, price, location, stadium, match_date, section, seat_number } = req.body;
  if (!match || !price || !location)
    return res.status(400).json({ message: "Match, price and location are required." });
  if (isNaN(price) || Number(price) <= 0)
    return res.status(400).json({ message: "Price must be a positive number." });
  if (match.trim().length < 5)
    return res.status(400).json({ message: "Match name must be at least 5 characters." });

  const ticket = await run(
    `INSERT INTO tickets (match, price, location, stadium, match_date, section, seat_number, seller_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      match.trim(), Number(price), location.trim(),
      stadium || "General Stadium",
      match_date || new Date().toISOString().split("T")[0],
      section || "A", seat_number || "-",
      req.session.user.id
    ]
  );
  res.status(201).json(ticket);
});

app.delete("/tickets/:id", requireAuth, async (req, res) => {
  const ticket = await queryOne("SELECT * FROM tickets WHERE id=$1", [req.params.id]);
  if (!ticket) return res.status(404).json({ message: "Ticket not found." });
  if (ticket.seller_id !== req.session.user.id)
    return res.status(403).json({ message: "You can only delete your own listings." });
  await query("DELETE FROM tickets WHERE id=$1", [req.params.id]);
  res.json({ message: "Ticket deleted." });
});

// ── PURCHASE ROUTE ────────────────────────────────────────────

app.post("/buy/:id", requireAuth, async (req, res) => {
  const buyer = await queryOne("SELECT verified FROM users WHERE id=$1", [req.session.user.id]);
  if (!buyer || !buyer.verified)
    return res.status(403).json({ message: "You must verify your account before buying tickets.", requiresVerification: true });

  const ticket = await queryOne("SELECT * FROM tickets WHERE id=$1 AND status='available'", [req.params.id]);
  if (!ticket) return res.status(404).json({ message: "Ticket not available." });
  if (ticket.seller_id === req.session.user.id)
    return res.status(400).json({ message: "Cannot buy your own ticket." });

  await query("UPDATE tickets SET status='sold' WHERE id=$1", [ticket.id]);
  const tx = await run(
    `INSERT INTO transactions (ticket_id, buyer_id, match, price, location, seat_number)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [ticket.id, req.session.user.id, ticket.match, ticket.price, ticket.location, ticket.seat_number]
  );
  res.status(201).json({ message: "Purchase successful.", transaction: tx });
});

// ── PROFILE ROUTES ────────────────────────────────────────────

app.get("/transactions", requireAuth, async (req, res) => {
  const txs = await queryAll(
    "SELECT * FROM transactions WHERE buyer_id=$1 ORDER BY id DESC",
    [req.session.user.id]
  );
  res.json(txs);
});

app.get("/my-listings", requireAuth, async (req, res) => {
  const listings = await queryAll(
    "SELECT * FROM tickets WHERE seller_id=$1 ORDER BY id DESC",
    [req.session.user.id]
  );
  res.json(listings);
});

// ── ANALYTICS ─────────────────────────────────────────────────

app.get("/api/stats", async (req, res) => {
  const [totalTickets, totalSold, totalUsers, totalRevenue] = await Promise.all([
    queryOne("SELECT COUNT(*) as c FROM tickets"),
    queryOne("SELECT COUNT(*) as c FROM tickets WHERE status='sold'"),
    queryOne("SELECT COUNT(*) as c FROM users"),
    queryOne("SELECT COALESCE(SUM(price),0) as s FROM transactions"),
  ]);

  const [byLocation, avgPriceByLocation, txByDay, priceRanges] = await Promise.all([
    queryAll(`SELECT location, COUNT(*) as count FROM tickets WHERE status='available'
              GROUP BY location ORDER BY count DESC LIMIT 6`),
    queryAll(`SELECT location, ROUND(AVG(price)::numeric,2) as avg_price
              FROM tickets GROUP BY location ORDER BY avg_price DESC LIMIT 6`),
    queryAll(`SELECT DATE(created_at) as day, COUNT(*) as count FROM transactions
              WHERE created_at >= NOW() - INTERVAL '7 days'
              GROUP BY day ORDER BY day`),
    queryAll(`SELECT
                CASE WHEN price<50  THEN 'Under $50'
                     WHEN price<100 THEN '$50-$99'
                     WHEN price<150 THEN '$100-$149'
                     WHEN price<200 THEN '$150-$199'
                     ELSE '$200+' END as range,
                COUNT(*) as count FROM tickets GROUP BY range`),
  ]);

  res.json({
    summary: {
      totalTickets: parseInt(totalTickets.c),
      totalSold:    parseInt(totalSold.c),
      totalUsers:   parseInt(totalUsers.c),
      totalRevenue: parseFloat(totalRevenue.s),
    },
    byLocation, avgPriceByLocation, txByDay, priceRanges,
  });
});

app.get("/api/seller-stats", requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  const listings = await queryAll("SELECT * FROM tickets WHERE seller_id=$1", [uid]);
  const sold      = listings.filter(t => t.status === "sold");
  const active    = listings.filter(t => t.status === "available");

  const totalRevenue = sold.reduce((s, t) => s + parseFloat(t.price), 0).toFixed(2);
  const avgPrice     = listings.length
    ? (listings.reduce((s, t) => s + parseFloat(t.price), 0) / listings.length).toFixed(2)
    : 0;
  const convRate = listings.length ? Math.round((sold.length / listings.length) * 100) : 0;

  const revMap = {};
  sold.forEach(t => { revMap[t.match] = (revMap[t.match] || 0) + parseFloat(t.price); });
  const topMatch = Object.keys(revMap).sort((a, b) => revMap[b] - revMap[a])[0] || null;

  const secMap = {};
  listings.forEach(t => { secMap[t.section || "?"] = (secMap[t.section || "?"] || 0) + 1; });
  const topSection = Object.keys(secMap).sort((a, b) => secMap[b] - secMap[a])[0] || null;

  res.json({ totalRevenue, totalSold: sold.length, totalActive: active.length, avgPrice, convRate, topMatch, topSection });
});

// ── VERIFICATION ──────────────────────────────────────────────

app.post("/send-code", requireAuth, async (req, res) => {
  const code    = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await query("DELETE FROM verify_codes WHERE user_id=$1", [req.session.user.id]);
  await query(
    "INSERT INTO verify_codes (user_id, code, expires_at) VALUES ($1,$2,$3)",
    [req.session.user.id, code, expires]
  );

  console.log(`Verification code for ${req.session.user.email}: ${code}`);
  res.json({ message: "Code sent! Check the server logs (demo mode).", code });
  // In production: send via email instead of returning in response
});

app.post("/verify-code", requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: "Code is required." });

  const record = await queryOne(
    "SELECT * FROM verify_codes WHERE user_id=$1 AND used=0 ORDER BY id DESC LIMIT 1",
    [req.session.user.id]
  );
  if (!record) return res.status(400).json({ message: "No code found. Please request a new one." });
  if (new Date(record.expires_at) < new Date())
    return res.status(400).json({ message: "Code has expired. Please request a new one." });
  if (record.code !== code.trim())
    return res.status(400).json({ message: "Incorrect code. Please try again." });

  await query("UPDATE verify_codes SET used=1 WHERE id=$1", [record.id]);
  await query("UPDATE users SET verified=1 WHERE id=$1", [req.session.user.id]);
  req.session.user.verified = 1;
  res.json({ message: "Account verified successfully!" });
});

app.get("/verification-status", requireAuth, async (req, res) => {
  const user = await queryOne("SELECT verified FROM users WHERE id=$1", [req.session.user.id]);
  res.json({ verified: user ? user.verified === 1 : false });
});

// ── START ──────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`BallPass running on port ${PORT}`);
  });
}).catch(err => console.error("Startup error:", err));
