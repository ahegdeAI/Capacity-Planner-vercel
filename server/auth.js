const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("./db");
const { sendMail, getRecentOutbox, DEV_MODE } = require("./mailer");
const { logAudit } = require("./audit");

const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "hgs.com").toLowerCase();
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

function isAllowedEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 0) return false;
  return e.slice(at + 1) === ALLOWED_DOMAIN;
}

function newId(prefix) { return `${prefix}_${crypto.randomBytes(12).toString("hex")}`; }
function newToken() { return crypto.randomBytes(24).toString("hex"); }

// Rate limits — modest defaults to slow down credential stuffing / spam
// without needing an external service; tune via env if this ever sits
// behind real traffic.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

async function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: "Not logged in." });
  const user = await db.get("SELECT * FROM users WHERE id = $1", [req.session.userId]);
  if (!user || !user.email_verified) { req.session.destroy(() => {}); return res.status(401).json({ error: "Not logged in." }); }
  req.user = { id: user.id, email: user.email, displayName: user.display_name };
  next();
}

function publicUser(row) {
  return { id: row.id, email: row.email, displayName: row.display_name, emailVerified: !!row.email_verified, createdAt: row.created_at };
}

const router = express.Router();

router.post("/register", authLimiter, async (req, res) => {
  const { email, displayName, password } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !password || password.length < 8) {
    return res.status(400).json({ error: "Enter a valid email and a password of at least 8 characters." });
  }
  if (!isAllowedEmail(cleanEmail)) {
    return res.status(403).json({ error: `Only @${ALLOWED_DOMAIN} email addresses can register for this tool.` });
  }
  const existing = await db.get("SELECT id FROM users WHERE email = $1", [cleanEmail]);
  if (existing) return res.status(409).json({ error: "An account with that email already exists — try logging in instead." });

  const id = newId("user");
  const passwordHash = await bcrypt.hash(password, 12);
  const createdAt = new Date().toISOString();
  await db.run(
    `INSERT INTO users (id, email, display_name, password_hash, email_verified, created_at) VALUES ($1, $2, $3, $4, 0, $5)`,
    [id, cleanEmail, (displayName || "").trim() || cleanEmail.split("@")[0], passwordHash, createdAt]
  );

  const token = newToken();
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString();
  await db.run(
    `INSERT INTO email_verifications (id, user_id, token, expires_at, used, created_at) VALUES ($1, $2, $3, $4, 0, $5)`,
    [newId("ev"), id, token, expiresAt, createdAt]
  );

  const verifyUrl = `${req.protocol}://${req.get("host")}/api/auth/verify?token=${token}`;
  await sendMail({
    to: cleanEmail,
    subject: "Verify your HGS AgentX Capacity Planner account",
    text: `Welcome to the AgentX Resource Capacity Planner.\n\nClick this link to verify your email and activate your account:\n${verifyUrl}\n\nThis link expires in 24 hours.`,
  });

  await logAudit({ action: "create", entity: "system", entityId: id, entityName: `Account registered: ${cleanEmail}`, userEmail: cleanEmail, userName: displayName });

  const payload = { ok: true, message: `Account created. Check ${cleanEmail} for a verification link before logging in.` };
  if (DEV_MODE) payload.devVerifyUrl = verifyUrl; // only because no real SMTP is configured — see mailer.js
  res.json(payload);
});

router.get("/verify", async (req, res) => {
  const { token } = req.query;
  const row = token && await db.get("SELECT * FROM email_verifications WHERE token = $1", [token]);
  if (!row || row.used || new Date(row.expires_at) < new Date()) {
    return res.status(400).send(verifyResultPage(false));
  }
  await db.run("UPDATE email_verifications SET used = 1 WHERE id = $1", [row.id]);
  await db.run("UPDATE users SET email_verified = 1 WHERE id = $1", [row.user_id]);
  const user = await db.get("SELECT * FROM users WHERE id = $1", [row.user_id]);
  await logAudit({ action: "update", entity: "system", entityId: user.id, entityName: `Email verified: ${user.email}`, userEmail: user.email, userName: user.display_name, field: "email_verified", oldValue: "false", newValue: "true" });
  res.send(verifyResultPage(true));
});

function verifyResultPage(ok) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Verify email</title>
  <style>body{font-family:system-ui,sans-serif;background:#001c41;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{background:#fff;color:#2d2d2d;padding:32px 36px;border-radius:12px;max-width:380px;text-align:center}
  a{color:#0088dd;font-weight:600}</style></head><body>
  <div class="box"><h2>${ok ? "✅ Email verified" : "❌ Link invalid or expired"}</h2>
  <p>${ok ? "Your account is now active — you can close this tab and log in." : "Please request a new verification email from the login screen."}</p>
  </div></body></html>`;
}

router.post("/resend-verification", authLimiter, async (req, res) => {
  const cleanEmail = String((req.body || {}).email || "").trim().toLowerCase();
  const user = await db.get("SELECT * FROM users WHERE email = $1", [cleanEmail]);
  // Same response whether or not the account exists, to avoid leaking who has an account.
  const generic = { ok: true, message: "If that account exists and isn't verified yet, a new link has been sent." };
  if (!user || user.email_verified) return res.json(generic);

  const token = newToken();
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString();
  await db.run(
    `INSERT INTO email_verifications (id, user_id, token, expires_at, used, created_at) VALUES ($1, $2, $3, $4, 0, $5)`,
    [newId("ev"), user.id, token, expiresAt, new Date().toISOString()]
  );
  const verifyUrl = `${req.protocol}://${req.get("host")}/api/auth/verify?token=${token}`;
  await sendMail({ to: user.email, subject: "Verify your HGS AgentX Capacity Planner account", text: `Verify your email:\n${verifyUrl}\n\nExpires in 24 hours.` });
  if (DEV_MODE) generic.devVerifyUrl = verifyUrl;
  res.json(generic);
});

router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();
  const user = await db.get("SELECT * FROM users WHERE email = $1", [cleanEmail]);
  if (!user) return res.status(401).json({ error: "No account with that email." });
  if (!isAllowedEmail(user.email)) return res.status(403).json({ error: `Only @${ALLOWED_DOMAIN} accounts can log in.` });
  const ok = await bcrypt.compare(password || "", user.password_hash);
  if (!ok) return res.status(401).json({ error: "Incorrect password." });
  if (!user.email_verified) return res.status(403).json({ error: "Please verify your email before logging in — check your inbox, or resend the link.", needsVerification: true });

  req.session.userId = user.id;
  await logAudit({ action: "login", entity: "system", entityId: user.id, entityName: `Logged in: ${user.email}`, userEmail: user.email, userName: user.display_name });
  res.json({ ok: true, user: publicUser(user) });
});

router.post("/logout", async (req, res) => {
  const userId = req.session && req.session.userId;
  if (userId) {
    const user = await db.get("SELECT * FROM users WHERE id = $1", [userId]);
    if (user) await logAudit({ action: "logout", entity: "system", entityId: user.id, entityName: `Logged out: ${user.email}`, userEmail: user.email, userName: user.display_name });
  }
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", async (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ user: null });
  const user = await db.get("SELECT * FROM users WHERE id = $1", [req.session.userId]);
  if (!user || !user.email_verified) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

router.post("/forgot-password", authLimiter, async (req, res) => {
  const cleanEmail = String((req.body || {}).email || "").trim().toLowerCase();
  const user = await db.get("SELECT * FROM users WHERE email = $1", [cleanEmail]);
  const generic = { ok: true, message: "If that account exists, a password reset link has been sent." };
  if (!user) return res.json(generic);

  const token = newToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await db.run(
    `INSERT INTO password_resets (id, user_id, token, expires_at, used, created_at) VALUES ($1, $2, $3, $4, 0, $5)`,
    [newId("pr"), user.id, token, expiresAt, new Date().toISOString()]
  );
  const resetUrl = `${req.protocol}://${req.get("host")}/reset-password.html?token=${token}`;
  await sendMail({ to: user.email, subject: "Reset your HGS AgentX Capacity Planner password", text: `Reset your password:\n${resetUrl}\n\nExpires in 1 hour. If you didn't request this, ignore this email.` });
  if (DEV_MODE) generic.devResetUrl = resetUrl;
  res.json(generic);
});

router.post("/reset-password", authLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const row = token && await db.get("SELECT * FROM password_resets WHERE token = $1", [token]);
  if (!row || row.used || new Date(row.expires_at) < new Date()) return res.status(400).json({ error: "This reset link is invalid or has expired." });
  const passwordHash = await bcrypt.hash(password, 12);
  await db.run("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, row.user_id]);
  await db.run("UPDATE password_resets SET used = 1 WHERE id = $1", [row.id]);
  const user = await db.get("SELECT * FROM users WHERE id = $1", [row.user_id]);
  await logAudit({ action: "update", entity: "system", entityId: user.id, entityName: `Password reset: ${user.email}`, userEmail: user.email, userName: user.display_name, field: "password", oldValue: "(hidden)", newValue: "(reset)" });
  res.json({ ok: true });
});

// Dev-only: lets the login screen show "here's your dev verification link"
// when no real SMTP is configured, instead of the user being stuck with no
// mailbox to check. Disabled automatically the moment SMTP_HOST is set.
router.get("/dev/outbox", (req, res) => {
  if (!DEV_MODE) return res.status(404).end();
  res.json({ devMode: true, messages: getRecentOutbox() });
});

module.exports = { router, requireAuth, isAllowedEmail, publicUser, ALLOWED_DOMAIN, authLimiter };
