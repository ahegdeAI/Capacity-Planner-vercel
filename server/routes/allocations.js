const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { rowToAllocation } = require("../seed");

const router = express.Router();
router.use(requireAuth);

async function getMeta(key, fallback) {
  const row = await db.get("SELECT value FROM meta WHERE key = $1", [key]);
  return row ? JSON.parse(row.value) : fallback;
}
async function monthLabel(idx) { const months = await getMeta("months", []); return (months[idx] && months[idx].label) || `Month ${idx + 1}`; }
async function resourceName(id) { const r = await db.get("SELECT name FROM resources WHERE id = $1", [id]); return r ? r.name : id; }
async function projectName(id) { const p = await db.get("SELECT name FROM projects WHERE id = $1", [id]); return p ? p.name : id; }

async function persist(a) {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE allocations SET resource_id=$1, project_id=$2, months=$3, updated_at=$4 WHERE id=$5`,
    [a.resourceId, a.projectId, JSON.stringify(a.months), now, a.id]
  );
}

router.post("/", async (req, res) => {
  const firstResource = await db.get("SELECT id FROM resources ORDER BY name LIMIT 1");
  const firstProject = await db.get("SELECT id FROM projects ORDER BY name LIMIT 1");
  if (!firstResource || !firstProject) return res.status(400).json({ error: "Add at least one resource and one project first." });
  const id = "a_" + crypto.randomBytes(8).toString("hex");
  const now = new Date().toISOString();
  const months = new Array(12).fill(0);
  await db.run(
    `INSERT INTO allocations (id, resource_id, project_id, months, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, firstResource.id, firstProject.id, JSON.stringify(months), now, now]
  );
  await logAudit({ action: "create", entity: "allocation", entityId: id, entityName: `${await resourceName(firstResource.id)} × ${await projectName(firstProject.id)}`, userEmail: req.user.email, userName: req.user.displayName });
  res.json(rowToAllocation(await db.get("SELECT * FROM allocations WHERE id = $1", [id])));
});

router.patch("/:id", async (req, res) => {
  const row = await db.get("SELECT * FROM allocations WHERE id = $1", [req.params.id]);
  if (!row) return res.status(404).json({ error: "Allocation not found." });
  const a = rowToAllocation(row);
  const { field, idx, value } = req.body || {};
  let fieldLabel, oldValue, newValue;

  if (field === "month") {
    oldValue = a.months[idx]; a.months[idx] = value; newValue = value;
    fieldLabel = `Allocation % — ${await monthLabel(idx)}`;
  } else if (field === "resourceId") {
    oldValue = await resourceName(a.resourceId); a.resourceId = value; newValue = await resourceName(value);
    fieldLabel = "Resource";
  } else if (field === "projectId") {
    oldValue = await projectName(a.projectId); a.projectId = value; newValue = await projectName(value);
    fieldLabel = "Project";
  } else {
    return res.status(400).json({ error: "Unknown field." });
  }

  await persist(a);
  const entityName = `${await resourceName(a.resourceId)} × ${await projectName(a.projectId)}`;
  if (String(oldValue) !== String(newValue)) {
    await logAudit({ action: "update", entity: "allocation", entityId: a.id, entityName, field: fieldLabel, oldValue, newValue, userEmail: req.user.email, userName: req.user.displayName });
  }
  res.json(rowToAllocation(await db.get("SELECT * FROM allocations WHERE id = $1", [a.id])));
});

router.delete("/:id", async (req, res) => {
  const row = await db.get("SELECT * FROM allocations WHERE id = $1", [req.params.id]);
  if (!row) return res.status(404).json({ error: "Allocation not found." });
  const entityName = `${await resourceName(row.resource_id)} × ${await projectName(row.project_id)}`;
  await db.run("DELETE FROM allocations WHERE id = $1", [req.params.id]);
  await logAudit({ action: "delete", entity: "allocation", entityId: row.id, entityName, userEmail: req.user.email, userName: req.user.displayName });
  res.json({ ok: true });
});

module.exports = router;
