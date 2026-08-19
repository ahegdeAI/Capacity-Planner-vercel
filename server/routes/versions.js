const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { snapshotFromDb } = require("../seed");

const router = express.Router();
router.use(requireAuth);

async function saveVersion({ label, auto, userEmail, userName }) {
  const id = "v_" + crypto.randomBytes(8).toString("hex");
  const ts = new Date().toISOString();
  const snapshot = await snapshotFromDb();
  await db.run(
    `INSERT INTO versions (id, ts, user_email, user_name, label, auto, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, ts, userEmail || null, userName || "Unknown", label || "Untitled snapshot", auto ? 1 : 0, JSON.stringify(snapshot)]
  );
  await logAudit({
    action: "version-save", entity: "system", entityName: label || "Untitled snapshot", userEmail, userName,
    newValue: `${snapshot.resources.length} resources, ${snapshot.projects.length} projects, ${snapshot.allocations.length} allocations`,
  });
  return { id, ts, user: userName || "Unknown", label: label || "Untitled snapshot", auto: !!auto, snapshot };
}

router.get("/", async (req, res) => {
  const rows = await db.all("SELECT id, ts, user_email, user_name, label, auto, snapshot FROM versions ORDER BY ts DESC");
  res.json(rows.map((v) => ({
    id: v.id, ts: v.ts, user: v.user_name, userEmail: v.user_email, label: v.label, auto: !!v.auto,
    snapshot: JSON.parse(v.snapshot),
  })));
});

router.post("/", async (req, res) => {
  const v = await saveVersion({ label: (req.body || {}).label, auto: false, userEmail: req.user.email, userName: req.user.displayName });
  res.json(v);
});

router.post("/:id/restore", async (req, res) => {
  const row = await db.get("SELECT * FROM versions WHERE id = $1", [req.params.id]);
  if (!row) return res.status(404).json({ error: "Version not found." });

  // Safety net: snapshot current state before overwriting it.
  await saveVersion({ label: `Auto-save before restoring "${row.label}"`, auto: true, userEmail: req.user.email, userName: req.user.displayName });

  const snapshot = JSON.parse(row.snapshot);
  const now = new Date().toISOString();
  await db.withTransaction(async (tx) => {
    await tx.run("DELETE FROM allocations");
    await tx.run("DELETE FROM projects");
    await tx.run("DELETE FROM resources");
    for (const r of snapshot.resources) {
      await tx.run(
        `INSERT INTO resources (id, name, role, area, cap, cap_notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.id, r.name, r.role, r.area, JSON.stringify(r.cap), JSON.stringify(r.capNotes || new Array(12).fill(null)), now, now]
      );
    }
    for (const p of snapshot.projects) {
      await tx.run(
        `INSERT INTO projects (id, name, group_name, area, status, priority, start_date, end_date, notes, roles, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [p.id, p.name, p.group, p.area, p.status, p.priority, p.start || null, p.end || null, p.notes || "", JSON.stringify(p.roles || {}), now, now]
      );
    }
    for (const a of snapshot.allocations) {
      await tx.run(
        `INSERT INTO allocations (id, resource_id, project_id, months, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [a.id, a.resourceId, a.projectId, JSON.stringify(a.months), now, now]
      );
    }
  });

  await logAudit({
    action: "version-restore", entity: "system", entityName: row.label, userEmail: req.user.email, userName: req.user.displayName,
    newValue: `Restored to snapshot saved ${row.ts} by ${row.user_name}`,
  });
  res.json({ ok: true });
});

module.exports = router;
