const express = require("express");
const db = require("../db");
const { requireAuth, publicUser } = require("../auth");
const { logAudit } = require("../audit");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const rows = await db.all("SELECT * FROM users WHERE email_verified = 1 ORDER BY display_name");
  res.json(rows.map(publicUser));
});

router.delete("/:id", async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove the account you're logged in as." });
  const row = await db.get("SELECT * FROM users WHERE id = $1", [req.params.id]);
  if (!row) return res.status(404).json({ error: "Account not found." });
  await db.run("DELETE FROM users WHERE id = $1", [req.params.id]);
  await logAudit({ action: "delete", entity: "system", entityId: row.id, entityName: `Account removed: ${row.display_name} (${row.email})`, userEmail: req.user.email, userName: req.user.displayName });
  res.json({ ok: true });
});

module.exports = router;
