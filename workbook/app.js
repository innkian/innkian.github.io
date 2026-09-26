/* Workbook — ticket tracker stored in a GitHub repo.
   Data layout (under settings.dataPath, default "workbook/data"):
     index.json                      summary of every ticket (drives the list)
     tickets/WB-0001.json            full ticket: fields, comments, attachments, work log, history
     att/WB-0001/<stamp>-<name>      pictures and files
   Every save is one atomic commit made through the GitHub Git Data API. */
(function () {
  "use strict";
  const { TYPES, riskRank } = window.WB_SCHEMA;

  /* ---------------- utilities ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const nowISO = () => new Date().toISOString();
  const localInputNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const todayInput = () => localInputNow().slice(0, 10);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  function fmtDate(v, withTime = true) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d)) return esc(v);
    const opts = { day: "2-digit", month: "short", year: "2-digit" };
    if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
    return d.toLocaleString("en-AU", opts);
  }
  function relTime(v) {
    const d = new Date(v); if (isNaN(d)) return "";
    const s = (Date.now() - d) / 1000, a = Math.abs(s), fut = s < 0;
    const u = a < 60 ? [Math.round(a), "s"] : a < 3600 ? [Math.round(a / 60), "m"] : a < 86400 ? [Math.round(a / 3600), "h"] : [Math.round(a / 86400), "d"];
    if (a < 45) return "just now";
    return fut ? `in ${u[0]}${u[1]}` : `${u[0]}${u[1]} ago`;
  }
  function fmtSize(b) { return b < 1024 ? b + " B" : b < 1048576 ? Math.round(b / 1024) + " kB" : (b / 1048576).toFixed(1) + " MB"; }
  function richText(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, "<br>");
  }
  function initials(n) { return (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(""); }

  // Durations, Jira style: 1w = 5d, 1d = 8h
  const UNIT = { w: 2400, d: 480, h: 60, m: 1 };
  function parseDur(s) {
    if (!s) return 0;
    s = String(s).trim().toLowerCase();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 60); // bare number = hours
    let tot = 0, ok = false;
    s.replace(/(\d+(?:\.\d+)?)\s*([wdhm])/g, (_, n, u) => { tot += parseFloat(n) * UNIT[u]; ok = true; });
    return ok ? Math.round(tot) : NaN;
  }
  function fmtDur(min) {
    if (!min) return "0m";
    const neg = min < 0; min = Math.abs(min);
    const out = [];
    for (const [u, v] of Object.entries(UNIT)) { const n = Math.floor(min / v); if (n) { out.push(n + u); min -= n * v; } }
    return (neg ? "−" : "") + out.join(" ");
  }

  function toast(msg, kind = "") {
    const t = $("#toast"); t.textContent = msg; t.className = "toast show " + kind;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = "toast"), kind === "err" ? 6000 : 3000);
  }

  /* ---------------- settings ---------------- */
  const DEFAULTS = { owner: "innkian", repo: "innkian.github.io", branch: "main", dataPath: "workbook/data", token: "", name: "" };
  let S = Object.assign({}, DEFAULTS, store.get("wb.settings", {}));
  const saveSettings = () => store.set("wb.settings", S);
  const canWrite = () => !!S.token;
  const dp = (p) => `${S.dataPath.replace(/\/+$/, "")}/${p}`;

  /* ---------------- GitHub layer ---------------- */
  class GhError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
  async function gh(path, opts = {}) {
    const headers = Object.assign({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, opts.headers || {});
    if (S.token) headers.Authorization = "Bearer " + S.token;
    if (opts.body && typeof opts.body !== "string") { opts.body = JSON.stringify(opts.body); headers["Content-Type"] = "application/json"; }
    const res = await fetch(`https://api.github.com/repos/${S.owner}/${S.repo}${path}`, Object.assign({}, opts, { headers, cache: "no-store" }));
    if (!res.ok) {
      let m = res.statusText; try { m = (await res.json()).message || m; } catch {}
      if (res.status === 401) m = "GitHub rejected the token (401). Check it in Settings.";
      if (res.status === 403 && /rate limit/i.test(m)) m = "GitHub rate limit reached. Add a token in Settings or wait a bit.";
      throw new GhError(m, res.status);
    }
    if (opts.raw) return res.text();
    return res.status === 204 ? null : res.json();
  }
  // Read a JSON file at a ref. Returns null if missing.
  async function readJSON(path, ref) {
    try {
      if (S.token) {
        const txt = await gh(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref || S.branch)}`, { headers: { Accept: "application/vnd.github.raw+json" }, raw: true });
        return JSON.parse(txt);
      }
      // No token: read the published site (same origin on GitHub Pages) or raw GitHub.
      const rel = path.startsWith(S.dataPath) ? "data" + path.slice(S.dataPath.length) : null;
      const url = location.hostname.endsWith("github.io") && rel ? rel + "?t=" + Date.now() : rawUrl(path) + "?t=" + Date.now();
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 404) return null;
      if (!r.ok) throw new GhError(r.statusText, r.status);
      return r.json();
    } catch (e) { if (e.status === 404) return null; throw e; }
  }
  const rawUrl = (path) => `https://raw.githubusercontent.com/${S.owner}/${S.repo}/${S.branch}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const localBlobs = new Map(); // path -> object URL, for files uploaded this session
  const fileUrl = (path) => localBlobs.get(path) || rawUrl(path);

  let busy = 0;
  function setBusy(d) { busy += d; document.body.classList.toggle("busy", busy > 0); }

  /* commitWith(build, message): build(readAt) returns {files:[{path, text|b64}], deletes:[path]}.
     Retries if the branch moved underneath (another device saved meanwhile). */
  async function commitWith(build, message) {
    if (!canWrite()) throw new GhError("Add a GitHub token in Settings to save.", 0);
    setBusy(1);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const ref = await gh(`/git/ref/heads/${encodeURIComponent(S.branch)}`);
        const head = ref.object.sha;
        const commit = await gh(`/git/commits/${head}`);
        const readAt = (p) => readJSON(p, head);
        const { files = [], deletes = [], result } = await build(readAt);
        const tree = [];
        for (const f of files) {
          const blob = await gh(`/git/blobs`, { method: "POST", body: f.b64 != null ? { content: f.b64, encoding: "base64" } : { content: f.text, encoding: "utf-8" } });
          tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
        }
        for (const p of deletes) tree.push({ path: p, mode: "100644", type: "blob", sha: null });
        const newTree = await gh(`/git/trees`, { method: "POST", body: { base_tree: commit.tree.sha, tree } });
        const newCommit = await gh(`/git/commits`, { method: "POST", body: { message, tree: newTree.sha, parents: [head] } });
        try {
          await gh(`/git/refs/heads/${encodeURIComponent(S.branch)}`, { method: "PATCH", body: { sha: newCommit.sha, force: false } });
          return result;
        } catch (e) {
          if (e.status === 422 && attempt < 2) continue; // not a fast-forward: rebuild on the new head
          throw e;
        }
      }
    } finally { setBusy(-1); }
  }

  /* ---------------- data model ---------------- */
  let INDEX = null; // { version, nextNum, tickets: [...] }
  const cache = new Map(); // id -> ticket

  const emptyIndex = () => ({ version: 1, nextNum: 1, tickets: [] });
  async function loadIndex(force) {
    if (INDEX && !force) return INDEX;
    INDEX = (await readJSON(dp("index.json"))) || emptyIndex();
    return INDEX;
  }
  async function loadTicket(id, force) {
    if (cache.has(id) && !force) return cache.get(id);
    const t = await readJSON(dp(`tickets/${id}.json`));
    if (t) cache.set(id, t);
    return t;
  }
  const pretty = (o) => JSON.stringify(o, null, 2) + "\n";

  function effStatus(t) {
    const f = t.fields || t;
    if (t.type === "bridge" && ["Requested", "Approved", "Applied"].includes(t.status) && f.expiryAt && new Date(f.expiryAt) < new Date()) return "Expired";
    return t.status;
  }
  const statusCat = (type, st) => (TYPES[type].workflow.states[st] || {}).cat || "todo";
  function summary(t) {
    const f = t.fields;
    return {
      id: t.id, type: t.type, title: t.title, status: t.status,
      equipment: f.equipment || "", component: f.component || "", department: f.department || "",
      assignee: f.assignee || "", reporter: f.reporter || "", priority: f.priority || "",
      owner: f.actionOwner || "", site: f.site || "",
      expiryAt: f.expiryAt || "", created: t.created, updated: t.updated,
      comments: (t.comments || []).length, files: (t.attachments || []).length,
    };
  }
  function upsertIndex(idx, t) {
    const s = summary(t);
    const i = idx.tickets.findIndex((x) => x.id === t.id);
    if (i >= 0) idx.tickets[i] = s; else idx.tickets.push(s);
    return idx;
  }
  function rememberPeople(fields) {
    const ppl = new Set(store.get("wb.people", []));
    for (const [k, v] of Object.entries(fields)) if (v && isPersonField(k)) ppl.add(String(v).trim());
    store.set("wb.people", Array.from(ppl).sort().slice(0, 300));
  }
  const PERSON_KEYS = new Set();
  Object.values(TYPES).forEach((T) => T.sections.forEach((s) => s.fields.forEach((f) => f.type === "person" && PERSON_KEYS.add(f.k))));
  const isPersonField = (k) => PERSON_KEYS.has(k);

  // Pending uploads: {name, type, size, b64, url}
  async function prepFile(file) {
    let blob = file, name = file.name || "pasted.png";
    const img = /^image\/(png|jpe?g|webp|bmp)$/i.test(file.type);
    if (img && file.size > 350 * 1024) {
      try {
        const bmp = await createImageBitmap(file);
        const max = 2000, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
        const c = document.createElement("canvas"); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        const out = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
        if (out && out.size < file.size) { blob = out; name = name.replace(/\.[^.]+$/, "") + ".jpg"; }
      } catch {}
    }
    if (blob.size > 20 * 1024 * 1024) throw new Error(`${name} is over 20 MB`);
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
    return { name, type: blob.type || file.type, size: blob.size, b64, url: URL.createObjectURL(blob) };
  }
  function attPath(id, name) {
    const safe = name.replace(/[^\w.\-]+/g, "_").slice(-60);
    return dp(`att/${id}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}-${safe}`);
  }
  // Turns pending uploads into commit files + attachment records.
  function stageUploads(id, pend, who) {
    const files = [], recs = [];
    for (const p of pend) {
      const path = attPath(id, p.name);
      files.push({ path, b64: p.b64 });
      recs.push({ path, name: p.name, type: p.type, size: p.size, at: nowISO(), by: who });
      localBlobs.set(path, p.url);
    }
    return { files, recs };
  }
  const isImg = (a) => /^image\//.test(a.type || "") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || a.path || "");

  /* mutate an existing ticket on the freshest head, keeping other devices' changes */
  async function mutateTicket(id, fn, message) {
    const t = await commitWith(async (readAt) => {
      const cur = await readAt(dp(`tickets/${id}.json`));
      if (!cur) throw new Error(`${id} not found in the repo`);
      const idx = (await readAt(dp("index.json"))) || emptyIndex();
      const extra = (await fn(cur)) || {};
      cur.updated = nowISO();
      upsertIndex(idx, cur);
      return {
        files: [...(extra.files || []), { path: dp(`tickets/${id}.json`), text: pretty(cur) }, { path: dp("index.json"), text: pretty(idx) }],
        deletes: extra.deletes || [],
        result: { t: cur, idx },
      };
    }, message);
    cache.set(id, t.t); INDEX = t.idx;
    return t.t;
  }

  /* ---------------- router ---------------- */
  const app = $("#app");
  let leaveGuard = null;
  window.addEventListener("hashchange", () => route());
  async function route() {
    if (leaveGuard) { leaveGuard(); leaveGuard = null; }
    const [path, qs] = (location.hash.slice(1) || "/").split("?");
    const q = new URLSearchParams(qs || "");
    const parts = path.split("/").filter(Boolean);
    $$(".topnav [data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === (parts[0] === "settings" ? "settings" : !parts[0] ? "list" : "")));
    closeMenu();
    showBanner();
    window.scrollTo(0, 0);
    try {
      if (!parts.length) await viewList();
      else if (parts[0] === "new" && TYPES[parts[1]]) await viewForm({ type: parts[1] });
      else if (parts[0] === "t") await viewTicket(parts[1]);
      else if (parts[0] === "edit") await viewForm({ id: parts[1], to: q.get("to") });
      else if (parts[0] === "settings") viewSettings();
      else location.hash = "#/";
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="empty"><h2>Couldn't load that</h2><p>${esc(e.message)}</p><p><a class="btn" href="#/settings">Check settings</a> <button class="btn" onclick="location.reload()">Retry</button></p></div>`;
    }
  }
  function showBanner() {
    const b = $("#banner");
    if (!S.token) {
      b.innerHTML = `Read-only. <a href="#/settings">Add a GitHub token</a> to create and edit tickets.`;
      b.hidden = false;
    } else b.hidden = true;
  }

  /* new menu */
  const newBtn = $("#newBtn"), newMenu = $("#newMenu");
  function closeMenu() { newMenu.hidden = true; newBtn.setAttribute("aria-expanded", "false"); }
  newBtn.addEventListener("click", (e) => { e.stopPropagation(); newMenu.hidden = !newMenu.hidden; newBtn.setAttribute("aria-expanded", String(!newMenu.hidden)); });
  document.addEventListener("click", (e) => { if (!newMenu.contains(e.target)) closeMenu(); });

  /* lightbox */
  const lb = $("#lightbox");
  function openLightbox(src) { $("img", lb).src = src; lb.hidden = false; }
  lb.addEventListener("click", () => (lb.hidden = true));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") lb.hidden = true; });
  app.addEventListener("click", (e) => { const im = e.target.closest("img[data-full]"); if (im) openLightbox(im.dataset.full); });

  const typeChip = (type) => `<span class="tchip t-${type}">${esc(TYPES[type].short)}</span>`;
  const statusChip = (type, st) => `<span class="schip s-${statusCat(type, st)}">${esc(st)}</span>`;

  /* ---------------- list view ---------------- */
  const LF = Object.assign({ q: "", type: "all", status: "open", sort: "updated" }, store.get("wb.listFilter", {}));
  async function viewList() {
    app.innerHTML = `<div class="loading">Loading tickets…</div>`;
    await loadIndex(true);
    const all = INDEX.tickets.map((t) => Object.assign({}, t, { eff: effStatus(t) }));
    const counts = { all: all.length }; for (const k in TYPES) counts[k] = all.filter((t) => t.type === k).length;
    const statuses = Array.from(new Set(Object.values(TYPES).flatMap((T) => Object.keys(T.workflow.states))));
    const alerts = all.filter((t) => t.type === "bridge" && (t.eff === "Expired" || (t.eff === "Applied" && t.expiryAt && new Date(t.expiryAt) - Date.now() < 12 * 3600e3)));
    app.innerHTML = `
      <div class="pagehead">
        <div><p class="kicker">Workbook</p><h1>Tickets</h1></div>
        <div class="newquick">
          ${Object.entries(TYPES).map(([k, T]) => `<a class="btn quick" href="#/new/${k}"><span class="tdot t-${k}"></span>${esc(T.label)}</a>`).join("")}
        </div>
      </div>
      ${alerts.length ? `<div class="alertbox"><strong>Bridge/bypass attention:</strong> ${alerts.map((t) => `<a href="#/t/${t.id}">${t.id}</a> ${esc(t.equipment)} — ${t.eff === "Expired" ? "expired " + relTime(t.expiryAt) : "expires " + relTime(t.expiryAt)}`).join(" · ")}</div>` : ""}
      <div class="toolbar">
        <input type="search" id="lq" placeholder="Search ID, title, equipment, people…" value="${esc(LF.q)}" aria-label="Search">
        <div class="seg" role="group" aria-label="Type">
          ${["all", ...Object.keys(TYPES)].map((k) => `<button type="button" data-type="${k}" class="${LF.type === k ? "on" : ""}">${k === "all" ? "All" : esc(TYPES[k].short)} <span class="n">${counts[k]}</span></button>`).join("")}
        </div>
        <select id="lstatus" aria-label="Status">
          <option value="open">Open (not done)</option><option value="all">All statuses</option>
          ${statuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
        </select>
        <select id="lsort" aria-label="Sort">
          <option value="updated">Recently updated</option><option value="created">Newest</option><option value="id">ID</option>
        </select>
      </div>
      <div id="rows"></div>`;
    $("#lstatus").value = LF.status; $("#lsort").value = LF.sort;
    const draw = () => {
      store.set("wb.listFilter", LF);
      const q = LF.q.trim().toLowerCase();
      let rows = all.filter((t) => (LF.type === "all" || t.type === LF.type)
        && (LF.status === "all" || (LF.status === "open" ? !["done", "bad"].includes(statusCat(t.type, t.eff)) : t.eff === LF.status))
        && (!q || [t.id, t.title, t.equipment, t.component, t.department, t.assignee, t.reporter, t.owner, t.site, t.priority, t.eff].join(" ").toLowerCase().includes(q)));
      rows.sort((a, b) => LF.sort === "id" ? b.id.localeCompare(a.id) : String(b[LF.sort]).localeCompare(String(a[LF.sort])));
      $("#rows").innerHTML = rows.length ? `
        <div class="tbl">
          <div class="tr th"><span>Key</span><span>Summary</span><span>Equipment</span><span>Status</span><span>Assignee</span><span>Updated</span></div>
          ${rows.map((t) => `
          <a class="tr" href="#/t/${t.id}">
            <span class="c-key mono"><span class="tdot t-${t.type}" title="${esc(TYPES[t.type].label)}"></span>${t.id}</span>
            <span class="c-title">${esc(t.title)}<small>${esc(TYPES[t.type].short)}${t.component ? " · " + esc(t.component) : ""}${t.comments ? ` · ${t.comments} 💬` : ""}${t.files ? ` · ${t.files} 📎` : ""}</small></span>
            <span class="c-eq mono">${esc(t.equipment)}</span>
            <span class="c-st">${statusChip(t.type, t.eff)}</span>
            <span class="c-as">${esc(t.assignee)}</span>
            <span class="c-up" title="${fmtDate(t.updated)}">${relTime(t.updated)}</span>
          </a>`).join("")}
        </div>` : `<div class="empty">${INDEX.tickets.length ? "No tickets match these filters." : `<h2>No tickets yet</h2><p>Raise a change request, a bridge/bypass or a service request to get started.</p>`}</div>`;
    };
    $("#lq").addEventListener("input", (e) => { LF.q = e.target.value; draw(); });
    $$(".seg button").forEach((b) => b.addEventListener("click", () => { LF.type = b.dataset.type; $$(".seg button").forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
    $("#lstatus").addEventListener("change", (e) => { LF.status = e.target.value; draw(); });
    $("#lsort").addEventListener("change", (e) => { LF.sort = e.target.value; draw(); });
    draw();
  }

  /* ---------------- form view (new + edit) ---------------- */
  function fieldHTML(f, val, fields) {
    const id = "f_" + f.k;
    const reqMark = f.req ? `<span class="req" title="Required">*</span>` : f.reqAt ? `<span class="req soft" title="Required when ${f.reqAt.join("/")}">*</span>` : "";
    const hidden = f.showIf && fields[f.showIf.k] !== f.showIf.v;
    let input = "";
    const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : "";
    switch (f.type) {
      case "textarea": input = `<textarea id="${id}" name="${f.k}" rows="${f.rows || 3}"${ph}>${esc(val)}</textarea>`; break;
      case "select": input = `<select id="${id}" name="${f.k}"><option value="">Select…</option>${f.opts.map((o) => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`; break;
      case "yesno": input = `<div class="yn" role="radiogroup" id="${id}">${["Yes", "No"].map((o) => `<label><input type="radio" name="${f.k}" value="${o}"${val === o ? " checked" : ""}><span>${o}</span></label>`).join("")}</div>`; break;
      case "date": input = `<input type="date" id="${id}" name="${f.k}" value="${esc(val)}">`; break;
      case "datetime": input = `<div class="dt"><input type="datetime-local" id="${id}" name="${f.k}" value="${esc(val)}"><button type="button" class="btn btn-sm" data-now="${f.k}">Now</button></div>`; break;
      case "url": input = `<input type="url" id="${id}" name="${f.k}" value="${esc(val)}"${ph}>`; break;
      case "risk": input = `<div class="riskout" data-risk></div>`; break;
      case "person": input = `<input type="text" id="${id}" name="${f.k}" value="${esc(val)}" list="dl_people" autocomplete="off"${ph}>`; break;
      case "duration": input = `<input type="text" id="${id}" name="${f.k}" value="${esc(val)}"${ph}><small class="durhint"></small>`; break;
      default: input = `<input type="text" id="${id}" name="${f.k}" value="${esc(val)}"${f.list ? ` list="dl_${f.k}"` : ""}${ph}>` + (f.list ? `<datalist id="dl_${f.k}">${f.list.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>` : "");
    }
    return `<div class="field${f.wide || f.type === "textarea" ? " wide" : ""}${f.type === "yesno" ? " fyn" : ""}" data-k="${f.k}"${f.showIf ? ` data-showif="${f.showIf.k}=${esc(f.showIf.v)}"` : ""}${hidden ? " hidden" : ""}>
      <label for="${id}">${esc(f.label)}${reqMark}</label>${f.help ? `<small class="help">${esc(f.help)}</small>` : ""}${input}</div>`;
  }
  function readForm(form, T) {
    const out = {};
    T.sections.forEach((s) => s.fields.forEach((f) => {
      if (f.type === "risk") return;
      if (f.type === "yesno") { const c = form.querySelector(`input[name="${f.k}"]:checked`); out[f.k] = c ? c.value : ""; }
      else { const el = form.elements[f.k]; out[f.k] = el ? el.value.trim() : ""; }
    }));
    return out;
  }
  function missingFields(T, fields, status) {
    const miss = [];
    T.sections.forEach((s) => s.fields.forEach((f) => {
      if (f.type === "risk") return;
      if (f.showIf && fields[f.showIf.k] !== f.showIf.v) return;
      const need = f.req || (f.reqAt && f.reqAt.includes(status));
      if (need && !String(fields[f.k] || "").trim()) miss.push(f);
    }));
    const gates = (T.workflow.gates || {})[status] || [];
    gates.forEach((k) => { if (!fields[k]) { const f = allFields(T).find((x) => x.k === k); if (f && !miss.includes(f)) miss.push(f); } });
    return miss;
  }
  const allFields = (T) => T.sections.flatMap((s) => s.fields);

  function renderRisk(scope, fields, T) {
    const box = $("[data-risk]", scope); if (!box) return;
    const r = riskRank(fields.likelihood, fields.severity);
    box.innerHTML = r ? `<span class="rk rk-${r.band.toLowerCase()}">${r.score}</span> ${r.band}` : `<span class="muted">Pick likelihood and severity</span>`;
  }

  function uploader(onChange) {
    // returns {el, list}
    const list = [];
    const el = document.createElement("div");
    el.className = "uploader";
    el.innerHTML = `<div class="thumbs"></div>
      <label class="btn btn-sm upbtn"><input type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.l5x,.acd,.zip" hidden> 📷 Add pictures / files</label>
      <small class="muted">or paste a screenshot / drop files here</small>`;
    const thumbs = $(".thumbs", el);
    const draw = () => {
      thumbs.innerHTML = list.map((p, i) => `<div class="thumb">${/^image\//.test(p.type) ? `<img src="${p.url}" alt="">` : `<span class="fileic">${esc(p.name.split(".").pop().toUpperCase())}</span>`}<small>${esc(p.name)}</small><button type="button" data-rm="${i}" aria-label="Remove">×</button></div>`).join("");
      onChange && onChange(list);
    };
    const add = async (files) => {
      for (const f of files) { try { list.push(await prepFile(f)); } catch (e) { toast(e.message, "err"); } }
      draw();
    };
    $("input", el).addEventListener("change", (e) => { add(Array.from(e.target.files)); e.target.value = ""; });
    thumbs.addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) { list.splice(+b.dataset.rm, 1); draw(); } });
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag"); });
    el.addEventListener("dragleave", () => el.classList.remove("drag"));
    el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("drag"); add(Array.from(e.dataTransfer.files)); });
    const onPaste = (e) => {
      const files = Array.from(e.clipboardData?.files || []).filter((f) => /^image\//.test(f.type));
      if (files.length) { e.preventDefault(); add(files); }
    };
    return { el, list, onPaste, clear() { list.length = 0; draw(); } };
  }

  async function viewForm({ type, id, to }) {
    let t = null;
    if (id) {
      app.innerHTML = `<div class="loading">Loading ${esc(id)}…</div>`;
      t = await loadTicket(id, true);
      if (!t) throw new Error(`${id} not found`);
      type = t.type;
    }
    const T = TYPES[type];
    const draftKey = "wb.draft." + (id || "new." + type);
    const draft = store.get(draftKey, null);
    let fields = {};
    if (t) fields = Object.assign({}, t.fields);
    else allFields(T).forEach((f) => { if (f.def) fields[f.k] = f.def; if (f.me && S.name) fields[f.k] = S.name; });
    let title = t ? t.title : "";
    let status = t ? effStatus(t) : T.workflow.start;
    if (to && T.workflow.states[to]) status = to;
    let restored = false;
    if (draft && (!t || draft.saved > t.updated)) { fields = Object.assign(fields, draft.fields); title = draft.title; restored = true; }

    const stateOpts = t ? [effStatus(t), ...(T.workflow.states[effStatus(t)]?.next || [])] : [T.workflow.start];
    const people = store.get("wb.people", []);
    app.innerHTML = `
      <form id="tform" class="tform t-${type}" novalidate>
        <div class="pagehead">
          <div><p class="kicker">${t ? `<a href="#/t/${t.id}">${t.id}</a> · Edit` : "New"} · ${typeChip(type)}</p>
          <h1>${t ? "Edit " : ""}${esc(T.label)}</h1></div>
        </div>
        ${t && t.imported ? `<div class="note">Imported from ${esc(t.importSource || "a register")}. Only the summary is required when editing; fill in the rest as you go.</div>` : ""}
        ${restored ? `<div class="note">Restored your unsaved changes. <button type="button" class="linkbtn" id="discardDraft">Discard them</button></div>` : ""}
        <datalist id="dl_people">${people.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
        <section class="card">
          <div class="grid">
            <div class="field wide"><label for="f_title">Summary<span class="req">*</span></label>
              <input id="f_title" name="title" type="text" value="${esc(title)}" placeholder="${type === "bridge" ? "e.g. CV-809 BRK001 release timer extension" : type === "service" ? "e.g. CV-809 not ramping on startup" : "e.g. Implement multiple under-speed detection methods for CV-809"}" autocomplete="off"></div>
            ${t ? `<div class="field"><label for="f_status">Status</label><select id="f_status" name="status">${stateOpts.map((s) => `<option${s === status ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></div>` : ""}
          </div>
        </section>
        ${T.sections.map((s) => `
          <section class="card">
            <h2>${esc(s.title)}</h2>${s.note ? `<p class="muted secnote">${esc(s.note)}</p>` : ""}
            <div class="grid">${s.fields.map((f) => fieldHTML(f, fields[f.k] || "", fields)).join("")}</div>
          </section>`).join("")}
        ${!t ? `<section class="card"><h2>Attachments</h2><div id="upSlot"></div></section>` : ""}
        <div class="formbar">
          <span class="muted" id="formMsg">${canWrite() ? "" : "Read-only: add a GitHub token in Settings to save."}</span>
          <a class="btn" href="${t ? "#/t/" + t.id : "#/"}">Cancel</a>
          <button type="submit" class="btn btn-primary" ${canWrite() ? "" : "disabled"}>${t ? "Save changes" : "Create " + esc(T.short)}</button>
        </div>
      </form>`;
    const form = $("#tform");
    let up = null;
    if (!t) { up = uploader(); $("#upSlot").appendChild(up.el); form.addEventListener("paste", up.onPaste); }

    const refresh = () => {
      const cur = readForm(form, T);
      $$("[data-showif]", form).forEach((el) => { const [k, v] = el.dataset.showif.split("="); el.hidden = cur[k] !== v; });
      renderRisk(form, cur, T);
      $$(".durhint", form).forEach((h) => { const v = h.previousElementSibling.value; const m = parseDur(v); h.textContent = v ? (isNaN(m) ? "Use e.g. 2w 3d 4h" : "= " + fmtDur(m)) : ""; });
      return cur;
    };
    refresh();
    let dirty = false;
    form.addEventListener("input", () => {
      dirty = true;
      const cur = refresh();
      store.set(draftKey, { saved: nowISO(), title: form.elements.title.value, fields: cur });
    });
    form.addEventListener("change", () => form.dispatchEvent(new Event("input")));
    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-now]"); if (b) { form.elements[b.dataset.now].value = localInputNow(); form.dispatchEvent(new Event("input")); }
    });
    const dd = $("#discardDraft"); if (dd) dd.addEventListener("click", () => { store.del(draftKey); route(); });
    const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    leaveGuard = () => window.removeEventListener("beforeunload", beforeUnload);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const cur = refresh();
      const newTitle = form.elements.title.value.trim();
      const newStatus = t ? form.elements.status.value : T.workflow.start;
      $$(".field.bad", form).forEach((x) => x.classList.remove("bad"));
      const miss = t && t.imported ? [] : missingFields(T, cur, newStatus);
      if (!newTitle) miss.unshift({ k: "title", label: "Summary" });
      if (cur.estimate && isNaN(parseDur(cur.estimate))) miss.push({ k: "estimate", label: "Original estimate (format)" });
      if (miss.length) {
        miss.forEach((f) => { const el = f.k === "title" ? form.elements.title.closest(".field") : $(`.field[data-k="${f.k}"]`, form); el && el.classList.add("bad"); });
        const first = $(".field.bad", form); first && first.scrollIntoView({ behavior: "smooth", block: "center" });
        toast(`${miss.length} required field${miss.length > 1 ? "s" : ""} missing: ${miss.slice(0, 3).map((f) => f.label).join(", ")}${miss.length > 3 ? "…" : ""}`, "err");
        return;
      }
      const btn = $('button[type="submit"]', form); btn.disabled = true; btn.textContent = "Saving…";
      try {
        const who = S.name || "Unknown";
        let saved;
        if (!t) {
          const pend = up.list.slice();
          const res = await commitWith(async (readAt) => {
            const idx = (await readAt(dp("index.json"))) || emptyIndex();
            const num = Math.max(idx.nextNum || 1, ...idx.tickets.filter((x) => /^WB-\d+$/.test(x.id)).map((x) => +x.id.split("-")[1] + 1));
            const nid = "WB-" + String(num).padStart(4, "0");
            idx.nextNum = num + 1;
            const { files, recs } = stageUploads(nid, pend, who);
            const nt = {
              id: nid, type, title: newTitle, status: T.workflow.start, fields: cur,
              comments: [], attachments: recs, worklog: [],
              history: [{ at: nowISO(), by: who, action: "created", to: T.workflow.start }],
              created: nowISO(), updated: nowISO(), createdBy: who,
            };
            upsertIndex(idx, nt);
            return { files: [...files, { path: dp(`tickets/${nid}.json`), text: pretty(nt) }, { path: dp("index.json"), text: pretty(idx) }], result: { t: nt, idx } };
          }, `${TYPES[type].short}: ${newTitle}`);
          cache.set(res.t.id, res.t); INDEX = res.idx; saved = res.t;
        } else {
          saved = await mutateTicket(t.id, (curT) => {
            const changed = allFields(T).filter((f) => f.type !== "risk" && (curT.fields[f.k] || "") !== (cur[f.k] || "")).map((f) => f.label);
            if (curT.title !== newTitle) changed.unshift("Summary");
            curT.title = newTitle;
            curT.fields = Object.assign({}, curT.fields, cur);
            if (changed.length) curT.history.push({ at: nowISO(), by: who, action: "edited", fields: changed });
            const from = effStatus(curT);
            if (newStatus !== from) applyTransition(curT, T, from, newStatus, who);
          }, `${t.id}: edit`);
        }
        rememberPeople(cur);
        store.del(draftKey); dirty = false;
        toast(t ? "Saved" : `Created ${saved.id}`, "ok");
        location.hash = "#/t/" + saved.id;
      } catch (err) {
        console.error(err); toast(err.message, "err");
        btn.disabled = false; btn.textContent = t ? "Save changes" : "Create " + T.short;
      }
    });
  }

  function applyTransition(tk, T, from, to, who) {
    const stamp = (T.workflow.stamps || {})[to];
    if (stamp && !tk.fields[stamp]) tk.fields[stamp] = localInputNow();
    tk.status = to;
    tk.history.push({ at: nowISO(), by: who, action: "status", from, to });
  }

  /* ---------------- ticket view ---------------- */
  let activityTab = store.get("wb.tab", "comments");
  async function viewTicket(id) {
    app.innerHTML = `<div class="loading">Loading ${esc(id)}…</div>`;
    const t = await loadTicket(id, true);
    if (!t) throw new Error(`${id} not found`);
    const T = TYPES[t.type];
    const st = effStatus(t);
    const next = T.workflow.states[st]?.next || [];
    const f = t.fields;
    const sideTitles = ["People", "Dates", "Time Tracking"];
    const valHTML = (fd) => {
      const v = f[fd.k];
      if (fd.type === "risk") { const r = riskRank(f.likelihood, f.severity); return r ? `<span class="rk rk-${r.band.toLowerCase()}">${r.score}</span> ${r.band}` : `<span class="muted">—</span>`; }
      if (!v) return `<span class="muted">—</span>`;
      if (fd.type === "url") return `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
      if (fd.type === "datetime" || fd.type === "date") return fmtDate(v, fd.type === "datetime");
      if (fd.type === "yesno") return `<span class="yn-v yn-${v.toLowerCase()}">${v}</span>`;
      if (fd.type === "duration") return fmtDur(parseDur(v));
      return richText(v);
    };
    const sec = (s) => {
      const fs = s.fields.filter((fd) => !(fd.showIf && f[fd.showIf.k] !== fd.showIf.v));
      return `<section class="card rd"><h2>${esc(s.title)}</h2>${s.note ? `<p class="muted secnote">${esc(s.note)}</p>` : ""}
        <dl class="${s.fields.every((x) => x.type === "yesno") || s.fields.some((x) => x.type === "yesno") ? "dl-flags" : ""}">${fs.map((fd) => `<div class="${fd.wide || fd.type === "textarea" ? "wide" : ""}"><dt>${esc(fd.label)}</dt><dd>${valHTML(fd)}</dd></div>`).join("")}</dl></section>`;
    };
    const expiry = t.type === "bridge" && f.expiryAt ? (() => {
      const past = new Date(f.expiryAt) < new Date();
      return `<div class="expiry ${past ? "past" : ""}">${past ? "Expired" : "Expires"} ${relTime(f.expiryAt)} <small>${fmtDate(f.expiryAt)}</small></div>`;
    })() : "";

    app.innerHTML = `
      <article class="ticket t-${t.type}">
        <div class="pagehead">
          <div>
            <p class="kicker"><a href="#/">Tickets</a> / <span class="mono">${t.id}</span> · ${typeChip(t.type)}</p>
            <h1>${esc(t.title)}</h1>
          </div>
        </div>
        <div class="actions noprint">
          <a class="btn" href="#/edit/${t.id}">Edit</a>
          <button type="button" class="btn" id="goComment">Add comment</button>
          ${next.map((n) => `<button type="button" class="btn btn-tr s-${statusCat(t.type, n)}" data-to="${esc(n)}">${esc(n)} →</button>`).join("")}
          <span class="spacer"></span>
          <button type="button" class="btn" id="printBtn">Print / PDF</button>
          <span class="curstatus">${statusChip(t.type, st)}</span>
        </div>
        <div class="tgrid">
          <div class="tmain">
            ${T.sections.filter((s) => !sideTitles.includes(s.title)).map(sec).join("")}
            <section class="card" id="attCard"><h2>Attachments <span class="n">${(t.attachments || []).length}</span></h2>
              <div class="attgrid">${(t.attachments || []).map((a, i) => `
                <figure class="att">${isImg(a) ? `<img src="${esc(fileUrl(a.path))}" alt="${esc(a.name)}" loading="lazy" data-full="${esc(fileUrl(a.path))}">` : `<a class="fileic big" href="${esc(fileUrl(a.path))}" target="_blank" rel="noopener">${esc(a.name.split(".").pop().toUpperCase())}</a>`}
                  <figcaption><a href="${esc(fileUrl(a.path))}" target="_blank" rel="noopener">${esc(a.name)}</a><small>${fmtSize(a.size || 0)} · ${fmtDate(a.at)}</small></figcaption>
                  <button type="button" class="rm noprint" data-rmatt="${i}" title="Delete attachment" aria-label="Delete attachment">×</button></figure>`).join("") || `<p class="muted">No attachments.</p>`}</div>
              <div id="attUp" class="noprint"></div>
            </section>
            ${T.worklog ? worklogHTML(t) : ""}
            <section class="card activity">
              <h2>Activity</h2>
              <div class="tabs noprint" role="tablist">
                ${["comments", ...(T.worklog ? ["worklog"] : []), "history"].map((k) => `<button type="button" role="tab" data-tab="${k}" class="${activityTab === k ? "on" : ""}">${k === "comments" ? "Comments" : k === "worklog" ? "Work log" : "History"}</button>`).join("")}
              </div>
              <div id="tabBody"></div>
            </section>
          </div>
          <aside class="tside">
            <section class="card rd"><h2>Status</h2><div class="stbig">${statusChip(t.type, st)}</div>${expiry}</section>
            ${T.sections.filter((s) => sideTitles.includes(s.title)).map(sec).join("")}
            <section class="card rd"><h2>Record</h2><dl>
              <div><dt>Created</dt><dd>${fmtDate(t.created)} <small class="muted">${esc(t.createdBy || "")}</small></dd></div>
              <div><dt>Updated</dt><dd>${fmtDate(t.updated)}</dd></div></dl></section>
          </aside>
        </div>
      </article>`;

    // transitions
    $$("[data-to]").forEach((b) => b.addEventListener("click", async () => {
      const to = b.dataset.to;
      if (!canWrite()) return toast("Add a GitHub token in Settings to change status.", "err");
      const miss = t.imported ? [] : missingFields(T, f, to);
      if (miss.length) { toast(`Fill ${miss.map((x) => x.label).join(", ")} to move to ${to}`, "err"); location.hash = `#/edit/${t.id}?to=${encodeURIComponent(to)}`; return; }
      if (["Cancelled", "Removed"].includes(to) && !confirm(`Move ${t.id} to ${to}?`)) return;
      b.disabled = true;
      try {
        await mutateTicket(t.id, (cur) => applyTransition(cur, T, effStatus(cur), to, S.name || "Unknown"), `${t.id}: ${st} → ${to}`);
        toast(`${t.id} → ${to}`, "ok"); viewTicket(t.id);
      } catch (e) { toast(e.message, "err"); b.disabled = false; }
    }));
    $("#printBtn").addEventListener("click", () => { activityTab = "comments"; drawTab(); window.print(); });
    $("#goComment").addEventListener("click", () => { activityTab = "comments"; drawTab(); $("#cText")?.focus(); $("#cText")?.scrollIntoView({ block: "center", behavior: "smooth" }); });

    // attachments
    if (canWrite()) {
      const up = uploader((list) => { $("#attSave").hidden = !list.length; });
      const slot = $("#attUp"); slot.appendChild(up.el);
      const save = document.createElement("button"); save.type = "button"; save.className = "btn btn-primary btn-sm"; save.id = "attSave"; save.textContent = "Upload"; save.hidden = true;
      slot.appendChild(save);
      save.addEventListener("click", async () => {
        save.disabled = true; save.textContent = "Uploading…";
        try {
          const pend = up.list.slice();
          await mutateTicket(t.id, (cur) => {
            const { files, recs } = stageUploads(t.id, pend, S.name || "Unknown");
            cur.attachments = [...(cur.attachments || []), ...recs];
            cur.history.push({ at: nowISO(), by: S.name || "Unknown", action: "attached", fields: recs.map((r) => r.name) });
            return { files };
          }, `${t.id}: attach ${pend.length} file(s)`);
          toast("Uploaded", "ok"); viewTicket(t.id);
        } catch (e) { toast(e.message, "err"); save.disabled = false; save.textContent = "Upload"; }
      });
    }
    $$("[data-rmatt]").forEach((b) => b.addEventListener("click", async () => {
      const a = t.attachments[+b.dataset.rmatt];
      if (!canWrite() || !confirm(`Delete ${a.name}? It is removed from the ticket and the repo's current files (git history keeps it).`)) return;
      try {
        await mutateTicket(t.id, (cur) => {
          cur.attachments = cur.attachments.filter((x) => x.path !== a.path);
          cur.history.push({ at: nowISO(), by: S.name || "Unknown", action: "removed attachment", fields: [a.name] });
          return { deletes: [a.path] };
        }, `${t.id}: remove ${a.name}`);
        viewTicket(t.id);
      } catch (e) { toast(e.message, "err"); }
    }));

    // worklog form
    const wf = $("#wlForm");
    if (wf) wf.addEventListener("submit", async (e) => {
      e.preventDefault();
      const spent = parseDur(wf.elements.spent.value);
      if (!spent || isNaN(spent)) return toast("Time spent like 1h 30m or 2d", "err");
      try {
        await mutateTicket(t.id, (cur) => {
          cur.worklog = cur.worklog || [];
          cur.worklog.push({ id: uid(), at: nowISO(), date: wf.elements.date.value || todayInput(), spent, note: wf.elements.note.value.trim(), by: S.name || "Unknown" });
        }, `${t.id}: log ${fmtDur(spent)}`);
        activityTab = "worklog"; toast("Work logged", "ok"); viewTicket(t.id);
      } catch (e2) { toast(e2.message, "err"); }
    });

    // activity tabs
    function drawTab() {
      store.set("wb.tab", activityTab);
      $$("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === activityTab));
      const body = $("#tabBody");
      if (activityTab === "history") {
        body.innerHTML = `<ol class="hist">${t.history.slice().reverse().map((h) => `<li><strong>${esc(h.by)}</strong> ${h.action === "status" ? `changed status ${statusChip(t.type, h.from)} → ${statusChip(t.type, h.to)}` : h.action === "created" ? "created the ticket" : `${esc(h.action)}${h.fields ? ": " + esc(h.fields.join(", ")) : ""}`}<small>${fmtDate(h.at)}</small></li>`).join("")}</ol>`;
      } else if (activityTab === "worklog") {
        const wl = (t.worklog || []).slice().sort((a, b) => b.date.localeCompare(a.date));
        body.innerHTML = wl.length ? `<ul class="wl">${wl.map((w) => `<li><span class="mono">${fmtDur(w.spent)}</span> <strong>${esc(w.by)}</strong> <small>${fmtDate(w.date, false)}</small>${w.note ? `<p>${richText(w.note)}</p>` : ""}<button type="button" class="linkbtn noprint" data-rmwl="${w.id}">Delete</button></li>`).join("")}</ul>` : `<p class="muted">No work logged yet. Use the form in Time Tracking above.</p>`;
        $$("[data-rmwl]", body).forEach((b) => b.addEventListener("click", async () => {
          if (!confirm("Delete this work log entry?")) return;
          try { await mutateTicket(t.id, (cur) => { cur.worklog = cur.worklog.filter((x) => x.id !== b.dataset.rmwl); }, `${t.id}: remove work log`); viewTicket(t.id); } catch (e) { toast(e.message, "err"); }
        }));
      } else {
        const cs = (t.comments || []).slice().reverse();
        body.innerHTML = `
          ${canWrite() ? `<form id="cForm" class="composer noprint">
            <div class="av">${esc(initials(S.name))}</div>
            <div class="cbox"><textarea id="cText" rows="3" placeholder="Add a comment… (paste screenshots straight in)"></textarea><div id="cUp"></div>
            <div class="crow"><button type="submit" class="btn btn-primary btn-sm">Comment</button></div></div></form>` : ""}
          <ul class="comments">${cs.map((c) => `
            <li class="cmt" data-cid="${c.id}"><div class="av">${esc(initials(c.author))}</div>
              <div class="cbody"><div class="chead"><strong>${esc(c.author)}</strong> <small title="${fmtDate(c.at)}">${fmtDate(c.at)}${c.edited ? " · edited" : ""}</small>
                ${canWrite() ? `<span class="cact noprint"><button type="button" class="linkbtn" data-edit="${c.id}">Edit</button><button type="button" class="linkbtn" data-del="${c.id}">Delete</button></span>` : ""}</div>
                <div class="ctext">${richText(c.text)}</div>
                ${(c.images || []).length ? `<div class="cimgs">${c.images.map((a) => isImg(a) ? `<img src="${esc(fileUrl(a.path))}" data-full="${esc(fileUrl(a.path))}" alt="${esc(a.name)}" loading="lazy">` : `<a class="fileic" href="${esc(fileUrl(a.path))}" target="_blank" rel="noopener" title="${esc(a.name)}">${esc(a.name.split(".").pop().toUpperCase())}</a>`).join("")}</div>` : ""}
              </div></li>`).join("") || `<li class="muted nocmt">No comments yet.</li>`}</ul>`;
        const cf = $("#cForm");
        if (cf) {
          const up = uploader(); $("#cUp").appendChild(up.el);
          $("#cText").addEventListener("paste", up.onPaste);
          cf.addEventListener("submit", async (e) => {
            e.preventDefault();
            const text = $("#cText").value.trim();
            if (!text && !up.list.length) return;
            const bt = $('button[type="submit"]', cf); bt.disabled = true; bt.textContent = "Posting…";
            try {
              const pend = up.list.slice();
              await mutateTicket(t.id, (cur) => {
                const { files, recs } = stageUploads(t.id, pend, S.name || "Unknown");
                cur.comments = cur.comments || [];
                cur.comments.push({ id: uid(), author: S.name || "Unknown", at: nowISO(), text, images: recs });
                return { files };
              }, `${t.id}: comment`);
              toast("Comment added", "ok"); viewTicket(t.id);
            } catch (e2) { toast(e2.message, "err"); bt.disabled = false; bt.textContent = "Comment"; }
          });
        }
        $$("[data-del]", body).forEach((b) => b.addEventListener("click", async () => {
          if (!confirm("Delete this comment and its pictures?")) return;
          const c = t.comments.find((x) => x.id === b.dataset.del);
          try {
            await mutateTicket(t.id, (cur) => { cur.comments = cur.comments.filter((x) => x.id !== c.id); return { deletes: (c.images || []).map((i) => i.path) }; }, `${t.id}: delete comment`);
            viewTicket(t.id);
          } catch (e) { toast(e.message, "err"); }
        }));
        $$("[data-edit]", body).forEach((b) => b.addEventListener("click", () => {
          const li = b.closest(".cmt"); const c = t.comments.find((x) => x.id === b.dataset.edit);
          const box = $(".ctext", li);
          box.innerHTML = `<textarea rows="3">${esc(c.text)}</textarea><div class="crow"><button type="button" class="btn btn-sm" data-x>Cancel</button><button type="button" class="btn btn-primary btn-sm" data-s>Save</button></div>`;
          $("[data-x]", box).onclick = () => drawTab();
          $("[data-s]", box).onclick = async () => {
            const nt = $("textarea", box).value.trim();
            try { await mutateTicket(t.id, (cur) => { const x = cur.comments.find((y) => y.id === c.id); if (x) { x.text = nt; x.edited = nowISO(); } }, `${t.id}: edit comment`); viewTicket(t.id); } catch (e) { toast(e.message, "err"); }
          };
        }));
      }
    }
    $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { activityTab = b.dataset.tab; drawTab(); }));
    if (!T.worklog && activityTab === "worklog") activityTab = "comments";
    drawTab();
  }

  function worklogHTML(t) {
    const est = parseDur(t.fields.estimate) || 0;
    const logged = (t.worklog || []).reduce((a, w) => a + (w.spent || 0), 0);
    const remain = Math.max(0, est - logged);
    const max = Math.max(est, logged, 1);
    return `<section class="card" id="wlCard"><h2>Time Tracking</h2>
      <div class="tt">
        <div class="ttrow"><span>Estimated</span><div class="bar"><i class="b-est" style="width:${(est / max) * 100}%"></i></div><b class="mono">${est ? fmtDur(est) : "Not specified"}</b></div>
        <div class="ttrow"><span>Remaining</span><div class="bar"><i class="b-rem" style="width:${(remain / max) * 100}%"></i></div><b class="mono">${est ? fmtDur(remain) : "—"}</b></div>
        <div class="ttrow"><span>Logged</span><div class="bar"><i class="b-log${logged > est && est ? " over" : ""}" style="width:${(logged / max) * 100}%"></i></div><b class="mono">${logged ? fmtDur(logged) : "Not specified"}</b></div>
      </div>
      ${canWrite() ? `<form id="wlForm" class="wlform noprint">
        <input name="spent" type="text" placeholder="Time spent, e.g. 3h 30m" aria-label="Time spent" required>
        <input name="date" type="date" value="${todayInput()}" aria-label="Date">
        <input name="note" type="text" placeholder="Work description" aria-label="Work description">
        <button class="btn btn-sm" type="submit">Log work</button></form>` : ""}
    </section>`;
  }

  /* ---------------- settings ---------------- */
  function viewSettings() {
    app.innerHTML = `
      <div class="pagehead"><div><p class="kicker">Workbook</p><h1>Settings</h1></div></div>
      <form id="sform" class="card settings">
        <div class="grid">
          <div class="field wide"><label for="s_name">Your name</label><small class="help">Used as the author of comments, work logs and the default reporter.</small><input id="s_name" name="name" value="${esc(S.name)}" placeholder="Inn-Kian Ong"></div>
          <div class="field wide"><label for="s_token">GitHub token</label>
            <small class="help">A fine-grained personal access token limited to <b>${esc(S.owner)}/${esc(S.repo)}</b> with <b>Contents: Read and write</b>. It is kept only in this browser.
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create one →</a></small>
            <input id="s_token" name="token" type="password" value="${esc(S.token)}" placeholder="github_pat_…" autocomplete="off"></div>
          <div class="field"><label for="s_owner">Owner</label><input id="s_owner" name="owner" value="${esc(S.owner)}"></div>
          <div class="field"><label for="s_repo">Repository</label><input id="s_repo" name="repo" value="${esc(S.repo)}"></div>
          <div class="field"><label for="s_branch">Branch</label><input id="s_branch" name="branch" value="${esc(S.branch)}"></div>
          <div class="field"><label for="s_path">Data folder</label><input id="s_path" name="dataPath" value="${esc(S.dataPath)}"></div>
        </div>
        <p class="warnnote">This repository is public, so tickets, comments and pictures saved here can be read by anyone who finds them. Leave out anything confidential, or point the data at a private repository.</p>
        <div class="formbar">
          <span id="sMsg" class="muted"></span>
          <button type="button" class="btn" id="sTest">Test connection</button>
          <button type="submit" class="btn btn-primary">Save settings</button>
        </div>
      </form>
      <section class="card"><h2>Backup</h2><p class="muted">Every save is a git commit, so the full history is in the repo. You can also download all tickets as one JSON file.</p>
        <button type="button" class="btn" id="sExport">Download all tickets (.json)</button></section>`;
    const form = $("#sform");
    const collect = () => { for (const k of ["name", "token", "owner", "repo", "branch", "dataPath"]) S[k] = form.elements[k].value.trim(); };
    form.addEventListener("submit", (e) => { e.preventDefault(); collect(); saveSettings(); INDEX = null; cache.clear(); showBanner(); toast("Settings saved", "ok"); });
    $("#sTest").addEventListener("click", async () => {
      collect(); const m = $("#sMsg"); m.textContent = "Checking…"; m.className = "muted";
      try {
        const r = await fetch(`https://api.github.com/repos/${S.owner}/${S.repo}`, { headers: S.token ? { Authorization: "Bearer " + S.token } : {}, cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || r.statusText);
        const push = j.permissions && j.permissions.push;
        m.textContent = push ? `✓ Connected to ${j.full_name}. You can save.` : `Connected to ${j.full_name}, read-only. The token needs Contents: Read and write.`;
        m.className = push ? "okmsg" : "errmsg";
      } catch (e) { m.textContent = "✗ " + e.message; m.className = "errmsg"; }
    });
    $("#sExport").addEventListener("click", async () => {
      try {
        const idx = await loadIndex(true);
        const all = [];
        for (const s of idx.tickets) all.push(await loadTicket(s.id, true));
        const blob = new Blob([JSON.stringify({ exported: nowISO(), tickets: all }, null, 2)], { type: "application/json" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `workbook-${todayInput()}.json`; a.click();
      } catch (e) { toast(e.message, "err"); }
    });
  }

  route();
})();
