// Email delivery — abstracted so real SMTP can be dropped in later without
// touching any calling code. No SMTP credentials are available in this
// environment, so by default this runs in DEV MODE: instead of actually
// sending mail, it logs the message to the console and (best-effort) appends
// it to data/mail-outbox.log, and (only outside production) keeps the last
// 50 messages in memory so the app's login screen can show a "here's your
// dev link" banner for demoing/testing without a real mailbox.
//
// The file write is wrapped in try/catch and is skipped entirely when
// running on Vercel: Vercel's filesystem is read-only outside /tmp, and
// /tmp doesn't persist across invocations anyway, so writing there would be
// pointless and writing anywhere else would throw. The two mechanisms that
// DO reliably work on Vercel — console.log (visible in Vercel's function
// logs) and the devVerifyUrl/devResetUrl fields returned directly in the API
// response — always still run.
//
// To go live: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in
// the environment (see .env.example) and restart — sendMail() will
// automatically switch to real delivery via nodemailer, no code changes.
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const DEV_MODE = !process.env.SMTP_HOST;
const DATA_DIR = path.join(__dirname, "..", "data");
const OUTBOX_PATH = path.join(DATA_DIR, "mail-outbox.log");

// Best-effort local-dev convenience only — never assume this succeeds.
if (!process.env.VERCEL) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) { /* non-fatal */ }
}
const recentOutbox = []; // in-memory, dev/demo only

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (DEV_MODE) {
    // "jsonTransport" never contacts the network — it just formats the
    // message so we can log/inspect it. Safe default with no credentials.
    transporter = nodemailer.createTransport({ jsonTransport: true });
  } else {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.SMTP_FROM || "HGS AgentX Capacity Planner <no-reply@hgs.com>";
  const t = getTransporter();
  const info = await t.sendMail({ from, to, subject, text, html });

  if (DEV_MODE) {
    const entry = { to, subject, text, sentAt: new Date().toISOString() };
    recentOutbox.unshift(entry);
    if (recentOutbox.length > 50) recentOutbox.pop();
    // Skip the file write entirely on Vercel (read-only FS outside /tmp,
    // and /tmp wouldn't persist across invocations anyway); everywhere else,
    // best-effort only — this is a debugging convenience, never load-bearing.
    if (!process.env.VERCEL) {
      try {
        fs.appendFileSync(OUTBOX_PATH, JSON.stringify(entry) + "\n");
      } catch (e) { /* non-fatal — logging only, e.g. read-only FS */ }
    }
    console.log(`\n[DEV MAIL] To: ${to}\n[DEV MAIL] Subject: ${subject}\n[DEV MAIL] ${text}\n`);
  }
  return info;
}

function getRecentOutbox() { return recentOutbox; }

module.exports = { sendMail, getRecentOutbox, DEV_MODE };
