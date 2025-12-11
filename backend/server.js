require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const OpenAI = require("openai");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

const db = new sqlite3.Database("./expenses.db");

function runQuery(sql, params = []) {
  return new Promise((resolve) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        console.log("SQL Error:", err.message);
        resolve([]);
      } else resolve(rows || []);
    });
  });
}

function runExecute(sql, params = []) {
  return new Promise((resolve) => {
    db.run(sql, params, function (err) {
      if (err) {
        console.log("SQL Exec Error:", err.message);
        resolve(false);
      } else resolve(true);
    });
  });
}

db.run(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL,
    category TEXT,
    date TEXT
  )
`);

function makeUTC(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

function fixExactDate(v) {
  const now = new Date();
  const year = now.getFullYear();

  if (!v || v.toLowerCase() === "today") {
    return toISO(makeUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [Y, M, D] = v.split("-").map(n => parseInt(n));
    return toISO(makeUTC(Y, M - 1, D));
  }

  if (/^\d{1,2}-\d{1,2}$/.test(v)) {
    const [M, D] = v.split("-").map(n => parseInt(n));
    return toISO(makeUTC(year, M - 1, D));
  }

  const monthName = v.match(/([A-Za-z]+)\s+(\d{1,2})/);
  if (monthName) {
    const month = new Date(`${monthName[1]} 1, 2000`).getMonth();
    const day = parseInt(monthName[2]);
    return toISO(makeUTC(year, month, day));
  }

  return toISO(makeUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function applyRelative(value) {
  const now = new Date();
  let d = makeUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  let v = value.toLowerCase().trim();

  if (v === "today") return toISO(d);
  if (v === "yesterday") {
    d.setUTCDate(d.getUTCDate() - 1);
    return toISO(d);
  }
  if (v === "day before yesterday") {
    d.setUTCDate(d.getUTCDate() - 2);
    return toISO(d);
  }

  if (v === "last week") {
    d.setUTCDate(d.getUTCDate() - 7);
    return toISO(d);
  }
  if (v === "last month") {
    d.setUTCMonth(d.getUTCMonth() - 1);
    return toISO(d);
  }
  if (v === "last year") {
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return toISO(d);
  }

  const m = v.match(/(-?\d+)\s*(day|days|week|weeks|month|months|year|years)/);
  if (m) {
    let num = parseInt(m[1]);
    const unit = m[2];

    if (unit.startsWith("day")) d.setUTCDate(d.getUTCDate() + num);
    if (unit.startsWith("week")) d.setUTCDate(d.getUTCDate() + num * 7);
    if (unit.startsWith("month")) d.setUTCMonth(d.getUTCMonth() + num);
    if (unit.startsWith("year")) d.setUTCFullYear(d.getUTCFullYear() + num);

    return toISO(d);
  }

  return toISO(d);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/api/voice", async (req, res) => {
  const text = req.body.text || "";

  try {
    const ai = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Extract amount, category, and date meaning.
Return JSON ONLY:
{
 "amount": 50,
 "category": "food",
 "date_type": "exact" or "relative",
 "value": "YYYY-MM-DD" or "January 1" or "-10 days" or "today"
}
If no date is mentioned → use "today".
`
        },
        { role: "user", content: text }
      ]
    });

    let raw = ai.choices[0].message.content.replace(/```json|```/g, "").trim();
    const result = JSON.parse(raw);

    let finalDate =
      result.date_type === "exact"
        ? fixExactDate(result.value)
        : applyRelative(result.value);

    await runExecute(
      "INSERT INTO expenses(amount, category, date) VALUES (?,?,?)",
      [result.amount || 0, result.category || "other", finalDate]
    );

    res.json({ success: true, date: finalDate });

  } catch (err) {
    console.log(err);
    res.json({ success: false, error: "AI error" });
  }
});


app.get("/api/expenses", async (req, res) => {
  const rows = await runQuery("SELECT * FROM expenses ORDER BY id DESC");
  res.json(rows);
});

app.get("/api/week", async (req, res) => {
  const rows = await runQuery(`
    SELECT * FROM expenses 
    WHERE date >= date('now','-7 day')
    ORDER BY id DESC
  `);
  res.json(rows);
});

app.get("/api/month", async (req, res) => {
  const rows = await runQuery(`
    SELECT * FROM expenses 
    WHERE strftime('%m', date) = strftime('%m','now')
    AND strftime('%Y', date) = strftime('%Y','now')
    ORDER BY id DESC
  `);
  res.json(rows);
});

app.get("/api/year", async (req, res) => {
  const rows = await runQuery(`
    SELECT * FROM expenses 
    WHERE strftime('%Y', date) = strftime('%Y','now')
    ORDER BY id DESC
  `);
  res.json(rows);
});

app.post("/api/custom", async (req, res) => {
  const { from, to } = req.body;

  const d1 = new Date(from);
  const d2 = new Date(to);

  if (isNaN(d1) || isNaN(d2)) return res.json([]);

  const rows = await runQuery(
    `SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY id DESC`,
    [from, to]
  );

  res.json(rows);
});

app.delete("/api/delete-last", async (req, res) => {
  const rows = await runQuery(`SELECT id FROM expenses ORDER BY id DESC LIMIT 1`);
  if (rows.length === 0) return res.json({ success: false });

  await runExecute(`DELETE FROM expenses WHERE id = ?`, [rows[0].id]);
  res.json({ success: true });
});

app.listen(5000, () => console.log("Server running on 5000"));
