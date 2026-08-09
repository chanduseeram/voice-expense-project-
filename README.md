# Voice Expense Tracker

Speak an expense ("200 on groceries yesterday") or add one by hand. Each person logs in and only sees their own expenses. React frontend + Express backend, Postgres for storage, OpenAI parses the voice text into amount/category/date.

Stack: React, Express, **PostgreSQL** (was SQLite — changed so data survives deploys, see below), JWT auth, OpenAI, react-speech-recognition.

---

## 1. Critical: rotate your OpenAI key

The originally uploaded `backend/.env` had a live `OPENAI_API_KEY` in plain text (not committed to git, but shared in the upload — treat as compromised). Revoke it at https://platform.openai.com/api-keys and generate a new one. Put it only in your local `.env` files, never commit it.

---

## 2. Why Postgres instead of SQLite, and why Neon instead of Supabase

You asked for permanent storage without the "goes offline if unused" problem Supabase's free tier has.

- **SQLite** stores data as a file on the server's local disk. Almost every free hosting platform (Render included) wipes that disk on redeploy or restart — fine for a demo, not for real data.
- **Supabase's free tier** pauses your whole project after a period of inactivity; you have to manually un-pause it before it responds again.
- **Neon** (neon.tech) is also free Postgres with no card required, but instead of pausing the project, it just scales the compute down to zero when idle and wakes it automatically in under a second on the next request — no manual restore, no downtime you have to notice. Storage is untouched either way. That's what this project is now wired for, via the standard `DATABASE_URL` connection string, so it'll work with Neon, Render's own Postgres, or any other hosted Postgres if you change your mind later.

---

## 3. What changed

**Backend (`backend/server.js`)**
- Swapped SQLite for Postgres (`pg`). Same schema idea, now with a `users` table and a `user_id` foreign key on `expenses`.
- Added authentication: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`. Passwords hashed with bcrypt (10 rounds), sessions are JWTs (30-day expiry) sent as `Authorization: Bearer <token>`.
- Every expense route now requires a valid token and is scoped to that user — one person can never see or modify another's data (enforced in the SQL `WHERE user_id = ...`, not just in the UI).
- Login/register share a strict rate limiter (20 attempts/15min) to blunt brute-forcing.
- Login returns the same generic "Invalid email or password" whether the email doesn't exist or the password is wrong, so failed logins can't be used to check which emails are registered.
- Server refuses to start if `JWT_SECRET` or `DATABASE_URL` isn't set, instead of silently running insecurely.
- Kept from the previous round: helmet, CORS allowlist, `/api/voice` rate limiting, full input validation, edit/delete by id, centralized error handling, single-service production static serving.

**Frontend**
- New `Login.js` — email/password login and registration, switches between the two.
- `api.js` — shared axios instance that attaches the JWT to every request automatically, and a `App.js` that logs the user out if a request comes back `401` (expired/invalid session).
- Token and email are kept in `localStorage` so a refresh doesn't log you out; "Log out" clears it.
- Same manual-entry, edit/delete, toast, and ledger-style UI as before, now per-user.

---

## 4. Local setup

**1. Get a free Postgres database (Neon)**
1. https://neon.tech → sign up (no card needed).
2. Create a project. Copy the connection string it gives you (starts with `postgresql://`).

**2. Backend**
```bash
cd backend
npm install
cp .env.example .env
```
Edit `.env`:
```
DATABASE_URL=postgresql://<your Neon connection string>
JWT_SECRET=<generate one — see below>
OPENAI_API_KEY=<your new key>
```
Generate a `JWT_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Then:
```bash
npm start
```
Tables are created automatically on first run. Runs on `http://localhost:5000`.

**3. Frontend** (separate terminal)
```bash
cd frontend
npm install
cp .env.example .env
npm start
```
Runs on `http://localhost:3000`, talks to the backend at `http://localhost:5000`. Register an account, then log in.

---

## 5. Deploying live, free — detailed steps

### Step 1 — push to GitHub
```bash
cd voice-expense-project
git init
git add .
git commit -m "ready to deploy"
gh repo create voice-expense-project --public --source=. --push
# or create the repo manually on github.com and:
# git remote add origin https://github.com/<you>/voice-expense-project.git
# git branch -M main && git push -u origin main
```
`.env` is already git-ignored in both `backend/` and `frontend/` — don't remove that.

### Step 2 — create the Neon database (if you haven't already)
1. https://neon.tech → sign up, no card.
2. New project → copy the `DATABASE_URL` connection string.

### Step 3 — create the Render web service
1. https://render.com → sign up (GitHub login is easiest, free tier needs no card).
2. **New +** → **Web Service** → connect your GitHub repo.
3. Settings:
   - **Root Directory:** leave blank
   - **Build Command:**
     ```
     cd frontend && npm install && npm run build && cd ../backend && npm install
     ```
   - **Start Command:**
     ```
     node backend/server.js
     ```
   - **Instance Type:** Free
4. **Environment** tab → add:
   - `DATABASE_URL` = your Neon connection string
   - `JWT_SECRET` = a generated random string (same command as above)
   - `OPENAI_API_KEY` = your key
   - `NODE_ENV` = `production`
   (`PORT` is injected by Render automatically; `ALLOWED_ORIGINS` can stay unset since the frontend is served from the same origin as the API in this setup.)
5. **Create Web Service** and watch the build log.

### Step 4 — verify
Open `https://your-name.onrender.com`, register an account, log in, add an expense (voice or manual), refresh the page — it should still be there.

### What's genuinely free here, long-term
- **Neon:** permanent free plan, 0.5 GB storage, 100 compute-hours/month, no card. Compute naps after 5 minutes idle and wakes on the next request in well under a second — your data is never at risk, and you never have to manually restart anything.
- **Render:** permanent free web service, 750 instance-hours/month, no card. It spins down after 15 minutes of no traffic and takes up to ~1 minute to wake on the next visit — that's a speed trade-off, not a data-loss risk, since your data now lives in Neon, not on Render's disk.
- Cost only enters the picture if you outgrow these limits (heavy traffic, more storage) or want to remove the cold-start delay (Render's $7/mo Starter instance stays warm).

### A note on OpenAI cost
`/api/voice` calls OpenAI on every save. The rate limiter caps this at 30 calls per 15 minutes per visitor; set a spending limit on your OpenAI account too if you expect public traffic.

---

## 6. Not carried over
The demo `.mp4` video and `.git` history were left out of this zip to keep it small — your original upload still has them.
