/* =========================================================================
   HGS AgentX — Resource Capacity & Project Planner
   Self-contained client-side app. All results are derived live from
   RESOURCES / PROJECTS / ALLOCATIONS — nothing is cached or hard-coded,
   so adding/editing/removing a resource, project or allocation immediately
   updates every results view (Utilisation, Project Health, Project Summary,
   Dashboard).
   ========================================================================= */

(function () {
  "use strict";

  const MONTH_BOUNDS = [
    ["2026-04-01", "2026-04-30"], ["2026-05-01", "2026-05-31"], ["2026-06-01", "2026-06-30"],
    ["2026-07-01", "2026-07-31"], ["2026-08-01", "2026-08-31"], ["2026-09-01", "2026-09-30"],
    ["2026-10-01", "2026-10-31"], ["2026-11-01", "2026-11-30"], ["2026-12-01", "2026-12-31"],
    ["2027-01-01", "2027-01-31"], ["2027-02-01", "2027-02-28"], ["2027-03-01", "2027-03-31"],
  ];

  const STATUS_OPTIONS = ["Pipeline", "Planning", "Active", "On Hold", "Completed"];
  const PRIORITY_OPTIONS = ["Low", "Medium", "High"];
  const GROUP_OPTIONS = ["CORE", "IMPLEMENTATION", "FEATURE"];
  const AREA_OPTIONS = ["Engineering", "Implementation", "Product"];

  // ---- live in-memory state, hydrated from the server on login/boot ------
  let STATE = null;
  let ACTIVE_TAB = "dashboard";
  let INSIGHTS_SUBTAB = "utilisation";
  let PROJECT_STATUS_FILTER = "All";
  let uidCounter = 1;

  // Only @<ALLOWED_EMAIL_DOMAIN> can register/log in — enforced server-side
  // (see server/auth.js); this is copy-only, for login-gate messaging.
  const ALLOWED_EMAIL_DOMAIN = "hgs.com";

  // ---- audit trail & version history — now server-authoritative (SQLite),
  // shared across every logged-in user rather than living in one browser
  // tab. AUDIT_LOG / VERSIONS below are local read-through caches, kept in
  // sync via refreshDataTabCaches(). See the Data tab for details. --------
  let AUDIT_LOG = [];
  let VERSIONS = [];
  let AUDIT_FILTER_USER = "All";

  // ---- accounts / session — real server-side auth (bcrypt-hashed
  // passwords, @hgs.com domain + email verification enforced in
  // server/auth.js). USERS is a read-through cache of verified accounts
  // (GET /api/users); ME is the logged-in user's own record from
  // GET /api/auth/me — never includes a password/hash. ---------------------
  let USERS = []; // { id, email, displayName, emailVerified, createdAt }
  let ME = null;
  function loggedInUser() { return ME; }

  // ---- per-table sort / filter, keyed by table id (e.g. "resources") -----
  let TABLE_SORT = {};   // { [tableId]: { col, dir } }
  let TABLE_FILTER = {}; // { [tableId]: { [col]: value } }
  let HIDDEN_COLS = {};  // { [tableId]: { [col]: true } } — Excel-style hide column
  let COL_PICKER_OPEN = {}; // { [tableId]: true } — keeps the picker open across toggles

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid(prefix) { return prefix + "_" + (Date.now().toString(36)) + "_" + (uidCounter++); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function round(n, d = 0) {
    const f = Math.pow(10, d);
    return Math.round((n + Number.EPSILON) * f) / f;
  }
  function num(v, fallback = 0) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function clampPct(v) {
    let n = num(v, 0);
    if (n < 0) n = 0;
    if (n > 100) n = 100;
    return n;
  }

  function todayISO() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  // current FY month index (0=Apr'26 .. 11=Mar'27), clamped into range
  function currentMonthIndex() {
    const t = todayISO();
    for (let i = 0; i < 12; i++) {
      if (t <= MONTH_BOUNDS[i][1]) return i < 0 ? 0 : Math.max(0, Math.min(11, i));
    }
    return 11;
  }
  function isBeforeFY() { return todayISO() < MONTH_BOUNDS[0][0]; }
  function isAfterFY() { return todayISO() > MONTH_BOUNDS[11][1]; }

  function networkDays(startISO, endISO) {
    if (!startISO || !endISO) return "";
    const start = new Date(startISO + "T00:00:00");
    const end = new Date(endISO + "T00:00:00");
    if (isNaN(start) || isNaN(end) || end < start) return "";
    let count = 0;
    const cur = new Date(start);
    while (cur <= end) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  }

  // Turn free-typed multi-line notes into a tidy bullet list on blur —
  // this is how the Notes field "captures bullet points" without needing
  // a rich text editor.
  function normalizeBullets(text) {
    return String(text || "")
      .split("\n")
      .map((line) => {
        const t = line.trim();
        if (!t) return "";
        const stripped = t.replace(/^[-*•]\s?/, "");
        return "• " + stripped;
      })
      .join("\n");
  }

  function noteTooltip(note) {
    if (!note) return "";
    const parts = [note.type || "Leave"];
    if (note.days) parts.push(`${note.days} day${note.days == 1 ? "" : "s"}`);
    const head = parts.join(" · ");
    return note.note ? `${head}: ${note.note}` : head;
  }

  // ---------------------------------------------------------------------
  // API client — every mutation now goes to the server, which is the
  // single shared source of truth (SQLite) for every logged-in user. The
  // server writes the audit-log entry itself, keyed off the authenticated
  // session, so it can't be spoofed from devtools like the old client-only
  // version could be.
  // ---------------------------------------------------------------------
  const API_BASE = "/api";
  async function apiFetch(path, options) {
    const opts = { credentials: "same-origin", ...options };
    if (opts.body && typeof opts.body !== "string") {
      opts.body = JSON.stringify(opts.body);
      opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    }
    const res = await fetch(API_BASE + path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty/non-JSON body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.data = data;
      throw err;
    }
    return data;
  }
  const apiGet = (p) => apiFetch(p);
  const apiPost = (p, body) => apiFetch(p, { method: "POST", body: body || {} });
  const apiPatch = (p, body) => apiFetch(p, { method: "PATCH", body: body || {} });
  const apiDelete = (p) => apiFetch(p, { method: "DELETE" });

  // ---------------------------------------------------------------------
  // Audit trail & version history — now backed by the server. AUDIT_LOG /
  // VERSIONS / USERS below are local read-through caches, refreshed
  // whenever the Data tab is opened or a mutation that affects them
  // happens; see refreshDataTabCaches().
  // ---------------------------------------------------------------------
  function activeUser() { return (ME && ME.displayName) || "Unknown"; }

  async function refreshDataTabCaches() {
    try {
      const [audit, versions, users] = await Promise.all([
        apiGet("/audit?limit=1000"),
        apiGet("/versions"),
        apiGet("/users"),
      ]);
      AUDIT_LOG = audit; VERSIONS = versions; USERS = users;
    } catch (e) {
      console.error("Couldn't refresh Data tab info:", e);
    }
    render();
  }

  function fmtLogValue(v) {
    if (v === null || v === undefined || v === "") return "(empty)";
    return String(v);
  }

  function fmtTs(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  // Saves a labelled snapshot server-side (POST /api/versions) — the server
  // stamps it with the authenticated user and writes its own audit-log
  // entry, so this can't be spoofed from devtools like the old client-only
  // version could be.
  async function saveVersion(label) {
    const v = await apiPost("/versions", { label: label || undefined });
    await refreshDataTabCaches();
    return v;
  }

  // Restores a previously-saved snapshot (POST /api/versions/:id/restore).
  // The server always takes its own safety-net snapshot of the current
  // state first, so a restore can never lose data permanently.
  async function restoreVersion(versionId) {
    const v = VERSIONS.find((x) => x.id === versionId);
    if (!v) return;
    if (!confirm(`Restore "${v.label}" (saved ${fmtTs(v.ts)} by ${v.user})? Your current data will be saved as a new snapshot first, so you can always come back.`)) return;
    try {
      await apiPost(`/versions/${versionId}/restore`);
      STATE = await apiGet("/state");
      await refreshDataTabCaches();
      ACTIVE_TAB = "data";
      render();
    } catch (err) {
      alert("Couldn't restore this version: " + err.message);
    }
  }

  const ACTION_META = {
    create: { label: "Added", cls: "tag-create" },
    update: { label: "Edited", cls: "tag-update" },
    delete: { label: "Deleted", cls: "tag-delete" },
    import: { label: "Imported file", cls: "tag-import" },
    restore: { label: "Reset to original", cls: "tag-restore" },
    "version-save": { label: "Saved version", cls: "tag-version" },
    "version-restore": { label: "Restored version", cls: "tag-restore" },
    login: { label: "Logged in", cls: "tag-update" },
    logout: { label: "Logged out", cls: "tag-update" },
  };
  function actionMeta(action) { return ACTION_META[action] || { label: action, cls: "tag-update" }; }

  function auditUsers() {
    const set = new Set(AUDIT_LOG.map((e) => e.user));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function viewVersionModal(versionId) {
    const v = VERSIONS.find((x) => x.id === versionId);
    if (!v) return;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true">
        <h3>${esc(v.label)}</h3>
        <p class="muted">Saved ${fmtTs(v.ts)} by <b>${esc(v.user)}</b> ${v.auto ? '<span class="tag-auto">Automatic</span>' : '<span class="tag-manual">Manual</span>'}</p>
        <table class="grid-table log-table">
          <tbody>
            <tr><td>Resources</td><td><b>${v.snapshot.resources.length}</b></td></tr>
            <tr><td>Projects</td><td><b>${v.snapshot.projects.length}</b></td></tr>
            <tr><td>Allocations</td><td><b>${v.snapshot.allocations.length}</b></td></tr>
          </tbody>
        </table>
        <p class="muted">Restoring will replace all current resources, projects and allocations with this snapshot. Your current data is auto-saved as a new snapshot first, so nothing is ever lost.</p>
        <div class="btn-row modal-actions">
          <button type="button" class="btn btn-primary" id="vmRestore">↺ Restore this version</button>
          <button type="button" class="btn btn-ghost" id="vmClose">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    overlay.querySelector("#vmClose").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("#vmRestore").addEventListener("click", () => { close(); restoreVersion(v.id); });
  }

  // ---------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------
  function getResource(id) { return STATE.resources.find((r) => r.id === id); }
  function getProject(id) { return STATE.projects.find((p) => p.id === id); }
  function allocsForResource(id) { return STATE.allocations.filter((a) => a.resourceId === id); }
  function allocsForProject(id) { return STATE.allocations.filter((a) => a.projectId === id); }

  // ---------------------------------------------------------------------
  // Accounts — real server-side auth (server/auth.js): bcrypt-hashed
  // passwords, @hgs.com domain enforced server-side, email verification
  // required before first login. These are thin wrappers around the
  // /api/auth/* endpoints; the server is the only source of truth for who
  // is logged in (session cookie), never anything kept in this file.
  // ---------------------------------------------------------------------
  async function registerUser(email, displayName, password) {
    try {
      const result = await apiPost("/auth/register", { email, displayName, password });
      return { ok: true, message: result.message, devVerifyUrl: result.devVerifyUrl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function attemptLogin(email, password) {
    try {
      const result = await apiPost("/auth/login", { email, password });
      ME = result.user;
      return { ok: true, user: ME };
    } catch (err) {
      return { ok: false, error: err.message, needsVerification: !!(err.data && err.data.needsVerification) };
    }
  }

  async function resendVerification(email) {
    try {
      const result = await apiPost("/auth/resend-verification", { email });
      return { ok: true, message: result.message, devVerifyUrl: result.devVerifyUrl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function forgotPassword(email) {
    try {
      const result = await apiPost("/auth/forgot-password", { email });
      return { ok: true, message: result.message, devResetUrl: result.devResetUrl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function logoutUser() {
    try { await apiPost("/auth/logout"); } catch (err) { /* best-effort — clear local state regardless */ }
    ME = null;
    STATE = null;
    showLoginGate();
  }

  async function removeUser(userId) {
    const u = USERS.find((x) => x.id === userId);
    if (!u) return;
    if (ME && u.id === ME.id) { alert("You can't remove the account you're currently logged in as. Log out first."); return; }
    if (!confirm(`Remove the account "${u.displayName}" (${u.email})? They will need to register again to log back in.`)) return;
    try {
      await apiDelete(`/users/${userId}`);
      await refreshDataTabCaches();
    } catch (err) {
      alert("Couldn't remove that account: " + err.message);
    }
  }

  // ---------------------------------------------------------------------
  // Login gate — a full-screen overlay shown until someone is logged in,
  // driven entirely by /api/auth/* (see server/auth.js). Modes:
  //   login          — email + password
  //   register       — email + name + password (@hgs.com only)
  //   check-email    — "verify your email" holding screen after registering
  //                    (or after resending), with a DEV MODE link when SMTP
  //                    isn't configured (see server/mailer.js)
  //   forgot         — request a password-reset email
  //   forgot-sent    — confirmation, with a DEV MODE reset link
  // There is deliberately no "restore accounts from a file" control here —
  // a client-uploaded JSON file must never be able to create or "verify" an
  // account, since that would bypass the @hgs.com + email-verification
  // checks the server enforces on every real registration.
  // ---------------------------------------------------------------------
  function showLoginGate() {
    document.body.classList.add("locked");
    let overlay = document.getElementById("loginGate");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "loginGate";
      overlay.className = "modal-overlay login-overlay";
      document.body.appendChild(overlay);
    }
    let mode = "login"; // "login" | "register" | "check-email" | "forgot" | "forgot-sent"
    let lastEmail = "";
    let noticeMessage = "";
    let devLink = "";

    function devBanner(label) {
      return devLink
        ? `<div class="dev-mode-banner"><b>DEV MODE</b> — no real SMTP is configured, so here's the ${label} link directly: <a href="${esc(devLink)}" id="devLinkAnchor" target="_blank" rel="noopener">${esc(devLink)}</a></div>`
        : "";
    }

    function paint() {
      let html;
      if (mode === "check-email") {
        html = `
          <div class="modal-box login-box" role="dialog" aria-modal="true">
            <div class="login-brand"><span class="wordmark">HGS<span class="dot">●</span></span></div>
            <h3>Check your email</h3>
            <p class="muted">${esc(noticeMessage || `We've sent a verification link to ${lastEmail}.`)}</p>
            ${devBanner("verification")}
            <div class="btn-row modal-actions">
              <button type="button" class="btn btn-secondary" id="resendBtn">Resend verification email</button>
            </div>
            <p class="login-switch"><a href="#" id="backToLogin">← Back to login</a></p>
          </div>`;
      } else if (mode === "forgot") {
        html = `
          <div class="modal-box login-box" role="dialog" aria-modal="true">
            <div class="login-brand"><span class="wordmark">HGS<span class="dot">●</span></span></div>
            <h3>Reset your password</h3>
            <p class="muted">Enter your @${esc(ALLOWED_EMAIL_DOMAIN)} email and we'll send you a reset link.</p>
            <div id="loginError" class="login-error"></div>
            <form id="forgotForm">
              <label class="modal-label">Email
                <input type="email" id="forgotEmail" class="cell-input" autocomplete="email" placeholder="you@${esc(ALLOWED_EMAIL_DOMAIN)}" value="${esc(lastEmail)}" required>
              </label>
              <div class="btn-row modal-actions">
                <button type="submit" class="btn btn-primary">Send reset link</button>
              </div>
            </form>
            <p class="login-switch"><a href="#" id="backToLogin">← Back to login</a></p>
          </div>`;
      } else if (mode === "forgot-sent") {
        html = `
          <div class="modal-box login-box" role="dialog" aria-modal="true">
            <div class="login-brand"><span class="wordmark">HGS<span class="dot">●</span></span></div>
            <h3>Check your email</h3>
            <p class="muted">${esc(noticeMessage || "If that account exists, a password reset link has been sent.")}</p>
            ${devBanner("reset")}
            <p class="login-switch"><a href="#" id="backToLogin">← Back to login</a></p>
          </div>`;
      } else {
        // "login" | "register"
        html = `
          <div class="modal-box login-box" role="dialog" aria-modal="true">
            <div class="login-brand"><span class="wordmark">HGS<span class="dot">●</span></span></div>
            <h3>${mode === "login" ? "Log in" : "Create your account"}</h3>
            <p class="muted">${mode === "login"
              ? "Sign in with your @hgs.com email to make edits — every change is attributed to your account."
              : `Register with your @${esc(ALLOWED_EMAIL_DOMAIN)} email. We'll send a verification link before you can log in.`}</p>
            <div id="loginError" class="login-error"></div>
            <form id="loginForm">
              <label class="modal-label">Email
                <input type="email" id="loginEmail" class="cell-input" autocomplete="email" placeholder="you@${esc(ALLOWED_EMAIL_DOMAIN)}" value="${esc(lastEmail)}" required>
              </label>
              ${mode === "register" ? `<label class="modal-label">Full name (shown in the audit log)
                <input type="text" id="loginDisplayName" class="cell-input" autocomplete="name">
              </label>` : ""}
              <label class="modal-label">Password
                <input type="password" id="loginPassword" class="cell-input" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="8" required>
              </label>
              <div class="btn-row modal-actions">
                <button type="submit" class="btn btn-primary" id="loginSubmit">${mode === "login" ? "Log in" : "Create account"}</button>
              </div>
            </form>
            <p class="login-switch">
              ${mode === "login"
                ? `New here? <a href="#" id="loginSwitch">Create an account</a> &nbsp;·&nbsp; <a href="#" id="forgotLink">Forgot password?</a>`
                : `Already have an account? <a href="#" id="loginSwitch">Log in</a>`}
            </p>
            <p class="muted login-caveat">🔒 <b>Real server-side security:</b> passwords are bcrypt-hashed and stored in the server's database — never sent back to the browser. Only @${esc(ALLOWED_EMAIL_DOMAIN)} email addresses can register, and every new account must verify its email before it can log in.</p>
          </div>`;
      }
      overlay.innerHTML = html;
      bind();
    }

    function bind() {
      overlay.querySelector("#backToLogin")?.addEventListener("click", (e) => {
        e.preventDefault();
        mode = "login";
        paint();
      });
      overlay.querySelector("#loginSwitch")?.addEventListener("click", (e) => {
        e.preventDefault();
        mode = mode === "login" ? "register" : "login";
        paint();
      });
      overlay.querySelector("#forgotLink")?.addEventListener("click", (e) => {
        e.preventDefault();
        mode = "forgot";
        paint();
      });
      overlay.querySelector("#resendBtn")?.addEventListener("click", async () => {
        const result = await resendVerification(lastEmail);
        noticeMessage = result.message || result.error;
        devLink = result.devVerifyUrl || "";
        paint();
      });
      overlay.querySelector("#loginForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = overlay.querySelector("#loginEmail").value.trim();
        const password = overlay.querySelector("#loginPassword").value;
        const errEl = overlay.querySelector("#loginError");
        const submitBtn = overlay.querySelector("#loginSubmit");
        lastEmail = email;
        submitBtn.disabled = true;
        if (mode === "login") {
          const result = await attemptLogin(email, password);
          if (!result.ok) {
            errEl.innerHTML = esc(result.error) + (result.needsVerification ? ` <a href="#" id="resendInline">Resend verification email</a>` : "");
            overlay.querySelector("#resendInline")?.addEventListener("click", async (ev) => {
              ev.preventDefault();
              const r = await resendVerification(email);
              noticeMessage = r.message;
              devLink = r.devVerifyUrl || "";
              mode = "check-email";
              paint();
            });
            submitBtn.disabled = false;
            return;
          }
          try {
            STATE = await apiGet("/state");
            await refreshDataTabCaches();
            hideLoginGate();
          } catch (err) {
            errEl.textContent = "Logged in, but couldn't load data: " + err.message;
            submitBtn.disabled = false;
          }
        } else {
          const displayName = overlay.querySelector("#loginDisplayName")?.value || "";
          const result = await registerUser(email, displayName, password);
          if (!result.ok) { errEl.textContent = result.error; submitBtn.disabled = false; return; }
          noticeMessage = result.message;
          devLink = result.devVerifyUrl || "";
          mode = "check-email";
          paint();
        }
      });
      overlay.querySelector("#forgotForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = overlay.querySelector("#forgotEmail").value.trim();
        lastEmail = email;
        const result = await forgotPassword(email);
        noticeMessage = result.message || result.error;
        devLink = result.devResetUrl || "";
        mode = "forgot-sent";
        paint();
      });
    }
    paint();
  }

  function hideLoginGate() {
    document.body.classList.remove("locked");
    const overlay = document.getElementById("loginGate");
    if (overlay) overlay.remove();
    render();
  }

  // ---------------------------------------------------------------------
  // Generic per-table sort / filter — shared by every data table (Resources,
  // Projects, Allocations, the three Insights views, and the Data tab's
  // version/audit tables). Each view defines its own column list; these
  // helpers just apply that column list to the row array before rendering.
  // ---------------------------------------------------------------------
  function toggleSort(tableId, col) {
    const cur = TABLE_SORT[tableId];
    if (cur && cur.col === col) cur.dir = -cur.dir;
    else TABLE_SORT[tableId] = { col, dir: 1 };
  }

  function sortIndicator(tableId, col) {
    const s = TABLE_SORT[tableId];
    if (!s || s.col !== col) return '<span class="sort-ind muted">⇅</span>';
    return `<span class="sort-ind active">${s.dir === 1 ? "▲" : "▼"}</span>`;
  }

  function thSort(tableId, col, label, extraClass) {
    return `<th class="sortable ${extraClass || ""}" data-sort-table="${tableId}" data-sort-col="${esc(col)}">${esc(label)} ${sortIndicator(tableId, col)}</th>`;
  }

  function applySort(tableId, rows, valueFns) {
    const s = TABLE_SORT[tableId];
    if (!s || !valueFns[s.col]) return rows;
    const fn = valueFns[s.col];
    return rows.slice().sort((a, b) => {
      let va = fn(a); let vb = fn(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") va = va.toLowerCase();
      if (typeof vb === "string") vb = vb.toLowerCase();
      if (va < vb) return -1 * s.dir;
      if (va > vb) return 1 * s.dir;
      return 0;
    });
  }

  function getFilter(tableId, col) { return (TABLE_FILTER[tableId] && TABLE_FILTER[tableId][col]) || ""; }
  function setFilter(tableId, col, val) {
    if (!TABLE_FILTER[tableId]) TABLE_FILTER[tableId] = {};
    TABLE_FILTER[tableId][col] = val;
  }
  function hasActiveFilters(tableId) {
    const f = TABLE_FILTER[tableId];
    return !!(f && Object.values(f).some((v) => v));
  }
  function clearTableFilters(tableId) {
    TABLE_FILTER[tableId] = {};
    delete TABLE_SORT[tableId];
    render();
  }

  function applyFilters(tableId, rows, matchFns) {
    const f = TABLE_FILTER[tableId];
    if (!f) return rows;
    return rows.filter((row) => Object.keys(f).every((col) => {
      const val = f[col];
      if (!val || !matchFns[col]) return true;
      return matchFns[col](row, val);
    }));
  }

  function filterTextInput(tableId, col, placeholder) {
    return `<input type="text" class="filter-input" placeholder="${esc(placeholder || "Filter…")}"
      data-filter-table="${tableId}" data-filter-col="${esc(col)}" data-focus-id="flt-${tableId}-${col}"
      value="${esc(getFilter(tableId, col))}">`;
  }
  function filterSelectInput(tableId, col, options, allLabel) {
    const cur = getFilter(tableId, col);
    return `<select class="filter-input" data-filter-table="${tableId}" data-filter-col="${esc(col)}">
      <option value="">${esc(allLabel || "All")}</option>
      ${options.map((o) => `<option value="${esc(o)}" ${o === cur ? "selected" : ""}>${esc(o)}</option>`).join("")}
    </select>`;
  }
  // Like filterSelectInput, but for columns filtered by id where the
  // display label differs from the stored value (e.g. resourceId → name).
  function filterSelectInputLabeled(tableId, col, items, allLabel) {
    const cur = getFilter(tableId, col);
    return `<select class="filter-input" data-filter-table="${tableId}" data-filter-col="${esc(col)}">
      <option value="">${esc(allLabel || "All")}</option>
      ${items.map((it) => `<option value="${esc(it.value)}" ${it.value === cur ? "selected" : ""}>${esc(it.label)}</option>`).join("")}
    </select>`;
  }
  function contains(hay, needle) { return String(hay || "").toLowerCase().includes(String(needle || "").toLowerCase()); }

  function withPreservedFocus(fn) {
    const active = document.activeElement;
    const focusId = active && active.dataset ? active.dataset.focusId : null;
    const selStart = active && "selectionStart" in active ? active.selectionStart : null;
    const selEnd = active && "selectionEnd" in active ? active.selectionEnd : null;
    fn();
    if (focusId) {
      const el = document.querySelector(`[data-focus-id="${focusId}"]`);
      if (el) {
        el.focus();
        if (selStart != null && el.setSelectionRange) {
          try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* not a text-selectable input */ }
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Column visibility — Excel-style "hide column". Each view defines an
  // ordered column list; hidden ones are collapsed via a <colgroup> (the
  // one CSS mechanism that truly removes a table column, header + filter
  // row + every body row, without touching any of the cell-rendering code
  // above) rather than editing every <td>/<th> individually.
  // ---------------------------------------------------------------------
  function isColHidden(tableId, key) { return !!(HIDDEN_COLS[tableId] && HIDDEN_COLS[tableId][key]); }
  function toggleColHidden(tableId, key) {
    if (!HIDDEN_COLS[tableId]) HIDDEN_COLS[tableId] = {};
    HIDDEN_COLS[tableId][key] = !HIDDEN_COLS[tableId][key];
  }
  function hiddenColCount(tableId) { return Object.values(HIDDEN_COLS[tableId] || {}).filter(Boolean).length; }
  function showAllCols(tableId) { HIDDEN_COLS[tableId] = {}; }

  function colGroupHtml(tableId, columns) {
    return `<colgroup>${columns.map((c) => `<col${isColHidden(tableId, c.key) ? ' style="visibility:collapse"' : ""}>`).join("")}</colgroup>`;
  }

  function columnPickerHtml(tableId, columns) {
    const hideable = columns.filter((c) => c.hideable);
    const hiddenCount = hiddenColCount(tableId);
    const open = !!COL_PICKER_OPEN[tableId];
    return `<div class="col-picker">
      <button type="button" class="btn btn-ghost btn-xs" data-action="toggle-col-picker" data-table="${tableId}">🗂 Columns${hiddenCount ? ` (${hiddenCount} hidden)` : ""}</button>
      <div class="col-picker-menu" ${open ? "" : "hidden"} data-col-menu="${tableId}">
        <div class="col-picker-head">
          <span>Show / hide columns</span>
          <button type="button" class="btn-link" data-action="show-all-cols" data-table="${tableId}">Show all</button>
        </div>
        ${hideable.map((c) => `<label class="col-picker-item"><input type="checkbox" data-action="toggle-col" data-table="${tableId}" data-col="${esc(c.key)}" ${isColHidden(tableId, c.key) ? "" : "checked"}> ${esc(c.label)}</label>`).join("")}
      </div>
    </div>`;
  }

  function resourceCap(resource, mIdx) {
    const v = resource.cap[mIdx];
    return Number.isFinite(v) ? v : 100;
  }

  function projectInMonth(project, mIdx) {
    const [first, last] = MONTH_BOUNDS[mIdx];
    const okStart = !project.start || project.start <= last;
    const okEnd = !project.end || project.end >= first;
    return okStart && okEnd;
  }

  // ---------------------------------------------------------------------
  // COMPUTE: Utilisation View  (Util% = Allocated% / Capacity% * 100)
  // ---------------------------------------------------------------------
  function computeUtilisation() {
    return STATE.resources.map((r) => {
      const allocs = allocsForResource(r.id);
      const monthly = MONTH_BOUNDS.map((_, mIdx) => {
        const allocated = allocs.reduce((s, a) => s + num(a.months[mIdx], 0), 0);
        const cap = resourceCap(r, mIdx);
        const util = cap > 0 ? round((allocated / cap) * 100, 1) : null;
        let status = null;
        if (util != null) status = util > 100 ? "over" : util >= 70 ? "healthy" : "under";
        return { allocated, cap, util, status };
      });
      const valid = monthly.filter((m) => m.util != null);
      const avgUtil = valid.length ? round(valid.reduce((s, m) => s + m.util, 0) / valid.length, 1) : null;
      let avgStatus = null;
      if (avgUtil != null) avgStatus = avgUtil > 100 ? "over" : avgUtil >= 70 ? "healthy" : "under";
      return { resource: r, monthly, avgUtil, avgStatus };
    });
  }

  // ---------------------------------------------------------------------
  // COMPUTE: Project Summary (total allocated % per project per month)
  // ---------------------------------------------------------------------
  function computeProjectSummary() {
    return STATE.projects.map((p) => {
      const allocs = allocsForProject(p.id);
      const monthly = MONTH_BOUNDS.map((_, mIdx) => round(allocs.reduce((s, a) => s + num(a.months[mIdx], 0), 0), 0));
      const nonZero = monthly.filter((v) => v > 0);
      const avgPct = nonZero.length ? round(nonZero.reduce((s, v) => s + v, 0) / nonZero.length, 0) : 0;
      return { project: p, monthly, avgPct, numRows: allocs.length };
    });
  }

  // ---------------------------------------------------------------------
  // COMPUTE: Project Allocation Health (role-weighted score)
  // ---------------------------------------------------------------------
  function projectScoreForMonth(project, mIdx) {
    const allocs = allocsForProject(project.id);
    const totalAllocated = allocs.reduce((s, a) => s + num(a.months[mIdx], 0), 0);
    const isActiveMonth = project.status === "Active" && totalAllocated > 0 && projectInMonth(project, mIdx);
    if (!isActiveMonth) return null;

    const roleEntries = Object.entries(project.roles || {}).filter(([, v]) => num(v, 0) > 0);
    const totalRequired = roleEntries.reduce((s, [, v]) => s + num(v, 0), 0);

    if (totalRequired > 0) {
      let contribution = 0;
      for (const [role, reqPct] of roleEntries) {
        const actual = allocs.reduce((s, a) => {
          const res = getResource(a.resourceId);
          return s + (res && res.role === role ? num(a.months[mIdx], 0) : 0);
        }, 0);
        const achievement = Math.min(actual / num(reqPct, 1), 1);
        contribution += achievement * num(reqPct, 0);
      }
      return round((contribution / totalRequired) * 100, 1);
    }
    // fallback: no roles defined -> plain average allocation of resources working that month
    const rows = allocs.filter((a) => num(a.months[mIdx], 0) > 0);
    if (!rows.length) return null;
    return round(rows.reduce((s, a) => s + num(a.months[mIdx], 0), 0) / rows.length, 1);
  }

  function flagForScore(score, priority) {
    if (score == null) return null;
    if (priority === "High") return score < 75 ? "C" : score <= 90 ? "R" : "OK";
    if (priority === "Medium") return score < 50 ? "C" : score < 75 ? "R" : "OK";
    return score < 50 ? "R" : "OK"; // Low / blank
  }

  function computeProjectHealth() {
    return STATE.projects.map((p) => {
      const monthly = MONTH_BOUNDS.map((_, mIdx) => {
        const score = projectScoreForMonth(p, mIdx);
        return { score, flag: flagForScore(score, p.priority) };
      });
      const activeScores = monthly.filter((m) => m.score != null).map((m) => m.score);
      const overallScore = activeScores.length ? round(activeScores.reduce((s, v) => s + v, 0) / activeScores.length, 1) : null;
      const overallFlag = flagForScore(overallScore, p.priority);
      return { project: p, monthly, overallScore, overallFlag };
    });
  }

  function healthComment(row) {
    const p = row.project;
    if (p.status !== "Active") return "—";
    if (row.overallScore == null) return "No allocation data.";
    const s = row.overallScore;
    if (p.priority === "High") {
      if (s < 75) return `HIGH: under-resourced (${s}%). Target >90%.`;
      if (s <= 90) return `HIGH: partially resourced (${s}%). Target >90%.`;
      return `HIGH: healthy (${s}%).`;
    }
    if (p.priority === "Medium") {
      if (s < 50) return `MEDIUM: under-resourced (${s}%). Target >75%.`;
      if (s < 75) return `MEDIUM: partially resourced (${s}%). Target >75%.`;
      return `MEDIUM: healthy (${s}%).`;
    }
    if (s < 50) return `LOW: low allocation (${s}%). Review if intentional.`;
    return `LOW: OK (${s}%).`;
  }

  // ---------------------------------------------------------------------
  // COMPUTE: Rolling avg capacity % (months elapsed in FY so far)
  // ---------------------------------------------------------------------
  function rollingAvgCap(resource) {
    let n;
    if (isBeforeFY()) n = 1;
    else if (isAfterFY()) n = 12;
    else n = currentMonthIndex() + 1;
    n = Math.max(1, Math.min(12, n));
    const slice = resource.cap.slice(0, n);
    return round(slice.reduce((s, v) => s + num(v, 100), 0) / slice.length, 1);
  }

  // ---------------------------------------------------------------------
  // COMPUTE: Planned / public holidays logged against capacity cells
  // ---------------------------------------------------------------------
  function leaveEntriesForMonth(mIdx) {
    return STATE.resources
      .filter((r) => r.capNotes && r.capNotes[mIdx])
      .map((r) => ({ resource: r, note: r.capNotes[mIdx] }));
  }

  // ---------------------------------------------------------------------
  // COMPUTE: Dashboard KPIs
  // ---------------------------------------------------------------------
  function computeDashboard() {
    const mIdx = currentMonthIndex();
    const util = computeUtilisation();
    const health = computeProjectHealth();
    const summary = computeProjectSummary();
    const leave = leaveEntriesForMonth(mIdx);

    const over = util.filter((u) => u.monthly[mIdx].status === "over");
    const under = util.filter((u) => u.monthly[mIdx].status === "under");
    const healthy = util.filter((u) => u.monthly[mIdx].status === "healthy");

    const avgUtilThisMonth = (() => {
      const valid = util.map((u) => u.monthly[mIdx].util).filter((v) => v != null);
      return valid.length ? round(valid.reduce((s, v) => s + v, 0) / valid.length, 1) : null;
    })();

    const activeProjectsThisMonth = health.filter((h) => h.monthly[mIdx].score != null);
    const critical = activeProjectsThisMonth.filter((h) => h.monthly[mIdx].flag === "C");
    const review = activeProjectsThisMonth.filter((h) => h.monthly[mIdx].flag === "R");
    const ok = activeProjectsThisMonth.filter((h) => h.monthly[mIdx].flag === "OK");

    const statusCounts = {};
    STATE.projects.forEach((p) => { statusCounts[p.status] = (statusCounts[p.status] || 0) + 1; });

    return {
      mIdx,
      totalResources: STATE.resources.length,
      totalProjects: STATE.projects.length,
      totalAllocationRows: STATE.allocations.length,
      statusCounts,
      avgUtilThisMonth,
      over, under, healthy,
      critical, review, ok,
      summary, leave,
    };
  }

  // ---------------------------------------------------------------------
  // Rendering helpers
  // ---------------------------------------------------------------------
  function utilCellClass(status) {
    if (status === "over") return "cell-red";
    if (status === "healthy") return "cell-green";
    if (status === "under") return "cell-blue";
    return "";
  }
  function allocCellClass(v) {
    if (v == null || v === 0) return "";
    if (v > 100) return "cell-red";
    if (v >= 80) return "cell-amber";
    return "cell-green";
  }
  function flagBadge(flag) {
    if (flag == null) return '<span class="muted">—</span>';
    if (flag === "C") return '<span class="badge badge-c">C</span>';
    if (flag === "R") return '<span class="badge badge-r">R</span>';
    return '<span class="badge badge-ok">OK</span>';
  }
  function statusBadge(status) {
    const cls = {
      Active: "st-active", Planning: "st-planning", Pipeline: "st-pipeline",
      "On Hold": "st-hold", Completed: "st-completed",
    }[status] || "st-pipeline";
    return `<span class="status-pill ${cls}">${esc(status)}</span>`;
  }
  function priorityBadge(p) {
    const cls = { High: "pr-high", Medium: "pr-medium", Low: "pr-low" }[p] || "pr-medium";
    return `<span class="pr-pill ${cls}">${esc(p)}</span>`;
  }

  // Sortable month header row, shared by Allocations / Utilisation /
  // Project health / Project summary — each month is its own sort column
  // (colPrefix + index, e.g. "m0".."m11") so you can click a month to rank
  // resources/projects by that month's value.
  function monthSortHeaderCells(tableId, colPrefix) {
    const cur = currentMonthIndex();
    return STATE.months.map((m, i) => `<th class="${i === cur ? "cur-month" : ""} sortable" data-sort-table="${tableId}" data-sort-col="${colPrefix}${i}">${esc(m.label)} ${sortIndicator(tableId, `${colPrefix}${i}`)}</th>`).join("");
  }

  // ---------------------------------------------------------------------
  // Navigation — every dashboard link/KPI/row routes through here so
  // clicking a number always lands on the tab (and row) that explains it.
  // ---------------------------------------------------------------------
  function goToTab({ tab, subtab, statusFilter, highlight }) {
    if (tab) ACTIVE_TAB = tab;
    if (subtab) INSIGHTS_SUBTAB = subtab;
    if (statusFilter !== undefined) PROJECT_STATUS_FILTER = statusFilter;
    render();
    if (highlight) {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-row-id="${highlight}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 2200);
      });
    }
  }

  // ---------------------------------------------------------------------
  // View: Dashboard
  // ---------------------------------------------------------------------
  function viewDashboard() {
    const d = computeDashboard();
    const curLabel = STATE.months[d.mIdx].label;

    // Needs-attention is categorized by type — projects vs. resources —
    // rather than interleaved, and every row routes to the tab/row that
    // explains the number (Insights, correct sub-tab, row highlighted).
    const projectItems = [
      ...d.critical.map((h) => ({ kind: "Critical", cls: "sev-critical", name: h.project.name, value: `${h.monthly[d.mIdx].score}%`, highlight: `proj-${h.project.id}` })),
      ...d.review.map((h) => ({ kind: "Needs review", cls: "sev-review", name: h.project.name, value: `${h.monthly[d.mIdx].score}%`, highlight: `proj-${h.project.id}` })),
    ];
    const resourceItems = [
      ...d.over.sort((a, b) => b.monthly[d.mIdx].util - a.monthly[d.mIdx].util)
        .map((u) => ({ kind: "Over-allocated", cls: "sev-over", name: u.resource.name, value: `${u.monthly[d.mIdx].util}%`, highlight: `res-${u.resource.id}` })),
      ...d.under.sort((a, b) => a.monthly[d.mIdx].util - b.monthly[d.mIdx].util)
        .map((u) => ({ kind: "Under-utilised", cls: "sev-under", name: u.resource.name, value: `${u.monthly[d.mIdx].util}%`, highlight: `res-${u.resource.id}` })),
    ];

    function renderAttnGroup(items, subtab, max) {
      if (!items.length) return `<li class="attn-row sev-none">All clear.</li>`;
      const shown = items.slice(0, max);
      const hidden = items.length - shown.length;
      return shown.map((a) => `
          <li class="attn-row ${a.cls} clickable" data-action="goto" data-tab="insights" data-subtab="${subtab}" data-highlight="${a.highlight}">
            <span class="attn-kind">${esc(a.kind)}</span>
            <span class="attn-name">${esc(a.name)}</span>
            <b class="attn-value">${esc(a.value)}</b>
          </li>`).join("") + (hidden > 0
            ? `<li class="attn-row sev-more clickable" data-action="goto" data-tab="insights" data-subtab="${subtab}">+${hidden} more — see Insights</li>`
            : "");
    }

    const statusChips = STATUS_OPTIONS.map(
      (s) => `<button type="button" class="kpi-chip clickable" data-action="goto" data-tab="projects" data-status-filter="${esc(s)}">
          <span class="status-pill ${{
            Active: "st-active", Planning: "st-planning", Pipeline: "st-pipeline",
            "On Hold": "st-hold", Completed: "st-completed",
          }[s]}">${s}</span><b>${d.statusCounts[s] || 0}</b>
        </button>`
    ).join("");

    const leaveRows = d.leave.length
      ? d.leave.map((l) => `
          <li class="attn-row sev-leave clickable" data-action="goto" data-tab="resources" data-highlight="res-${l.resource.id}">
            <span class="attn-kind">${esc(l.note.type || "Leave")}</span>
            <span class="attn-name">${esc(l.resource.name)}${l.note.days ? ` — ${esc(l.note.days)} day${l.note.days == 1 ? "" : "s"}` : ""}${l.note.note ? `<span class="muted"> · ${esc(l.note.note)}</span>` : ""}</span>
          </li>`).join("")
      : `<li class="attn-row sev-none">No planned or public holidays logged for ${esc(curLabel)} yet. Click the note icon (<span class="legend-dot note-dot"></span>) on any month cell in Resources to add one.</li>`;

    return `
      <div class="panel intro-panel">
        <h1>Resource capacity planner — AgentX team</h1>
        <p class="muted">${esc(STATE.meta.fyLabel)} &middot; showing <b>${esc(curLabel)}</b> as the current month</p>
      </div>

      <div class="kpi-grid">
        <button type="button" class="kpi-card clickable" data-action="goto" data-tab="resources"><div class="kpi-label">Resources</div><div class="kpi-value">${d.totalResources}</div></button>
        <button type="button" class="kpi-card clickable" data-action="goto" data-tab="projects" data-status-filter="All"><div class="kpi-label">Projects</div><div class="kpi-value">${d.totalProjects}</div></button>
        <button type="button" class="kpi-card clickable" data-action="goto" data-tab="insights" data-subtab="utilisation"><div class="kpi-label">Avg utilisation</div><div class="kpi-value">${d.avgUtilThisMonth == null ? "—" : d.avgUtilThisMonth + "%"}</div></button>
        <button type="button" class="kpi-card clickable" data-action="scroll-to" data-target="attentionPanel"><div class="kpi-label">Needs attention</div><div class="kpi-value">${projectItems.length + resourceItems.length}</div></button>
        <button type="button" class="kpi-card clickable" data-action="scroll-to" data-target="leavePanel"><div class="kpi-label">On leave this month</div><div class="kpi-value">${d.leave.length}</div></button>
      </div>

      <div class="panel" id="attentionPanel">
        <h2>Needs attention this month</h2>
        <div class="attn-group-label">Projects <span class="muted">(${projectItems.length})</span></div>
        <ul class="attn-list">${renderAttnGroup(projectItems, "health", 4)}</ul>
        <div class="attn-group-label">Resources <span class="muted">(${resourceItems.length})</span></div>
        <ul class="attn-list">${renderAttnGroup(resourceItems, "utilisation", 4)}</ul>
      </div>

      <div class="panel" id="leavePanel">
        <h2>Planned &amp; public holidays — ${esc(curLabel)}</h2>
        <ul class="attn-list">${leaveRows}</ul>
      </div>

      <div class="panel">
        <h2>Projects by status <span class="muted">— click to filter</span></h2>
        <div class="kpi-chip-row">${statusChips}</div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // View: Resources
  // ---------------------------------------------------------------------
  const RES_TABLE = "resources";
  function viewResources() {
    const util = computeUtilisation();
    const utilOf = (r) => (util.find((x) => x.resource.id === r.id) || {}).avgUtil;

    let rows = applyFilters(RES_TABLE, STATE.resources, {
      name: (r, v) => contains(r.name, v),
      role: (r, v) => contains(r.role, v),
      area: (r, v) => r.area === v,
    });
    rows = applySort(RES_TABLE, rows, {
      name: (r) => r.name, role: (r) => r.role, area: (r) => r.area,
      rollingAvg: (r) => rollingAvgCap(r), avgUtil: (r) => utilOf(r),
      ...Object.fromEntries(STATE.months.map((m, i) => [`cap${i}`, (r) => num(r.cap[i], 100)])),
    });

    const cur = currentMonthIndex();
    const rowsHtml = rows.map((r) => {
      const u = util.find((x) => x.resource.id === r.id);
      const capCells = r.cap.map((c, i) => {
        const note = r.capNotes && r.capNotes[i];
        return `<td class="${i === cur ? "cur-month" : ""} ${note ? "has-note" : ""}">
          <div class="cap-cell">
            <input type="number" min="0" max="100" step="5" value="${num(c, 100)}"
              data-entity="resource" data-id="${r.id}" data-field="cap" data-idx="${i}" class="cell-input">
            <button type="button" class="note-btn ${note ? "has-note" : ""}" data-action="open-holiday" data-id="${r.id}" data-idx="${i}"
              title="${note ? esc(noteTooltip(note)) : "Log planned or public holiday"}">●</button>
          </div>
        </td>`;
      }).join("");
      return `
        <tr data-row-id="res-${r.id}">
          <td class="sticky-col name-cell">
            <input type="text" value="${esc(r.name)}" data-entity="resource" data-id="${r.id}" data-field="name" class="cell-input name-input">
          </td>
          <td><input list="roleList" value="${esc(r.role)}" data-entity="resource" data-id="${r.id}" data-field="role" class="cell-input role-input"></td>
          <td>
            <select data-entity="resource" data-id="${r.id}" data-field="area" class="cell-input">
              ${AREA_OPTIONS.map((a) => `<option value="${esc(a)}" ${a === r.area ? "selected" : ""}>${esc(a)}</option>`).join("")}
            </select>
          </td>
          ${capCells}
          <td class="readonly">${rollingAvgCap(r)}%</td>
          <td class="readonly ${utilCellClass(u.avgStatus)}">${u.avgUtil == null ? "—" : u.avgUtil + "%"}</td>
          <td><button class="btn btn-danger btn-xs" data-action="delete-resource" data-id="${r.id}">Delete</button></td>
        </tr>`;
    }).join("");

    const monthSortHeaders = STATE.months.map((m, i) => `<th class="${i === cur ? "cur-month" : ""} sortable" data-sort-table="${RES_TABLE}" data-sort-col="cap${i}">
        <div>${esc(m.label)}</div><div class="th-sub">${m.hours}h &middot; ${m.days}d</div> ${sortIndicator(RES_TABLE, `cap${i}`)}
      </th>`).join("");

    const resColumns = [
      { key: "name", label: "Name", hideable: false },
      { key: "role", label: "Role", hideable: true },
      { key: "area", label: "Area", hideable: true },
      ...STATE.months.map((m, i) => ({ key: `cap${i}`, label: m.label, hideable: true })),
      { key: "rollingAvg", label: "Rolling avg cap%", hideable: true },
      { key: "avgUtil", label: "Avg utilisation", hideable: true },
      { key: "_actions", label: "", hideable: false },
    ];

    return `
      <div class="panel">
        <div class="panel-head">
          <h2>Resources — team register &amp; monthly capacity %</h2>
          <button class="btn btn-primary" data-action="add-resource">+ Add resource</button>
        </div>
        <p class="muted">Edit any cell directly. Capacity % = how much of this person's time is available that month (reduce for planned leave / part-time). Hours shown under each month are working hours, Mon–Fri, weekends excluded. Rolling avg and utilisation update live.</p>
        <p class="muted"><span class="legend-dot note-dot"></span> <b>Planned / public holidays:</b> click the dot on any month cell to log leave for that person — it doesn't need its own column. Logged months are highlighted in amber and show a suggested capacity % you can apply with one click.</p>
        <div class="table-toolbar">
          <span class="muted">Click a column header to sort. Type in a filter box to narrow rows.</span>
          <div class="table-toolbar-actions">
            ${columnPickerHtml(RES_TABLE, resColumns)}
            ${hasActiveFilters(RES_TABLE) || TABLE_SORT[RES_TABLE] ? `<button class="btn btn-ghost btn-xs" data-action="clear-table" data-table="${RES_TABLE}">✕ Clear sort &amp; filters</button>` : ""}
          </div>
        </div>
        <div class="table-scroll">
          <table class="grid-table">
            ${colGroupHtml(RES_TABLE, resColumns)}
            <thead>
              <tr>
                ${thSort(RES_TABLE, "name", "Name", "sticky-col")}${thSort(RES_TABLE, "role", "Role")}${thSort(RES_TABLE, "area", "Area")}
                ${monthSortHeaders}
                ${thSort(RES_TABLE, "rollingAvg", "Rolling avg cap%")}${thSort(RES_TABLE, "avgUtil", "Avg utilisation")}<th></th>
              </tr>
              <tr class="filter-row-cells">
                <td class="sticky-col">${filterTextInput(RES_TABLE, "name", "Filter name…")}</td>
                <td>${filterTextInput(RES_TABLE, "role", "Filter role…")}</td>
                <td>${filterSelectInput(RES_TABLE, "area", AREA_OPTIONS)}</td>
                <td colspan="${STATE.months.length + 3}"></td>
              </tr>
            </thead>
            <tbody>${rowsHtml || `<tr><td colspan="18" class="muted center">${STATE.resources.length ? "No resources match this filter." : "No resources yet — click “Add resource”."}</td></tr>`}</tbody>
          </table>
        </div>
      </div>
      <datalist id="roleList">${STATE.roles.map((r) => `<option value="${esc(r)}">`).join("")}</datalist>
    `;
  }

  // ---------------------------------------------------------------------
  // View: Projects
  // ---------------------------------------------------------------------
  const PROJ_TABLE = "projects";
  function viewProjects() {
    // Column-level Status filter is the same underlying state as the
    // status chips below, so both stay in sync with each other and with
    // dashboard deep-links.
    setFilter(PROJ_TABLE, "status", PROJECT_STATUS_FILTER === "All" ? "" : PROJECT_STATUS_FILTER);

    let filtered = applyFilters(PROJ_TABLE, STATE.projects, {
      name: (p, v) => contains(p.name, v),
      group: (p, v) => p.group === v,
      area: (p, v) => p.area === v,
      status: (p, v) => p.status === v,
      priority: (p, v) => p.priority === v,
      notes: (p, v) => contains(p.notes, v),
    });
    filtered = applySort(PROJ_TABLE, filtered, {
      name: (p) => p.name, group: (p) => p.group, area: (p) => p.area, status: (p) => p.status,
      priority: (p) => ({ Low: 0, Medium: 1, High: 2 }[p.priority] ?? -1),
      start: (p) => p.start || "", end: (p) => p.end || "",
      budgetDays: (p) => { const d = networkDays(p.start, p.end); return d === "" ? -1 : d; },
      ...Object.fromEntries(STATE.roles.map((role) => [`role:${role}`, (p) => num(p.roles[role], -1)])),
    });

    const rows = filtered.map((p) => {
      const total = STATE.roles.reduce((s, role) => s + num(p.roles[role], 0), 0);
      let validation;
      if (total === 0) validation = '<span class="muted">— No roles defined</span>';
      else if (total > 100) validation = `<span class="txt-red">⚠ ${total}% — exceeds 100%</span>`;
      else if (total < 100) validation = `<span class="txt-amber">⚠ ${total}% — should be 100%</span>`;
      else validation = '<span class="txt-green">✓ 100%</span>';

      const roleCells = STATE.roles.map((role) => `<td>
          <input type="number" min="0" max="100" step="5" value="${p.roles[role] || ""}" placeholder="—"
            data-entity="project" data-id="${p.id}" data-field="role" data-role="${esc(role)}" class="cell-input role-pct-input">
        </td>`).join("");

      const budgetDays = networkDays(p.start, p.end);

      return `
        <tr data-row-id="proj-${p.id}">
          <td class="sticky-col name-cell"><input type="text" value="${esc(p.name)}" data-entity="project" data-id="${p.id}" data-field="name" class="cell-input name-input"></td>
          <td>
            <select data-entity="project" data-id="${p.id}" data-field="group" class="cell-input">
              ${GROUP_OPTIONS.map((g) => `<option value="${g}" ${g === p.group ? "selected" : ""}>${g}</option>`).join("")}
            </select>
          </td>
          <td>
            <select data-entity="project" data-id="${p.id}" data-field="area" class="cell-input">
              ${AREA_OPTIONS.map((a) => `<option value="${esc(a)}" ${a === p.area ? "selected" : ""}>${esc(a)}</option>`).join("")}
            </select>
          </td>
          <td>
            <select data-entity="project" data-id="${p.id}" data-field="status" class="cell-input">
              ${STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </td>
          <td>
            <select data-entity="project" data-id="${p.id}" data-field="priority" class="cell-input">
              ${PRIORITY_OPTIONS.map((pr) => `<option value="${pr}" ${pr === p.priority ? "selected" : ""}>${pr}</option>`).join("")}
            </select>
          </td>
          <td><input type="date" value="${p.start || ""}" data-entity="project" data-id="${p.id}" data-field="start" class="cell-input"></td>
          <td><input type="date" value="${p.end || ""}" data-entity="project" data-id="${p.id}" data-field="end" class="cell-input"></td>
          <td class="readonly center">${budgetDays === "" ? "—" : budgetDays}</td>
          <td class="notes-cell"><textarea rows="3" data-entity="project" data-id="${p.id}" data-field="notes" class="cell-input notes-input" placeholder="Add notes — one point per line">${esc(p.notes)}</textarea></td>
          ${roleCells}
          <td class="readonly">${validation}</td>
          <td><button class="btn btn-danger btn-xs" data-action="delete-project" data-id="${p.id}">Delete</button></td>
        </tr>`;
    }).join("");

    const filterChips = ["All", ...STATUS_OPTIONS].map((s) => {
      const count = s === "All" ? STATE.projects.length : STATE.projects.filter((p) => p.status === s).length;
      return `<button type="button" class="chip-filter ${PROJECT_STATUS_FILTER === s ? "active" : ""}" data-status="${esc(s)}">${esc(s)} <span class="muted">${count}</span></button>`;
    }).join("");

    const projColumns = [
      { key: "name", label: "Project", hideable: false },
      { key: "group", label: "Group", hideable: true },
      { key: "area", label: "Area/Type", hideable: true },
      { key: "status", label: "Status", hideable: true },
      { key: "priority", label: "Priority", hideable: true },
      { key: "start", label: "Start", hideable: true },
      { key: "end", label: "End", hideable: true },
      { key: "budgetDays", label: "Budget days", hideable: true },
      { key: "notes", label: "Notes", hideable: true },
      ...STATE.roles.map((r) => ({ key: `role:${r}`, label: r, hideable: true })),
      { key: "validation", label: "Validation", hideable: true },
      { key: "_actions", label: "", hideable: false },
    ];

    return `
      <div class="panel">
        <div class="panel-head">
          <h2>Projects — project register</h2>
          <button class="btn btn-primary" data-action="add-project">+ Add project</button>
        </div>
        <p class="muted">Enter required role allocation % per role for each project (should sum to 100%). Budget days auto-calculate from dates (working days, Mon–Fri). Notes support multiple lines — each line becomes its own bullet.</p>
        <div class="filter-row">${filterChips}</div>
        <div class="table-toolbar">
          <span class="muted">Click a column header to sort. Use the boxes under the headers to filter.</span>
          <div class="table-toolbar-actions">
            ${columnPickerHtml(PROJ_TABLE, projColumns)}
            ${hasActiveFilters(PROJ_TABLE) || TABLE_SORT[PROJ_TABLE] ? `<button class="btn btn-ghost btn-xs" data-action="clear-table" data-table="${PROJ_TABLE}">✕ Clear sort &amp; filters</button>` : ""}
          </div>
        </div>
        <div class="table-scroll">
          <table class="grid-table">
            ${colGroupHtml(PROJ_TABLE, projColumns)}
            <thead>
              <tr>
                ${thSort(PROJ_TABLE, "name", "Project", "sticky-col")}${thSort(PROJ_TABLE, "group", "Group")}${thSort(PROJ_TABLE, "area", "Area/Type")}${thSort(PROJ_TABLE, "status", "Status")}${thSort(PROJ_TABLE, "priority", "Priority")}
                ${thSort(PROJ_TABLE, "start", "Start")}${thSort(PROJ_TABLE, "end", "End")}${thSort(PROJ_TABLE, "budgetDays", "Budget days")}<th>Notes</th>
                ${STATE.roles.map((r) => thSort(PROJ_TABLE, `role:${r}`, r, "role-head")).join("")}
                <th>Validation</th><th></th>
              </tr>
              <tr class="filter-row-cells">
                <td class="sticky-col">${filterTextInput(PROJ_TABLE, "name", "Filter project…")}</td>
                <td>${filterSelectInput(PROJ_TABLE, "group", GROUP_OPTIONS)}</td>
                <td>${filterSelectInput(PROJ_TABLE, "area", AREA_OPTIONS)}</td>
                <td>${filterSelectInput(PROJ_TABLE, "status", STATUS_OPTIONS)}</td>
                <td>${filterSelectInput(PROJ_TABLE, "priority", PRIORITY_OPTIONS)}</td>
                <td></td><td></td><td></td>
                <td>${filterTextInput(PROJ_TABLE, "notes", "Filter notes…")}</td>
                <td colspan="${STATE.roles.length + 2}"></td>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="20" class="muted center">${STATE.projects.length ? "No projects match this filter." : "No projects yet — click “Add project”."}</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // View: Allocations (Capacity Planner)
  // ---------------------------------------------------------------------
  const ALLOC_TABLE = "allocations";
  function viewAllocations() {
    const cur = currentMonthIndex();

    let rows = applyFilters(ALLOC_TABLE, STATE.allocations, {
      resourceId: (a, v) => a.resourceId === v,
      projectId: (a, v) => a.projectId === v,
    });
    rows = applySort(ALLOC_TABLE, rows, {
      resourceName: (a) => { const r = getResource(a.resourceId); return r ? r.name : ""; },
      projectName: (a) => { const p = getProject(a.projectId); return p ? p.name : ""; },
      avg: (a) => round(a.months.reduce((s, v) => s + num(v, 0), 0) / 12, 0),
      ...Object.fromEntries(STATE.months.map((m, i) => [`m${i}`, (a) => num(a.months[i], 0)])),
    });

    const rowsHtml = rows.map((a) => {
      const res = getResource(a.resourceId);
      const proj = getProject(a.projectId);
      const avg = round(a.months.reduce((s, v) => s + num(v, 0), 0) / 12, 0);
      const monthCells = a.months.map((v, i) => `<td class="${allocCellClass(v)} ${i === cur ? "cur-month" : ""}">
          <input type="number" min="0" max="100" step="5" value="${v || ""}" placeholder="0"
            data-entity="allocation" data-id="${a.id}" data-field="month" data-idx="${i}" class="cell-input alloc-input">
        </td>`).join("");
      return `
        <tr data-row-id="alloc-${a.id}">
          <td class="sticky-col name-cell">
            <select data-entity="allocation" data-id="${a.id}" data-field="resourceId" class="cell-input">
              ${STATE.resources.map((r) => `<option value="${r.id}" ${r.id === a.resourceId ? "selected" : ""}>${esc(r.name)}</option>`).join("")}
            </select>
          </td>
          <td class="readonly">${res ? esc(res.role) : "—"}</td>
          <td>
            <select data-entity="allocation" data-id="${a.id}" data-field="projectId" class="cell-input">
              ${STATE.projects.map((p) => `<option value="${p.id}" ${p.id === a.projectId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
            </select>
          </td>
          <td class="readonly">${proj ? esc(proj.area) : "—"}</td>
          ${monthCells}
          <td class="readonly">${avg}%</td>
          <td><button class="btn btn-danger btn-xs" data-action="delete-allocation" data-id="${a.id}">Delete</button></td>
        </tr>`;
    }).join("");

    const allocColumns = [
      { key: "resourceName", label: "Resource", hideable: false },
      { key: "role", label: "Role (auto)", hideable: true },
      { key: "projectName", label: "Project", hideable: true },
      { key: "area", label: "Area (auto)", hideable: true },
      ...STATE.months.map((m, i) => ({ key: `m${i}`, label: m.label, hideable: true })),
      { key: "avg", label: "Avg %", hideable: true },
      { key: "_actions", label: "", hideable: false },
    ];

    return `
      <div class="panel">
        <div class="panel-head">
          <h2>Allocations — capacity planner (% per resource × project × month)</h2>
          <button class="btn btn-primary" data-action="add-allocation">+ Add allocation</button>
        </div>
        <p class="muted">Enter allocation % (0–100) per month. Role and Area fill in automatically from the Resources / Projects registers, so they can never drift out of sync.</p>
        <div class="table-toolbar">
          <span class="muted">Click a column header to sort. Use the boxes under the headers to filter.</span>
          <div class="table-toolbar-actions">
            ${columnPickerHtml(ALLOC_TABLE, allocColumns)}
            ${hasActiveFilters(ALLOC_TABLE) || TABLE_SORT[ALLOC_TABLE] ? `<button class="btn btn-ghost btn-xs" data-action="clear-table" data-table="${ALLOC_TABLE}">✕ Clear sort &amp; filters</button>` : ""}
          </div>
        </div>
        <div class="table-scroll">
          <table class="grid-table">
            ${colGroupHtml(ALLOC_TABLE, allocColumns)}
            <thead>
              <tr>
                ${thSort(ALLOC_TABLE, "resourceName", "Resource", "sticky-col")}<th>Role (auto)</th>${thSort(ALLOC_TABLE, "projectName", "Project")}<th>Area (auto)</th>
                ${monthSortHeaderCells(ALLOC_TABLE, "m")}
                ${thSort(ALLOC_TABLE, "avg", "Avg %")}<th></th>
              </tr>
              <tr class="filter-row-cells">
                <td class="sticky-col">${filterSelectInputLabeled(ALLOC_TABLE, "resourceId", STATE.resources.map((r) => ({ value: r.id, label: r.name })), "All resources")}</td>
                <td></td>
                <td>${filterSelectInputLabeled(ALLOC_TABLE, "projectId", STATE.projects.map((p) => ({ value: p.id, label: p.name })), "All projects")}</td>
                <td></td>
                <td colspan="${STATE.months.length + 2}"></td>
              </tr>
            </thead>
            <tbody>${rowsHtml || `<tr><td colspan="18" class="muted center">${STATE.allocations.length ? "No allocations match this filter." : "No allocations yet — click “Add allocation”."}</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // View: Utilisation (results)
  // ---------------------------------------------------------------------
  const UTIL_TABLE = "utilisation";
  function viewUtilisation() {
    let data = applyFilters(UTIL_TABLE, computeUtilisation(), {
      name: (u, v) => contains(u.resource.name, v),
      role: (u, v) => contains(u.resource.role, v),
      status: (u, v) => u.avgStatus === v,
    });
    data = applySort(UTIL_TABLE, data, {
      name: (u) => u.resource.name, role: (u) => u.resource.role, avg: (u) => u.avgUtil,
      status: (u) => u.avgStatus,
      ...Object.fromEntries(STATE.months.map((m, i) => [`m${i}`, (u) => u.monthly[i].util])),
    });

    const rows = data.map((u) => {
      const cells = u.monthly.map((m, i) => `<td class="${utilCellClass(m.status)} ${i === currentMonthIndex() ? "cur-month" : ""}">${m.util == null ? "—" : m.util + "%"}</td>`).join("");
      return `<tr data-row-id="res-${u.resource.id}">
        <td class="sticky-col name-cell">${esc(u.resource.name)}</td>
        <td class="readonly">${esc(u.resource.role)}</td>
        ${cells}
        <td class="readonly ${utilCellClass(u.avgStatus)}">${u.avgUtil == null ? "—" : u.avgUtil + "%"}</td>
        <td class="readonly">${u.avgStatus ? { over: "⚠ Over-allocated", healthy: "✓ Healthy", under: "💤 Under-utilised" }[u.avgStatus] : "—"}</td>
      </tr>`;
    }).join("");

    const utilColumns = [
      { key: "name", label: "Resource", hideable: false },
      { key: "role", label: "Role", hideable: true },
      ...STATE.months.map((m, i) => ({ key: `m${i}`, label: m.label, hideable: true })),
      { key: "avg", label: "Avg", hideable: true },
      { key: "status", label: "Status", hideable: true },
    ];

    return `
      <div class="panel">
        <h2>Utilisation <span class="muted">— auto-calculated, do not edit</span></h2>
        <p class="muted">Util % = Allocated % ÷ Available Capacity % × 100. &nbsp; <span class="legend-dot cell-red"></span> &gt;100% over &nbsp; <span class="legend-dot cell-green"></span> 70–100% healthy &nbsp; <span class="legend-dot cell-blue"></span> &lt;70% under-utilised.</p>
        <div class="table-toolbar">
          <span class="muted">Click a column header to sort. Use the boxes under the headers to filter.</span>
          <div class="table-toolbar-actions">
            ${columnPickerHtml(UTIL_TABLE, utilColumns)}
            ${hasActiveFilters(UTIL_TABLE) || TABLE_SORT[UTIL_TABLE] ? `<button class="btn btn-ghost btn-xs" data-action="clear-table" data-table="${UTIL_TABLE}">✕ Clear sort &amp; filters</button>` : ""}
          </div>
        </div>
        <div class="table-scroll">
          <table class="grid-table">
            ${colGroupHtml(UTIL_TABLE, utilColumns)}
            <thead>
              <tr>${thSort(UTIL_TABLE, "name", "Resource", "sticky-col")}${thSort(UTIL_TABLE, "role", "Role")}${monthSortHeaderCells(UTIL_TABLE, "m")}${thSort(UTIL_TABLE, "avg", "Avg")}${thSort(UTIL_TABLE, "status", "Status")}</tr>
              <tr class="filter-row-cells">
                <td class="sticky-col">${filterTextInput(UTIL_TABLE, "name", "Filter resource…")}</td>
                <td>${filterTextInput(UTIL_TABLE, "role", "Filter role…")}</td>
                <td colspan="${STATE.months.length + 1}"></td>
                <td>${filterSelectInputLabeled(UTIL_TABLE, "status", [{ value: "over", label: "Over-allocated" }, { value: "healthy", label: "Healthy" }, { value: "under", label: "Under-utilised" }])}</td>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="16" class="muted center">${computeUtilisation().length ? "No resources match this filter." : "Add resources and allocations to see utilisation."}</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // View: Project Alloc Health (results)
  // ---------------------------------------------------------------------
  const HEALTH_TABLE = "health";
  function viewProjectHealth() {
    let data = applyFilters(HEALTH_TABLE, computeProjectHealth(), {
      name: (h, v) => contains(h.project.name, v),
      status: (h, v) => h.project.status === v,
      priority: (h, v) => h.project.priority === v,
    });
    data = applySort(HEALTH_TABLE, data, {
      name: (h) => h.project.name, status: (h) => h.project.status,
      priority: (h) => ({ Low: 0, Medium: 1, High: 2 }[h.project.priority] ?? -1),
      overall: (h) => h.overallScore,
      ...Object.fromEntries(STATE.months.map((m, i) => [`m${i}`, (h) => h.monthly[i].score])),
    });

    const rows = data.map((h) => {
      const cells = h.monthly.map((m, i) => `<td class="${i === currentMonthIndex() ? "cur-month" : ""}">${flagBadge(m.flag)}${m.score != null ? `<div class="score-sub">${m.score}%</div>` : ""}</td>`).join("");
      return `<tr data-row-id="proj-${h.project.id}">
        <td class="sticky-col name-cell">${esc(h.project.name)}</td>
        <td class="readonly">${statusBadge(h.project.status)}</td>
        <td class="readonly">${priorityBadge(h.project.priority)}</td>
        ${cells}
        <td class="readonly">${h.overallScore == null ? "—" : h.overallScore + "%"}</td>
        <td class="readonly comment-cell">${esc(healthComment(h))}</td>
      </tr>`;
    }).join("");

    const healthColumns = [
      { key: "name", label: "Project", hideable: false },
      { key: "status", label: "Status", hideable: true },
      { key: "priority", label: "Priority", hideable: true },
      ...STATE.months.map((m, i) => ({ key: `m${i}`, label: m.label, hideable: true })),
      { key: "overall", label: "Overall", hideable: true },
      { key: "comment", label: "Comment", hideable: true },
    ];

    return `
      <div class="panel">
        <h2>Project health <span class="muted">— auto-calculated, do not edit</span></h2>
        <p class="muted">Score = role-weighted cumulative achievement (actual vs. required % per role). Falls back to plain average if a project has no roles defined. Only <b>Active</b> projects with allocation data in a given month are flagged.<br>
        Thresholds — <b>High priority:</b> C &lt;75% · R 75–90% · OK &gt;90% &nbsp; <b>Medium:</b> C &lt;50% · R 50–75% · OK &gt;75% &nbsp; <b>Low:</b> R &lt;50% · OK ≥50% (no critical).</p>
        <div class="table-toolbar">
          <span class="muted">Click a column header to sort. Use the boxes under the headers to filter.</span>
          <div class="table-toolbar-actions">
            ${columnPickerHtml(HEALTH_TABLE, healthColumns)}
            ${hasActiveFilters(HEALTH_TABLE) || TABLE_SORT[HEALTH_TABLE] ? `<button class="btn btn-ghost btn-xs" data-action="clear-table" data-table="${HEALTH_TABLE}">✕ Clear sort &amp; filters</button>` : ""}
          </div>
        </div>
        <div class="table-scroll">
          <table class="grid-table">
            ${colGroupHtml(HEALTH_TABLE, healthColumns)}
            <thead>
              <tr>${thSort(HEALTH_TABLE, "name", "Project", "sticky-col")}${thSort(HEALTH_TABLE, "status", "Status")}${thSort(HEALTH_TABLE, "priority", "Priority")}${monthSortHeaderCells(HEALTH_TABLE, "m")}${thSort(HEALTH_TABLE, "overall", "Overall")}<th>Comment</th></tr>
              <tr class="filter-row-cells">
                <td class="sticky-col">${filterTextInput(HEALTH_TABLE, "name", "Filter project…")}</td>
                <td>${filterSelectInput(HEALTH_TABLE, "status", STATUS_OPTIONS)}</td>
                <td>${filterSelectInput(HEALTH_TABLE, "priority", PRIORITY_OPTIONS)}</td>
                <td colspan="${STATE.months.length + 2}"></td>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="18" class="muted center">${computeProjectHealth().length ? "No projects match this filter." : "Add projects, role requirements, and allocations to see health scores."}</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // View: Project Summary (results)
  // ---------------------------------------------------------------------
  const SUMMARY_TABLE = "summary";
  function viewProjectSummary() {
    let data = applyFilters(SUMMARY_TABLE, computeProjectSummary(), {
      name: (s, v) => contains(s.project.name, v),
      status: (s, v) => s.project.status === v,
    });
    data = applySort(SUMMARY_TABLE, data, {
      name: (s) => s.project.name, status: (s) => s.project.status,
      avg: (s) => s.avgPct, rows: (s) => s.numRows,
      ...Object.fromEntries(STATE.months.map((m, i) => [`m${i}`, (s) => s.monthly[i]])),
    });

    const rows = data.map((s) => {
      const cells = s.monthly.map((v, i) => `<td class="${allocCellClass(v)} ${i === currentMonthIndex() ? "cur-month" : ""}">${v ? v + "%" : "—"}</td>`).join("");
      return `<tr data-row-id="proj-${s.project.id}">
        <td class="sticky-col name-cell">${esc(s.project.name)}</td>
        <td class="readonly">${statusBadge(s.project.status)}</td>
        ${cells}
        <td class="readonly">${s.avgPct}%</td>
        <td class="readonly center">${s.numRows}</td>
      </tr>`;
    }).join("");

    const summaryColumns = [
      { key: "name", label: "Project", hideable: false },
      { key: "status", label: "Status", hideable: true },
      ...STATE.months.map((m, i) => ({ key: `m${i}`, label: m.label, hideable: true })),
      { key: "avg", label: "Avg%", hideable: true },
      { key: "rows", label: "# Res rows", hideable: true },
    ];

    return `
      <div class="panel">
        <h2>Project summary <span class="muted">— auto-calculated, do not edit</span></h2>
        <p class="muted">Total allocation % combined across all resources assigned to each project, per month.</p>
        <div class="table-toolbar">
          <span class="muted">Click a column header to sort. Use the boxes under the headers to filter.</span>
          <div class="table-toolbar-actions">
            ${columnPickerHtml(SUMMARY_TABLE, summaryColumns)}
            ${hasActiveFilters(SUMMARY_TABLE) || TABLE_SORT[SUMMARY_TABLE] ? `<button class="btn btn-ghost btn-xs" data-action="clear-table" data-table="${SUMMARY_TABLE}">✕ Clear sort &amp; filters</button>` : ""}
          </div>
        </div>
        <div class="table-scroll">
          <table class="grid-table">
            ${colGroupHtml(SUMMARY_TABLE, summaryColumns)}
            <thead>
              <tr>${thSort(SUMMARY_TABLE, "name", "Project", "sticky-col")}${thSort(SUMMARY_TABLE, "status", "Status")}${monthSortHeaderCells(SUMMARY_TABLE, "m")}${thSort(SUMMARY_TABLE, "avg", "Avg%")}${thSort(SUMMARY_TABLE, "rows", "# Res rows")}</tr>
              <tr class="filter-row-cells">
                <td class="sticky-col">${filterTextInput(SUMMARY_TABLE, "name", "Filter project…")}</td>
                <td>${filterSelectInput(SUMMARY_TABLE, "status", STATUS_OPTIONS)}</td>
                <td colspan="${STATE.months.length + 2}"></td>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="16" class="muted center">${computeProjectSummary().length ? "No projects match this filter." : "Add projects and allocations to see the summary."}</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // View: Data (import/export/reset)
  // ---------------------------------------------------------------------
  const VER_TABLE = "versions";
  const LOG_TABLE = "auditlog";
  function viewData() {
    const me = loggedInUser();

    // Version snapshots — most recent first, sortable
    let versions = applySort(VER_TABLE, VERSIONS, {
      ts: (v) => v.ts, label: (v) => v.label, user: (v) => v.user, type: (v) => (v.auto ? 0 : 1),
    });
    if (!TABLE_SORT[VER_TABLE]) versions = versions.slice().reverse();
    const versionRows = versions.map((v) => `
      <tr data-row-id="ver-${v.id}">
        <td class="nowrap">${fmtTs(v.ts)}</td>
        <td>${esc(v.label)}</td>
        <td>${esc(v.user)}</td>
        <td>${v.auto ? '<span class="tag-auto">Auto</span>' : '<span class="tag-manual">Manual</span>'}</td>
        <td class="muted">${v.snapshot.resources.length} resources · ${v.snapshot.projects.length} projects · ${v.snapshot.allocations.length} allocations</td>
        <td class="nowrap">
          <button class="btn btn-xs btn-secondary" data-action="view-version" data-id="${v.id}">View</button>
          <button class="btn btn-xs btn-ghost" data-action="restore-version" data-id="${v.id}">Restore</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="6" class="muted">No versions saved yet.</td></tr>`;

    // Audit log — most recent first, optionally filtered by user, sortable
    const users = auditUsers();
    const userOptions = ['<option value="All">All users</option>']
      .concat(users.map((u) => `<option value="${esc(u)}" ${u === AUDIT_FILTER_USER ? "selected" : ""}>${esc(u)}</option>`))
      .join("");
    let filteredLog = AUDIT_LOG.filter((e) => AUDIT_FILTER_USER === "All" || e.user === AUDIT_FILTER_USER);
    filteredLog = applySort(LOG_TABLE, filteredLog, {
      ts: (e) => e.ts, user: (e) => e.user, action: (e) => e.action, entity: (e) => e.entity,
    });
    if (!TABLE_SORT[LOG_TABLE]) filteredLog = filteredLog.slice().reverse();
    const auditRows = filteredLog.map((e) => {
      const meta = actionMeta(e.action);
      const change = e.field
        ? `<span class="muted">${esc(e.field)}:</span> ${esc(fmtLogValue(e.oldValue))} → <b>${esc(fmtLogValue(e.newValue))}</b>`
        : (e.newValue ? esc(fmtLogValue(e.newValue)) : "");
      return `
      <tr data-row-id="log-${e.id}">
        <td class="nowrap">${fmtTs(e.ts)}</td>
        <td>${esc(e.user)}</td>
        <td><span class="tag-action ${meta.cls}">${esc(meta.label)}</span></td>
        <td>${esc(e.entity)}${e.entityName ? ` — ${esc(e.entityName)}` : ""}</td>
        <td>${change}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="muted">No activity logged yet.</td></tr>`;

    // Users & access — every verified @hgs.com account registered on the server
    const userRows = USERS.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)).map((u) => `
      <tr data-row-id="user-${u.id}">
        <td>${esc(u.displayName)} ${ME && u.id === ME.id ? '<span class="tag-manual">You</span>' : ""}</td>
        <td class="muted">${esc(u.email)}</td>
        <td class="nowrap">${fmtTs(u.createdAt)}</td>
        <td class="nowrap">${ME && u.id === ME.id ? "" : `<button class="btn btn-xs btn-danger" data-action="remove-user" data-id="${u.id}">Remove</button>`}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="muted">No accounts yet.</td></tr>`;

    return `
      <div class="panel">
        <h2>📖 How to use this planner</h2>
        <p class="muted">A quick tour of every tab and tool. Everything recalculates live — there's no "save" needed while you work, only when you want to keep a copy (see <a href="#" data-action="scroll-to" data-target="saveLoadPanel">Save &amp; load your data</a> below).</p>
        <div class="help-grid">
          <div class="help-card">
            <h4>🔐 Signing in</h4>
            <ul>
              <li>Register with your @hgs.com email and a password — you'll get a verification link by email before you can log in.</li>
              <li>Every edit is attributed to whoever is logged in — see it in the <b>Audit log</b> below.</li>
              <li>This is real server-side authentication: bcrypt-hashed passwords, the @hgs.com domain and email verification are all enforced by the server, not the browser. See <b>Users &amp; access</b> below.</li>
            </ul>
          </div>
          <div class="help-card">
            <h4>🧭 Getting around</h4>
            <ul>
              <li><b>Dashboard</b> — the headline numbers, what needs attention, and who's on leave this month. Every number and row is clickable and jumps you to the detail behind it.</li>
              <li><b>Resources / Projects / Allocations</b> — the three editable registers everything else is calculated from.</li>
              <li><b>Insights</b> — read-only Utilisation, Project health and Project summary views, calculated live from the three registers.</li>
              <li><b>⚙ Data</b> (top right) — this tab: instructions, save/load, accounts, version history, audit log.</li>
            </ul>
          </div>
          <div class="help-card">
            <h4>✏️ Editing data</h4>
            <ul>
              <li>Click into any cell in Resources, Projects or Allocations to edit it directly — text, numbers, dropdowns and dates all commit as soon as you tab or click away.</li>
              <li>Notes fields accept multiple lines — each line you type becomes its own bullet point automatically.</li>
              <li>Role %, Rolling avg, Utilisation, Budget days and every Insights view are calculated automatically — you never edit those directly, they update the moment the underlying data changes.</li>
            </ul>
          </div>
          <div class="help-card">
            <h4>🔀 Sorting columns</h4>
            <ul>
              <li>Click any column header to sort by it — click again to reverse the order.</li>
              <li>The little ▲ / ▼ / ⇅ next to a header shows whether that column is driving the current sort.</li>
              <li>Works on every table, including the month-by-month columns.</li>
            </ul>
          </div>
          <div class="help-card">
            <h4>🔍 Filtering columns</h4>
            <ul>
              <li>Type or pick a value in the small box under a header to narrow the rows shown — text boxes filter as you type, dropdowns filter as soon as you choose.</li>
              <li>Filters combine — set several at once to narrow further.</li>
              <li>A <b>"✕ Clear sort &amp; filters"</b> button appears above the table whenever one is active.</li>
            </ul>
          </div>
          <div class="help-card">
            <h4>🗂 Hiding columns</h4>
            <ul>
              <li>Click <b>"🗂 Columns"</b> above any table to show/hide checkboxes for that table's columns — just like Excel's hide-column feature.</li>
              <li>Untick a column to hide it, tick it to bring it back, or use <b>"Show all"</b> to reset.</li>
              <li>The Name/Resource/Project identity column always stays visible so rows are never ambiguous.</li>
            </ul>
          </div>
          <div class="help-card">
            <h4>🗓 Planned &amp; public holidays</h4>
            <ul>
              <li>On the Resources tab, click the small dot in the corner of any month's capacity cell to log leave for that person — no extra column needed.</li>
              <li>It'll suggest a capacity % based on days off, which you can apply with one click.</li>
              <li>Logged months are highlighted in amber, and show up on the Dashboard's "On leave this month" panel.</li>
            </ul>
          </div>
          <div class="help-card">
            <h4>💾 Saving your work</h4>
            <ul>
              <li>Every edit is written straight to the server's database as you make it — there's no separate "save" step, and it's shared live with every other logged-in @hgs.com teammate.</li>
              <li><b>Export data (.json)</b> below downloads a full backup (data, version history, audit log) from the server for safekeeping or offline use.</li>
              <li><b>Version history</b> lets you save/restore named snapshots any time; a safety-net snapshot is always taken automatically (server-side) before a restore or import.</li>
            </ul>
          </div>
        </div>
      </div>
      <div class="panel" id="saveLoadPanel">
        <h2>Save &amp; load your data</h2>
        <p class="muted">All edits are already persisted server-side in real time — nothing here is required to "keep" your changes. Export a backup whenever you want a portable copy, or import a previously-exported backup file to restore the whole dataset (a safety-net version is always taken first).</p>
        <div class="btn-row">
          <button class="btn btn-primary" data-action="export-json">⬇ Export data (.json)</button>
          <label class="btn btn-secondary file-btn">⬆ Import data (.json)<input type="file" id="importFile" accept=".json" hidden></label>
          <button class="btn btn-secondary" data-action="export-xlsx">⬇ Export as Excel (.xlsx)</button>
          <button class="btn btn-ghost" data-action="reset-data">↺ Reset to original workbook data</button>
        </div>
      </div>
      <div class="panel">
        <h2>🔐 Users &amp; access</h2>
        <p class="muted">Every verified @hgs.com account registered on this server, logged in as <b>${esc(me ? me.displayName : "Unknown")}</b>. <b>Security note:</b> accounts are stored server-side with bcrypt-hashed passwords — passwords themselves are never sent back to the browser, and the server enforces the @hgs.com domain and email verification on every registration. There is currently one permission tier: every logged-in account can read and write everything, including removing other accounts here.</p>
        <div class="table-scroll">
          <table class="grid-table log-table">
            <thead><tr><th>Name</th><th>Email</th><th>Account created</th><th></th></tr></thead>
            <tbody>${userRows}</tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>🕓 Version history</h2>
        <p class="muted">Save a labelled snapshot any time. Snapshots are also taken automatically before a restore or import, so you can always undo. <b>Storage note:</b> versions are stored server-side in the shared database — every logged-in user sees the same history, and it survives page reloads and browser restarts.</p>
        <div class="btn-row">
          <button class="btn btn-primary" data-action="save-version">💾 Save version now</button>
        </div>
        <div class="table-scroll">
          <table class="grid-table log-table">
            <thead><tr>${thSort(VER_TABLE, "ts", "Saved")}${thSort(VER_TABLE, "label", "Label")}${thSort(VER_TABLE, "user", "By")}${thSort(VER_TABLE, "type", "Type")}<th>Contents</th><th></th></tr></thead>
            <tbody>${versionRows}</tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>📝 Audit log</h2>
        <p class="muted">Every add, edit and delete is logged here with who made it and when. <b>Storage note:</b> this is a server-authoritative log, written by the server itself against your verified session — not something the browser can spoof or edit. It's shared across every logged-in user. It is included in JSON exports, or export it on its own as CSV below.</p>
        <div class="btn-row">
          <label class="modal-label" style="display:inline-flex;align-items:center;gap:8px;width:auto;">Filter by user
            <select id="auditUserFilter" class="cell-input" style="width:auto;">${userOptions}</select>
          </label>
          <button class="btn btn-secondary" data-action="export-audit-csv">⬇ Export audit log (.csv)</button>
        </div>
        <div class="table-scroll">
          <table class="grid-table log-table">
            <thead><tr>${thSort(LOG_TABLE, "ts", "When")}${thSort(LOG_TABLE, "user", "Who")}${thSort(LOG_TABLE, "action", "Action")}${thSort(LOG_TABLE, "entity", "Item")}<th>Change</th></tr></thead>
            <tbody>${auditRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // View: Insights — Utilisation / Project Health / Project Summary,
  // combined under one tab with a sub-switcher (three separate read-only
  // "results" sheets in the original workbook, all derived from the same
  // Resources + Projects + Allocations data).
  // ---------------------------------------------------------------------
  const INSIGHTS_SUBTABS = [
    { id: "utilisation", label: "Utilisation", render: viewUtilisation },
    { id: "health", label: "Project health", render: viewProjectHealth },
    { id: "summary", label: "Project summary", render: viewProjectSummary },
  ];

  function viewInsights() {
    const sub = INSIGHTS_SUBTABS.find((s) => s.id === INSIGHTS_SUBTAB) || INSIGHTS_SUBTABS[0];
    const switcher = INSIGHTS_SUBTABS.map(
      (s) => `<button class="seg-btn ${s.id === INSIGHTS_SUBTAB ? "active" : ""}" data-subtab="${s.id}">${esc(s.label)}</button>`
    ).join("");
    return `
      <div class="seg-row">${switcher}</div>
      ${sub.render()}
      <div class="panel legend-panel">
        <span class="muted">Colour key — allocation % cells: <span class="legend-dot cell-green"></span> &lt;80% &nbsp; <span class="legend-dot cell-amber"></span> 80–100% &nbsp; <span class="legend-dot cell-red"></span> &gt;100%
        &nbsp;&nbsp;|&nbsp;&nbsp; utilisation % cells: <span class="legend-dot cell-blue"></span> &lt;70% under-used &nbsp; <span class="legend-dot cell-green"></span> 70–100% healthy &nbsp; <span class="legend-dot cell-red"></span> &gt;100% over-allocated</span>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  // Primary navigation is kept deliberately short: the three read-only
  // results sheets (Utilisation / Project Health / Project Summary) live
  // together under one "Insights" tab with a sub-switcher, and Data/export
  // is reached from a small header button rather than a full nav tab.
  const TABS = [
    { id: "dashboard", label: "Dashboard", render: viewDashboard },
    { id: "resources", label: "Resources", render: viewResources },
    { id: "projects", label: "Projects", render: viewProjects },
    { id: "allocations", label: "Allocations", render: viewAllocations },
    { id: "insights", label: "Insights", render: viewInsights },
  ];
  const HEADER_TABS = [{ id: "data", label: "Data", render: viewData }];
  const ALL_TABS = TABS.concat(HEADER_TABS);

  function renderHeaderUser() {
    const chip = document.getElementById("userChip");
    const logoutBtn = document.getElementById("logoutBtn");
    const me = loggedInUser();
    if (chip) chip.textContent = me ? `Logged in as ${me.displayName}` : "";
    if (logoutBtn) logoutBtn.style.display = me ? "" : "none";
  }

  function render() {
    renderHeaderUser();
    const nav = document.getElementById("tabNav");
    nav.innerHTML = TABS.map((t) => `<button class="tab-btn ${t.id === ACTIVE_TAB ? "active" : ""}" data-tab="${t.id}">${esc(t.label)}</button>`).join("");
    const dataBtn = document.getElementById("dataTabBtn");
    if (dataBtn) dataBtn.classList.toggle("active", ACTIVE_TAB === "data");
    const view = document.getElementById("view");
    const tab = ALL_TABS.find((t) => t.id === ACTIVE_TAB) || TABS[0];
    view.innerHTML = tab.render();
    bindViewEvents();
  }

  // ---------------------------------------------------------------------
  // Event handling — edits, add/delete, tabs
  // ---------------------------------------------------------------------
  function bindGlobalEvents() {
    document.getElementById("tabNav").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab-btn");
      if (!btn) return;
      ACTIVE_TAB = btn.dataset.tab;
      render();
    });
    const dataBtn = document.getElementById("dataTabBtn");
    if (dataBtn) dataBtn.addEventListener("click", () => { ACTIVE_TAB = "data"; render(); });
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", logoutUser);

    // Close any open column-visibility picker when clicking elsewhere.
    document.addEventListener("click", () => {
      if (Object.keys(COL_PICKER_OPEN).length) { COL_PICKER_OPEN = {}; render(); }
    });
  }

  function bindViewEvents() {
    const view = document.getElementById("view");

    // Insights sub-tab switcher
    view.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        INSIGHTS_SUBTAB = btn.dataset.subtab;
        render();
      });
    });

    // Generic column sort — click any sortable header cell.
    view.querySelectorAll("[data-sort-col]").forEach((th) => {
      th.addEventListener("click", () => {
        toggleSort(th.dataset.sortTable, th.dataset.sortCol);
        render();
      });
    });

    // Generic column filters — text inputs filter live (focus preserved
    // across the resulting re-render); selects filter on change.
    view.querySelectorAll("select.filter-input").forEach((el) => {
      el.addEventListener("change", () => {
        setFilter(el.dataset.filterTable, el.dataset.filterCol, el.value);
        // The Projects table's Status column shares state with the status
        // filter chips above it, so keep both in sync either direction.
        if (el.dataset.filterTable === PROJ_TABLE && el.dataset.filterCol === "status") {
          PROJECT_STATUS_FILTER = el.value || "All";
        }
        render();
      });
    });
    view.querySelectorAll("input.filter-input").forEach((el) => {
      el.addEventListener("input", () => {
        setFilter(el.dataset.filterTable, el.dataset.filterCol, el.value);
        withPreservedFocus(render);
      });
    });
    view.querySelectorAll('[data-action="clear-table"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.table === PROJ_TABLE) PROJECT_STATUS_FILTER = "All";
        clearTableFilters(btn.dataset.table);
      });
    });

    // Column visibility — Excel-style "hide column" picker
    view.querySelectorAll('[data-action="toggle-col-picker"]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = btn.dataset.table;
        const wasOpen = !!COL_PICKER_OPEN[t];
        COL_PICKER_OPEN = {}; // only one picker open at a time
        COL_PICKER_OPEN[t] = !wasOpen;
        render();
      });
    });
    view.querySelectorAll('[data-action="toggle-col"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        toggleColHidden(cb.dataset.table, cb.dataset.col);
        render();
      });
    });
    view.querySelectorAll('[data-action="show-all-cols"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        showAllCols(btn.dataset.table);
        render();
      });
    });
    view.querySelectorAll(".col-picker-menu").forEach((menu) => {
      menu.addEventListener("click", (e) => e.stopPropagation());
    });

    // Dashboard links — KPI cards, attention rows, status chips: every one
    // of these routes to the tab (and row) that explains the number.
    view.querySelectorAll('[data-action="goto"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        goToTab({
          tab: btn.dataset.tab,
          subtab: btn.dataset.subtab,
          statusFilter: btn.dataset.statusFilter,
          highlight: btn.dataset.highlight,
        });
      });
    });
    view.querySelectorAll('[data-action="scroll-to"]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const target = document.getElementById(btn.dataset.target);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    // Projects status filter chips
    view.querySelectorAll(".chip-filter").forEach((btn) => {
      btn.addEventListener("click", () => {
        PROJECT_STATUS_FILTER = btn.dataset.status;
        render();
      });
    });

    // Resources — planned/public holiday note on a capacity cell
    view.querySelectorAll('[data-action="open-holiday"]').forEach((btn) => {
      btn.addEventListener("click", () => openHolidayModal(btn.dataset.id, parseInt(btn.dataset.idx, 10)));
    });

    // Inline cell edits. Only SELECT/date fire one "change" per commit, so
    // those re-render (and audit-log) immediately. Everything typed
    // character-by-character (text/number/textarea) mutates STATE quietly
    // on every keystroke — for live cross-tab recompute without rebuilding
    // the input mid-type and losing focus/cursor — and only re-renders +
    // audit-logs on blur, once the final value is known.
    view.querySelectorAll(".cell-input").forEach((el) => {
      el.dataset.original = el.value;
      const isCommitEl = el.tagName === "SELECT" || el.type === "date";
      const evt = isCommitEl ? "change" : "input";
      el.addEventListener(evt, (e) => onCellEdit(e.target, isCommitEl));
      if (!isCommitEl) el.addEventListener("blur", (e) => onCellEdit(e.target, true));
    });

    // add / delete buttons
    view.querySelectorAll('[data-action="add-resource"]').forEach((b) => b.addEventListener("click", addResource));
    view.querySelectorAll('[data-action="add-project"]').forEach((b) => b.addEventListener("click", addProject));
    view.querySelectorAll('[data-action="add-allocation"]').forEach((b) => b.addEventListener("click", addAllocation));
    view.querySelectorAll('[data-action="delete-resource"]').forEach((b) => b.addEventListener("click", () => deleteResource(b.dataset.id)));
    view.querySelectorAll('[data-action="delete-project"]').forEach((b) => b.addEventListener("click", () => deleteProject(b.dataset.id)));
    view.querySelectorAll('[data-action="delete-allocation"]').forEach((b) => b.addEventListener("click", () => deleteAllocation(b.dataset.id)));

    // data tab
    const exportJsonBtn = view.querySelector('[data-action="export-json"]');
    if (exportJsonBtn) exportJsonBtn.addEventListener("click", exportJSON);
    const exportXlsxBtn = view.querySelector('[data-action="export-xlsx"]');
    if (exportXlsxBtn) exportXlsxBtn.addEventListener("click", exportXLSX);
    const resetBtn = view.querySelector('[data-action="reset-data"]');
    if (resetBtn) resetBtn.addEventListener("click", resetData);
    const importFile = view.querySelector("#importFile");
    if (importFile) importFile.addEventListener("change", importJSON);

    // Version history
    const saveVersionBtn = view.querySelector('[data-action="save-version"]');
    if (saveVersionBtn) {
      saveVersionBtn.addEventListener("click", async () => {
        const label = prompt("Label this version (optional):", "");
        if (label === null) return; // cancelled
        try {
          await saveVersion(label.trim() || undefined);
        } catch (err) {
          alert("Couldn't save version: " + err.message);
        }
      });
    }
    view.querySelectorAll('[data-action="view-version"]').forEach((b) => b.addEventListener("click", () => viewVersionModal(b.dataset.id)));
    view.querySelectorAll('[data-action="restore-version"]').forEach((b) => b.addEventListener("click", () => restoreVersion(b.dataset.id)));

    // Audit log
    const exportAuditBtn = view.querySelector('[data-action="export-audit-csv"]');
    if (exportAuditBtn) exportAuditBtn.addEventListener("click", exportAuditCSV);
    const auditFilter = view.querySelector("#auditUserFilter");
    if (auditFilter) {
      auditFilter.addEventListener("change", () => {
        AUDIT_FILTER_USER = auditFilter.value;
        render();
      });
    }

    // Users & access
    view.querySelectorAll('[data-action="remove-user"]').forEach((b) => b.addEventListener("click", () => removeUser(b.dataset.id)));
  }

  // ---------------------------------------------------------------------
  // Planned / public holiday capture — a small modal anchored to a single
  // capacity cell, so leave can be logged without adding a new column.
  // ---------------------------------------------------------------------
  function openHolidayModal(resourceId, idx) {
    const r = getResource(resourceId);
    if (!r || !Number.isInteger(idx)) return;
    if (!r.capNotes) r.capNotes = new Array(12).fill(null);
    const existing = r.capNotes[idx];
    const workingDays = STATE.months[idx].days;
    const monthLabel = STATE.months[idx].label;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true">
        <h3>${esc(r.name)} — ${esc(monthLabel)}</h3>
        <p class="muted">Log planned or public holiday for this person this month — it's captured on this cell, no new column needed. This is documentation only; use the suggestion below (or edit Capacity % directly) if it should also reduce their availability.</p>
        <label class="modal-label">Type
          <select id="hnType" class="cell-input">
            <option value="Planned Holiday">Planned holiday</option>
            <option value="Public Holiday">Public holiday</option>
            <option value="Other">Other leave</option>
          </select>
        </label>
        <label class="modal-label">Days off in ${esc(monthLabel)} <span class="muted">(${workingDays} working days that month)</span>
          <input type="number" min="0" max="${workingDays}" id="hnDays" class="cell-input" value="${existing && existing.days ? existing.days : ""}">
        </label>
        <label class="modal-label">Note
          <textarea id="hnNote" class="cell-input" rows="3" placeholder="e.g. team offsite, festival holiday, planned annual leave...">${esc(existing && existing.note ? existing.note : "")}</textarea>
        </label>
        <div class="modal-suggest" id="hnSuggest"></div>
        <div class="btn-row modal-actions">
          <button type="button" class="btn btn-primary" id="hnSave">Save</button>
          <button type="button" class="btn btn-ghost" id="hnClear">Clear</button>
          <button type="button" class="btn btn-ghost" id="hnCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#hnType").value = (existing && existing.type) || "Planned Holiday";

    function updateSuggestion() {
      const days = num(overlay.querySelector("#hnDays").value, 0);
      const suggestEl = overlay.querySelector("#hnSuggest");
      if (days > 0) {
        const suggested = Math.max(0, round(100 * (1 - days / Math.max(1, workingDays)), 0));
        suggestEl.innerHTML = `Suggested capacity for ${esc(monthLabel)} based on days off: <b>${suggested}%</b> <button type="button" class="btn btn-secondary btn-xs" id="hnApply">Use this</button>`;
        overlay.querySelector("#hnApply").addEventListener("click", async () => {
          try {
            const updated = await apiPatch(`/resources/${r.id}`, { field: "cap", idx, value: clampPct(suggested) });
            Object.assign(getResource(r.id), updated);
            suggestEl.innerHTML += ' <span class="txt-green">✓ applied</span>';
            await refreshDataTabCaches();
          } catch (err) {
            alert("Couldn't apply suggested capacity: " + err.message);
          }
        });
      } else {
        suggestEl.innerHTML = "";
      }
    }
    overlay.querySelector("#hnDays").addEventListener("input", updateSuggestion);
    updateSuggestion();

    function close() { overlay.remove(); }
    overlay.querySelector("#hnCancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("#hnClear").addEventListener("click", async () => {
      try {
        const updated = await apiPatch(`/resources/${r.id}`, { field: "capNote", idx, note: null });
        Object.assign(getResource(r.id), updated);
        close();
        await refreshDataTabCaches();
      } catch (err) {
        alert("Couldn't clear this holiday note: " + err.message);
      }
    });
    overlay.querySelector("#hnSave").addEventListener("click", async () => {
      const type = overlay.querySelector("#hnType").value;
      const days = overlay.querySelector("#hnDays").value;
      const note = overlay.querySelector("#hnNote").value.trim();
      const next = (!days && !note) ? null : { type, days: days ? num(days, 0) : null, note };
      try {
        const updated = await apiPatch(`/resources/${r.id}`, { field: "capNote", idx, note: next });
        Object.assign(getResource(r.id), updated);
        close();
        await refreshDataTabCaches();
      } catch (err) {
        alert("Couldn't save this holiday note: " + err.message);
      }
    });
  }

  let rerenderPending = false;
  function scheduleRerender(preserveFocus) {
    if (rerenderPending) return;
    rerenderPending = true;
    requestAnimationFrame(() => {
      rerenderPending = false;
      render();
    });
  }

  // Inline cell edits now round-trip through the server (PATCH /api/…),
  // which validates, persists to SQLite and writes its own audit-log entry
  // keyed off the authenticated session. The local STATE mutation below
  // still happens on every keystroke (isCommit === false) so derived views
  // stay live and the input never loses focus mid-type (see the comment on
  // the "cell-input" event bindings in bindViewEvents); only the isCommit
  // branch talks to the server.
  async function onCellEdit(el, isCommit) {
    const entity = el.dataset.entity;
    const id = el.dataset.id;
    const field = el.dataset.field;
    let newDisplay = el.value;

    if (entity === "resource") {
      const r = getResource(id);
      if (!r) return;
      if (field === "name") r.name = el.value;
      else if (field === "role") r.role = el.value;
      else if (field === "area") r.area = el.value;
      else if (field === "cap") r.cap[parseInt(el.dataset.idx, 10)] = clampPct(el.value);
    } else if (entity === "project") {
      const p = getProject(id);
      if (!p) return;
      if (field === "name") p.name = el.value;
      else if (field === "group") p.group = el.value;
      else if (field === "area") p.area = el.value;
      else if (field === "status") p.status = el.value;
      else if (field === "priority") p.priority = el.value;
      else if (field === "start") p.start = el.value || null;
      else if (field === "end") p.end = el.value || null;
      else if (field === "notes") {
        const normalized = isCommit ? normalizeBullets(el.value) : el.value;
        p.notes = normalized;
        newDisplay = normalized;
      } else if (field === "role") {
        const v = el.value === "" ? "" : clampPct(el.value);
        p.roles[el.dataset.role] = v;
        newDisplay = v;
      }
    } else if (entity === "allocation") {
      const a = STATE.allocations.find((x) => x.id === id);
      if (!a) return;
      if (field === "resourceId") a.resourceId = el.value;
      else if (field === "projectId") a.projectId = el.value;
      else if (field === "month") a.months[parseInt(el.dataset.idx, 10)] = clampPct(el.value);
    }

    if (!isCommit) return;
    el.dataset.original = el.value;

    try {
      if (entity === "resource") {
        const body = field === "cap"
          ? { field: "cap", idx: parseInt(el.dataset.idx, 10), value: clampPct(newDisplay) }
          : { field, value: newDisplay };
        const updated = await apiPatch(`/resources/${id}`, body);
        Object.assign(getResource(id), updated);
      } else if (entity === "project") {
        const body = field === "role"
          ? { field: "role", role: el.dataset.role, value: newDisplay }
          : { field, value: newDisplay };
        const updated = await apiPatch(`/projects/${id}`, body);
        Object.assign(getProject(id), updated);
      } else if (entity === "allocation") {
        const body = field === "month"
          ? { field: "month", idx: parseInt(el.dataset.idx, 10), value: clampPct(newDisplay) }
          : { field, value: newDisplay };
        const updated = await apiPatch(`/allocations/${id}`, body);
        Object.assign(STATE.allocations.find((x) => x.id === id), updated);
      }
      await refreshDataTabCaches(); // also re-renders, picking up the audit-log entry the server just wrote
    } catch (err) {
      alert("Couldn't save that change: " + err.message);
      try { STATE = await apiGet("/state"); } catch (e2) { /* keep optimistic local state if this also fails */ }
      render();
    }
  }

  async function addResource() {
    try {
      const r = await apiPost("/resources", {});
      STATE.resources.push(r);
      await refreshDataTabCaches();
    } catch (err) {
      alert("Couldn't add resource: " + err.message);
    }
  }
  async function addProject() {
    try {
      const p = await apiPost("/projects", {});
      STATE.projects.push(p);
      await refreshDataTabCaches();
    } catch (err) {
      alert("Couldn't add project: " + err.message);
    }
  }
  async function addAllocation() {
    if (!STATE.resources.length || !STATE.projects.length) {
      alert("Add at least one resource and one project first.");
      return;
    }
    try {
      const a = await apiPost("/allocations", {});
      STATE.allocations.push(a);
      await refreshDataTabCaches();
    } catch (err) {
      alert("Couldn't add allocation: " + err.message);
    }
  }
  async function deleteResource(id) {
    const r = getResource(id);
    if (!r) return;
    const linked = allocsForResource(id).length;
    const msg = linked ? `This resource has ${linked} allocation row(s). Delete the resource and those allocation rows too?` : "Delete this resource?";
    if (!confirm(msg)) return;
    try {
      await apiDelete(`/resources/${id}`);
      STATE = await apiGet("/state");
      await refreshDataTabCaches();
    } catch (err) {
      alert("Couldn't delete this resource: " + err.message);
    }
  }
  async function deleteProject(id) {
    const p = getProject(id);
    if (!p) return;
    const linked = allocsForProject(id).length;
    const msg = linked ? `This project has ${linked} allocation row(s). Delete the project and those allocation rows too?` : "Delete this project?";
    if (!confirm(msg)) return;
    try {
      await apiDelete(`/projects/${id}`);
      STATE = await apiGet("/state");
      await refreshDataTabCaches();
    } catch (err) {
      alert("Couldn't delete this project: " + err.message);
    }
  }
  async function deleteAllocation(id) {
    const a = STATE.allocations.find((x) => x.id === id);
    if (!a) return;
    try {
      await apiDelete(`/allocations/${id}`);
      STATE = await apiGet("/state");
      await refreshDataTabCaches();
    } catch (err) {
      alert("Couldn't delete this allocation: " + err.message);
    }
  }

  // ---------------------------------------------------------------------
  // Import / Export / Reset
  // ---------------------------------------------------------------------
  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Backup file is generated and streamed by the server (GET /api/export/json,
  // which sets Content-Disposition) so it always reflects the shared,
  // server-authoritative dataset — not just whatever this browser tab has
  // cached locally. A same-origin navigation carries the session cookie.
  function exportJSON() {
    window.location.href = API_BASE + "/export/json";
  }

  function exportAuditCSV() {
    const header = ["Timestamp", "User", "Action", "Entity", "Entity name", "Field", "Old value", "New value"];
    const rows = AUDIT_LOG.map((e) => [
      fmtTs(e.ts), e.user, e.action, e.entity, e.entityName, e.field || "", fmtLogValue(e.oldValue), fmtLogValue(e.newValue),
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    downloadBlob(csv, "capacity-planner-audit-log.csv", "text/csv");
  }

  // Restores a full backup file server-side (POST /api/export/import). The
  // server takes its own safety-net snapshot first (like a version restore)
  // and writes the audit-log entry itself — accounts are never part of this
  // (see the login gate: importing a file can never create/verify an
  // account, only @hgs.com self-registration + email verification can).
  function importJSON(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.resources || !data.projects || !data.allocations) throw new Error("Missing resources/projects/allocations");
        await apiPost("/export/import", data);
        STATE = await apiGet("/state");
        await refreshDataTabCaches();
        alert("Data imported successfully.");
      } catch (err) {
        alert("Could not import this file: " + err.message);
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  }

  // There's no separate client-side "SEED" concept any more — "reset to
  // original" just restores the version the server saved when it first
  // seeded the database (see server/seed.js), like any other version
  // restore (safety-net snapshot taken automatically first).
  const SEED_VERSION_LABEL = "Original workbook data (converted from Excel)";
  async function resetData() {
    if (!confirm("This discards all your edits and restores the original workbook data (with fixes applied). Your current data will be saved as a snapshot first, so you can always come back. Continue?")) return;
    try {
      const versions = await apiGet("/versions");
      const seedVersion = versions.find((v) => v.label === SEED_VERSION_LABEL) || versions[versions.length - 1];
      if (!seedVersion) { alert("Couldn't find the original workbook snapshot to restore."); return; }
      await apiPost(`/versions/${seedVersion.id}/restore`);
      STATE = await apiGet("/state");
      await refreshDataTabCaches();
    } catch (err) {
      alert("Couldn't reset to original data: " + err.message);
    }
  }

  function exportXLSX() {
    if (typeof XLSX === "undefined") {
      alert("Excel export library did not load (no internet access?). Try “Export data (.json)” instead.");
      return;
    }
    const wb = XLSX.utils.book_new();
    const monthLabels = STATE.months.map((m) => m.label);

    const monthHourLabels = STATE.months.map((m) => `${m.label} (${m.hours}h)`);
    const resSheet = [["#", "Name", "Role", "Area", ...monthHourLabels, "Rolling Avg Cap%", "Planned/public holidays logged"]];
    STATE.resources.forEach((r, i) => {
      const notes = (r.capNotes || [])
        .map((n, idx) => (n ? `${STATE.months[idx].label}: ${n.type}${n.days ? ` (${n.days}d)` : ""}${n.note ? ` — ${n.note}` : ""}` : null))
        .filter(Boolean).join(" | ");
      resSheet.push([i + 1, r.name, r.role, r.area, ...r.cap, rollingAvgCap(r), notes]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resSheet), "Resources");

    const projSheet = [["#", "Name", "Group", "Area", "Status", "Priority", "Start", "End", "Budget Days", "Notes", ...STATE.roles]];
    STATE.projects.forEach((p, i) => projSheet.push([
      i + 1, p.name, p.group, p.area, p.status, p.priority, p.start || "", p.end || "",
      networkDays(p.start, p.end), p.notes, ...STATE.roles.map((r) => p.roles[r] || ""),
    ]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(projSheet), "Projects");

    const allocSheet = [["Resource", "Role", "Project", "Area", ...monthLabels, "Avg%"]];
    STATE.allocations.forEach((a) => {
      const res = getResource(a.resourceId), proj = getProject(a.projectId);
      const avg = round(a.months.reduce((s, v) => s + num(v, 0), 0) / 12, 0);
      allocSheet.push([res ? res.name : "", res ? res.role : "", proj ? proj.name : "", proj ? proj.area : "", ...a.months, avg]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(allocSheet), "Capacity Planner");

    const util = computeUtilisation();
    const utilSheet = [["Resource", "Role", ...monthLabels, "Avg Util%", "Status"]];
    util.forEach((u) => utilSheet.push([u.resource.name, u.resource.role, ...u.monthly.map((m) => (m.util == null ? "" : m.util)), u.avgUtil == null ? "" : u.avgUtil, u.avgStatus || ""]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(utilSheet), "Utilisation View");

    const health = computeProjectHealth();
    const healthSheet = [["Project", "Status", "Priority", ...monthLabels, "Overall Score%", "Comment"]];
    health.forEach((h) => healthSheet.push([h.project.name, h.project.status, h.project.priority, ...h.monthly.map((m) => (m.flag == null ? "" : `${m.flag} (${m.score}%)`)), h.overallScore == null ? "" : h.overallScore, healthComment(h)]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(healthSheet), "Project Alloc Health");

    const summary = computeProjectSummary();
    const summarySheet = [["Project", "Status", ...monthLabels, "Avg%", "# Res Rows"]];
    summary.forEach((s) => summarySheet.push([s.project.name, s.project.status, ...s.monthly, s.avgPct, s.numRows]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summarySheet), "Proj Summary");

    XLSX.writeFile(wb, "HGS_AgentX_Capacity_Planner_Export.xlsx");
  }

  // ---------------------------------------------------------------------
  // Boot — the server owns seeding (server/seed.js runs once, on first
  // boot, straight into SQLite), so the client's only job is to find out
  // whether there's a valid session (GET /api/auth/me) and, if so, load
  // the shared state from the server. No data is ever embedded in the page.
  // ---------------------------------------------------------------------
  async function boot() {
    bindGlobalEvents();
    try {
      const meResult = await apiGet("/auth/me");
      if (meResult && meResult.user) {
        ME = meResult.user;
        STATE = await apiGet("/state");
        await refreshDataTabCaches();
        render();
      } else {
        showLoginGate();
      }
    } catch (err) {
      console.error("Couldn't check login status:", err);
      showLoginGate();
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
