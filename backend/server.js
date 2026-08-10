require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || "development";
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Refusing to start without it.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set. Refusing to start without it.");
  process.exit(1);
}

// Render (and most PaaS hosts) put the app behind a reverse proxy. Without this,
// express-rate-limit can't correctly read the client IP from X-Forwarded-For and
// throws a ValidationError on every request. "1" = trust exactly one hop, which
// matches Render's setup.
if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ---------- Security & core middleware ----------
app.use(helmet());
app.disable("x-powered-by");

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) {
        return /^https?:\/\/localhost(:\d+)?$/.test(origin)
          ? callback(null, true)
          : callback(new Error("Not allowed by CORS"));
      }
      return allowedOrigins.includes(origin)
        ? callback(null, true)
        : callback(new Error("Not allowed by CORS"));
    }
  })
);

app.use(express.json({ limit: "50kb" }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const voiceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, slow down." }
});

// Auth endpoints get their own strict limiter to slow down credential stuffing / brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts, try again later." }
});

// ---------- Database (Postgres, e.g. Neon) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      date DATE NOT NULL,
      type TEXT NOT NULL DEFAULT 'expense'
    )
  `);
  // Migration for databases created before "type" existed — safe to run every startup.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'expense'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id)`);
}

// ---------- Date helpers ----------
function makeUTC(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}
function toISO(date) {
  return date.toISOString().slice(0, 10);
}
function isValidISODate(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !isNaN(d.getTime());
}

// ---------- Local rule-based voice-text parser (no external AI, no API key, no cost) ----------
const EXPENSE_KEYWORDS = {
  food: ["food", "lunch", "dinner", "breakfast", "grocery", "groceries", "snack", "restaurant", "coffee", "tea", "meal", "pizza", "burger", "eat", "eating"],
  travel: ["travel", "uber", "ola", "taxi", "cab", "bus", "train", "flight", "fuel", "petrol", "diesel", "metro", "auto", "ride"],
  shopping: ["shopping", "shirt", "shoes", "clothes", "amazon", "flipkart", "dress", "mall", "bought", "buy"],
  bills: ["bill", "bills", "electricity", "recharge", "rent", "wifi", "internet", "subscription"],
  health: ["health", "medicine", "doctor", "hospital", "pharmacy", "medical", "clinic"],
  entertainment: ["movie", "entertainment", "netflix", "game", "concert", "party", "outing"]
};

const INCOME_KEYWORDS = {
  salary: ["salary", "paycheck", "wages"],
  refund: ["refund", "cashback", "returned my money", "return"],
  gift: ["gift", "gave me", "friend gave", "birthday money"]
};

const INCOME_TRIGGER_WORDS = [
  "gave me", "received", "got back", "refund", "salary", "cashback",
  "earned", "credited", "returned", "paid me", "got paid"
];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const RELATIVE_UNIT_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30
};

function extractDateFromText(lower) {
  const now = new Date();

  // explicit "<month> <day>(st/nd/rd/th)? <year>?"
  // explicit "<month> <day>(st/nd/rd/th)? <year>?" — anchored to real month names so a
  // word+number pair earlier in the sentence (e.g. "got 20") can never be mistaken for it
  const monthPattern = MONTHS.join("|");
  let m = lower.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`));
  if (m) {
    const month = MONTHS.indexOf(m[1]);
    const day = parseInt(m[2], 10);
    const year = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
    if (day >= 1 && day <= 31) {
      return { date: toISO(makeUTC(year, month, day)), raw: m[0] };
    }
  }

  // ISO date yyyy-mm-dd
  m = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    return { date: toISO(makeUTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))), raw: m[0] };
  }

  // "N days/weeks/months/years back/ago" — N can be a digit or spelled out
  const numWordPattern = Object.keys(RELATIVE_UNIT_WORDS).join("|");
  m = lower.match(new RegExp(`\\b(\\d+|${numWordPattern})\\s*(day|days|week|weeks|month|months|year|years)\\s*(back|ago)\\b`));
  if (m) {
    const num = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : RELATIVE_UNIT_WORDS[m[1]];
    const unit = m[2];
    let d = makeUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (unit.startsWith("day")) d.setUTCDate(d.getUTCDate() - num);
    if (unit.startsWith("week")) d.setUTCDate(d.getUTCDate() - num * 7);
    if (unit.startsWith("month")) d.setUTCMonth(d.getUTCMonth() - num);
    if (unit.startsWith("year")) d.setUTCFullYear(d.getUTCFullYear() - num);
    return { date: toISO(d), raw: m[0] };
  }

  // literal phrases
  const literals = [
    ["day before yesterday", -2],
    ["yesterday", -1],
    ["today", 0],
    ["last week", -7],
    ["last month", null],
    ["last year", null]
  ];
  for (const [phrase, deltaDays] of literals) {
    if (lower.includes(phrase)) {
      let d = makeUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      if (phrase === "last month") d.setUTCMonth(d.getUTCMonth() - 1);
      else if (phrase === "last year") d.setUTCFullYear(d.getUTCFullYear() - 1);
      else d.setUTCDate(d.getUTCDate() + deltaDays);
      return { date: toISO(d), raw: phrase };
    }
  }

  return { date: toISO(makeUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), raw: null };
}

function detectType(lower) {
  return INCOME_TRIGGER_WORDS.some((w) => lower.includes(w)) ? "income" : "expense";
}

function detectCategory(lower, type) {
  const map = type === "income" ? INCOME_KEYWORDS : EXPENSE_KEYWORDS;
  for (const [category, words] of Object.entries(map)) {
    if (words.some((w) => lower.includes(w))) return category;
  }
  return "other";
}

function extractAmountFromText(lower, dateRaw) {
  let masked = lower;
  if (dateRaw) masked = masked.split(dateRaw).join(" ");
  // mask standalone 4-digit years so they're never mistaken for the amount
  masked = masked.replace(/\b(19|20)\d{2}\b/g, " ");
  const m = masked.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function parseExpenseText(text) {
  const lower = text.toLowerCase().trim();
  const { date, raw: dateRaw } = extractDateFromText(lower);
  const type = detectType(lower);
  const category = detectCategory(lower, type);
  const amount = extractAmountFromText(lower, dateRaw);
  return { amount, category, type, date };
}

// ---------- Input validation ----------
const MAX_AMOUNT = 10000000;
const MAX_CATEGORY_LEN = 40;

function validateExpenseInput({ amount, category, date, type }) {
  const errors = [];
  const numAmount = Number(amount);

  if (amount === undefined || amount === null || amount === "") {
    errors.push("amount is required");
  } else if (!Number.isFinite(numAmount) || numAmount <= 0) {
    errors.push("amount must be a positive number");
  } else if (numAmount > MAX_AMOUNT) {
    errors.push(`amount must be less than ${MAX_AMOUNT}`);
  }

  let cleanCategory = typeof category === "string" ? category.trim() : "";
  if (!cleanCategory) cleanCategory = "other";
  cleanCategory = cleanCategory.slice(0, MAX_CATEGORY_LEN);

  let cleanDate = date;
  if (!cleanDate) {
    cleanDate = toISO(new Date());
  } else if (!isValidISODate(cleanDate)) {
    errors.push("date must be in YYYY-MM-DD format");
  }

  const cleanType = type === "income" ? "income" : "expense";

  return {
    errors,
    value: { amount: numAmount, category: cleanCategory, date: cleanDate, type: cleanType }
  };
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------- Auth helpers ----------
function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "Not authenticated" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ success: false, error: "Invalid or expired session" });
  }
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- Routes: health ----------
app.get("/api/health", (req, res) => res.json({ ok: true, env: NODE_ENV }));

// ---------- Routes: auth ----------
app.post(
  "/api/auth/register",
  authLimiter,
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(422).json({ success: false, error: "Enter a valid email" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(422).json({ success: false, error: "Password must be at least 8 characters" });
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: "An account with that email already exists" });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users(email, password_hash) VALUES ($1,$2) RETURNING id, email",
      [email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    res.status(201).json({ success: true, token: signToken(user.id), email: user.email });
  })
);

app.post(
  "/api/auth/login",
  authLimiter,
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || typeof password !== "string") {
      return res.status(422).json({ success: false, error: "Enter a valid email and password" });
    }

    const result = await pool.query("SELECT id, password_hash FROM users WHERE email = $1", [
      email.toLowerCase()
    ]);
    // Same generic error whether the email is unknown or the password is wrong,
    // so login attempts can't be used to enumerate registered accounts.
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }
    res.json({ success: true, token: signToken(user.id), email: email.toLowerCase() });
  })
);

app.get(
  "/api/auth/me",
  requireAuth,
  wrap(async (req, res) => {
    const result = await pool.query("SELECT id, email FROM users WHERE id = $1", [req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, user: result.rows[0] });
  })
);

// ---------- Routes: expenses (all require auth, all scoped to req.userId) ----------
app.post(
  "/api/voice",
  requireAuth,
  voiceLimiter,
  wrap(async (req, res) => {
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ success: false, error: "No speech text provided" });

    const result = parseExpenseText(text);
    if (result.amount === null) {
      return res.status(422).json({ success: false, error: "Could not find an amount in that" });
    }

    const { errors, value } = validateExpenseInput({
      amount: result.amount,
      category: result.category,
      date: result.date,
      type: result.type
    });
    if (errors.length) return res.status(422).json({ success: false, error: errors.join(", ") });

    const insert = await pool.query(
      "INSERT INTO expenses(user_id, amount, category, date, type) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [req.userId, value.amount, value.category, value.date, value.type]
    );
    res.json({ success: true, id: insert.rows[0].id, ...value });
  })
);

app.post(
  "/api/expenses",
  requireAuth,
  wrap(async (req, res) => {
    const { errors, value } = validateExpenseInput(req.body || {});
    if (errors.length) return res.status(422).json({ success: false, error: errors.join(", ") });
    const insert = await pool.query(
      "INSERT INTO expenses(user_id, amount, category, date, type) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [req.userId, value.amount, value.category, value.date, value.type]
    );
    res.status(201).json({ success: true, id: insert.rows[0].id, ...value });
  })
);

app.get(
  "/api/expenses",
  requireAuth,
  wrap(async (req, res) => {
    const result = await pool.query(
      "SELECT id, amount, category, date, type FROM expenses WHERE user_id = $1 ORDER BY id DESC",
      [req.userId]
    );
    res.json(result.rows);
  })
);

app.get(
  "/api/week",
  requireAuth,
  wrap(async (req, res) => {
    const result = await pool.query(
      `SELECT id, amount, category, date, type FROM expenses
       WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY id DESC`,
      [req.userId]
    );
    res.json(result.rows);
  })
);

app.get(
  "/api/month",
  requireAuth,
  wrap(async (req, res) => {
    const result = await pool.query(
      `SELECT id, amount, category, date, type FROM expenses
       WHERE user_id = $1
       AND EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE)
       AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)
       ORDER BY id DESC`,
      [req.userId]
    );
    res.json(result.rows);
  })
);

app.get(
  "/api/year",
  requireAuth,
  wrap(async (req, res) => {
    const result = await pool.query(
      `SELECT id, amount, category, date, type FROM expenses
       WHERE user_id = $1 AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)
       ORDER BY id DESC`,
      [req.userId]
    );
    res.json(result.rows);
  })
);

app.post(
  "/api/custom",
  requireAuth,
  wrap(async (req, res) => {
    const { from, to } = req.body || {};
    if (!isValidISODate(from) || !isValidISODate(to)) {
      return res.status(422).json({ success: false, error: "from/to must be YYYY-MM-DD" });
    }
    const result = await pool.query(
      `SELECT id, amount, category, date, type FROM expenses
       WHERE user_id = $1 AND date BETWEEN $2 AND $3
       ORDER BY id DESC`,
      [req.userId, from, to]
    );
    res.json(result.rows);
  })
);

app.put(
  "/api/expenses/:id",
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "Invalid id" });

    const { errors, value } = validateExpenseInput(req.body || {});
    if (errors.length) return res.status(422).json({ success: false, error: errors.join(", ") });

    const result = await pool.query(
      `UPDATE expenses SET amount = $1, category = $2, date = $3, type = $4
       WHERE id = $5 AND user_id = $6
       RETURNING id`,
      [value.amount, value.category, value.date, value.type, id, req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, error: "Expense not found" });
    res.json({ success: true, id, ...value });
  })
);

app.delete(
  "/api/expenses/last",
  requireAuth,
  wrap(async (req, res) => {
    const last = await pool.query(
      "SELECT id FROM expenses WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
      [req.userId]
    );
    if (last.rows.length === 0) return res.status(404).json({ success: false, error: "No expenses to delete" });
    await pool.query("DELETE FROM expenses WHERE id = $1 AND user_id = $2", [last.rows[0].id, req.userId]);
    res.json({ success: true, id: last.rows[0].id });
  })
);

app.delete(
  "/api/expenses/:id",
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "Invalid id" });

    const result = await pool.query("DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING id", [
      id,
      req.userId
    ]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, error: "Expense not found" });
    res.json({ success: true, id });
  })
);

// ---------- Serve the built frontend in production (single-service deploy) ----------
const frontendBuildPath = path.join(__dirname, "..", "frontend", "build");
if (NODE_ENV === "production") {
  app.use(express.static(frontendBuildPath));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(frontendBuildPath, "index.html"));
  });
}

// ---------- 404 + central error handler ----------
app.use((req, res) => res.status(404).json({ success: false, error: "Not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.message);
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ success: false, error: "Origin not allowed" });
  }
  res.status(500).json({ success: false, error: "Internal server error" });
});

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT} [${NODE_ENV}]`));
  })
  .catch((err) => {
    console.error("Failed to initialize database schema:", err.message);
    process.exit(1);
  });

module.exports = app;