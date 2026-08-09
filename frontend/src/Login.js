import { useState } from "react";
import api from "./api";

export default function Login({ onAuthed }) {
  const [mode, setMode] = useState("login"); // 'login' | 'register'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await api.post(path, { email, password });
      if (!res.data.success) throw new Error(res.data.error || "Something went wrong");
      localStorage.setItem("token", res.data.token);
      localStorage.setItem("email", res.data.email);
      onAuthed(res.data.email);
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="card">
        <header className="header">
          <span className="eyebrow">Ledger</span>
          <h1>Voice Expense Tracker</h1>
          <p className="subtitle">{mode === "login" ? "Log in to your ledger" : "Create your ledger"}</p>
        </header>

        {error && <div className="toast toast--error">{error}</div>}

        <form className="auth-form" onSubmit={submit}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password (min 8 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          <button type="submit" className="btn btn--primary btn--wide" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Log in" : "Sign up"}
          </button>
        </form>

        <p className="switch-mode">
          {mode === "login" ? "New here?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setError("");
              setMode(mode === "login" ? "register" : "login");
            }}
          >
            {mode === "login" ? "Create an account" : "Log in"}
          </button>
        </p>
      </div>
    </div>
  );
}
