# HGS AgentX — Resource Capacity Planner (server edition)

A hosted, multi-user, secured version of the AgentX resource capacity &
project planner. This is a conversion of the original single-file
client-only HTML app into a real client/server app:

- **Auth** — self-service registration restricted to `@hgs.com` email
  addresses, bcrypt-hashed passwords, required email verification before
  first login, and forgot-password/reset-password flows. All enforced
  server-side (`server/auth.js`) — never trust-the-client.
- **Persistent, shared storage** — every resource, project, allocation,
  version snapshot and audit-log entry lives in a single **Postgres**
  database (plain `pg`/node-postgres, targeting Vercel Postgres/Neon in
  production), shared live across every logged-in user, instead of in one
  browser tab's memory.
- **Server-authoritative audit log & version history** — every write is
  logged against the authenticated session on the server
  (`server/audit.js`), and named snapshots (`server/routes/versions.js`)
  can be saved/restored by anyone logged in, with an automatic safety-net
  snapshot taken before every restore or import.
- **Same UI** — the HGS-branded frontend (Kanit/Raleway, tab layout,
  sortable/filterable tables, column hide-picker, holiday-note modal,
  version history & audit log panels) is unchanged from the original app;
  only the data layer moved from in-memory JS arrays to real API calls.

## Architecture

- **`server/db.js`** — a `pg` connection pool (reads `DATABASE_URL`, or
  `POSTGRES_URL` as a fallback name some Vercel integrations use), the
  Postgres schema (`CREATE TABLE IF NOT EXISTS` for every table), and a
  lazy, idempotent `ensureInit()` that creates the schema and seeds the DB
  (only if empty) exactly once per warm process/instance. It's awaited as
  Express middleware ahead of every `/api/*` route, which is what makes
  cold starts on serverless safe — there's no module-load-time synchronous
  DDL anymore, because Postgres access is inherently async.
- **`server/app.js`** — builds and exports the fully configured Express
  `app` (helmet, session middleware, every router, static file serving,
  SPA fallback) without calling `.listen()`.
- **`server/index.js`** — local-dev entry point only: loads `.env`,
  requires `server/app.js`, and calls `app.listen(PORT)`.
- **`api/index.js`** — Vercel serverless entry point: `module.exports =
  require("../server/app")`. Vercel's Node runtime accepts an Express app
  instance directly as the request handler, so no `.listen()` is needed
  here at all.
- **`vercel.json`** — rewrites `/api/*` to the `api/index.js` function;
  everything else falls through to Vercel's automatic static serving of
  `public/`.

Every database call in the app is `async`/`await` against the `pg` pool —
there is no synchronous DB access anywhere (that was only possible with
the old `better-sqlite3` driver, which doesn't work on Vercel's
serverless functions since they have no persistent writable disk and no
long-running process).

## Quick start

```bash
npm install
cp .env.example .env      # then edit .env — see "Environment variables" below
npm start                 # or: node server/index.js
```

You need a Postgres instance reachable via `DATABASE_URL` before starting
— a free [Neon](https://neon.tech) project works well for local dev too
(the same driver is used either way), or install Postgres locally, e.g.:

```bash
sudo apt-get install -y postgresql
sudo pg_ctlcluster 16 main start
sudo -u postgres psql -c "CREATE ROLE cp WITH LOGIN PASSWORD 'cp'; CREATE DATABASE capacity_planner OWNER cp;"
# then in .env:
# DATABASE_URL=postgres://cp:cp@127.0.0.1:5432/capacity_planner
```

The app listens on `http://localhost:3000` by default (override with
`PORT`). On first boot it creates the schema and seeds the database from
`server/seed-data.json` (the original converted-from-Excel dataset) — this
only happens once (checked via an empty `resources` table); every
subsequent boot reads whatever is already in the database.

## Environment variables

See `.env.example` for the full list with inline comments. Summary:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` (or `POSTGRES_URL`) | Yes | Postgres connection string. Vercel's Postgres/Neon integration injects this automatically once attached to the project. For local dev, point it at a local or Neon Postgres instance. |
| `SESSION_SECRET` | Yes, in production | Signs session cookies. Any long random string. |
| `ALLOWED_EMAIL_DOMAIN` | No (defaults `hgs.com`) | Only `@<this domain>` emails can register/log in. |
| `PORT` | No (defaults `3000`) | Port the server listens on — local dev only (`server/index.js`); not used on Vercel. |
| `NODE_ENV` | No | Set to `production` when deployed behind HTTPS — makes session cookies `secure`. Leave unset for local `http://` testing. Vercel sets this automatically. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | No | Real SMTP delivery for verification/reset emails. Leave `SMTP_HOST` unset to run in DEV MODE (see below). |
| `PGSSL` | No | Override automatic SSL detection (`true`/`false`) for the Postgres connection — see `server/db.js`. Usually not needed; SSL is auto-detected from `sslmode=require` in the connection string. |

## DEV MODE email (no SMTP configured)

If `SMTP_HOST` is left unset, the app runs in **DEV MODE**
(`server/mailer.js`): verification and password-reset emails are never
actually sent. Instead:

- The full message is logged to the server console (visible in Vercel's
  function logs too, when deployed there).
- Locally (not on Vercel), it's also best-effort appended as a JSON line
  to `data/mail-outbox.log` — this write is skipped entirely on Vercel
  (read-only filesystem outside `/tmp`, and `/tmp` doesn't persist across
  invocations anyway) and is never load-bearing anywhere; it's purely a
  local debugging convenience.
- The relevant API response (`/api/auth/register`,
  `/api/auth/resend-verification`, `/api/auth/forgot-password`) includes a
  `devVerifyUrl` / `devResetUrl` field with the link directly in it, and the
  login screen surfaces it as a clickable "DEV MODE" banner — so you can
  register, verify, and reset passwords end-to-end without a real mailbox.
  **This in-response mechanism is the one that reliably works on Vercel**,
  since there's no way to read a log file there.
- `GET /api/auth/dev/outbox` returns the last 50 dev-mode messages as JSON
  (disabled automatically outside DEV MODE — returns 404 once `SMTP_HOST`
  is set).

## Going live with real email

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and
`SMTP_FROM` in `.env` (or your Vercel project's env vars) and restart/
redeploy. `sendMail()` automatically switches to real delivery via
`nodemailer` — no code changes needed. Once `SMTP_HOST` is set, DEV MODE
turns off automatically: `devVerifyUrl`/`devResetUrl` stop appearing in
API responses and `/api/auth/dev/outbox` returns 404.

## Deploying to Vercel

1. Push this repo to GitHub (or GitLab/Bitbucket), then in the Vercel
   dashboard: **Add New… → Project**, and import that repo. Vercel
   auto-detects the `api/` directory and `public/` static files — no
   framework preset or build command is needed.
2. **Storage tab → Create Database → Postgres** (Vercel Postgres, powered
   by Neon) and attach it to the project. This automatically populates
   `DATABASE_URL` (and/or `POSTGRES_URL`, depending on the integration
   version) in your project's environment variables — you don't set this
   by hand.
3. In **Project Settings → Environment Variables**, set at minimum:
   - `SESSION_SECRET` — a long random string (e.g. `openssl rand -hex 32`).
   - `ALLOWED_EMAIL_DOMAIN` — e.g. `hgs.com`.
   - Optionally `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/
     `SMTP_PASS`/`SMTP_FROM` for real email delivery. Leaving `SMTP_HOST`
     unset keeps the app in DEV MODE — verification/reset links surface
     directly in the API response and UI banner rather than being emailed,
     since there's no persistent log file to read on Vercel (see "DEV MODE
     email" above).
   - `NODE_ENV=production` is set automatically by Vercel — you don't need
     to set it yourself.
4. Deploy. On the first request that hits a cold serverless instance,
   `ensureInit()` creates the schema and seeds the database from
   `server/seed-data.json` if the `resources` table is empty — no manual
   migration step needed.
5. Every subsequent deploy/cold-start reuses the same Postgres database,
   so data persists across deploys (unlike a container's ephemeral
   filesystem).

## Database & backups

- All application data (resources/projects/allocations, the audit log,
  version snapshots, and sessions) lives in Postgres, addressed via
  `DATABASE_URL`. There is no local file to back up or `.gitignore` for
  the database itself anymore.
- **Back it up** using your Postgres provider's tooling — for Vercel
  Postgres/Neon, that's Neon's branching/point-in-time-restore features in
  its dashboard, or a plain `pg_dump $DATABASE_URL`.
- A logical backup can also be downloaded any time from inside the app:
  Data tab → **Export data (.json)**, or `GET /api/export/json` directly.
  It can be restored later via **Import data (.json)** (Data tab) or
  `POST /api/export/import` — a safety-net version snapshot is always
  taken automatically before an import.

## Running with Docker

```bash
docker build -t hgs-capacity-planner .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgres://user:pass@your-postgres-host:5432/capacity_planner" \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  hgs-capacity-planner
```

The Docker image still works as an alternative to Vercel if you'd rather
run this on a traditional host — just point `DATABASE_URL` at any reachable
Postgres instance (Neon, Vercel Postgres, RDS, a self-hosted server, etc.).
Since `pg` is a pure-JS driver (no native bindings to compile, unlike the
old `better-sqlite3` dependency), the image no longer needs a C build
toolchain and uses the slim Node base image. There's no volume to mount
for app data anymore — everything lives in Postgres — the `data` directory
in the image is only used for the best-effort local dev-mode mail log,
which is never load-bearing (see "DEV MODE email" above).

## Known limitations

- **Single permission tier.** Every logged-in `@hgs.com` account has full
  read/write access to all data, including removing other accounts on the
  Data tab's "Users & access" panel. There is no separate admin/regular
  role yet — if that's needed, add a `role` column to the `users` table
  and gate the relevant routes on it.
- **DEV MODE email only, unless you configure SMTP.** Out of the box,
  verification and password-reset links are shown directly in the app
  (via the API response banner) rather than emailed — fine for testing,
  not for real users. See "Going live with real email" above.
- **Rate limiting is basic.** Auth endpoints are rate-limited
  (20 requests / 15 min per IP by default — see `server/auth.js`) to slow
  down credential stuffing, but there's no CAPTCHA or more advanced abuse
  protection.
- **This Postgres rewrite was tested against a local Postgres instance,
  not real Neon/Vercel Postgres** — no live Vercel/Neon credentials were
  available in the environment this rework was built in. The `pg` wire
  protocol is identical against any standard Postgres host, so this should
  carry over directly, but it's worth a smoke test against the real Vercel
  Postgres database after the first deploy (register/verify/log in, edit a
  cell, reload).
