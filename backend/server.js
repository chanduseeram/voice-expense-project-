require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

const db = new sqlite3.Database("./expenses.db");

db.run(`
  CREATE TABLE IF NOT EXISTS expenses(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL,
    category TEXT,
    date TEXT
  )
`);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function applyRelative(type, value) {
  let d = new Date();

  if (type === "relative") {
    value = value.toLowerCase();

    if (value.includes("day")) {
      let n = parseInt(value);
      d.setDate(d.getDate() + n);
    }

    if (value.includes("week")) {
      let n = parseInt(value);
      d.setDate(d.getDate() + n * 7);
    }

    if (value.includes("month")) {
      let n = parseInt(value);
      d.setMonth(d.getMonth() + n);
    }

    if (value.includes("year")) {
      let n = parseInt(value);
      d.setFullYear(d.getFullYear() + n);
    }
  }

  return d.toISOString().slice(0, 10);
}

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

Return this JSON ONLY:

{
 "amount": number,
 "category": "food/groceries/shopping/health/travel/bills/entertainment/other",
 "date_type": "exact" or "relative",
 "value": "YYYY-MM-DD" or "-1 days" or "-2 months" etc
}

Rules:
- "yesterday" → "relative", "-1 days"
- "day before yesterday" → "relative", "-2 days"
- "x days ago" → "relative", "-x days"
- "x weeks ago" → "relative", "-x weeks"
- "x months ago" → "relative", "-x months"
- "x years ago" → "relative", "-x years"
- "last month" → "relative", "-1 months"
- "last week" → "relative", "-1 weeks"
- "last year" → "relative", "-1 years"

If date explicitly mentioned → exact.
If no date mentioned → exact with today's date.
`
        },
        { role: "user", content: text }
      ]
    });

    let raw = ai.choices[0].message.content.trim();
    raw = raw.replace(/```json|```/g, "");
    const result = JSON.parse(raw);

    let finalDate = "";

    if (result.date_type === "exact") {
      finalDate = result.value;
    } else {
      finalDate = applyRelative("relative", result.value);
    }

    db.run(
      "INSERT INTO expenses(amount, category, date) VALUES (?,?,?)",
      [result.amount, result.category, finalDate]
    );

    res.json({ success: true, date: finalDate, data: result });
  } catch (err) {
    console.log(err);
    res.json({ success: false, error: "AI extraction failed" });
  }
});

app.get("/api/expenses", (req, res) => {
  db.all("SELECT * FROM expenses ORDER BY id DESC", (err, rows) => {
    res.json(rows || []);
  });
});

app.delete("/api/delete-last", (req, res) => {
  db.get("SELECT id FROM expenses ORDER BY id DESC LIMIT 1", (err, row) => {
    if (!row) return res.json({ success: false });

    db.run("DELETE FROM expenses WHERE id = ?", [row.id], () => {
      res.json({ success: true });
    });
  });
});

app.listen(5000, () => console.log("Server running on 5000"));
