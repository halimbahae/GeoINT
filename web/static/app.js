"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const state = {
  name: null, info: null, recon: null, tools: null,
  pollTimer: null, stopwatchTimer: null,
  running: new Set(),       // job ids seen as running
  lastStatus: null,
  apiDown: false,           // last api call hit a network failure (server down)
};

// ---------------------------------------------------------------- utilities
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    state.apiDown = true;   // network failure: browser deems server unreachable
    throw e;
  }
  state.apiDown = false;
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
  return json;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

function fileURL(name, rel) {
  return `/api/session/${encodeURIComponent(name)}/files?path=${encodeURIComponent(rel)}`;
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// tiny markdown renderer (subset sufficient for recon.md & reports)
function mdInline(s) {
  let out = esc(s);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    const safe = u.startsWith("http") ? u.replace(/[<>"']/g, "") : "#";
    return safe === "#" ? `<code>${esc(t)}</code>` : `<a href="${safe}" target="_blank" rel="noopener">${esc(t)}</a>`;
  });
  return out;
}

function md(src) {
  if (!src) return "<p class='muted'>Nothing here yet.</p>";
  let html = "";
  const lines = String(src).split("\n");
  let inCode = false, codeBuf = [], inList = false;
  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      if (inCode) { html += "<pre>" + esc(codeBuf.join("\n")) + "</pre>"; codeBuf = []; inCode = false; }
      else inCode = true;
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    const m = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (m) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      if (!inList) { html += "<ul class='list'>"; inList = true; }
      html += "<li>" + mdInline(raw.replace(/^\s*[-*]\s+/, "")) + "</li>";
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (!raw.trim()) continue;
    if (/^\|/.test(raw.trim())) { html += "<p class='mono'>" + esc(raw.trim()) + "</p>"; continue; }
    html += "<p>" + mdInline(raw) + "</p>";
  }
  if (inCode) html += "<pre>" + esc(codeBuf.join("\n")) + "</pre>";
  if (inList) html += "</ul>";
  return html;
}

// ------------------------------------------------------------------ routing
window.addEventListener("hashchange", route);
function route() {
  let h = location.hash.replace(/^#\/?/, "");
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  if (h) openSession(h);
  else showHome();
}

function showHome() {
  state.name = null;
  stopPollers();
  $("#view-home").classList.remove("hidden");
  $("#view-session").classList.add("hidden");
  $("#btn-home").classList.add("hidden");
  loadSessions();
}

function openSession(name) {
  state.name = name;
  $("#view-home").classList.add("hidden");
  $("#view-session").classList.remove("hidden");
  $("#btn-home").classList.remove("hidden");
  $("#s-name").textContent = name;
  if (location.hash !== "#/" + name) location.hash = "#/" + name;
  loadSession();
}

// ------------------------------------------------------------------ session
let loadTimer = null;
async function loadSession() {
  const name = state.name;
  let info;
  try {
    info = await api(`/api/session/${encodeURIComponent(name)}`);
  } catch (e) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => { if (state.name === name) loadSession(); }, 2000);
    $("#s-status").innerHTML = `<span class="pill err">server unreachable — retrying…</span>`;
    return;
  }
  clearTimeout(loadTimer); loadTimer = null;
  state.info = info;
  const o = info.meta && info.meta.original;
  const rel = o ? o.relative_path : null;
  const img = $("#s-photo");
  img.onerror = () => { img.alt = "photo not found"; img.style.opacity = 0.25; };
  img.style.opacity = 1;
  img.src = rel ? fileURL(name, rel) : "";
  $("#s-started").textContent = "started " + fmtTime(info.meta && info.meta.started_at);
  const status = (info.meta && info.meta.status) || "?";
  const pill = $("#s-status");
  pill.innerHTML = "";
  const sp = document.createElement("span");
  sp.className = "pill " + (status === "completed" ? "ok" : "");
  sp.textContent = status;
  pill.appendChild(sp);
  const res = info.result;
  $("#s-result").innerHTML = res
    ? `<span class="pill ok">${esc(res.country)}${res.region ? " · " + esc(res.region) : ""} · ${esc(res.city_or_nearest_locality)}</span>
       <div class="mono muted" style="margin-top:6px">${esc(res.latitude)} , ${esc(res.longitude)} — ${esc(res.confidence)}</div>`
    : "";
  await Promise.all([loadRecon(), loadTools()]);
  renderReport();
  activateTab("overview");
  pollStatus(); // prime the live tracker
}

let reconLoading = false;
async function loadRecon() {
  if (reconLoading || !state.name) return;
  reconLoading = true;
  try {
    const name = state.name;
    state.recon = await api(`/api/session/${encodeURIComponent(name)}/recon`);
    renderOverview();
    renderEvidence();
  } finally { reconLoading = false; }
}

async function loadTools() {
  const name = state.name;
  state.tools = (await api(`/api/session/${encodeURIComponent(name)}/tools`)).tools;
  renderTools();
}

// -------------------------------------------------------------------- recon
async function startRecon(mode) {
  const name = state.name;
  const payload = {
    mode,
    no_ml: mode === "quick",
    no_rev: $("#opt-norev").checked,
    skip: $("#opt-skipdetect").checked ? ["detect", "calib", "prior"] : [],
  };
  const job = await api(`/api/session/${encodeURIComponent(name)}/recon`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (state.info) state.info.jobs = (state.info.jobs || []).concat([job]);
  ensurePoll();
  pollStatus();
}

// --------------------------------------------- job polling + live tracker
function ensurePoll() {
  if (!state.pollTimer) state.pollTimer = setInterval(pollStatus, 1200);
}

function stopPollers() {
  clearInterval(state.pollTimer); state.pollTimer = null;
  stopStopwatch();
}

async function pollStatus() {
  if (!state.name || state.apiDown) return;
  try {
    const st = await api(`/api/session/${encodeURIComponent(state.name)}/recon/status`);
    handleStatus(st);
  } catch { /* transient, keep polling */ }
}

function jobId(j) { return j.job_id || j.job; }

function handleStatus(st) {
  state.lastStatus = st;
  renderTracker(st);
  pollReconLog(st.running ? st.running.job : null);
  // transition detection: running -> done/failed/orphaned
  const running = st.jobs.filter((j) => j.status === "running").map(jobId);
  const prev = new Set(state.running);
  state.running = new Set(running);
  const finished = st.jobs.filter((j) => prev.has(jobId(j)) && j.status !== "running");
  finished.forEach((j) => {
    toast(`${j.kind || "job"} ${j.status === "done" ? "done" : j.status === "failed" ? "failed (rc=" + j.rc + ")" : "interrupted"}`);
    if ((j.kind || "").startsWith("recon")) loadSession();
  });
  // recon buttons enabled only when this session's recon slot is free
  const busy = st.running !== null;
  $("#btn-recon-quick").disabled = busy;
  $("#btn-recon-full").disabled = busy;
  if (!busy && running.length === 0) { stopPollers(); stopReconLog(); }
}

let reconLogJid = null;
let reconLogTimer = null;
function pollReconLog(jid) {
  if (jid === reconLogJid) return;
  stopReconLog();
  reconLogJid = jid;
  if (!jid) return;
  const sync = async () => {
    if (state.apiDown || !reconLogJid) return;
    try {
      const j = await api(`/api/session/${encodeURIComponent(state.name)}/job/${reconLogJid}`);
      const text = j.content || j.status || "";
      for (const el of $$("[data-livelog]")) {
        if (!text) continue;
        el.textContent = text;
        el.classList.remove("hidden");
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
        if (near) el.scrollTop = el.scrollHeight;
      }
    } catch { /* transient */ }
  };
  sync();
  reconLogTimer = setInterval(sync, 1500);
}
function stopReconLog() {
  if (reconLogTimer) { clearInterval(reconLogTimer); reconLogTimer = null; }
  reconLogJid = null;
}

function startStopwatch(started) {
  const el = $("#job-elapsed");
  el.classList.remove("hidden");
  const t0 = Date.now();
  const base = Math.max(0, t0 - new Date(started || t0).getTime());
  const tick = () => { el.textContent = "⏱ " + fmtDur((base + (Date.now() - t0)) / 1000); };
  clearInterval(state.stopwatchTimer);
  tick();
  state.stopwatchTimer = setInterval(tick, 1000);
}

function stopStopwatch() {
  clearInterval(state.stopwatchTimer);
  state.stopwatchTimer = null;
  const el = $("#job-elapsed");
  if (el) el.classList.add("hidden");
}

function renderTracker(st) {
  const bar = $("#jobbar");
  const jobs = st.jobs || [];
  const recon = st.running || null;
  bar.classList.toggle("hidden", !(recon || jobs.length));

  const gb = $("#global-busy");
  const gn = st.global_running || 0;
  gb.classList.toggle("hidden", gn === 0);
  if (gn) gb.textContent = `⚙ ${gn}/${st.max_jobs} running`;

  const stepsEl = $("#job-steps");
  const live = st.live || { steps: [], total: 0, done: 0 };
  stepsEl.classList.toggle("hidden", !recon);
  const pb = $("#job-progress"), fill = $("#job-progress-fill");

  if (recon) {
    $("#job-kind").className = "pill run";
    $("#job-kind").textContent = "RECON";
    $("#job-status-text").textContent = "running";
    stepsEl.innerHTML = live.steps.map((s) => {
      const cls = { done: "done", running: "run", pending: "", failed: "err" }[s.state] || "";
      const ic = { done: "✔", running: "●", pending: "○", failed: "✗" }[s.state] || "•";
      const dg = s.digest ? `<span class="step-dg">${esc(s.digest)}</span>` : "";
      return `<span class="step ${cls}" title="${esc(s.digest || s.label)}"><span class="step-ic">${ic}</span>${esc(s.label)}${dg}</span>`;
    }).join("");
    pb.classList.remove("hidden");
    fill.style.width = (live.total ? (live.done / live.total) * 100 : 0) + "%";
    startStopwatch(recon.started);
  } else {
    stepsEl.innerHTML = "";
    pb.classList.add("hidden");
    stopStopwatch();
    const finished = jobs.filter((j) => j.status !== "running");
    const last = finished[finished.length - 1] || jobs[jobs.length - 1];
    if (last) {
      $("#job-kind").className = "pill " + (last.status === "done" ? "ok" : last.status === "failed" ? "err" : "");
      $("#job-kind").textContent = (last.kind || "job").toUpperCase();
      $("#job-status-text").textContent = last.status === "orphaned"
        ? "interrupted (server restarted)"
        : (last.status + (last.rc != null ? " · rc=" + last.rc : ""));
    }
  }
  renderJobHistory(jobs);
  $("#btn-log").classList.toggle("hidden", !recon && !(st.log_tail || ""));
  $("#btn-stop").classList.toggle("hidden", !recon);
}

function renderJobHistory(jobs) {
  const hist = $("#job-history");
  hist.classList.toggle("hidden", jobs.length === 0);
  const lastId = state.running.size
    ? [...state.running][0]
    : (jobs.length ? jobId(jobs[jobs.length - 1]) : null);
  const rows = jobs.slice(-8).reverse().map((j) => {
    const cls = { done: "ok", failed: "err", running: "run" }[j.status] || "";
    const ic = j.status === "done" ? "✔" : j.status === "failed" ? "✗" : j.status === "running" ? "●" : "⊙";
    return `<div class="jh-row"><span class="pill ${cls}">${ic} ${esc(j.kind || "job")}</span>
      <span class="muted">${esc(j.status)}${j.rc != null ? " · rc=" + j.rc : ""}</span>
      <span class="muted">${fmtTime(j.started)}${j.ended ? " → " + fmtTime(j.ended) : ""}</span>${jobId(j) === lastId && j.status === "running" ? " <span class='pill run'>live</span>" : ""}</div>`;
  }).join("");
  hist.innerHTML = rows;
}

function renderLog(tail) {
  const pre = $("#job-log");
  if (!tail) { pre.classList.add("hidden"); return; }
  pre.classList.remove("hidden");
  pre.textContent = tail;
  pre.scrollTop = pre.scrollHeight;
}

// ----------------------------------------------------------------- overview
function renderOverview() {
  const host = $("#tab-overview");
  const r = state.recon;
  host.innerHTML = "";
  const st = state.lastStatus || {};
  const running = st.running;
  if (!r || !r.has) {
    if (running) {
      const live = st.live || { done: 0, total: 0 };
      const pct = live.total ? Math.round((live.done / live.total) * 100) : 0;
      host.innerHTML = `<div class="live-recon">
        <h3>Recon in progress <span class="pill run">● running</span></h3>
        <p class="muted">${live.done}/${live.total} steps done (${pct}%) — steps are tracked live in the bar above. The log below tails each step as it lands.</p>
        <pre id="job-log-live" class="log" data-livelog>starting…</pre>
      </div>`;
      return;
    }
    host.innerHTML = `<div class="empty-state">
       <p>No recon results yet for this session.</p>
       <p class="muted">Run <strong>Quick recon</strong> (fast, no local models) or <strong>Full recon (ML)</strong>
          to gather metadata, OCR, reverse image search, the text→country signals, object crops,
          camera calibration and the learned world prior.</p></div>`;
    return;
  }

  const steps = r.steps || {};
  const bad = Object.entries(steps).filter(([, v]) => (v.rc || 0) !== 0);
  if (bad.length) {
    host.appendChild(block("Steps that failed", `<ul class="list">${bad.map(([k, v]) =>
      `<li><strong>${esc(k)}</strong> rc=${v.rc} — ${esc(v.error || v.stdout_tail || "")}</li>`).join("")}</ul>`));
  }

  host.appendChild(block("Recon summary", `<div class="md">${md(r.md)}</div>`, true));

  const m = r.meta;
  if (m) {
    const g = m.gps || {}, t = m.time || {};
    const rows = [];
    if (g.lat != null) rows.push(["GPS", `${g.lat}, ${g.lon}`]);
    if (t.DateTimeOriginal) rows.push(["Capture time", t.DateTimeOriginal]);
    if (t.utc_offset) rows.push(["UTC offset", `${t.utc_offset} (${(t.countries_with_this_offset_on_that_date || []).join(", ")})`]);
    if (m.camera) rows.push(["Camera / software", JSON.stringify(m.camera)]);
    if (m.filename_hints && m.filename_hints.length) rows.push(["Filename hints", m.filename_hints.map((h) => h.pattern).join("; ")]);
    if (rows.length) host.appendChild(block("Metadata", kv(rows)));
  }

  if (r.ocr && r.ocr.items && r.ocr.items.length) {
    const rows = r.ocr.items.map((it) => [`${it.conf.toFixed(2)} ${it.pass}`, it.text]);
    host.appendChild(block("OCR", kv(rows)));
  }

  const tg = r.textgeo;
  if (tg && tg.shortlist) {
    const list = (tg.shortlist || []).map((x) => `<li><strong>${esc(x.name)}</strong> (log LR ${x.log_lr})</li>`).join("");
    const sig = (tg.signals || []).map((s) => `<li>[${esc(s.kind)}/${esc(s.status)}] ${esc(s.clue)}</li>`).join("");
    const places = (tg.places || []).slice(0, 6).map((p) =>
      `<li>“${esc(p.matched || "")}” → ${esc(p.name)}, ${esc(p.admin1 || "")}, ${esc(p.country_name || "")}</li>`).join("");
    host.appendChild(block("Text → country signals",
      `<ul class="list">${list}</ul><ul class="list">${sig}</ul>${places ? `<p class="muted" style="margin-top:6px">Places:</p><ul class="list">${places}</ul>` : ""}`));
  }

  if (r.prior) {
    const a = r.prior.assessment || {};
    const comb = (r.prior.combined || []).slice(0, 6).map((x) => `<li>${esc(x.name)} (${(x.p * 100).toFixed(0)}%)</li>`).join("");
    const bg = r.prior.best_guess;
    host.appendChild(block("World prior (models — ranking only)", `
      <p>${a.informative === false ? "⚠ Uninformative: " + esc((a.reasons || []).join("; ")) : "Informative"}</p>
      <ul class="list">${comb}</ul>
      ${bg ? `<p class="muted">Model point guess: ${bg.lat.toFixed(4)}, ${bg.lon.toFixed(4)}${bg.near ? " near " + esc(bg.near) : ""}</p>` : ""}
      ${pathExists(state.info.files, "recon/prior/prior_map.png") ? `
      <div class="prior-map-wrap">
        <div class="prior-map-row">
          <div id="prior-chips" class="prior-chips"></div>
          <span class="spacer"></span>
          <button id="prior-max" class="btn ghost mini">⛶ fullscreen</button>
        </div>
        <div id="prior-map"></div>
        <p class="muted"><small>drag to pan · scroll to zoom · click a chip, circle or ★ for details · switch overlays top-right — maps try OSM tiles first, the <em>Prior snapshot</em> layer is the exact prior_map.png and works offline.</small></p>
      </div>` : ""}`));
    if (pathExists(state.info.files, "recon/prior/prior_map.png")) initPriorMap();
  }

  if (r.calib) {
    const u = r.calib.uncertainty || {};
    host.appendChild(block("Camera calibration",
      `<p>hfov ${r.calib.hfov_deg}°, 35&nbsp;mm eq ${r.calib.focal_35mm_equiv} mm, pitch ${r.calib.pitch_deg}° ±${u.pitch_uncertainty ?? "?"}, roll ${r.calib.roll_deg}° ±${u.roll_uncertainty ?? "?"}</p>`));
  }

  if (r.detect && r.detect.detections && r.detect.detections.length) {
    const counts = {};
    r.detect.detections.forEach((d) => { counts[d.cls] = (counts[d.cls] || 0) + 1; });
    host.appendChild(block("object crops",
      `<p>${Object.entries(counts).map(([k, v]) => `${esc(k)} ×${v}`).join(" · ")} — see the Evidence tab</p>`));
  }
}

function block(title, inner, wide = false) {
  const s = document.createElement("section");
  s.className = "section-block" + (wide ? " wide" : "");
  s.innerHTML = `<h3>${esc(title)}</h3>${inner}`;
  return s;
}

function kv(rows) {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}

// ----------------------------------------------------------------- evidence
function renderEvidence() {
  const host = $("#tab-evidence");
  const name = state.name;
  const files = (state.info && state.info.files) || {};
  host.innerHTML = "";

  const groups = [
    ["recon/intake/edges", "Edge & corner crops"],
    ["recon/intake/rev", "Reverse image search results"],
    ["recon/intake", "OCR & search variants"],
    ["recon/detect", "Object crops"],
    ["recon/meta", "Metadata extras"],
    ["recon/prior", "Prior maps"],
    ["refsheet", "Reference sheets"],
    ["recon", "Recon"],
  ];

  const PRIME = [
    ["recon/intake/ocr.png", "OCR boxes"],
    ["recon/detect/detect_sheet.jpg", "Detector sheet"],
    ["recon/calib.jpg", "Calibration line"],
    ["recon/prior/prior_map.png", "World prior map"],
  ];

  let shown = 0;
  const keyOut = PRIME.filter(([p]) => pathExists(files, p)).map(([p]) => p);
  renderSheet(host, "Key output", keyOut);
  for (const [dir, label] of groups) {
    const paths = (files[dir] || []).filter((p) => /\.(jpe?g|png|webp|gif)$/i.test(p));
    if (!paths.length) continue;
    renderSheet(host, label, paths.slice(0, 40));
    shown += paths.length;
  }
  if (!shown) {
    host.innerHTML = `<div class="empty-state"><p>No evidence images yet — run recon first.</p></div>`;
  }
}

function pathExists(files, rel) {
  const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const key = parent || "(root)";
  return (files[key] || []).includes(rel);
}

function tag(label, rels) {
  const fig = (r) => `<figure>
      <img src="${fileURL(state.name, r)}" loading="lazy" onclick="openModal(this)" alt="${esc(r)}">
      <figcaption>${esc(r.split("/").pop())}</figcaption></figure>`;
  return `<div class="evidence-group"><h3 class="card-title">${esc(label)}</h3><div class="evidence-grid">${rels.map(fig).join("")}</div></div>`;
}

function renderSheet(host, label, rels) {
  const div = document.createElement("div");
  div.innerHTML = tag(label, rels);
  host.appendChild(div.firstChild);
}

function openModal(el) {
  hideModal();
  const m = $("#modal");
  const c = el.cloneNode(false);
  c.removeAttribute("id");
  if (c.tagName === "IMG") {
    c.style.cursor = "default";
    c.onclick = null;
  }
  m.appendChild(c);
  m.classList.remove("hidden");
}
window.hideModal = function hideModal() {
  const m = $("#modal");
  if (m.classList.contains("hidden")) return;
  const priorEl = $("#prior-map.full");
  if (priorEl) {
    m.removeChild(priorEl);
    priorEl.classList.remove("full");
    if (state.priorMapHome) { state.priorMapHome.appendChild(priorEl); }
    if (state.priorMap) {
      requestAnimationFrame(() => {
        state.priorMap.invalidateSize();
        if (state.priorSavedBounds) state.priorMap.fitBounds(state.priorSavedBounds);
      });
    }
  }
  m.innerHTML = "";
  m.classList.add("hidden");
};

function showPriorMapMax() {
  const el = $("#prior-map");
  if (!el) return;
  hideModal();
  state.priorMapHome = el.parentNode;
  const m = $("#modal");
  m.appendChild(el);
  el.classList.add("full");
  m.classList.remove("hidden");
  if (state.priorMap) {
    requestAnimationFrame(() => {
      state.priorMap.invalidateSize();
      if (state.priorSavedBounds) state.priorMap.fitBounds(state.priorSavedBounds);
    });
  }
}

function initPriorMap() {
  const el = $("#prior-map");
  if (!el) return;
  if (state.priorMap) { state.priorMap.remove(); state.priorMap = null; }
  const prior = state.recon.prior || {};
  const gc = prior.geoclip || {};
  if (!document.getElementById("prior-max").onclick) {
    document.getElementById("prior-max").onclick = showPriorMapMax;
  }
  const ccName = (iso2) => ((prior.combined || []).find((x) => x.iso2 === iso2) || {}).name || iso2;

  const map = L.map(el, { preferCanvas: true, worldCopyJump: true });
  state.priorMap = map;

  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  const snap = L.imageOverlay(fileURL(state.name, "recon/prior/prior_map.png"),
    [[-85.0511, -180], [85.0511, 180]], { opacity: 0.82 });
  const base = {
    "OSM streets": osm,
    "Prior snapshot (PNG)": L.layerGroup([snap]),
  };

  const overlays = {};
  const clusters = (gc.clusters || []).filter((c) => c && typeof c.lat === "number");
  const pts = (gc.points || []).filter((p) => p && p.length >= 3 && typeof p[0] === "number");
  const bg = prior.best_guess;

  if (clusters.length) {
    const maxMass = Math.max(1e-6, ...clusters.map((c) => c.mass));
    const glyphs = clusters.map((c) => {
      const near = c.near || {};
      const pct = ((c.mass || 0) * 100).toFixed(0) + "%";
      const where = [near.name, near.admin1, near.country_name].filter(Boolean).join(", ");
      const circle = L.circle([c.lat, c.lon], {
        radius: (40 + Math.sqrt(c.mass / maxMass) * 260) * 1000,
        color: "#ff5a3c", weight: 2, fillColor: "#ff5a3c", fillOpacity: 0.14,
      });
      circle.bindTooltip(`${pct} near ${where}`, { sticky: true });
      circle.bindPopup(`<strong>${pct} of GeoCLIP mass</strong><br>${where || "—"}<br><code>${c.lat}, ${c.lon}</code>`);
      return circle;
    });
    overlays["GeoCLIP clusters (mass %)"] = L.layerGroup(glyphs);
  }
  if (pts.length) {
    const maxP = Math.max(1e-6, ...pts.map((p) => p[2]));
    const glyphs = pts.map((p) => L.circleMarker([p[0], p[1]], {
      radius: 1.5 + 4 * Math.sqrt(p[2] / maxP),
      color: "#5bd0f0", weight: 1, fillColor: "#5bd0f0", fillOpacity: 0.75,
    }).bindPopup(`<code>${p[0]}, ${p[1]}</code> · p=${p[2].toFixed(4)}`));
    overlays["GeoCLIP top points"] = L.layerGroup(glyphs);
  }
  if (bg && typeof bg.lat === "number") {
    const guess = L.marker([bg.lat, bg.lon], {
      icon: L.divIcon({ className: "guess-icon", html: "★", iconSize: [22, 22], iconAnchor: [11, 16] }),
      zIndexOffset: 1000,
    });
    guess.bindPopup(`<strong>Model point guess</strong><br>${bg.lat}, ${bg.lon}${bg.near ? " — near " + esc(bg.near) : ""}${bg.country ? " (" + esc(ccName(bg.country)) + ")" : ""}<br><em>${esc(bg.how || "")}</em>`);
    overlays["Model point guess"] = guess;
  }

  osm.addTo(map);
  Object.values(overlays).forEach((l) => l.addTo(map));
  L.control.layers(base, overlays, { position: "topright", collapsed: true }).addTo(map);

  const padView = (latlng, deg) => L.latLngBounds([[latlng.lat - deg, latlng.lng - deg], [latlng.lat + deg, latlng.lng + deg]]);
  if (clusters.length) {
    state.priorSavedBounds = L.latLngBounds(clusters.map((c) => [c.lat, c.lon])).pad(0.3);
    map.fitBounds(state.priorSavedBounds, { maxZoom: 9 });
  } else if (bg) {
    state.priorSavedBounds = padView(bg, 3);
    map.setView([bg.lat, bg.lon], 6);
  } else {
    state.priorSavedBounds = null;
    map.setView([20, 0], 2);
  }

  const chips = $("#prior-chips");
  if (chips) {
    chips.innerHTML = "";
    const add = (t, fn) => { const b = document.createElement("button"); b.className = "chip"; b.textContent = t; b.onclick = fn; chips.appendChild(b); };
    clusters.slice(0, 8).forEach((c) => {
      const near = c.near || {};
      const where = [near.name, near.admin1].filter(Boolean).join(", ");
      add(`${((c.mass || 0) * 100).toFixed(0)}% ${where || c.lat + ", " + c.lon}`, () => map.fitBounds(padView(c, 1.4), { maxZoom: 11 }));
    });
    if (bg) add(`★ ${bg.lat.toFixed(4)}, ${bg.lon.toFixed(4)}${bg.near ? " " + bg.near : ""}`, () => map.fitBounds(padView(bg, 1.1), { maxZoom: 12 }));
  }
}

// ------------------------------------------------------------------- tools
const TOOL_RULES = {
  textgeo: (a) => (!a.text ? "text is required" : null),
  geodata: (a) => {
    if (!a.cmd) return "choose a command (search / towns)";
    if (a.cmd === "search" && !a.query) return "search needs a place name";
    if (a.cmd === "towns" && !a.cc) return "towns needs a country code (e.g. PT)";
    return null;
  },
  board: (a) => {
    const need = {
      apply: [["kind", "board apply needs a kind (e.g. driving-side)"], ["value", "board apply needs a value (e.g. left / right)"]],
      clue: [["clue", "board clue needs the clue text"]],
      ingest: [["source", "ingest needs a source (textgeo / prior)"]],
    };
    if (!a.cmd || !need[a.cmd]) return null;
    const miss = need[a.cmd].find(([k]) => !a[k]);
    return miss ? miss[1] : null;
  },
  refsheet: (a) => (!a.where ? "enter a target, e.g. countries=PT,ES,MA" : null),
};

function renderTools() {
  const host = $("#tab-tools");
  host.innerHTML = "";
  (state.tools || []).forEach((tool) => {
    const card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.tool = tool.name;
    const fields = tool.fields.map((f) => {
      if (f.type === "select") {
        return `<label>${esc(f.label)}<select data-k="${esc(f.key)}">${f.options.map((o) =>
          `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select></label>`;
      }
      return `<label>${esc(f.label)}<input type="text" data-k="${esc(f.key)}" placeholder="${esc(f.placeholder || "")}"></label>`;
    }).join("");
    card.innerHTML = `<h4>${esc(tool.label)}</h4>
      <div class="tool-fields">${fields}</div>
      <button class="btn" data-act="run">Run</button>
      <pre class="log hidden" data-log></pre>`;
    host.appendChild(card);
  });

  host.insertAdjacentHTML("beforeend", `<div class="tool-card">
    <h4>Custom GeoInt command (advanced)</h4>
    <p class="hint">argv list, first element a script name, e.g. <span class="mono">["textgeo.py","--text","hello"]</span></p>
    <input type="text" id="custom-argv" placeholder='["meta.py", "original/test_photo.jpg"]' style="width:100%;margin-bottom:10px">
    <button class="btn" id="btn-custom">Run</button>
    <pre class="log hidden" data-log></pre></div>`);
  (state.running || []).forEach((id) => markToolRunning(id));
}

function markToolRunning(jobId) {
  // disable any tool card whose job that id belongs to is detected later in the tracker
}

async function runTool(card) {
  const name = state.name;
  const tool = card.dataset.tool;
  const args = {};
  $$("[data-k]", card).forEach((el) => {
    args[el.dataset.k] = el.value.trim();
  });
  const rule = TOOL_RULES[tool];
  if (rule) {
    const bad = rule(args);
    if (bad) { toast("⚠ " + bad, "err"); return; }
  }
  const btn = $("[data-act=run]", card);
  btn.disabled = true;
  btn.textContent = "…";
  const logEl = $("[data-log]", card);
  logEl.classList.remove("hidden");
  logEl.textContent = "starting…";
  try {
    const job = await api(`/api/session/${encodeURIComponent(name)}/tools`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
    if (state.info) state.info.jobs = (state.info.jobs || []).concat([job]);
    btn.dataset.job = job.job;
    ensurePoll();
    pollToolJob(job.job, card);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Run";
    errMsg(e);
  }
}

function pollToolJob(jobId, card) {
  const name = state.name;
  if (card._toolPoll) clearInterval(card._toolPoll);
  card._toolPoll = setInterval(async () => {
    if (state.apiDown) return;
    try {
      const j = await api(`/api/session/${encodeURIComponent(name)}/job/${jobId}`);
      const logEl = $("[data-log]", card);
      if (logEl) {
        logEl.textContent = j.content || j.status || "(empty log)";
        logEl.scrollTop = logEl.scrollHeight;
      }
      if (j.status === "done" || j.status === "failed" || j.status === "orphaned") {
        clearInterval(card._toolPoll);
        card._toolPoll = null;
        const btn = $("[data-act=run]", card);
        if (btn) { btn.disabled = false; btn.textContent = "Run"; delete btn.dataset.job; }
        toast(`tool ${j.status === "done" ? "done" : "failed (rc=" + j.rc + ")"}`);
      }
    } catch { /* job not ready / transient */ }
  }, 1200);
}

async function runCustom() {
  const name = state.name;
  const raw = $("#custom-argv").value.trim();
  if (!raw) { toast("⚠ enter an argv list, e.g. [\"meta.py\", \"original/test_photo.jpg\"]", "err"); return; }
  let argv;
  try { argv = JSON.parse(raw); if (!Array.isArray(argv) || !argv.length) throw new Error(); }
  catch { argv = raw.split(/\s+/).filter(Boolean); }
  const btn = $("#btn-custom");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const job = await api(`/api/session/${encodeURIComponent(name)}/tools`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "custom", argv }),
    });
    if (state.info) state.info.jobs = (state.info.jobs || []).concat([job]);
    ensurePoll();
    pollToolJob(job.job, btn.closest(".tool-card"));
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Run";
    errMsg(e);
  }
}

// ------------------------------------------------------------------- report
function renderReport() {
  const host = $("#tab-report");
  const name = state.name;
  const info = state.info || {};
  const res = info.result || {};
  host.innerHTML = `
    <div class="section-block">
      <h3>report.md</h3>
      <textarea id="report-ta" spellcheck="false" placeholder="Edit the geolocation report (gut call, evidence, answer)…"></textarea>
      <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
        <button class="btn primary" id="btn-save-report">Save report</button>
      </div>
    </div>
    <div class="section-block">
      <h3>Finish the session</h3>
      <div class="tool-fields">
        <label>Country<input type="text" id="f-country" value="${esc(res.country || "")}"></label>
        <label>Region<input type="text" id="f-region" value="${esc(res.region || "")}"></label>
        <label>City / nearest locality<input type="text" id="f-city" value="${esc(res.city_or_nearest_locality || "")}"></label>
        <label>Latitude<input type="text" id="f-lat" value="${res.latitude != null ? res.latitude : ""}"></label>
        <label>Longitude<input type="text" id="f-lon" value="${res.longitude != null ? res.longitude : ""}"></label>
        <label>Confidence<select id="f-conf">
          <option value="high"${res.confidence === "high" ? " selected" : ""}>high</option>
          <option value="medium"${res.confidence === "medium" ? " selected" : ""}>medium</option>
          <option value="low"${res.confidence === "low" ? " selected" : ""}>low</option>
        </select></label>
      </div>
      <button class="btn primary" id="btn-finish">Finish archive</button>
    </div>
    <div class="section-block hidden" id="truth-panel">
      <h3>Record ground truth (score this guess)</h3>
      <div class="tool-fields">
        <label>Truth latitude<input type="text" id="t-lat"></label>
        <label>Truth longitude<input type="text" id="t-lon"></label>
        <label>Country<input type="text" id="t-country"></label>
        <label>Region<input type="text" id="t-region"></label>
        <label>City<input type="text" id="t-city"></label>
        <label>Source<input type="text" id="t-source" placeholder="owner / puzzle / reveal"></label>
      </div>
      <button class="btn" id="btn-truth">Score</button>
      <div id="truth-result"></div>
    </div>`;
  const ta = $("#report-ta");
  ta.value = (info.report || "").replace(/<!-- geogussr-archive -->[\s\S]*$/, "").trimEnd();
  if (info.truth || info.result) $("#truth-panel").classList.remove("hidden");
}

async function saveReport() {
  const name = state.name;
  await api(`/api/session/${encodeURIComponent(name)}/report`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: $("#report-ta").value }),
  });
  toast("report saved");
}

async function finishSession() {
  const name = state.name;
  const body = {
    country: $("#f-country").value, region: $("#f-region").value, city: $("#f-city").value,
    lat: $("#f-lat").value, lon: $("#f-lon").value, confidence: $("#f-conf").value,
  };
  if (!body.country.trim()) { toast("⚠ country is required", "err"); return; }
  const lat = parseFloat(body.lat), lon = parseFloat(body.lon);
  if (isNaN(lat) || body.lat.trim() === "") { toast("⚠ latitude must be a number", "err"); return; }
  if (isNaN(lon) || body.lon.trim() === "") { toast("⚠ longitude must be a number", "err"); return; }
  const res = await api(`/api/session/${encodeURIComponent(name)}/finish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  state.name = res.name;
  location.hash = "#/" + res.name;
  toast("session archived ✔");
}

async function recordTruth() {
  const name = state.name;
  const res = await api(`/api/session/${encodeURIComponent(name)}/truth`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lat: $("#t-lat").value, lon: $("#t-lon").value,
      country: $("#t-country").value, region: $("#t-region").value, city: $("#t-city").value,
      source: $("#t-source").value,
    }),
  });
  const t = res.truth || {};
  $("#truth-result").innerHTML = `<p class="pill ${t.error_km !== undefined && t.error_km <= 200 ? "ok" : "err"}">
     ${t.error_km != null ? t.error_km.toFixed(2) + " km error" : ""} ${t.game_score_estimate != null ? "· score " + t.game_score_estimate : ""} ${t.country_hit ? "· country ✓" : t.country_hit === false ? "· country ✗" : ""}</p>`;
  toast("truth recorded");
}

// ------------------------------------------------------------------- home
async function loadSessions() {
  const host = $("#sessions");
  host.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await api("/api/sessions");
    const list = data.sessions || [];
    if (!list.length) { host.innerHTML = '<p class="muted">No sessions yet — drop a photo above to begin.</p>'; return; }
    host.innerHTML = list.map((s) => {
      const res = s.result;
      const active = (s.jobs || []).some((j) => j.status === "running");
      return `<div class="session-card" data-name="${esc(s.name)}">
        ${s.thumb ? `<img src="/api/session/${encodeURIComponent(s.name)}/${s.thumb}" loading="lazy">` : ""}
        <div class="sc-meta">
          <div class="sc-name">${esc(s.name)} ${active ? '<span class="pill run">● running</span>' : ""}</div>
          <div class="sc-sub">${esc(fmtTime(s.started_at))}</div>
          ${res ? `<div class="sc-sub">${esc(res.country)} · ${esc(res.city_or_nearest_locality)} (${esc(res.confidence)})</div>` : ""}
          <div class="sc-sub">${s.truth != null ? "truth error " + s.truth + " km" : s.status}</div>
        </div>
        <div class="sc-actions">
          <button class="btn ghost mini" data-act="rename" title="Rename">✎</button>
          <button class="btn ghost mini danger" data-act="delete" title="Delete session">🗑</button>
        </div></div>`;
    }).join("");
  } catch (e) {
    host.innerHTML = `<p class="err">Could not load sessions: ${esc(e.message)}</p>`;
  }
}

// -------------------------------------------------------------------- toasts
function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("out"), 2800);
  setTimeout(() => el.remove(), 3200);
}

function errMsg(e) {
  toast("⚠ " + e.message, "err");
}

let connText = "…";

async function health() {
  try {
    const h = await api("/api/health");
    connText = h.uv ? "uv ✓ · python ✓" : "uv not found";
    const p = $("#conn");
    p.textContent = connText;
    p.classList = "pill ok";
  } catch (e) {
    $("#conn").textContent = "server offline";
    $("#conn").className = "pill err";
  }
}

// -------------------------------------------------------------------- init
function initEvents() {
  const dz = $("#dropzone"), file = $("#dz-file");
  dz.addEventListener("click", () => file.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); dz.classList.remove("drag");
    if (e.dataTransfer.files.length) upload([...e.dataTransfer.files][0]);
  });
  file.addEventListener("change", () => { if (file.files.length) upload(file.files[0]); file.value = ""; });
  $("#sessions").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (act) {
      const card = act.closest(".session-card");
      const name = card && card.dataset.name;
      if (!name) return;
      if (act.dataset.act === "rename") {
        const fresh = prompt("New session name:", name);
        if (!fresh || !fresh.trim() || fresh.trim() === name) return;
        const newName = fresh.trim();
        try {
          const r = await api(`/api/session/${encodeURIComponent(name)}/rename`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: newName }),
          });
          toast(`renamed → ${r.name}`);
          if (state.name === name) { location.hash = "#/" + r.name; openSession(r.name); }
          loadSessions();
        } catch (err) { errMsg(err); }
        return;
      }
      if (act.dataset.act === "delete") {
        if (!confirm(`Delete session ${name}?\nThis removes the whole archive folder from disk.`)) return;
        try {
          await api(`/api/session/${encodeURIComponent(name)}`, { method: "DELETE" });
          toast(`deleted ${name}`);
          if (state.name === name) { location.hash = "#/"; showHome(); }
          loadSessions();
        } catch (err) { errMsg(err); }
        return;
      }
    }
    const card = e.target.closest(".session-card");
    if (card && card.dataset.name) openSession(card.dataset.name);
  });
  $("#btn-home").addEventListener("click", () => { location.hash = "#/"; });
  $("#btn-refresh").addEventListener("click", loadSession);
  $("#btn-recon-quick").addEventListener("click", () => startRecon("quick").catch(errMsg));
  $("#btn-recon-full").addEventListener("click", () => startRecon("full").catch(errMsg));
  $("#btn-stop").addEventListener("click", async () => {
    try {
      await api(`/api/session/${encodeURIComponent(state.name)}/recon/stop`, { method: "POST" });
      toast("recon stopped");
      pollStatus();
    } catch (e) { errMsg(e); }
  });
  $("#btn-log").addEventListener("click", () => {
    const logEl = $("#job-log");
    logEl.classList.toggle("hidden");
    renderLog(state.lastStatus && !state.lastStatus.running ? "" : (state.lastStatus ? state.lastStatus.log_tail : ""));
  });
  $$("#tabs .tab").forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));
  $("#tab-tools").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act=run]");
    if (btn) {
      const card = btn.closest(".tool-card");
      runTool(card);
    }
    if (e.target.closest("#btn-custom")) runCustom();
  });
  $("#tab-report").addEventListener("click", async (e) => {
    if (e.target.closest("#btn-save-report")) saveReport().catch(errMsg);
    if (e.target.closest("#btn-finish")) finishSession().catch(errMsg);
    if (e.target.closest("#btn-truth")) recordTruth().catch(errMsg);
  });
}

function activateTab(name) {
  $$("#tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
}

async function upload(f) {
  const fd = new FormData();
  fd.append("photo", f, f.name);
  $("#dz-text").innerHTML = "<strong>Uploading " + esc(f.name) + "…</strong>";
  try {
    const s = await api("/api/sessions", { method: "POST", body: fd });
    $("#dz-text").innerHTML = "<strong>Drop a photo here</strong> or click to choose";
    location.hash = "#/" + s.name;
    openSession(s.name);
  } catch (e) {
    $("#dz-text").innerHTML = "<strong>Failed:</strong> " + esc(e.message);
  }
}

// ------------------------------------------------------------------- boot
window.addEventListener("DOMContentLoaded", () => {
  initEvents();
  health();
  route();
});
window.openModal = openModal;
window.openSession = openSession;