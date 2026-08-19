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
  // Billable is stored as a real boolean server-side; the select/filter
  // widgets work with the string form of that boolean ("true"/"false"),
  // same as every other <select> value, and this pairs each with its
  // readable label.
  const BILLABLE_OPTIONS = [
    { value: "true", label: "Billable" },
    { value: "false", label: "Non-billable" },
  ];
  function billableLabel(v) { return v ? "Billable" : "Non-billable"; }

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
      // Restoring a version loads a fresh snapshot — re-check it for
      // pending holiday suggestions the same way a fresh page load would,
      // rather than relying on the one-shot-per-page-load guard (which may
      // already have fired earlier this session against the pre-restore data).
      RECONCILED_HOLIDAY_CAPS = false;
      await reconcilePendingHolidayCaps();
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
    // Next login is a fresh session (possibly a different user) — let it
    // re-check for pending holiday suggestions rather than staying
    // permanently skipped from this tab's earlier login.
    RECONCILED_HOLIDAY_CAPS = false;
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
            await reconcilePendingHolidayCaps();
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

  // ---------------------------------------------------------------------
  // COMPUTE: max allocatable hours for a resource in a given month —
  // capacity % of that month's total working hours (Mon–Fri). This is the
  // single formula every hours-based figure in the app derives from:
  //   maxAllocatableHours = capacityPercent / 100 × workingHours
  // Since capacityPercent already reflects any logged-holiday reduction
  // (see applyHolidayNoteAndCap below) once applied, this stays correct
  // end-to-end without needing to know about holidays itself.
  // ---------------------------------------------------------------------
  function maxAllocatableHours(resource, mIdx) {
    const cap = resourceCap(resource, mIdx);
    const hours = (STATE.months[mIdx] && STATE.months[mIdx].hours) || 0;
    return round((cap / 100) * hours, 1);
  }
  function allocatedPctForResourceMonth(resourceId, mIdx) {
    return allocsForResource(resourceId).reduce((s, a) => s + num(a.months[mIdx], 0), 0);
  }
  function allocatedHoursForResourceMonth(resourceId, mIdx) {
    const hours = (STATE.months[mIdx] && STATE.months[mIdx].hours) || 0;
    return round((allocatedPctForResourceMonth(resourceId, mIdx) / 100) * hours, 1);
  }
  // Same over/healthy/under classification computeUtilisation uses, exposed
  // standalone so any other view (e.g. Allocations) can show the identical
  // over-allocation verdict for a resource+month without recomputing the
  // whole utilisation table.
  function resourceMonthStatus(resource, mIdx) {
    const cap = resourceCap(resource, mIdx);
    if (!(cap > 0)) return null;
    const util = round((allocatedPctForResourceMonth(resource.id, mIdx) / cap) * 100, 1);
    return util > 100 ? "over" : util >= 70 ? "healthy" : "under";
  }

  // ---------------------------------------------------------------------
  // COMPUTE: suggested capacity % for a logged planned/public holiday note.
  //   suggested% = baseCapacity% × (workingDays - loggedDays) / workingDays
  // Reduces the resource's *pre-holiday* capacity % (so a part-time
  // person's existing reduced % is further reduced by holidays, not
  // overwritten to assume a 100% base) — shared by the "log holiday" modal
  // and the pending-note reconciliation pass so both always agree on the
  // same number.
  //
  // "Pre-holiday" base is captured once, into the note itself
  // (note.baseCapacity — an additive optional field on the existing
  // capNotes JSON blob, not a schema change), at the moment the note is
  // first saved. Deliberately NOT recomputed from the resource's *current*
  // live capacity % on every render: once a suggestion has been applied,
  // the live capacity already reflects the reduction, and re-deriving from
  // it would compound (100% → 91% → 83% → 75% → … on every re-render)
  // instead of settling once the suggestion is applied. Notes saved before
  // this fix have no baseCapacity, so they fall back to the live capacity
  // at read time — the same (slightly imperfect, but non-compounding for a
  // single apply) behaviour as before.
  // ---------------------------------------------------------------------
  function suggestedCapForHoliday(baseCapPct, workingDays, loggedDays) {
    const wd = num(workingDays, 0);
    const days = num(loggedDays, 0);
    if (!(wd > 0) || !(days > 0)) return null;
    const frac = Math.max(0, (wd - days) / wd);
    return clampPct(round(num(baseCapPct, 100) * frac, 0));
  }
  function baseCapForNote(resource, mIdx, note) {
    const n = note !== undefined ? note : (resource.capNotes && resource.capNotes[mIdx]);
    return n && Number.isFinite(n.baseCapacity) ? n.baseCapacity : resourceCap(resource, mIdx);
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
      const monthly = MONTH_BOUNDS.map((_, mIdx) => {
        const allocated = allocatedPctForResourceMonth(r.id, mIdx);
        const cap = resourceCap(r, mIdx);
        const util = cap > 0 ? round((allocated / cap) * 100, 1) : null;
        const status = util != null ? (util > 100 ? "over" : util >= 70 ? "healthy" : "under") : null;
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
  //
  // When called with a tableId (the Resources table, in practice), any
  // month column currently hidden via that table's column-hide picker
  // (HIDDEN_COLS / isColHidden — see "Column visibility" above) is left out
  // of the average entirely, so hiding e.g. 3 of the elapsed months'
  // columns recomputes this over just the remaining visible ones. Every
  // other call site (XLSX export, any future non-interactive consumer)
  // omits tableId and gets the full, view-preference-independent average —
  // column-hide is a personal UI preference, not a data transform, so it
  // must not leak into exports. Returns null if every candidate month is
  // hidden (nothing left to average) — render as "—".
  // ---------------------------------------------------------------------
  function rollingAvgCap(resource, tableId) {
    let n;
    if (isBeforeFY()) n = 1;
    else if (isAfterFY()) n = 12;
    else n = currentMonthIndex() + 1;
    n = Math.max(1, Math.min(12, n));
    const indices = [];
    for (let i = 0; i < n; i++) {
      if (tableId && isColHidden(tableId, `cap${i}`)) continue;
      indices.push(i);
    }
    if (!indices.length) return null;
    const vals = indices.map((i) => num(resource.cap[i], 100));
    return round(vals.reduce((s, v) => s + v, 0) / vals.length, 1);
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

    const billableCount = STATE.projects.filter((p) => p.billable !== false).length;
    const nonBillableCount = STATE.projects.length - billableCount;

    // ---- Utilisation trend — average utilisation % across every resource,
    // for every month in the FY (not just the current one). Feeds the
    // Dashboard's trend chart. Independent of Resources-tab column-hide
    // state (that's scoped to Rolling avg cap% only, per spec).
    const monthlyAvgUtil = MONTH_BOUNDS.map((_, i) => {
      const valid = util.map((u) => u.monthly[i].util).filter((v) => v != null);
      return valid.length ? round(valid.reduce((s, v) => s + v, 0) / valid.length, 1) : null;
    });

    // ---- Average utilisation by role — feeds the Dashboard's bar chart.
    // Only roles with at least one resource that has a computable avgUtil
    // are included; sorted highest-utilised first so the exec-readable
    // story ("who's stretched thinnest") reads top-to-bottom.
    const roleUtilMap = {};
    util.forEach((u) => {
      const role = u.resource.role || "Unassigned";
      if (u.avgUtil == null) return;
      (roleUtilMap[role] || (roleUtilMap[role] = [])).push(u.avgUtil);
    });
    const utilByRole = Object.entries(roleUtilMap)
      .map(([role, vals]) => ({
        role, count: vals.length,
        avg: round(vals.reduce((s, v) => s + v, 0) / vals.length, 1),
      }))
      .sort((a, b) => b.avg - a.avg);

    // ---- Billable vs non-billable, broken down by project group — feeds
    // the Dashboard's billing panel. "Core" is deliberately excluded: it's
    // always non-billable by definition, so including it here would just
    // be a 0%-billable row with no signal. Feature / Implementation are the
    // real, distinct group values in the data (see GROUP_OPTIONS) — kept
    // as two separate rows rather than merged into one bucket, so the
    // breakdown doesn't hide which of the two is actually driving any
    // non-billable share. See project notes for the full reasoning.
    const billableByGroup = GROUP_OPTIONS.filter((g) => g !== "CORE").map((g) => {
      const projs = STATE.projects.filter((p) => p.group === g);
      const billable = projs.filter((p) => p.billable !== false).length;
      const total = projs.length;
      const nonBillable = total - billable;
      return {
        group: g,
        billable, nonBillable, total,
        billablePct: total ? round((billable / total) * 100, 0) : 0,
        nonBillablePct: total ? round((nonBillable / total) * 100, 0) : 0,
      };
    });

    return {
      mIdx,
      totalResources: STATE.resources.length,
      totalProjects: STATE.projects.length,
      totalAllocationRows: STATE.allocations.length,
      activeProjectCount: statusCounts.Active || 0,
      statusCounts,
      billableCount, nonBillableCount, billableByGroup,
      avgUtilThisMonth, monthlyAvgUtil, utilByRole,
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
  function goToTab({ tab, subtab, statusFilter, highlight, projectGroupFilter, projectBillableFilter }) {
    if (tab) ACTIVE_TAB = tab;
    if (subtab) INSIGHTS_SUBTAB = subtab;
    if (statusFilter !== undefined) PROJECT_STATUS_FILTER = statusFilter;
    // Dashboard's billable-by-group breakdown (item 3) deep-links straight
    // into the Projects table's own column filters, same mechanism the
    // status chips already use for the Status column.
    if (projectGroupFilter !== undefined) setFilter(PROJ_TABLE, "group", projectGroupFilter);
    if (projectBillableFilter !== undefined) setFilter(PROJ_TABLE, "billable", projectBillableFilter);
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
  // Dashboard charts — hand-rolled, dependency-free (no charting library:
  // see CSP in server/app.js, which doesn't allowlist one, and none is
  // needed for two simple exec-facing charts). Colours reuse the exact
  // same brand tokens/semantics as the rest of the app (over/healthy/under
  // = red/green/blue, matching utilCellClass) so the Dashboard reads as
  // the same product as Resources/Allocations/Insights, not a bolted-on
  // separate tool.
  // ---------------------------------------------------------------------
  function utilBandClass(avg) {
    if (avg == null) return "";
    return avg > 100 ? "bar-over" : avg >= 70 ? "bar-healthy" : "bar-under";
  }

  // Horizontal bar chart — average utilisation % by role. Plain HTML/CSS
  // bars (width: N%) rather than SVG: simpler, and text labels never need
  // separate positioning logic. Capped display scale gives >100% bars a
  // little headroom instead of clipping at the container edge.
  function utilBarChartHtml(rows) {
    if (!rows.length) return `<p class="muted chart-empty">No utilisation data yet — add resources and allocations.</p>`;
    const scaleMax = Math.max(100, ...rows.map((r) => r.avg)) * 1.08;
    return `<div class="bar-chart" role="img" aria-label="Average utilisation by role">
      ${rows.map((r) => `
        <div class="bar-chart-row">
          <div class="bar-chart-label" title="${esc(r.role)}">${esc(r.role)} <span class="muted">(${r.count})</span></div>
          <div class="bar-chart-track">
            <div class="bar-chart-fill ${utilBandClass(r.avg)}" style="width:${clampPct((r.avg / scaleMax) * 100)}%"></div>
            <div class="bar-chart-ref" style="left:${clampPct((100 / scaleMax) * 100)}%"></div>
          </div>
          <div class="bar-chart-value">${r.avg}%</div>
        </div>`).join("")}
      <div class="bar-chart-legend muted">Bars scaled to fit; dashed line marks 100% capacity. <span class="legend-dot bar-over"></span> over &nbsp; <span class="legend-dot bar-healthy"></span> healthy &nbsp; <span class="legend-dot bar-under"></span> under</div>
    </div>`;
  }

  // Trend line (inline SVG) — average utilisation % across all resources,
  // one point per FY month. A simple area+line chart with a labelled
  // 100%-capacity reference line and the current month highlighted, so an
  // exec can see at a glance whether utilisation is trending toward or
  // away from full capacity across the year, not just this month's snapshot.
  function utilTrendSvg(monthlyAvgUtil, months, curIdx) {
    const w = 760, h = 200, padL = 8, padR = 8, padT = 16, padB = 26;
    const innerW = w - padL - padR, innerH = h - padT - padB;
    const vals = monthlyAvgUtil.map((v) => (v == null ? null : v));
    const known = vals.filter((v) => v != null);
    if (!known.length) return `<p class="muted chart-empty">No utilisation data yet — add resources and allocations.</p>`;
    const maxV = Math.max(100, ...known) * 1.1;
    const stepX = months.length > 1 ? innerW / (months.length - 1) : 0;
    const yFor = (v) => padT + innerH - (v / maxV) * innerH;
    const xFor = (i) => padL + i * stepX;
    const pts = vals.map((v, i) => (v == null ? null : [xFor(i), yFor(v)]));
    const knownPts = pts.filter(Boolean);
    const linePath = knownPts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const areaPath = knownPts.length
      ? linePath + ` L${knownPts[knownPts.length - 1][0].toFixed(1)},${(padT + innerH).toFixed(1)} L${knownPts[0][0].toFixed(1)},${(padT + innerH).toFixed(1)} Z`
      : "";
    const y100 = yFor(100).toFixed(1);
    const dots = pts.map((p, i) => p ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === curIdx ? 4.5 : 2.5}" class="trend-dot ${i === curIdx ? "trend-dot-cur" : ""}"><title>${esc(months[i].label)}: ${vals[i]}% avg utilisation</title></circle>` : "").join("");
    const labels = pts.map((p, i) => `<text x="${xFor(i).toFixed(1)}" y="${h - 6}" class="trend-month-label ${i === curIdx ? "cur" : ""}" text-anchor="middle">${esc(months[i].label.replace(/'\d\d$/, ""))}</text>`).join("");
    return `<svg viewBox="0 0 ${w} ${h}" class="trend-svg" role="img" aria-label="Utilisation trend across the fiscal year">
      <line x1="${padL}" y1="${y100}" x2="${w - padR}" y2="${y100}" class="trend-ref-line"></line>
      <text x="${w - padR}" y="${(Number(y100) - 4).toFixed(1)}" class="trend-ref-label" text-anchor="end">100% capacity</text>
      ${areaPath ? `<path d="${areaPath}" class="trend-area"></path>` : ""}
      ${linePath ? `<path d="${linePath}" class="trend-line"></path>` : ""}
      ${dots}
      ${labels}
    </svg>`;
  }

  // ---------------------------------------------------------------------
  // View: Dashboard
  // ---------------------------------------------------------------------
  const GROUP_LABELS = { CORE: "Core", IMPLEMENTATION: "Implementation", FEATURE: "Feature" };
  function groupLabel(g) { return GROUP_LABELS[g] || g; }

  function viewDashboard() {
    const d = computeDashboard();
    const curLabel = STATE.months[d.mIdx].label;

    // Needs-attention is categorized by type — projects vs. resources —
    // rather than interleaved, and every row routes to the tab/row that
    // explains the number (Insights, correct sub-tab, row highlighted).
    const projectItems = [
      ...d.critical.map((h) => ({ kind: "Critical", cls: "sev-critical", icon: "⛔", name: h.project.name, value: `${h.monthly[d.mIdx].score}%`, highlight: `proj-${h.project.id}` })),
      ...d.review.map((h) => ({ kind: "Needs review", cls: "sev-review", icon: "⚠", name: h.project.name, value: `${h.monthly[d.mIdx].score}%`, highlight: `proj-${h.project.id}` })),
    ];
    const resourceItems = [
      ...d.over.sort((a, b) => b.monthly[d.mIdx].util - a.monthly[d.mIdx].util)
        .map((u) => ({ kind: "Over-allocated", cls: "sev-over", icon: "🔺", name: u.resource.name, value: `${u.monthly[d.mIdx].util}%`, highlight: `res-${u.resource.id}` })),
      ...d.under.sort((a, b) => a.monthly[d.mIdx].util - b.monthly[d.mIdx].util)
        .map((u) => ({ kind: "Under-utilised", cls: "sev-under", icon: "🔻", name: u.resource.name, value: `${u.monthly[d.mIdx].util}%`, highlight: `res-${u.resource.id}` })),
    ];

    // Needs-attention — card grid (not a plain list): each issue is its own
    // small card with a coloured left edge + icon, matching the app's
    // existing card/panel visual language (rounded corners, soft shadow)
    // rather than the flatter row style this replaces.
    function renderAttnGroup(items, subtab, max) {
      if (!items.length) return `<div class="attn-card sev-none">All clear.</div>`;
      const shown = items.slice(0, max);
      const hidden = items.length - shown.length;
      return shown.map((a) => `
          <button type="button" class="attn-card ${a.cls} clickable" data-action="goto" data-tab="insights" data-subtab="${subtab}" data-highlight="${a.highlight}">
            <span class="attn-icon">${a.icon}</span>
            <span class="attn-card-body">
              <span class="attn-kind">${esc(a.kind)}</span>
              <span class="attn-name" title="${esc(a.name)}">${esc(a.name)}</span>
            </span>
            <b class="attn-value">${esc(a.value)}</b>
          </button>`).join("") + (hidden > 0
            ? `<button type="button" class="attn-card sev-more clickable" data-action="goto" data-tab="insights" data-subtab="${subtab}">+${hidden} more — see Insights</button>`
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
          <button type="button" class="attn-card sev-leave clickable" data-action="goto" data-tab="resources" data-highlight="res-${l.resource.id}">
            <span class="attn-icon">🌴</span>
            <span class="attn-card-body">
              <span class="attn-kind">${esc(l.note.type || "Leave")}</span>
              <span class="attn-name">${esc(l.resource.name)}${l.note.days ? ` — ${esc(l.note.days)} day${l.note.days == 1 ? "" : "s"}` : ""}${l.note.note ? `<span class="muted"> · ${esc(l.note.note)}</span>` : ""}</span>
            </span>
          </button>`).join("")
      : `<div class="attn-card sev-none">No planned or public holidays logged for ${esc(curLabel)} yet. Click the note icon (<span class="legend-dot note-dot"></span>) on any month cell in Resources to add one.</div>`;

    // Billable vs non-billable, by project group (item 3) — Core excluded
    // (always non-billable by definition, so it carries no signal here).
    // Each group's billable/non-billable counts are individually
    // click-to-filter straight into the Projects table, same idiom as the
    // status chips above.
    const billingGroupCards = d.billableByGroup.map((g) => `
      <div class="billing-group-card">
        <div class="billing-group-head">${esc(groupLabel(g.group))} <span class="muted">— ${g.total} project${g.total === 1 ? "" : "s"}</span></div>
        <div class="billing-group-bar" title="${g.billablePct}% billable · ${g.nonBillablePct}% non-billable">
          <div class="billing-group-bar-billable" style="width:${g.billablePct}%"></div>
          <div class="billing-group-bar-nonbillable" style="width:${g.nonBillablePct}%"></div>
        </div>
        <div class="kpi-chip-row">
          <button type="button" class="kpi-chip clickable" data-action="goto" data-tab="projects" data-status-filter="All" data-project-group="${esc(g.group)}" data-project-billable="true">
            <span class="status-pill st-billable">Billable</span><b>${g.billable}</b> <span class="muted">(${g.billablePct}%)</span>
          </button>
          <button type="button" class="kpi-chip clickable" data-action="goto" data-tab="projects" data-status-filter="All" data-project-group="${esc(g.group)}" data-project-billable="false">
            <span class="status-pill st-nonbillable">Non-billable</span><b>${g.nonBillable}</b> <span class="muted">(${g.nonBillablePct}%)</span>
          </button>
        </div>
      </div>`).join("");

    return `
      <div class="panel intro-panel">
        <h1>Resource capacity planner — AgentX team</h1>
        <p class="muted">${esc(STATE.meta.fyLabel)} &middot; showing <b>${esc(curLabel)}</b> as the current month &middot; ${d.totalResources} resources across ${d.totalProjects} projects</p>
      </div>

      <div class="kpi-grid kpi-hero">
        <button type="button" class="kpi-card clickable" data-action="goto" data-tab="resources">
          <div class="kpi-label">Resources</div><div class="kpi-value">${d.totalResources}</div>
        </button>
        <button type="button" class="kpi-card clickable" data-action="goto" data-tab="projects" data-status-filter="Active">
          <div class="kpi-label">Active projects</div><div class="kpi-value">${d.activeProjectCount}</div><div class="kpi-sub muted">of ${d.totalProjects} total</div>
        </button>
        <button type="button" class="kpi-card clickable" data-action="goto" data-tab="insights" data-subtab="utilisation">
          <div class="kpi-label">Avg utilisation</div><div class="kpi-value">${d.avgUtilThisMonth == null ? "—" : d.avgUtilThisMonth + "%"}</div><div class="kpi-sub muted">this month</div>
        </button>
        <button type="button" class="kpi-card clickable kpi-card-warn" data-action="goto" data-tab="insights" data-subtab="utilisation">
          <div class="kpi-label">Over-allocated</div><div class="kpi-value">${d.over.length}</div><div class="kpi-sub muted">resources this month</div>
        </button>
        <button type="button" class="kpi-card clickable" data-action="scroll-to" data-target="attentionPanel">
          <div class="kpi-label">Needs attention</div><div class="kpi-value">${projectItems.length + resourceItems.length}</div><div class="kpi-sub muted">projects + resources</div>
        </button>
        <button type="button" class="kpi-card clickable" data-action="scroll-to" data-target="leavePanel">
          <div class="kpi-label">On leave this month</div><div class="kpi-value">${d.leave.length}</div>
        </button>
      </div>

      <div class="grid-2">
        <div class="panel chart-panel">
          <h2>Avg utilisation by role</h2>
          <p class="muted">This fiscal year, averaged per resource then rolled up by role.</p>
          ${utilBarChartHtml(d.utilByRole)}
        </div>
        <div class="panel chart-panel">
          <h2>Utilisation trend — ${esc(STATE.meta.fyLabel)}</h2>
          <p class="muted">Average utilisation % across every resource, month by month. <span class="legend-dot" style="background:var(--brand)"></span> current month.</p>
          ${utilTrendSvg(d.monthlyAvgUtil, STATE.months, d.mIdx)}
        </div>
      </div>

      <div class="panel" id="attentionPanel">
        <h2>Needs attention this month</h2>
        <div class="attn-group-label">Projects <span class="muted">(${projectItems.length})</span></div>
        <div class="attn-grid">${renderAttnGroup(projectItems, "health", 4)}</div>
        <div class="attn-group-label">Resources <span class="muted">(${resourceItems.length})</span></div>
        <div class="attn-grid">${renderAttnGroup(resourceItems, "utilisation", 4)}</div>
      </div>

      <div class="panel" id="leavePanel">
        <h2>Planned &amp; public holidays — ${esc(curLabel)}</h2>
        <div class="attn-grid">${leaveRows}</div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <h2>Projects by status <span class="muted">— click to filter</span></h2>
          <div class="kpi-chip-row">${statusChips}</div>
        </div>

        <div class="panel">
          <h2>Billable vs non-billable <span class="muted">— by group</span></h2>
          <p class="muted">Overall: <b>${d.billableCount}</b> billable (${d.totalProjects ? round(d.billableCount / d.totalProjects * 100, 0) : 0}%) &middot; <b>${d.nonBillableCount}</b> non-billable. Core excluded below — it's always non-billable by definition, so it adds no signal to this breakdown.</p>
          <div class="billing-group-grid">${billingGroupCards}</div>
        </div>
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
      rollingAvg: (r) => rollingAvgCap(r, RES_TABLE), avgUtil: (r) => utilOf(r),
      ...Object.fromEntries(STATE.months.map((m, i) => [`cap${i}`, (r) => num(r.cap[i], 100)])),
    });

    const cur = currentMonthIndex();
    const rowsHtml = rows.map((r) => {
      const u = util.find((x) => x.resource.id === r.id);
      const capCells = r.cap.map((c, i) => {
        const note = r.capNotes && r.capNotes[i];
        const capValue = num(c, 100);
        // Capacity % is now always kept in sync automatically as soon as a
        // holiday/PTO note is logged (see applyHolidayNoteAndCap /
        // reconcilePendingHolidayCaps) — the number in the cell is always
        // correct, so there's no separate "click to apply" chip to manage
        // any more. The amber cell fill + note dot (with a tooltip showing
        // the logged days) is the only remaining indicator that a month
        // has a holiday note on it.
        return `<td class="${i === cur ? "cur-month" : ""} ${note ? "has-note" : ""}">
          <div class="cap-cell">
            <input type="number" min="0" max="100" step="5" value="${capValue}"
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
          <td class="readonly">${(() => { const ra = rollingAvgCap(r, RES_TABLE); return ra == null ? "—" : ra + "%"; })()}</td>
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
        <p class="muted"><span class="legend-dot note-dot"></span> <b>Planned / public holidays:</b> click the dot on any month cell to log leave for that person — it doesn't need its own column. Saving updates that month's capacity % automatically (highlighted in amber), so the number is always correct without a separate apply step.</p>
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
      status: (p, v) => p.status === v,
      priority: (p, v) => p.priority === v,
      billable: (p, v) => String(p.billable !== false) === v,
      notes: (p, v) => contains(p.notes, v),
    });
    filtered = applySort(PROJ_TABLE, filtered, {
      name: (p) => p.name, group: (p) => p.group, status: (p) => p.status,
      priority: (p) => ({ Low: 0, Medium: 1, High: 2 }[p.priority] ?? -1),
      billable: (p) => (p.billable !== false ? 1 : 0),
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
            <select data-entity="project" data-id="${p.id}" data-field="status" class="cell-input">
              ${STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </td>
          <td>
            <select data-entity="project" data-id="${p.id}" data-field="priority" class="cell-input">
              ${PRIORITY_OPTIONS.map((pr) => `<option value="${pr}" ${pr === p.priority ? "selected" : ""}>${pr}</option>`).join("")}
            </select>
          </td>
          <td>
            <select data-entity="project" data-id="${p.id}" data-field="billable" class="cell-input">
              ${BILLABLE_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === String(p.billable !== false) ? "selected" : ""}>${o.label}</option>`).join("")}
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
      { key: "status", label: "Status", hideable: true },
      { key: "priority", label: "Priority", hideable: true },
      { key: "billable", label: "Billable", hideable: true },
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
                ${thSort(PROJ_TABLE, "name", "Project", "sticky-col")}${thSort(PROJ_TABLE, "group", "Group")}${thSort(PROJ_TABLE, "status", "Status")}${thSort(PROJ_TABLE, "priority", "Priority")}
                ${thSort(PROJ_TABLE, "billable", "Billable")}
                ${thSort(PROJ_TABLE, "start", "Start")}${thSort(PROJ_TABLE, "end", "End")}${thSort(PROJ_TABLE, "budgetDays", "Budget days")}<th>Notes</th>
                ${STATE.roles.map((r) => thSort(PROJ_TABLE, `role:${r}`, r, "role-head")).join("")}
                <th>Validation</th><th></th>
              </tr>
              <tr class="filter-row-cells">
                <td class="sticky-col">${filterTextInput(PROJ_TABLE, "name", "Filter project…")}</td>
                <td>${filterSelectInput(PROJ_TABLE, "group", GROUP_OPTIONS)}</td>
                <td>${filterSelectInput(PROJ_TABLE, "status", STATUS_OPTIONS)}</td>
                <td>${filterSelectInput(PROJ_TABLE, "priority", PRIORITY_OPTIONS)}</td>
                <td>${filterSelectInputLabeled(PROJ_TABLE, "billable", BILLABLE_OPTIONS, "All")}</td>
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
      // Cell colour + "remaining hrs" readout reflect this resource's total
      // allocation across *every* project that month vs. their capacity
      // (maxAllocatableHours = capacity% ÷ 100 × that month's working
      // hours) — the same status computeUtilisation/the Dashboard use, so
      // a resource whose capacity was reduced by a logged holiday shows the
      // same over-allocation warning here, not just on the Utilisation tab.
      const monthCells = a.months.map((v, i) => {
        const status = res ? resourceMonthStatus(res, i) : null;
        const cellCls = status ? utilCellClass(status) : allocCellClass(v);
        const remainingSub = res
          ? (() => {
              const remaining = round(maxAllocatableHours(res, i) - allocatedHoursForResourceMonth(res.id, i), 1);
              return `<div class="score-sub">${remaining < 0 ? `over by ${Math.abs(remaining)}h` : `${remaining}h left`}</div>`;
            })()
          : "";
        return `<td class="${cellCls} ${i === cur ? "cur-month" : ""}">
          <input type="number" min="0" max="100" step="5" value="${v || ""}" placeholder="0"
            data-entity="allocation" data-id="${a.id}" data-field="month" data-idx="${i}" class="cell-input alloc-input">
          ${remainingSub}
        </td>`;
      }).join("");
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
          ${monthCells}
          <td class="readonly">${avg}%</td>
          <td><button class="btn btn-danger btn-xs" data-action="delete-allocation" data-id="${a.id}">Delete</button></td>
        </tr>`;
    }).join("");

    const allocColumns = [
      { key: "resourceName", label: "Resource", hideable: false },
      { key: "role", label: "Role (auto)", hideable: true },
      { key: "projectName", label: "Project", hideable: true },
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
        <p class="muted">Enter allocation % (0–100) per month. Role fills in automatically from the Resources register, so it can never drift out of sync. Each cell's small subtext is that resource's remaining hours that month (capacity % × working hours, across every project they're on) — cell colour matches the same over/healthy/under-allocated verdict as the Utilisation tab, so a capacity % reduced for a logged holiday shows up here too. &nbsp; <span class="legend-dot cell-red"></span> over-allocated &nbsp; <span class="legend-dot cell-green"></span> healthy &nbsp; <span class="legend-dot cell-blue"></span> under-utilised.</p>
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
                ${thSort(ALLOC_TABLE, "resourceName", "Resource", "sticky-col")}<th>Role (auto)</th>${thSort(ALLOC_TABLE, "projectName", "Project")}
                ${monthSortHeaderCells(ALLOC_TABLE, "m")}
                ${thSort(ALLOC_TABLE, "avg", "Avg %")}<th></th>
              </tr>
              <tr class="filter-row-cells">
                <td class="sticky-col">${filterSelectInputLabeled(ALLOC_TABLE, "resourceId", STATE.resources.map((r) => ({ value: r.id, label: r.name })), "All resources")}</td>
                <td></td>
                <td>${filterSelectInputLabeled(ALLOC_TABLE, "projectId", STATE.projects.map((p) => ({ value: p.id, label: p.name })), "All projects")}</td>
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
              <li>Saving automatically reduces that month's capacity % based on days off — no separate "apply" step needed.</li>
              <li>Logged months are highlighted in amber, and show up on the Dashboard's "On leave this month" panel.</li>
              <li>You can still edit the capacity % directly by hand at any time — a manual edit always sticks and is never overwritten automatically.</li>
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
          projectGroupFilter: btn.dataset.projectGroup,
          projectBillableFilter: btn.dataset.projectBillable,
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

  // Computes the suggested capacity % implied by a logged holiday note and
  // persists it as one save action: PATCH the capacity % (field: "cap" —
  // the exact same call a manual capacity-cell edit makes, so it's
  // audit-logged identically as "Capacity % changed" and every downstream
  // calculation picks it up immediately since they all read the resource's
  // cap[] array live), then PATCH the note itself (field: "capNote") with
  // its pre-holiday baseCapacity frozen and applied:true — which is what
  // marks this note as settled so a later render or reconciliation pass
  // never re-suggests or re-applies it (see reconcilePendingHolidayCaps).
  //
  // Shared by the "log a new holiday" modal's save handler and the
  // one-time pending-note reconciliation pass on load, so a brand-new
  // holiday and an old pre-existing "pending" one from before this feature
  // existed both get applied and persisted identically.
  async function applyHolidayNoteAndCap(resource, idx, note) {
    const workingDays = STATE.months[idx] && STATE.months[idx].days;
    const base = baseCapForNote(resource, idx, note);
    const suggested = suggestedCapForHoliday(base, workingDays, note.days);
    if (suggested == null) return null;
    const cUpdated = await apiPatch(`/resources/${resource.id}`, { field: "cap", idx, value: suggested });
    Object.assign(resource, cUpdated);
    const appliedNote = { ...note, baseCapacity: base, applied: true };
    const nUpdated = await apiPatch(`/resources/${resource.id}`, { field: "capNote", idx, note: appliedNote });
    Object.assign(resource, nUpdated);
    return suggested;
  }

  // ---------------------------------------------------------------------
  // One-time-per-page-load sweep over every resource+month with a logged
  // holiday/PTO note whose suggested capacity % hasn't been applied yet.
  // This is how "pending" notes already sitting in the database — logged
  // before auto-apply existed, so the cell is still showing its old
  // pre-holiday capacity % — get resolved automatically the moment the app
  // loads, without anyone having to hunt down and click a suggestion chip
  // for each one.
  //
  // Safe to call after every full STATE reload (boot, login, version
  // restore) without misbehaving against real, already-partly-applied
  // production data:
  //   1. RECONCILED_HOLIDAY_CAPS — runs at most once per page load; the
  //      many render() calls that happen afterwards (e.g. every keystroke)
  //      never re-enter this function. Reset on logout (a fresh login
  //      re-checks) and explicitly before a version restore (fresh data
  //      deserves a fresh check).
  //   2. note.applied — once a note's suggestion has been applied, by this
  //      pass or by the "log a new holiday" save flow, it's marked
  //      applied:true and permanently skipped from here on, so it settles
  //      instead of re-firing on every future load.
  //   3. resourceCap(r, idx) === baseCapForNote(r, idx, note) — only
  //      touches a month whose *live* capacity % still equals the
  //      pre-holiday base the note implies (for a note with no
  //      baseCapacity recorded — i.e. every real pending note in
  //      production today — that base falls back to the live capacity
  //      itself, so this is trivially true and the suggestion applies).
  //      If a human has since changed that cell by hand, the live % no
  //      longer matches and this pass leaves it alone rather than
  //      clobbering their edit.
  // ---------------------------------------------------------------------
  let RECONCILED_HOLIDAY_CAPS = false;
  async function reconcilePendingHolidayCaps() {
    if (RECONCILED_HOLIDAY_CAPS || !STATE || !Array.isArray(STATE.resources)) return;
    RECONCILED_HOLIDAY_CAPS = true;
    const pending = [];
    STATE.resources.forEach((r) => {
      (r.capNotes || []).forEach((note, idx) => {
        if (!note || !note.days || note.applied) return;
        if (resourceCap(r, idx) !== baseCapForNote(r, idx, note)) return; // manually changed since — don't clobber
        pending.push({ resourceId: r.id, idx, note });
      });
    });
    if (!pending.length) return;
    console.info(`Auto-applying ${pending.length} pending holiday-adjusted capacity suggestion(s) found on load (attributed to ${activeUser()})…`);
    for (const { resourceId, idx, note } of pending) {
      const r = getResource(resourceId);
      if (!r) continue;
      try {
        await applyHolidayNoteAndCap(r, idx, note);
      } catch (err) {
        console.error(`Couldn't auto-apply pending holiday suggestion for resource ${resourceId}, month ${idx}:`, err);
      }
    }
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
    // Captured once when the modal opens (see suggestedCapForHoliday's
    // comment for why): the "pre-holiday" capacity % to compute
    // suggestions off, so re-opening this modal or tweaking the day count
    // never compounds a previously-applied suggestion.
    const baseCapacity = baseCapForNote(r, idx, existing);

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
      // Reduces this resource's pre-holiday capacity % (not a flat 100%
      // base, and not the live capacity % which may already reflect a
      // previously-applied suggestion) by the fraction of working days
      // logged as leave — same formula, and the same shared helper, as the
      // reconciliation pass (see suggestedCapForHoliday), so a part-time
      // person's existing reduced % is further reduced by holidays rather
      // than being overwritten. Saving applies this automatically — no
      // separate "apply" click needed any more.
      const suggested = suggestedCapForHoliday(baseCapacity, workingDays, days);
      suggestEl.innerHTML = suggested != null
        ? `Saving will set capacity for ${esc(monthLabel)} to <b>${suggested}%</b> — ${esc(r.name)}'s ${baseCapacity}% capacity × ${workingDays - days}/${workingDays} available working days.`
        : "";
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
      const hasDays = !!(days && num(days, 0) > 0);
      const next = (!days && !note) ? null : { type, days: hasDays ? num(days, 0) : null, note };
      try {
        if (next && hasDays) {
          // Log the note AND apply the capacity % it implies in one save
          // action — applyHolidayNoteAndCap freezes baseCapacity and marks
          // the note applied:true, so no separate "click to apply" chip is
          // needed any more (see its comment for the full flow).
          await applyHolidayNoteAndCap(r, idx, next);
        } else {
          const updated = await apiPatch(`/resources/${r.id}`, { field: "capNote", idx, note: next });
          Object.assign(getResource(r.id), updated);
        }
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
      else if (field === "status") p.status = el.value;
      else if (field === "priority") p.priority = el.value;
      else if (field === "billable") p.billable = el.value === "true";
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

    const projSheet = [["#", "Name", "Group", "Status", "Priority", "Start", "End", "Budget Days", "Notes", ...STATE.roles]];
    STATE.projects.forEach((p, i) => projSheet.push([
      i + 1, p.name, p.group, p.status, p.priority, p.start || "", p.end || "",
      networkDays(p.start, p.end), p.notes, ...STATE.roles.map((r) => p.roles[r] || ""),
    ]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(projSheet), "Projects");

    const allocSheet = [["Resource", "Role", "Project", ...monthLabels, "Avg%"]];
    STATE.allocations.forEach((a) => {
      const res = getResource(a.resourceId), proj = getProject(a.projectId);
      const avg = round(a.months.reduce((s, v) => s + num(v, 0), 0) / 12, 0);
      allocSheet.push([res ? res.name : "", res ? res.role : "", proj ? proj.name : "", ...a.months, avg]);
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
        await reconcilePendingHolidayCaps();
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
