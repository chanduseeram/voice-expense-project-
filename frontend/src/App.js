import SpeechRecognition, { useSpeechRecognition } from "react-speech-recognition";
import { useEffect, useMemo, useState, useCallback } from "react";
import api from "./api";
import Login from "./Login";
import "./App.css";

const EXPENSE_CATEGORIES = ["food", "travel", "shopping", "bills", "health", "entertainment", "other"];
const INCOME_CATEGORIES = ["salary", "gift", "refund", "other"];

const CATEGORY_COLORS = [
  "#1f7a5c",
  "#2f9e6e",
  "#c98a3a",
  "#4d7fae",
  "#b5443b",
  "#8a5db0",
  "#6b6b63"
];

// Single source of truth for the sidebar/topbar nav links, so both the
// mobile fixed bar and the desktop sidebar stay in sync and can each
// show which section is "active".
const NAV_ITEMS = [
  { key: "dashboard", label: "Dashboard", target: "panel-quickadd" },
  { key: "add", label: "Add Expense", target: "panel-quickadd" },
  { key: "entries", label: "Entries", target: "panel-entries" },
  { key: "analytics", label: "Analytics", target: "panel-analytics" }
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatCurrency(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatDisplayDate(isoStr) {
  const [y, m, d] = String(isoStr).slice(0, 10).split("-");
  if (!y || !m || !d) return String(isoStr).slice(0, 10);
  return `${d}-${m}-${y}`;
}


export default function App() {
  const [email, setEmail] = useState(() => localStorage.getItem("email"));

  const logout = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("email");
    setEmail(null);
  }, []);

  if (!email) {
    return <Login onAuthed={(e) => setEmail(e)} />;
  }

  return <Dashboard email={email} onLogout={logout} />;
}

function Dashboard({ email, onLogout }) {
  const { transcript, listening, resetTranscript, browserSupportsSpeechRecognition } =
    useSpeechRecognition();

  const [expenses, setExpenses] = useState([]);
  const [filter, setFilter] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({ amount: "", category: "", date: "", type: "expense" });
  const [manual, setManual] = useState({ amount: "", category: "food", date: todayISO(), type: "expense" });
  const [savingVoice, setSavingVoice] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [showAllEntries, setShowAllEntries] = useState(false);
  const [activeNav, setActiveNav] = useState("dashboard");
  const ENTRY_PREVIEW_COUNT = 5;

  const showToast = useCallback((type, text) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const handleAuthError = useCallback(
    (err) => {
      if (err.response?.status === 401) {
        onLogout();
        return true;
      }
      return false;
    },
    [onLogout]
  );

  const loadExpenses = useCallback(async () => {
    setLoading(true);
    try {
      let url = "/api/expenses";
      if (filter === "week") url = "/api/week";
      if (filter === "month") url = "/api/month";
      if (filter === "year") url = "/api/year";

      const res = await api.get(url);
      setExpenses(Array.isArray(res.data) ? res.data : []);
      setShowAllEntries(false);
    } catch (err) {
      if (!handleAuthError(err)) showToast("error", "Could not reach the server");
    } finally {
      setLoading(false);
    }
  }, [filter, showToast, handleAuthError]);

  useEffect(() => {
    loadExpenses();
  }, [loadExpenses]);

  // --- Totals: income is subtracted from the net total, not added ---
  const totalExpense = useMemo(
    () => expenses.filter((e) => e.type !== "income").reduce((s, e) => s + (Number(e.amount) || 0), 0),
    [expenses]
  );
  const totalIncome = useMemo(
    () => expenses.filter((e) => e.type === "income").reduce((s, e) => s + (Number(e.amount) || 0), 0),
    [expenses]
  );
  const netTotal = totalExpense - totalIncome;

  const expenseRows = useMemo(() => expenses.filter((e) => e.type !== "income"), [expenses]);

  const categoryBreakdown = useMemo(() => {
    const byCategory = {};
    expenseRows.forEach((e) => {
      byCategory[e.category] = (byCategory[e.category] || 0) + (Number(e.amount) || 0);
    });
    const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    return entries.map(([category, amount], i) => ({
      category,
      amount,
      pct: total > 0 ? (amount / total) * 100 : 0,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length]
    }));
  }, [expenseRows]);

  const donutBackground = useMemo(() => {
    if (categoryBreakdown.length === 0) return "#e9e6db";
    let cursor = 0;
    const stops = categoryBreakdown.map((c) => {
      const start = cursor;
      cursor += c.pct;
      return `${c.color} ${start}% ${cursor}%`;
    });
    return `conic-gradient(${stops.join(", ")})`;
  }, [categoryBreakdown]);

  const avgExpense = expenseRows.length > 0 ? totalExpense / expenseRows.length : 0;
  const categoriesUsedCount = new Set(expenseRows.map((e) => e.category)).size;

  const sendVoiceExpense = async () => {
    if (!transcript) {
      showToast("error", "Say something before saving, e.g. \"200 on groceries yesterday\"");
      return;
    }
    setSavingVoice(true);
    try {
      const res = await api.post("/api/voice", { text: transcript });
      if (!res.data.success) throw new Error(res.data.error || "Could not save expense");
      showToast("success", res.data.type === "income" ? "Income saved" : "Expense saved");
      resetTranscript();
      loadExpenses();
    } catch (err) {
      if (!handleAuthError(err)) {
        showToast("error", err.response?.data?.error || err.message || "Could not save expense");
      }
    } finally {
      setSavingVoice(false);
    }
  };

  const addManualExpense = async (e) => {
    e.preventDefault();
    if (!manual.amount || Number(manual.amount) <= 0) {
      showToast("error", "Enter an amount greater than 0");
      return;
    }
    try {
      const res = await api.post("/api/expenses", manual);
      if (!res.data.success) throw new Error(res.data.error);
      showToast("success", manual.type === "income" ? "Income added" : "Expense added");
      setManual({ amount: "", category: manual.type === "income" ? "salary" : "food", date: todayISO(), type: manual.type });
      loadExpenses();
    } catch (err) {
      if (!handleAuthError(err)) showToast("error", err.response?.data?.error || "Could not add expense");
    }
  };

  const startEdit = (row) => {
    setEditingId(row.id);
    setEditDraft({ amount: row.amount, category: row.category, date: String(row.date).slice(0, 10), type: row.type || "expense" });
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async (id) => {
    try {
      const res = await api.put(`/api/expenses/${id}`, editDraft);
      if (!res.data.success) throw new Error(res.data.error);
      showToast("success", "Entry updated");
      setEditingId(null);
      loadExpenses();
    } catch (err) {
      if (!handleAuthError(err)) showToast("error", err.response?.data?.error || "Could not update entry");
    }
  };

  const deleteExpense = async (id) => {
    if (!window.confirm("Delete this entry?")) return;
    try {
      await api.delete(`/api/expenses/${id}`);
      showToast("success", "Entry deleted");
      loadExpenses();
    } catch (err) {
      if (!handleAuthError(err)) showToast("error", "Could not delete entry");
    }
  };

  const applyCustom = async () => {
    if (!from || !to) {
      showToast("error", "Pick both a start and end date");
      return;
    }
    try {
      const r = await api.post("/api/custom", { from, to });
      setExpenses(Array.isArray(r.data) ? r.data : []);
    } catch (err) {
      if (!handleAuthError(err)) showToast("error", "Could not load that date range");
    }
  };

  const categoryOptionsFor = (type) => (type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES);

  // Highlights the clicked nav item and scrolls its target panel into view.
  // Nothing else changes on the page — there's only one page — but the
  // sidebar/topbar reflect which section the user last chose.
  const goToNav = (item) => {
    setActiveNav(item.key);
    setMobileNavOpen(false);
    document.getElementById(item.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="shell">
      {/* Fixed mobile top bar: hamburger + app name + email/logout.
          Stays pinned to the top of the viewport regardless of scroll
          position or which panel/menu is open. */}
      <div className="mobile-topbar">
        <div className="mobile-topbar-left">
          <button
            className="mobile-topbar-hamburger"
            onClick={() => setMobileNavOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            ☰
          </button>
          <span className="mobile-topbar-title">Voice Expense Tracker</span>
        </div>
        <div className="mobile-topbar-right">
          <span className="mobile-topbar-email">{email}</span>
          <button className="mobile-topbar-logout" onClick={onLogout}>
            Log out
          </button>
        </div>
      </div>

      {/* Dims the page and lets you tap-away to close the mobile sidebar */}
      <div
        className={`sidebar-overlay ${mobileNavOpen ? "sidebar-overlay--visible" : ""}`}
        onClick={() => setMobileNavOpen(false)}
      />

      <aside className={`sidebar ${mobileNavOpen ? "sidebar--open" : ""}`}>
        <div className="brand">
          <div className="brand-badge">
            <span className="bar" />
            <span className="bar" />
            <span className="bar" />
            <span className="bar" />
          </div>
          <div>
            <div className="brand-title">Voice Expense Tracker</div>
            <div className="brand-subtitle">Speak an expense, or add one by hand.</div>
          </div>
        </div>

        {/* Shown on both mobile (inside the slide-in sidebar) and desktop
            (as the persistent left-hand nav). Clicking an item scrolls to
            its panel and marks that item active, even though it's all one
            page. */}
        <nav className="nav-list">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${activeNav === item.key ? "nav-item--active" : ""}`}
              onClick={() => goToNav(item)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="voice-tips">
          <div className="voice-tips-title">Voice Commands</div>
          <div className="voice-tips-sub">Try saying:</div>
          <ul>
            <li>"I spent ₹200 on food today"</li>
            <li>"My friend gave me back ₹500, three days back"</li>
            <li>"I spent ₹1000 on shopping on June 5th 2026"</li>
          </ul>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="eyebrow">Ledger</span>
            <h1>Voice Expense Tracker</h1>
          </div>
          <div className="profile-chip">
            <span className="profile-avatar">{email?.[0]?.toUpperCase() || "?"}</span>
            <span className="account-email">{email}</span>
            <button className="btn btn--small btn--ghost" onClick={onLogout}>
              Log out
            </button>
          </div>
        </header>

        {toast && <div className={`toast toast--${toast.type}`}>{toast.text}</div>}

        <div className="content-grid">
          <div className="content-main">
            <section className="panel" id="panel-quickadd">
              <h2 className="panel-title">Quick Add</h2>

              {!browserSupportsSpeechRecognition ? (
                <p className="warning">
                  Your browser doesn't support voice input. Try Chrome or Edge, or use the manual form below.
                </p>
              ) : (
                <>
                  <div className="button-row">
                    <button
                      className={`btn btn--start ${listening ? "btn--pulsing" : ""}`}
                      onClick={() => SpeechRecognition.startListening({ continuous: true })}
                      disabled={listening}
                    >
                      <span className="mic-dot" /> {listening ? "Listening…" : "Start"}
                    </button>
                    <button className="btn btn--stop" onClick={SpeechRecognition.stopListening} disabled={!listening}>
                      Stop
                    </button>
                    <button className="btn btn--ghost" onClick={resetTranscript}>
                      Clear
                    </button>
                  </div>

                  <div className="transcript-box">
                    <p className="transcript-text">
                      {transcript || <span className="muted">No speech detected yet</span>}
                    </p>
                  </div>

                  <button className="btn btn--save btn--wide" onClick={sendVoiceExpense} disabled={savingVoice}>
                    {savingVoice ? "Saving…" : "Save Spoken Expense"}
                  </button>
                </>
              )}

              <div className="divider" />

              <button
                type="button"
                className="btn btn--ghost btn--wide"
                onClick={() => setShowManualForm((v) => !v)}
              >
                {showManualForm ? "Hide manual entry" : "+ Manual entry"}
              </button>

              {showManualForm && (
                <form className="manual-form" onSubmit={addManualExpense}>
                  <div className="type-toggle">
                    <button
                      type="button"
                      className={`toggle-btn ${manual.type === "expense" ? "toggle-btn--active" : ""}`}
                      onClick={() => setManual({ ...manual, type: "expense", category: "food" })}
                    >
                      Expense
                    </button>
                    <button
                      type="button"
                      className={`toggle-btn toggle-btn--income ${manual.type === "income" ? "toggle-btn--active" : ""}`}
                      onClick={() => setManual({ ...manual, type: "income", category: "salary" })}
                    >
                      Income
                    </button>
                  </div>
                  <div className="manual-form-row">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Amount"
                      value={manual.amount}
                      onChange={(e) => setManual({ ...manual, amount: e.target.value })}
                    />
                    <select
                      value={manual.category}
                      onChange={(e) => setManual({ ...manual, category: e.target.value })}
                    >
                      {categoryOptionsFor(manual.type).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={manual.date}
                      onChange={(e) => setManual({ ...manual, date: e.target.value })}
                    />
                    <button type="submit" className="btn btn--primary">
                      Add
                    </button>
                  </div>
                </form>
              )}
            </section>

            <section className="panel" id="panel-entries">
              <h2 className="panel-title">Entries</h2>

              <div className="filters-row">
                <select className="filter-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="all">All time</option>
                  <option value="week">This week</option>
                  <option value="month">This month</option>
                  <option value="year">This year</option>
                </select>
                <div className="range-row">
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                  <span>to</span>
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                  <button className="btn btn--ghost" onClick={applyCustom}>
                    Apply range
                  </button>
                </div>
              </div>

              {loading ? (
                <p className="muted">Loading…</p>
              ) : expenses.length === 0 ? (
                <p className="empty-state">Nothing here yet. Speak or add your first entry above.</p>
              ) : (
                <>
                  <div className="receipt">
                    {(showAllEntries ? expenses : expenses.slice(0, ENTRY_PREVIEW_COUNT)).map((row) => (
                    <div className="receipt-row" key={row.id}>
                      {editingId === row.id ? (
                        <>
                          <select
                            className="edit-input"
                            value={editDraft.type}
                            onChange={(e) =>
                              setEditDraft({
                                ...editDraft,
                                type: e.target.value,
                                category: categoryOptionsFor(e.target.value)[0]
                              })
                            }
                          >
                            <option value="expense">Expense</option>
                            <option value="income">Income</option>
                          </select>
                          <input
                            type="number"
                            step="0.01"
                            className="edit-input"
                            value={editDraft.amount}
                            onChange={(e) => setEditDraft({ ...editDraft, amount: e.target.value })}
                          />
                          <select
                            className="edit-input"
                            value={editDraft.category}
                            onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })}
                          >
                            {categoryOptionsFor(editDraft.type).map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <input
                            type="date"
                            className="edit-input"
                            value={editDraft.date}
                            onChange={(e) => setEditDraft({ ...editDraft, date: e.target.value })}
                          />
                          <div className="row-actions">
                            <button className="btn btn--small btn--primary" onClick={() => saveEdit(row.id)}>
                              Save
                            </button>
                            <button className="btn btn--small btn--ghost" onClick={cancelEdit}>
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className={`amount-mono ${row.type === "income" ? "amount-income" : ""}`}>
                            {row.type === "income" ? "+" : "−"}₹{formatCurrency(row.amount)}
                          </span>
                          <span className="category-badge">{row.category}</span>
                          <span className="date-mono">{formatDisplayDate(row.date)}</span>
                        
                          <div className="row-actions">
                            <button className="btn btn--small btn--ghost" onClick={() => startEdit(row)}>
                              Edit
                            </button>
                            <button className="btn btn--small btn--danger" onClick={() => deleteExpense(row.id)}>
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  </div>
                  {expenses.length > ENTRY_PREVIEW_COUNT && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--wide show-more-btn"
                      onClick={() => setShowAllEntries((v) => !v)}
                    >
                      {showAllEntries ? "Show less" : `Show more (${expenses.length - ENTRY_PREVIEW_COUNT} more)`}
                    </button>
                  )}
                </>
              )}
            </section>
          </div>

          <div className="content-side">
            <section className="panel total-panel">
              <span className="total-label">Total (net)</span>
              <span className="total-amount">₹{formatCurrency(netTotal)}</span>
              <span className="total-breakdown">
                ₹{formatCurrency(totalExpense)} spent · ₹{formatCurrency(totalIncome)} received
              </span>
            </section>

            <section className="panel" id="panel-analytics">
              <h2 className="panel-title">Expense by category</h2>
              {categoryBreakdown.length === 0 ? (
                <p className="empty-state">No expenses yet.</p>
              ) : (
                <div className="donut-row">
                  <div className="donut" style={{ background: donutBackground }}>
                    <div className="donut-hole" />
                  </div>
                  <ul className="donut-legend">
                    {categoryBreakdown.map((c) => (
                      <li key={c.category}>
                        <span className="legend-dot" style={{ background: c.color }} />
                        <span className="legend-label">{c.category}</span>
                        <span className="legend-pct">{c.pct.toFixed(0)}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section className="panel">
              <h2 className="panel-title">Overview</h2>
              <div className="stat-grid">
                <div className="stat-box">
                  <span className="stat-value">₹{formatCurrency(totalExpense)}</span>
                  <span className="stat-label">Total Expenses</span>
                </div>
                <div className="stat-box">
                  <span className="stat-value stat-value--income">₹{formatCurrency(totalIncome)}</span>
                  <span className="stat-label">Total Income</span>
                </div>
                <div className="stat-box">
                  <span className="stat-value">{expenses.length}</span>
                  <span className="stat-label">Total Entries</span>
                </div>
                <div className="stat-box">
                  <span className="stat-value">₹{formatCurrency(avgExpense)}</span>
                  <span className="stat-label">Average Expense</span>
                </div>
                <div className="stat-box">
                  <span className="stat-value">{categoriesUsedCount}</span>
                  <span className="stat-label">Categories Used</span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}