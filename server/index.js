// Local dev / traditional-host entry point. Vercel doesn't use this file —
// it imports server/app.js directly via api/index.js and never calls
// .listen() (serverless functions don't run a long-lived process).
require("dotenv").config();
const app = require("./app");
const { DEV_MODE } = require("./mailer");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\nHGS AgentX Capacity Planner listening on http://localhost:${PORT}`);
  console.log(`Allowed login domain: @${(process.env.ALLOWED_EMAIL_DOMAIN || "hgs.com")}`);
  console.log(DEV_MODE
    ? "Mail delivery: DEV MODE (no SMTP configured) — verification links are logged to the console and (best-effort, local only) data/mail-outbox.log."
    : `Mail delivery: SMTP (${process.env.SMTP_HOST})`);
});
