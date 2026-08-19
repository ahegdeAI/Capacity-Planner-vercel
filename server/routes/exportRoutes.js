const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { snapshotFromDb } = require("../seed");

const router = express.Router();
router.use(requireAuth);

async function getMeta(key, fallback) {
  const row = await db.get("SELECT value FROM meta WHERE key = $1", [key]);
  return row ? JSON.parse(row.value) : fallback;
}

router.get("/json", async (req, res) => {
  const snapshot = await snapshotFromDb();
  const auditLog = await db.all("SELECT * FROM audit_log ORDER BY ts");
  const versions = await db.all("SELECT * FROM versions ORDER BY ts");
  const payload = {
    ...snapshot,
    months: await getMeta("months", []),
    roles: await getMeta("roles", []),
    meta: await getMeta("fy", {}),
    auditLog: auditLog.map((r) => ({ id: r.id, ts: r.ts, user: r.user_name, userEmail: r.user_email, action: r.action, entity: r.entity, entityId: r.entity_id, entityName: r.entity_name, field: r.field, oldValue: r.old_value, newValue: r.new_value })),
    versions: versions.map((v) => ({ id: v.id, ts: v.ts, user: v.user_name, label: v.label, auto: !!v.auto, snapshot: JSON.parse(v.snapshot) })),
    exportedAt: new Date().toISOString(),
    exportedBy: req.user.email,
  };
  res.setHeader("Content-Disposition", 'attachment; filename="capacity-planner-backup.json"');
  res.json(payload);
});

// Full DB restore from a previously-exported backup file. This is a
// destructive operation (like a version restore) — a safety-net snapshot
// is always taken first. Every logged-in account can do this today; if
// that turns out to be too permissive for a shared multi-user deployment,
// add a `role` column to users and gate this behind it.
router.post("/import", async (req, res) => {
  const data = req.body || {};
  if (!Array.isArray(data.resources) || !Array.isArray(data.projects) || !Array.isArray(data.allocations)) {
    return res.status(400).json({ error: "File is missing resources/projects/allocations." });
  }

  const beforeSnapshot = await snapshotFromDb();
  await db.run(
    `INSERT INTO versions (id, ts, user_email, user_name, label, auto, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ["v_" + crypto.randomBytes(8).toString("hex"), new Date().toISOString(), req.user.email, req.user.displayName, "Auto-save before importing a backup file", 1, JSON.stringify(beforeSnapshot)]
  );

  const now = new Date().toISOString();
  await db.withTransaction(async (tx) => {
    await tx.run("DELETE FROM allocations");
    await tx.run("DELETE FROM projects");
    await tx.run("DELETE FROM resources");
    for (const r of data.resources) {
      await tx.run(
        `INSERT INTO resources (id, name, role, area, cap, cap_notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.id, r.name, r.role, r.area, JSON.stringify(r.cap), JSON.stringify(r.capNotes || new Array(12).fill(null)), now, now]
      );
    }
    for (const p of data.projects) {
      await tx.run(
        `INSERT INTO projects (id, name, group_name, area, status, priority, start_date, end_date, notes, roles, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [p.id, p.name, p.group, p.area, p.status, p.priority, p.start || null, p.end || null, p.notes || "", JSON.stringify(p.roles || {}), now, now]
      );
    }
    for (const a of data.allocations) {
      await tx.run(
        `INSERT INTO allocations (id, resource_id, project_id, months, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [a.id, a.resourceId, a.projectId, JSON.stringify(a.months), now, now]
      );
    }
  });

  await logAudit({
    action: "import", entity: "system", entityName: "Backup file", userEmail: req.user.email, userName: req.user.displayName,
    newValue: `${data.resources.length} resources, ${data.projects.length} projects, ${data.allocations.length} allocations`,
  });
  res.json({ ok: true });
});

module.exports = router;
