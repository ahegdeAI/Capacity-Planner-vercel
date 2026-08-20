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
  // The "Add assignment" modal (public/app.js) always sends an explicit
  // resourceId + projectId the user picked — this is what actually fixes
  // the "adding a new row doesn't seem to do anything" bug: the OLD
  // behaviour (always defaulting to whichever resource/project sorts first
  // alphabetically) silently created a row for a resource×project pair
  // that, in practice, almost never matched whatever the Allocations
  // table's own Resource/Project filter was currently set to — so the row
  // WAS added (and persisted), but immediately filtered out of view with
  // no error and no visual change, which is indistinguishable from "did
  // nothing" to a user with a filter active. See revealAllocationRow() in
  // app.js for the client-side half of this fix (it also clears any
  // now-conflicting filter so the new row is guaranteed visible).
  //
  // resourceId/projectId are still optional and fall back to the old
  // alphabetically-first behaviour if omitted, for back-compat with any
  // other caller.
  const { resourceId, projectId, months: monthsBody } = req.body || {};
  let resource = resourceId ? await db.get("SELECT id FROM resources WHERE id = $1", [resourceId]) : null;
  let project = projectId ? await db.get("SELECT id FROM projects WHERE id = $1", [projectId]) : null;
  if (!resource) resource = await db.get("SELECT id FROM resources ORDER BY name LIMIT 1");
  if (!project) project = await db.get("SELECT id FROM projects ORDER BY name LIMIT 1");
  if (!resource || !project) return res.status(400).json({ error: "Add at least one resource and one project first." });

  const id = "a_" + crypto.randomBytes(8).toString("hex");
  const now = new Date().toISOString();
  let months = new Array(12).fill(0);
  if (Array.isArray(monthsBody) && monthsBody.length === 12) {
    months = monthsBody.map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    });
  }
  await db.run(
    `INSERT INTO allocations (id, resource_id, project_id, months, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, resource.id, project.id, JSON.stringify(months), now, now]
  );
  await logAudit({ action: "create", entity: "allocation", entityId: id, entityName: `${await resourceName(resource.id)} × ${await projectName(project.id)}`, userEmail: req.user.email, userName: req.user.displayName });
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
