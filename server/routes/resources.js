const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { rowToResource } = require("../seed");

const router = express.Router();
router.use(requireAuth);

async function getMeta(key, fallback) {
  const row = await db.get("SELECT value FROM meta WHERE key = $1", [key]);
  return row ? JSON.parse(row.value) : fallback;
}
async function monthLabel(idx) { const months = await getMeta("months", []); return (months[idx] && months[idx].label) || `Month ${idx + 1}`; }

router.post("/", async (req, res) => {
  const { name, role, area } = req.body || {};
  const id = "r_" + crypto.randomBytes(8).toString("hex");
  const now = new Date().toISOString();
  const cap = new Array(12).fill(100);
  const capNotes = new Array(12).fill(null);
  await db.run(
    `INSERT INTO resources (id, name, role, area, cap, cap_notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, name || "New resource", role || "", area || "Engineering", JSON.stringify(cap), JSON.stringify(capNotes), now, now]
  );
  await logAudit({ action: "create", entity: "resource", entityId: id, entityName: name || "New resource", userEmail: req.user.email, userName: req.user.displayName });
  res.json(rowToResource(await db.get("SELECT * FROM resources WHERE id = $1", [id])));
});

router.patch("/:id", async (req, res) => {
  const row = await db.get("SELECT * FROM resources WHERE id = $1", [req.params.id]);
  if (!row) return res.status(404).json({ error: "Resource not found." });
  const r = rowToResource(row);
  const { field, idx, value, note } = req.body || {};
  let fieldLabel = field, oldValue, newValue;

  if (field === "cap") {
    oldValue = r.cap[idx]; r.cap[idx] = value; newValue = value;
    fieldLabel = `Capacity % — ${await monthLabel(idx)}`;
  } else if (field === "capNote") {
    oldValue = r.capNotes[idx] ? JSON.stringify(r.capNotes[idx]) : "(empty)";
    r.capNotes[idx] = note; newValue = note ? JSON.stringify(note) : "(empty)";
    fieldLabel = `Holiday note — ${await monthLabel(idx)}`;
  } else if (["name", "role", "area"].includes(field)) {
    oldValue = r[field]; r[field] = value; newValue = value;
    fieldLabel = { name: "Name", role: "Role", area: "Area" }[field];
  } else {
    return res.status(400).json({ error: "Unknown field." });
  }

  const now = new Date().toISOString();
  await db.run(
    `UPDATE resources SET name=$1, role=$2, area=$3, cap=$4, cap_notes=$5, updated_at=$6 WHERE id=$7`,
    [r.name, r.role, r.area, JSON.stringify(r.cap), JSON.stringify(r.capNotes), now, r.id]
  );

  if (String(oldValue) !== String(newValue)) {
    await logAudit({ action: "update", entity: "resource", entityId: r.id, entityName: r.name, field: fieldLabel, oldValue, newValue, userEmail: req.user.email, userName: req.user.displayName });
  }
  res.json(rowToResource(await db.get("SELECT * FROM resources WHERE id = $1", [r.id])));
});

router.delete("/:id", async (req, res) => {
  const row = await db.get("SELECT * FROM resources WHERE id = $1", [req.params.id]);
  if (!row) return res.status(404).json({ error: "Resource not found." });
  const allocCountRow = await db.get("SELECT COUNT(*) AS n FROM allocations WHERE resource_id = $1", [req.params.id]);
  const allocCount = Number(allocCountRow.n);
  await db.run("DELETE FROM allocations WHERE resource_id = $1", [req.params.id]);
  await db.run("DELETE FROM resources WHERE id = $1", [req.params.id]);
  await logAudit({
    action: "delete", entity: "resource", entityId: row.id, entityName: row.name,
    newValue: allocCount ? `Also removed ${allocCount} allocation row(s) for this resource` : undefined,
    userEmail: req.user.email, userName: req.user.displayName,
  });
  res.json({ ok: true });
});

module.exports = router;
