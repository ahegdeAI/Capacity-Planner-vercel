// Server-side audit log — this is the key upgrade from the old single-file
// version, where the audit trail was just a JS array anyone could edit from
// devtools. Every write goes through this one function, tied to the
// server-verified session user, into the shared Postgres DB.
const crypto = require("crypto");
const db = require("./db");

async function logAudit({ action, entity, entityId, entityName, field, oldValue, newValue, userEmail, userName }) {
  await db.run(
    `INSERT INTO audit_log (id, ts, user_email, user_name, action, entity, entity_id, entity_name, field, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      "log_" + crypto.randomBytes(10).toString("hex"),
      new Date().toISOString(),
      userEmail || null,
      userName || "Unknown",
      action, entity,
      entityId || null,
      entityName || "",
      field || null,
      oldValue === undefined ? null : String(oldValue),
      newValue === undefined ? null : String(newValue),
    ]
  );
}

module.exports = { logAudit };
