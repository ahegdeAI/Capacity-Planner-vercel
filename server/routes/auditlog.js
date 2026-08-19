const express = require("express");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const { user, limit } = req.query;
  let rows;
  if (user && user !== "All") {
    rows = await db.all("SELECT * FROM audit_log WHERE user_name = $1 ORDER BY ts DESC LIMIT $2", [user, Number(limit) || 500]);
  } else {
    rows = await db.all("SELECT * FROM audit_log ORDER BY ts DESC LIMIT $1", [Number(limit) || 500]);
  }
  res.json(rows.map((r) => ({
    id: r.id, ts: r.ts, user: r.user_name, userEmail: r.user_email, action: r.action, entity: r.entity,
    entityId: r.entity_id, entityName: r.entity_name, field: r.field, oldValue: r.old_value, newValue: r.new_value,
  })));
});

router.get("/users", async (req, res) => {
  const rows = await db.all("SELECT DISTINCT user_name FROM audit_log WHERE user_name IS NOT NULL ORDER BY user_name");
  res.json(rows.map((r) => r.user_name));
});

router.get("/export.csv", async (req, res) => {
  const rows = await db.all("SELECT * FROM audit_log ORDER BY ts DESC");
  const header = ["Timestamp", "User", "User email", "Action", "Entity", "Entity name", "Field", "Old value", "New value"];
  const csvRows = rows.map((r) => [r.ts, r.user_name, r.user_email, r.action, r.entity, r.entity_name, r.field || "", r.old_value || "", r.new_value || ""]);
  const csv = [header, ...csvRows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="capacity-planner-audit-log.csv"');
  res.send(csv);
});

module.exports = router;
