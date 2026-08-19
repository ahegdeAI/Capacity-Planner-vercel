// First-boot seeding: loads the original converted-from-Excel dataset into
// the Postgres DB, but only if the DB is empty — every run after that reads
// straight from the DB, so edits persist across restarts/cold-starts and
// are shared between everyone who logs in.
const fs = require("fs");
const path = require("path");
const db = require("./db");

function nowISO() { return new Date().toISOString(); }

async function seedIfEmpty() {
  const row = await db.get("SELECT COUNT(*) AS n FROM resources");
  if (Number(row.n) > 0) return false; // already seeded

  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-data.json"), "utf8"));
  const ts = nowISO();

  await db.withTransaction(async (tx) => {
    for (const r of seed.resources) {
      await tx.run(
        `INSERT INTO resources (id, name, role, area, cap, cap_notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.id, r.name, r.role, r.area, JSON.stringify(r.cap), JSON.stringify(r.capNotes || new Array(12).fill(null)), ts, ts]
      );
    }
    for (const p of seed.projects) {
      // Note: seed-data.json still has an `area` field on each project
      // object (harmless leftover from before Area/Type was removed from
      // Projects) -- it's intentionally not read here anymore.
      await tx.run(
        `INSERT INTO projects (id, name, group_name, status, priority, start_date, end_date, notes, roles, billable, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [p.id, p.name, p.group, p.status, p.priority, p.start || null, p.end || null, p.notes || "", JSON.stringify(p.roles || {}), p.billable === false ? false : true, ts, ts]
      );
    }
    for (const a of seed.allocations) {
      await tx.run(
        `INSERT INTO allocations (id, resource_id, project_id, months, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [a.id, a.resourceId, a.projectId, JSON.stringify(a.months), ts, ts]
      );
    }

    const upsertMeta = (key, value) =>
      tx.run(
        `INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    await upsertMeta("months", JSON.stringify(seed.months));
    await upsertMeta("roles", JSON.stringify(seed.roles));
    await upsertMeta("fixesApplied", JSON.stringify(seed.fixesApplied || []));
    await upsertMeta("fy", JSON.stringify(seed.meta || {}));

    await tx.run(
      `INSERT INTO audit_log (id, ts, user_email, user_name, action, entity, entity_id, entity_name, field, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        "log_seed_" + Date.now(), ts, null, "System",
        "create", "system", null, "Database seeded",
        null, null,
        `${seed.resources.length} resources, ${seed.projects.length} projects, ${seed.allocations.length} allocations — ${(seed.fixesApplied || []).length} fixes applied on conversion from Excel`,
      ]
    );

    // Snapshot for the initial version has to be built from what we just
    // inserted (there's no snapshotFromDb-on-the-transaction helper), so
    // build it directly from the seed data rather than re-querying.
    const snapshot = {
      resources: seed.resources.map((r) => ({ id: r.id, name: r.name, role: r.role, area: r.area, cap: r.cap, capNotes: r.capNotes || new Array(12).fill(null) })),
      projects: seed.projects.map((p) => ({ id: p.id, name: p.name, group: p.group, status: p.status, priority: p.priority, start: p.start || null, end: p.end || null, notes: p.notes || "", roles: p.roles || {}, billable: p.billable === false ? false : true })),
      allocations: seed.allocations.map((a) => ({ id: a.id, resourceId: a.resourceId, projectId: a.projectId, months: a.months })),
    };
    await tx.run(
      `INSERT INTO versions (id, ts, user_email, user_name, label, auto, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["v_seed_" + Date.now(), ts, null, "System", "Original workbook data (converted from Excel)", 1, JSON.stringify(snapshot)]
    );
  });

  return true;
}

async function snapshotFromDb() {
  const resourceRows = await db.all("SELECT * FROM resources ORDER BY name");
  const projectRows = await db.all("SELECT * FROM projects ORDER BY name");
  const allocationRows = await db.all("SELECT * FROM allocations");
  return {
    resources: resourceRows.map(rowToResource),
    projects: projectRows.map(rowToProject),
    allocations: allocationRows.map(rowToAllocation),
  };
}

function rowToResource(row) {
  return {
    id: row.id, name: row.name, role: row.role, area: row.area,
    cap: JSON.parse(row.cap), capNotes: JSON.parse(row.cap_notes),
  };
}
function rowToProject(row) {
  return {
    id: row.id, name: row.name, group: row.group_name, status: row.status,
    priority: row.priority, start: row.start_date, end: row.end_date, notes: row.notes,
    roles: JSON.parse(row.roles),
    // Default true (Billable) for any row that predates this column —
    // matches how the org has presumably been treating all projects until
    // now. In practice the DB-level NOT NULL DEFAULT true (see db.js's
    // migration) means row.billable is never actually null/undefined, but
    // this stays defensive in case of e.g. hand-edited data.
    billable: row.billable === false ? false : true,
  };
}
function rowToAllocation(row) {
  return { id: row.id, resourceId: row.resource_id, projectId: row.project_id, months: JSON.parse(row.months) };
}

module.exports = { seedIfEmpty, snapshotFromDb, rowToResource, rowToProject, rowToAllocation, nowISO };
