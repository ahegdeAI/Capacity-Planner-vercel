const express = require("express");
const db = require("../db");
const { rowToResource, rowToProject, rowToAllocation } = require("../seed");

const router = express.Router();

async function getMeta(key, fallback) {
  const row = await db.get("SELECT value FROM meta WHERE key = $1", [key]);
  return row ? JSON.parse(row.value) : fallback;
}

router.get("/", async (req, res) => {
  const resourceRows = await db.all("SELECT * FROM resources ORDER BY name");
  const projectRows = await db.all("SELECT * FROM projects ORDER BY name");
  const allocationRows = await db.all("SELECT * FROM allocations");
  res.json({
    resources: resourceRows.map(rowToResource),
    projects: projectRows.map(rowToProject),
    allocations: allocationRows.map(rowToAllocation),
    months: await getMeta("months", []),
    roles: await getMeta("roles", []),
    fixesApplied: await getMeta("fixesApplied", []),
    meta: await getMeta("fy", {}),
  });
});

module.exports = router;
