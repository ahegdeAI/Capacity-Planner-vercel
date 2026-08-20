// "Import Actual Hours" — parses an OpenAir-style Excel export, matches its
// rows against existing Resources/Projects, and (after a review step where
// the user can flip a project's billable/non-billable classification) commits
// aggregated (resource, project, month, hours) rows into the `actuals` table.
//
// Flow: POST /preview (multipart .xlsx upload) -> parses + aggregates +
// matches, does NOT touch the DB (except read-only project lookups), and
// stashes the result server-side under a short-lived importId so the client
// doesn't have to round-trip a large payload back to us. POST /confirm takes
// that importId (+ optional per-project billable overrides) and actually
// writes to the DB, then discards the stashed session.
const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../db");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB is generous for an OpenAir timesheet export
});

// ---------------------------------------------------------------------
// In-memory import-session store — parsed-but-uncommitted preview data,
// keyed by a short-lived importId. Simple TTL sweep rather than a temp DB
// table: this is a single-process app (no serverless/multi-instance
// concerns for this particular flow — sessions are only ever read back
// within the same warm process that created them, same request cycle as a
// user reviewing a just-uploaded file), so a plain Map is the least-risk
// option that still avoids trusting a huge re-uploaded payload from the
// client on confirm.
const IMPORT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const importSessions = new Map(); // importId -> { createdAt, sourceFile, rows, requiresMonthSelection }

function sweepExpiredSessions() {
  const now = Date.now();
  for (const [id, sess] of importSessions) {
    if (now - sess.createdAt > IMPORT_SESSION_TTL_MS) importSessions.delete(id);
  }
}

// ---------------------------------------------------------------------
// Flexible header detection — synonym lists matched case-insensitively,
// whitespace-tolerant, partial-match against each header cell. OpenAir
// exports (and hand-edited variants of them) are not consistent about exact
// column names, so this deliberately doesn't assume a rigid layout.
// ---------------------------------------------------------------------
const COLUMN_SYNONYMS = {
  resource: ["resource name", "employee name", "resource", "employee", "staff name", "staff", "user name", "consultant"],
  project: ["project name", "client name", "job name", "project", "client", "job", "engagement"],
  hours: ["hours charged", "hours logged", "hours worked", "total hours", "charged hours", "logged hours", "actual hours", "hours"],
  date: ["entry date", "work date", "date", "day", "period", "timesheet period"],
  billable: ["billable/non-billable", "billing category", "billing type", "billable", "category", "type"],
};

function normalizeHeader(s) {
  return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
}
function normalizeName(s) {
  return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
}

// Picks the best-matching header cell (by column index) for each logical
// field. Exact normalized match wins over substring/partial match; each
// header cell can only be claimed by one field, first-come (resource before
// project before hours before date before billable) so e.g. a "Project
// Hours" style header can't simultaneously satisfy both "project" and
// "hours".
function detectColumns(headerRow) {
  const claimed = new Set();
  const mapping = {}; // field -> { index, header }
  const normalizedHeaders = headerRow.map(normalizeHeader);

  for (const field of Object.keys(COLUMN_SYNONYMS)) {
    const synonyms = COLUMN_SYNONYMS[field];
    let best = null; // { index, score } lower score = better (0 = exact)
    normalizedHeaders.forEach((h, idx) => {
      if (!h || claimed.has(idx)) return;
      synonyms.forEach((syn) => {
        if (h === syn) {
          if (!best || best.score > 0) best = { index: idx, score: 0 };
        } else if (h.includes(syn) || syn.includes(h)) {
          const score = 1 + Math.abs(h.length - syn.length);
          if (!best || score < best.score) best = { index: idx, score };
        }
      });
    });
    if (best) {
      mapping[field] = { index: best.index, header: headerRow[best.index] };
      claimed.add(best.index);
    }
  }
  return mapping;
}

// Builds a lookup from "monthIndex" keyed by calendar (year, month0based),
// from this app's FY months meta (e.g. key "apr26" = April 2026). This is
// how a per-row calendar date in the source file gets mapped onto the same
// 0-11 month index convention allocations.months already uses.
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function buildMonthLookup(months) {
  const lookup = new Map(); // "YYYY-M" (M = 0-based) -> index
  months.forEach((m, idx) => {
    const key = String(m.key || "").toLowerCase();
    const match = key.match(/^([a-z]{3})(\d{2})$/);
    if (!match) return;
    const abbrIdx = MONTH_ABBR.indexOf(match[1]);
    if (abbrIdx === -1) return;
    const year = 2000 + Number(match[2]);
    lookup.set(`${year}-${abbrIdx}`, idx);
  });
  return lookup;
}

// Excel serial date (1900 date system) -> JS Date. XLSX's own cellDates:true
// option handles this for real Date cells, but plain sheet_to_json(header:1)
// on a workbook read without cellDates can still hand back a raw number for
// a cell Excel displays as a date, so this is a defensive fallback.
function excelSerialToDate(n) {
  // Excel's epoch is 1899-12-30 (accounting for its fictitious 1900 leap day).
  return new Date(Math.round((n - 25569) * 86400 * 1000));
}

function parseDateCell(raw) {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date && !isNaN(raw)) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = excelSerialToDate(raw);
    return isNaN(d) ? null : d;
  }
  const d = new Date(String(raw));
  return isNaN(d) ? null : d;
}

function parseHoursCell(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

router.post("/preview", upload.single("file"), async (req, res) => {
  sweepExpiredSessions();
  if (!req.file) return res.status(400).json({ error: "No file uploaded — pick a .xlsx file." });
  if (!/\.xlsx$/i.test(req.file.originalname || "")) {
    return res.status(400).json({ error: "Only .xlsx files are supported." });
  }

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: "buffer" });
  } catch (err) {
    return res.status(400).json({ error: "Couldn't parse this file as an Excel workbook. " + err.message });
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return res.status(400).json({ error: "The workbook has no sheets." });
  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  if (!raw.length) return res.status(400).json({ error: "The first sheet is empty." });

  // Header row: first row containing at least 2 non-empty cells (skips any
  // leading title/blank rows some exports prepend).
  let headerRowIdx = raw.findIndex((r) => r.filter((c) => String(c || "").trim()).length >= 2);
  if (headerRowIdx === -1) headerRowIdx = 0;
  const headerRow = raw[headerRowIdx];
  const dataRows = raw.slice(headerRowIdx + 1).filter((r) => r.some((c) => String(c || "").trim() !== ""));

  const mapping = detectColumns(headerRow);
  const warnings = [];
  if (!mapping.resource) warnings.push("Couldn't find a resource/employee-name column — resource matching will be skipped.");
  if (!mapping.project) warnings.push("Couldn't find a project/client-name column — project matching will be skipped.");
  if (!mapping.hours) warnings.push("Couldn't find an hours column — hours will default to 0 for every row.");
  if (!mapping.resource || !mapping.project || !mapping.hours) {
    return res.status(400).json({
      error: "Couldn't detect the required columns (resource, project, and hours) in this file's header row.",
      detectedColumns: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v.header])),
      warnings,
    });
  }

  // Resource/Project lookup tables, normalized-name -> row.
  const [resourceRows, projectRows] = await Promise.all([
    db.all("SELECT id, name FROM resources"),
    db.all("SELECT id, name, billable FROM projects"),
  ]);
  const resourceByName = new Map(resourceRows.map((r) => [normalizeName(r.name), r]));
  const projectByName = new Map(projectRows.map((p) => [normalizeName(p.name), p]));

  const months = await (async () => {
    const row = await db.get("SELECT value FROM meta WHERE key = $1", ["months"]);
    return row ? JSON.parse(row.value) : [];
  })();
  const monthLookup = buildMonthLookup(months);

  const hasDateColumn = !!mapping.date;
  let anyDateParsed = false;
  let anyDateUnmapped = false;

  // Aggregation: key = resourceKey||projectKey||month (month is "" when no
  // date column exists at all — see comment above importSessions — every
  // row in that case belongs to the single period the user picks at
  // confirm time, so summing them together now is already correct).
  const aggregates = new Map();
  let totalRowsParsed = 0;

  for (const row of dataRows) {
    totalRowsParsed++;
    const resourceRaw = String(row[mapping.resource.index] ?? "").trim();
    const projectRaw = String(row[mapping.project.index] ?? "").trim();
    const hours = parseHoursCell(row[mapping.hours.index]) || 0;
    if (!resourceRaw && !projectRaw) continue; // fully blank row, ignore silently

    let monthIndex = null;
    if (hasDateColumn) {
      const d = parseDateCell(row[mapping.date.index]);
      if (d) {
        anyDateParsed = true;
        const idx = monthLookup.get(`${d.getFullYear()}-${d.getMonth()}`);
        if (idx != null) monthIndex = idx;
        else anyDateUnmapped = true;
      } else {
        anyDateUnmapped = true;
      }
    }

    const resourceMatch = resourceByName.get(normalizeName(resourceRaw)) || null;
    const projectMatch = projectByName.get(normalizeName(projectRaw)) || null;

    const monthKey = monthIndex == null ? "" : String(monthIndex);
    const key = `${normalizeName(resourceRaw)}||${normalizeName(projectRaw)}||${monthKey}`;
    if (!aggregates.has(key)) {
      aggregates.set(key, {
        resourceRaw, projectRaw,
        resourceId: resourceMatch ? resourceMatch.id : null,
        projectId: projectMatch ? projectMatch.id : null,
        projectName: projectMatch ? projectMatch.name : null,
        month: monthIndex,
        hours: 0,
        sourceRowCount: 0,
      });
    }
    const agg = aggregates.get(key);
    agg.hours += hours;
    agg.sourceRowCount++;
  }

  if (hasDateColumn && !anyDateParsed) {
    warnings.push(`Detected a date column ("${mapping.date.header}") but couldn't parse any dates in it — treating this import as a single period; pick the month it applies to below.`);
  } else if (hasDateColumn && anyDateUnmapped) {
    warnings.push("Some rows had a date outside this workbook's 12 FY months, or an unparseable date — those rows were grouped under 'no date' and need a month picked for them too.");
  }

  // A row only truly has "no usable month" if either there was no date
  // column at all, or its date couldn't be parsed/mapped — both land as
  // month === null in the aggregate. If ANY aggregate row still has a null
  // month after parsing, the review UI needs a month picker (applied to
  // just those rows at confirm time).
  const requiresMonthSelection = Array.from(aggregates.values()).some((a) => a.month == null);

  const aggregatedRows = Array.from(aggregates.values()).map((a) => ({
    resourceRaw: a.resourceRaw,
    projectRaw: a.projectRaw,
    resourceId: a.resourceId,
    projectId: a.projectId,
    month: a.month,
    hours: Math.round(a.hours * 100) / 100,
    sourceRowCount: a.sourceRowCount,
    matchedResource: !!a.resourceId,
    matchedProject: !!a.projectId,
  }));

  const unmatchedResources = Array.from(new Set(
    aggregatedRows.filter((r) => !r.matchedResource && r.resourceRaw).map((r) => r.resourceRaw)
  )).sort();
  const unmatchedProjects = Array.from(new Set(
    aggregatedRows.filter((r) => !r.matchedProject && r.projectRaw).map((r) => r.projectRaw)
  )).sort();

  // Distinct matched projects (for the billable/non-billable review step) —
  // deliberately every matched project encountered, not just "Feature"
  // group ones; billable is a per-project override that can apply to any
  // project.
  const distinctProjectIds = Array.from(new Set(aggregatedRows.filter((r) => r.projectId).map((r) => r.projectId)));
  const distinctProjects = distinctProjectIds.map((id) => {
    const p = projectRows.find((pr) => pr.id === id);
    return { projectId: id, projectName: p.name, billable: p.billable !== false };
  }).sort((a, b) => a.projectName.localeCompare(b.projectName));

  const importId = "imp_" + crypto.randomBytes(10).toString("hex");
  importSessions.set(importId, {
    createdAt: Date.now(),
    sourceFile: req.file.originalname,
    rows: aggregatedRows,
    requiresMonthSelection,
  });

  res.json({
    importId,
    sourceFile: req.file.originalname,
    detectedColumns: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v.header])),
    totalRowsParsed,
    aggregatedRowCount: aggregatedRows.length,
    matchedRowCount: aggregatedRows.filter((r) => r.matchedResource && r.matchedProject).length,
    unmatchedRowCount: aggregatedRows.filter((r) => !r.matchedResource || !r.matchedProject).length,
    requiresMonthSelection,
    aggregatedRows,
    distinctProjects,
    unmatchedResources,
    unmatchedProjects,
    warnings,
    months,
  });
});

router.post("/confirm", async (req, res) => {
  sweepExpiredSessions();
  const { importId, month, billableOverrides } = req.body || {};
  const session = importId && importSessions.get(importId);
  if (!session) {
    return res.status(400).json({ error: "This import preview has expired or was already confirmed — please re-upload the file." });
  }

  const fallbackMonth = session.requiresMonthSelection ? Number(month) : null;
  if (session.requiresMonthSelection && (!Number.isInteger(fallbackMonth) || fallbackMonth < 0 || fallbackMonth > 11)) {
    return res.status(400).json({ error: "This import has rows with no detected date — pick which month it applies to before confirming." });
  }

  // Apply billable overrides — per-project edit, same audited pattern as
  // the Projects tab's own billable toggle (server/routes/projects.js).
  const projectsUpdated = [];
  if (billableOverrides && typeof billableOverrides === "object") {
    for (const [projectId, rawValue] of Object.entries(billableOverrides)) {
      const value = rawValue === true || rawValue === "true";
      const row = await db.get("SELECT * FROM projects WHERE id = $1", [projectId]);
      if (!row) continue;
      const oldBillable = row.billable !== false;
      if (oldBillable === value) continue; // no-op, don't audit-log a non-change
      await db.run("UPDATE projects SET billable = $1, updated_at = $2 WHERE id = $3", [value, new Date().toISOString(), projectId]);
      await logAudit({
        action: "update", entity: "project", entityId: projectId, entityName: row.name,
        field: "Billable", oldValue: oldBillable ? "Billable" : "Non-billable", newValue: value ? "Billable" : "Non-billable",
        userEmail: req.user.email, userName: req.user.displayName,
      });
      projectsUpdated.push({ projectId, projectName: row.name, billable: value });
    }
  }

  // Re-read current billable state for every distinct project referenced
  // (post-override) so the snapshot on each inserted row reflects the
  // now-current value, not what was true before this confirm request.
  const distinctProjectIds = Array.from(new Set(session.rows.filter((r) => r.projectId).map((r) => r.projectId)));
  const currentBillable = new Map();
  for (const id of distinctProjectIds) {
    const row = await db.get("SELECT billable FROM projects WHERE id = $1", [id]);
    currentBillable.set(id, row ? row.billable !== false : true);
  }

  let aggregatedRowsImported = 0;
  let sourceRowsImported = 0;
  let aggregatedRowsSkipped = 0;
  let sourceRowsSkipped = 0;
  const now = new Date().toISOString();

  await db.withTransaction(async (tx) => {
    for (const row of session.rows) {
      if (!row.resourceId || !row.projectId) {
        aggregatedRowsSkipped++;
        sourceRowsSkipped += row.sourceRowCount;
        continue;
      }
      const monthIndex = row.month != null ? row.month : fallbackMonth;
      await tx.run(
        `INSERT INTO actuals (resource_id, project_id, month, hours, billable, source_file, imported_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.resourceId, row.projectId, monthIndex, row.hours, currentBillable.get(row.projectId) !== false, session.sourceFile, now]
      );
      aggregatedRowsImported++;
      sourceRowsImported += row.sourceRowCount;
    }
  });

  importSessions.delete(importId);

  res.json({
    aggregatedRowsImported,
    sourceRowsImported,
    aggregatedRowsSkipped,
    sourceRowsSkipped,
    projectsUpdated,
    sourceFile: session.sourceFile,
  });
});

router.get("/", async (req, res) => {
  const rows = await db.all(
    `SELECT a.id, a.resource_id, a.project_id, a.month, a.hours, a.billable, a.source_file, a.imported_at,
            r.name AS resource_name, p.name AS project_name
     FROM actuals a
     LEFT JOIN resources r ON r.id = a.resource_id
     LEFT JOIN projects p ON p.id = a.project_id
     ORDER BY a.imported_at DESC, a.id DESC`
  );
  res.json(rows.map((r) => ({
    id: r.id,
    resourceId: r.resource_id,
    resourceName: r.resource_name || "(unknown resource)",
    projectId: r.project_id,
    projectName: r.project_name || "(unknown project)",
    month: r.month,
    hours: Number(r.hours),
    billable: r.billable,
    sourceFile: r.source_file,
    importedAt: r.imported_at,
  })));
});

router.get("/summary", async (req, res) => {
  const rows = await db.all(
    `SELECT month, billable, SUM(hours) AS hours
     FROM actuals
     GROUP BY month, billable
     ORDER BY month`
  );
  const byMonth = new Map();
  for (const r of rows) {
    const m = r.month;
    if (!byMonth.has(m)) byMonth.set(m, { month: m, billableHours: 0, nonBillableHours: 0 });
    const entry = byMonth.get(m);
    if (r.billable) entry.billableHours = Number(r.hours);
    else entry.nonBillableHours = Number(r.hours);
  }
  const summary = Array.from(byMonth.values())
    .map((e) => ({ ...e, totalHours: Math.round((e.billableHours + e.nonBillableHours) * 100) / 100 }))
    .sort((a, b) => a.month - b.month);
  res.json({ months: summary });
});

module.exports = router;
