const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { rowToProject } = require("../seed");

const router = express.Router();
router.use(requireAuth);

const FIELD_LABELS = { name: "Name", group: "Group", area: "Area/Type", status: "Status", priority: "Priority", start: "Start date", end: "End date", notes: "Notes" };

async function persist(p) {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE projects SET name=$1, group_name=$2, area=$3, status=$4, priority=$5, start_date=$6, end_date=$7, notes=$8, roles=$9, updated_at=$10 WHERE id=$11`,
    [p.name, p.group, p.area, p.status, p.priority, p.start || null, p.end || null, p.notes || "", JSON.stringify(p.roles || {}), now, p.id]
  );
}

router.post("/", async (req, res) => {
  const id = "p_" + crypto.randomBytes(8).toString("hex");
  const now = new Date().toISOString();
  const name = (req.body || {}).name || "New project";
  await db.run(
    `INSERT INTO projects (id, name, group_name, area, status, priority, start_date, end_date, notes, roles, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, name, "CORE", "Engineering", "Pipeline", "Medium", null, null, "", "{}", now, now]
  );
  await logAudit({ action: "create", entity: "project", entityId: id, entityName: name, userEmail: req.user.email, userName: req.user.displayName });
  res.json(rowToProject(await db.get("SELECT * FROM projects WHERE id = $1", [id])));
});

router.patch("/:id", async (req, res) => {
  const row = await db.get("SELECT * FROM projects WHERE id = $1", [req.params.id]);
  if (!row) return res.status(404).json({ error: "Project not found." });
  const p = rowToProject(row);
  const { field, role, value } = req.body || {};
  let fieldLabel, oldValue, newValue;

  if (field === "role") {
    oldValue = p.roles[role] || ""; p.roles[role] = value; newValue = value;
    fieldLabel = `Required % — ${role}`;
  } else if (FIELD_LABELS[field]) {
    oldValue = p[field]; p[field] = value; newValue = value;
    fieldLabel = FIELD_LABELS[field];
  } else {
    return res.status(400).json({ error: "Unknown field." });
  }

  await persist(p);
  if (String(oldValue || "") !== String(newValue || "")) {
    await logAudit({ action: "update", entity: "project", entityId: p.id, entityName: p.name, field: fieldLabel, oldValue, newValue, userEmail: req.user.email, userName: req.user.displayName });
  }
  res.json(rowToProject(await db.get("SELECT * FROM projects WHERE id = $1", [p.id])));
});

router.delete("/:id", async (req, res) => {
  const row = await db.get("SELECT * FROM projects WHERE id = $1", [req.params.id]);
  if (!row) return res.status(404).json({ error: "Project not found." });
  const allocCountRow = await db.get("SELECT COUNT(*) AS n FROM allocations WHERE project_id = $1", [req.params.id]);
  const allocCount = Number(allocCountRow.n);
  await db.run("DELETE FROM allocations WHERE project_id = $1", [req.params.id]);
  await db.run("DELETE FROM projects WHERE id = $1", [req.params.id]);
  await logAudit({
    action: "delete", entity: "project", entityId: row.id, entityName: row.name,
    newValue: allocCount ? `Also removed ${allocCount} allocation row(s) for this project` : undefined,
    userEmail: req.user.email, userName: req.user.displayName,
  });
  res.json({ ok: true });
});

module.exports = router;
