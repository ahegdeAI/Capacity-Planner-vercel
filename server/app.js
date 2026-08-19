// Builds and configures the full Express app — shared between local dev
// (server/index.js calls app.listen() on this) and Vercel (api/index.js
// hands this same app instance directly to Vercel's Node runtime as the
// request handler, with no .listen() call needed there).
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);

const { pool, ensureInit } = require("./db");
const { router: authRouter } = require("./auth");
const stateRoutes = require("./routes/state");
const resourceRoutes = require("./routes/resources");
const projectRoutes = require("./routes/projects");
const allocationRoutes = require("./routes/allocations");
const versionRoutes = require("./routes/versions");
const auditLogRoutes = require("./routes/auditlog");
const userRoutes = require("./routes/users");
const exportRoutes = require("./routes/exportRoutes");

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("trust proxy", 1);

// Content-Security-Policy is relaxed for inline <style>/<script> because the
// frontend is a small hand-rolled app with no bundler step; if this is
// fronted by a build pipeline later, tighten this to nonce/hash-based CSP.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
    },
  },
}));
app.use(express.json({ limit: "2mb" }));

// Session storage: connect-pg-simple, sharing the same pg Pool used for
// app data — a single pool for the whole app. Its own `session` table is
// auto-created on first run (createTableIfMissing) rather than being part
// of our own schema init, which keeps that concern isolated to the
// session-store library.
app.use(session({
  store: new PgSession({ pool, tableName: "session", createTableIfMissing: true }),
  name: "capacity_planner_sid",
  secret: process.env.SESSION_SECRET || "dev-secret-change-me-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd, // requires HTTPS in production — see README
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

if (!process.env.SESSION_SECRET) {
  console.warn("⚠ SESSION_SECRET is not set — using an insecure default. Set it before deploying (see .env.example).");
}

// Lazy, idempotent schema/seed init, run as middleware ahead of every /api/*
// route so it's guaranteed to have completed (on this warm instance) before
// any route touches the DB — this is what makes cold starts on serverless
// safe without any module-load-time synchronous DDL. See server/db.js for
// details on ensureInit()'s caching and the documented first-seed race.
app.use("/api", async (req, res, next) => {
  try {
    await ensureInit();
    next();
  } catch (err) {
    console.error("Database init failed:", err);
    res.status(503).json({ error: "Database is not available. Please try again shortly." });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/state", stateRoutes);
app.use("/api/resources", resourceRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/allocations", allocationRoutes);
app.use("/api/versions", versionRoutes);
app.use("/api/audit", auditLogRoutes);
app.use("/api/users", userRoutes);
app.use("/api/export", exportRoutes);

app.use(express.static(path.join(__dirname, "..", "public")));
// Fallback for client-side routes (e.g. /reset-password.html is a real
// static file so it's served above; anything else not under /api/ gets the
// SPA shell). Deliberately not a path-pattern route — Express 5's stricter
// path-to-regexp rejects a bare "*", and middleware-with-no-path avoids that.
// (This app has no client-side router — it's a single index.html with
// in-page tabs — so this fallback only really matters for stray/unknown
// paths; Vercel's static file serving handles the known public/ files
// directly in production, see vercel.json.)
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

module.exports = app;
