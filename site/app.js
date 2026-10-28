"use strict";

/* ---------------------------------------------------------- ayarlar ---- */

const FALLBACK_REPO = "thedrowned925/indir";
const API = "https://api.github.com";
const LS = { repo: "indir.repo", token: "indir.token", jobs: "indir.jobs", form: "indir.form" };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* yoksay */ } },
};

function detectRepo() {
  const saved = store.get(LS.repo, "");
  if (saved) return saved;
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  const seg = location.pathname.split("/").filter(Boolean)[0];
  if (m && seg) return `${m[1]}/${seg}`;
  if (m) return `${m[1]}/${m[1]}.github.io`;
  return FALLBACK_REPO;
}

let REPO = detectRepo();
let TOKEN = store.get(LS.token, "");

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, ms = 3500) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

function fmtSize(n) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtDur(s) {
  if (!s) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(x).padStart(2, "0");
}

/* ------------------------------------------------------------ form ----- */

let mode = "video";
const LOSSLESS = new Set(["flac", "wav", "alac"]);
const NO_THUMB_AUDIO = new Set(["wav", "aac"]);

function chipValue(name) {
  return $(`.chips[data-name="${name}"] .on`)?.dataset.v;
}

function setMode(m) {
  mode = m;
  $$(".tab[data-mode]").forEach((t) => t.classList.toggle("active", t.dataset.mode === m));
  $$(".pane").forEach((p) => (p.hidden = p.dataset.pane !== m));
  refreshUi();
}

function refreshUi() {
  const af = chipValue("audio_format");
  $("#aqField").classList.toggle("dim", LOSSLESS.has(af) || af === "best");
  $("#bdField").classList.toggle("dim", !LOSSLESS.has(af));
  $$(".dep").forEach((d) => d.classList.toggle("off", !$("#" + d.dataset.dep).checked));

  const q = chipValue("quality");
  const codec = $("#vcodec").value;
  const warn = ["compat", "h264"].includes(codec) && ["4320", "2160", "1440"].includes(q);
  $("#codecHint").style.color = warn ? "var(--warn)" : "";

  let h = "";
  if (mode === "video") {
    const fid = $("#format_id").value.trim();
    h = fid ? `Format: ${fid} → ${$("#container").value.toUpperCase()}`
            : `${q === "best" ? "En iyi kalite" : q + "p"} · ${$("#container").value.toUpperCase()} · ${$("#vcodec").selectedOptions[0].text}`;
  } else {
    h = `${$(`.chips[data-name="audio_format"] .on`).textContent}`;
    if (!LOSSLESS.has(af) && af !== "best") h += ` · ${$("#audio_quality").selectedOptions[0].text}`;
    if ($("#sample_rate").value !== "orig") h += ` · ${$("#sample_rate").selectedOptions[0].text}`;
    if (LOSSLESS.has(af) && $("#bit_depth").value !== "orig") h += ` · ${$("#bit_depth").value}-bit`;
  }
  $("#modeHint").textContent = h;
  saveForm();
}

const FORM_IDS = ["container", "vcodec", "fps", "subs", "auto_subs", "embed_subs", "sub_langs", "audio_quality",
  "sample_rate", "bit_depth", "channels", "metadata", "thumbnail", "chapters", "precise_cut", "playlist_items"];

function saveForm() {
  const f = { mode, quality: chipValue("quality"), audio_format: chipValue("audio_format") };
  FORM_IDS.forEach((id) => { const el = $("#" + id); f[id] = el.type === "checkbox" ? el.checked : el.value; });
  f.sponsor = $$("#sponsor input:checked").map((i) => i.value);
  store.set(LS.form, f);
}

function loadForm() {
  const f = store.get(LS.form, null);
  if (!f) return;
  FORM_IDS.forEach((id) => {
    const el = $("#" + id);
    if (!(id in f)) return;
    if (el.type === "checkbox") el.checked = !!f[id]; else el.value = f[id];
  });
  for (const name of ["quality", "audio_format"]) {
    const b = $(`.chips[data-name="${name}"] [data-v="${f[name]}"]`);
    if (b) { $$(`.chips[data-name="${name}"] button`).forEach((x) => x.classList.remove("on")); b.classList.add("on"); }
  }
  $$("#sponsor input").forEach((i) => (i.checked = (f.sponsor || []).includes(i.value)));
  setMode(f.mode === "audio" ? "audio" : "video");
}

function buildRequest(forceMode) {
  const url = $("#url").value.trim();
  const r = { url, mode: forceMode || mode };
  if (r.mode === "info") return r;

  const common = {
    metadata: $("#metadata").checked,
    thumbnail: $("#thumbnail").checked,
    chapters: $("#chapters").checked,
  };
  const start = $("#start").value.trim(), end = $("#end").value.trim();
  if (start || end) Object.assign(common, { start, end, precise_cut: $("#precise_cut").checked });
  if ($("#playlist").checked) Object.assign(common, { playlist: true, playlist_items: $("#playlist_items").value.trim() || "1:25" });
  const sb = $$("#sponsor input:checked").map((i) => i.value);
  if (sb.length) common.sponsorblock = sb;

  if (r.mode === "video") {
    Object.assign(r, {
      quality: chipValue("quality"),
      container: $("#container").value,
      vcodec: $("#vcodec").value,
      fps: $("#fps").value,
    });
    const fid = $("#format_id").value.trim();
    if (fid) r.format_id = fid;
    if ($("#subs").checked) Object.assign(r, {
      subs: true, auto_subs: $("#auto_subs").checked, embed_subs: $("#embed_subs").checked, sub_langs: $("#sub_langs").value.trim(),
    });
  } else {
    const af = chipValue("audio_format");
    Object.assign(r, {
      audio_format: af,
      audio_quality: $("#audio_quality").value,
      sample_rate: $("#sample_rate").value,
      bit_depth: $("#bit_depth").value,
      channels: $("#channels").value,
    });
    if (NO_THUMB_AUDIO.has(af)) common.thumbnail = false;
  }
  return Object.assign(r, common);
}

function describe(r) {
  if (r.mode === "info") return "Format listesi";
  if (r.mode === "audio") {
    const names = { mp3: "MP3", m4a: "M4A", aac: "AAC", opus: "Opus", vorbis: "OGG", flac: "FLAC", wav: "WAV", alac: "ALAC", best: "Orijinal ses" };
    let s = names[r.audio_format] || r.audio_format;
    if (!LOSSLESS.has(r.audio_format) && r.audio_format !== "best") s += " " + r.audio_quality.replace(/^(\d)$/, "V$1");
    if (r.sample_rate !== "orig") s += ` ${r.sample_rate / 1000}kHz`;
    if (LOSSLESS.has(r.audio_format) && r.bit_depth !== "orig") s += ` ${r.bit_depth}-bit`;
    return s;
  }
  if (r.format_id) return `Format ${r.format_id} · ${r.container.toUpperCase()}`;
  return `${r.quality === "best" ? "En iyi" : r.quality + "p"} · ${r.container.toUpperCase()}`;
}

/* ---------------------------------------------------------- GitHub ----- */

const etags = new Map();
let rateLeft = null;

async function api(path, opts = {}) {
  const headers = { Accept: "application/vnd.github+json", ...(opts.headers || {}) };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const cached = opts.method ? null : etags.get(path);
  if (cached) headers["If-None-Match"] = cached.etag;
  const res = await fetch(API + path, { ...opts, headers, cache: "no-store" });
  const left = res.headers.get("x-ratelimit-remaining");
  if (left != null) rateLeft = +left;
  if (res.status === 304 && cached) return cached.data;
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += " " + (await res.json()).message; } catch { /* yoksay */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const et = res.headers.get("etag");
  if (et && !opts.method) etags.set(path, { etag: et, data });
  return data;
}

function issueTitle(job) {
  let host = "";
  try { host = new URL(job.req.url).hostname.replace(/^www\./, ""); } catch { /* yoksay */ }
  return `[indir] ${job.id} · ${describe(job.req)} · ${host}`;
}

function issueBody(job) {
  return [
    `**${describe(job.req)}** — ${job.req.url}`,
    "",
    "Bu issue [indir sitesi](" + location.href.split("#")[0] + ") tarafından oluşturuldu. Değiştirmeden **Submit new issue**'ya bas.",
    "",
    "```json",
    JSON.stringify(job.req, null, 2),
    "```",
  ].join("\n");
}

/* ---------------------------------------------------------- işler ------ */

let jobs = store.get(LS.jobs, []);
const saveJobs = () => store.set(LS.jobs, jobs.slice(0, 50));

function newId() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 8);
}

async function submit(forceMode) {
  const req = buildRequest(forceMode);
  try { new URL(req.url); } catch { toast("Önce geçerli bir bağlantı yapıştır."); $("#url").focus(); return; }

  const job = { id: newId(), req, status: "pending", created: Date.now() };
  jobs.unshift(job);
  saveJobs();
  render();

  if (TOKEN) {
    try {
      const issue = await api(`/repos/${REPO}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: issueTitle(job), body: issueBody(job) }),
      });
      job.number = issue.number;
      job.status = "queued";
    } catch (e) {
      job.status = "error";
      job.error = "Issue açılamadı: " + e.message + (e.status === 401 || e.status === 403 ? " (token geçersiz ya da Issues: write izni yok)" : "");
    }
  } else {
    openIssueTab(job);
  }
  saveJobs();
  render();
  poll(true);
}

function newIssueUrl(job) {
  const q = new URLSearchParams({ title: issueTitle(job), body: issueBody(job) });
  return `https://github.com/${REPO}/issues/new?${q}`;
}

function openIssueTab(job) {
  const w = window.open(newIssueUrl(job), "_blank", "noopener");
  if (!w) toast("Açılır pencere engellendi — karttaki “GitHub'da aç” bağlantısını kullan.", 6000);
  else toast("GitHub sekmesinde “Submit new issue”a bas, sonra buraya dön.", 6000);
}

function parseComment(body) {
  const m = body.match(/<!-- indir:(\w+) -->/);
  if (!m) return null;
  const j = body.match(/```json\s*([\s\S]*?)```/);
  let data = null;
  if (j) { try { data = JSON.parse(j[1]); } catch { /* yoksay */ } }
  return { kind: m[1], data };
}

async function findIssues() {
  const waiting = jobs.filter((j) => !j.number && j.status === "pending");
  if (!waiting.length) return;
  const list = await api(`/repos/${REPO}/issues?state=all&sort=created&direction=desc&per_page=30`);
  for (const j of waiting) {
    const hit = list.find((i) => !i.pull_request && i.title.includes(`[indir] ${j.id}`));
    if (hit) { j.number = hit.number; j.status = "queued"; }
    else if (Date.now() - j.created > 30 * 60e3) { j.status = "error"; j.error = "Issue bulunamadı. GitHub'da “Submit”e bastın mı?"; }
  }
}

async function checkJob(j) {
  const comments = await api(`/repos/${REPO}/issues/${j.number}/comments?per_page=50`);
  for (const c of comments) {
    const p = parseComment(c.body || "");
    if (!p) continue;
    if (p.kind === "status" && j.status === "queued") j.status = "running";
    if (p.kind === "result") { j.status = "done"; j.files = p.data?.files || []; j.release = p.data?.release; j.partial = p.data?.partial; }
    if (p.kind === "info") { j.status = "done"; j.info = p.data; showFormats(p.data, j); }
    if (p.kind === "error") { j.status = "error"; j.error = p.data?.message || "Bilinmeyen hata"; j.run = p.data?.run; }
  }
  if (!["done", "error"].includes(j.status)) {
    const issue = await api(`/repos/${REPO}/issues/${j.number}`);
    if (issue.state === "closed" && Date.now() - new Date(issue.closed_at).getTime() > 60e3) {
      j.status = "error";
      j.error = "Issue yorum olmadan kapandı. İş akışı çalışmamış olabilir (Actions sekmesine bak).";
    }
  }
}

let pollTimer = null;
let busy = false;

async function poll(now) {
  clearTimeout(pollTimer);
  const active = jobs.filter((j) => ["pending", "queued", "running"].includes(j.status));
  if (!active.length) return;
  if (!now) {
    if (!busy) {
      busy = true;
      try {
        await findIssues();
        for (const j of active.filter((x) => x.number)) await checkJob(j);
      } catch (e) {
        if (e.status === 403 || e.status === 429) toast("GitHub API sınırına ulaşıldı. Ayarlara token eklersen sınır kalkar.", 6000);
        else if (e.status === 404) toast(`Depo bulunamadı: ${REPO} (Ayarlar'dan düzelt)`, 6000);
        else console.warn(e);
      } finally {
        busy = false;
      }
      saveJobs();
      render();
    }
  }
  const delay = TOKEN ? 5000 : (rateLeft != null && rateLeft < 15 ? 60000 : 12000);
  pollTimer = setTimeout(() => poll(false), now ? 4000 : delay);
}

/* ---------------------------------------------------------- çizim ------ */

const STATUS = {
  pending: ["run", "GitHub'da onay bekleniyor"],
  queued: ["run", "Sırada"],
  running: ["run", "İndiriliyor"],
  done: ["ok", "Hazır"],
  error: ["err", "Hata"],
};

function render() {
  const box = $("#jobs");
  if (!jobs.length) { box.innerHTML = '<p class="empty">Henüz indirme yok.</p>'; return; }
  box.innerHTML = jobs.map((j) => {
    const [cls, label] = STATUS[j.status] || ["", j.status];
    const spinning = cls === "run" ? '<span class="spin"></span>' : "";
    const title = j.files?.[0]?.name || j.info?.title || j.req.url;
    let extra = "";
    if (j.files?.length) {
      extra += '<div class="files">' + j.files.map((f) =>
        `<a class="dl" href="${esc(f.url)}" download><span class="i">⬇</span><span class="n">${esc(f.name)}</span><span class="s">${fmtSize(f.size)}</span></a>`
      ).join("") + "</div>";
      if (j.partial) extra += '<p class="hint">Bazı öğeler indirilemedi.</p>';
    }
    if (j.error) extra += `<div class="errbox">${esc(j.error)}</div>`;
    const acts = [];
    if (j.status === "pending" && !TOKEN) acts.push(`<a href="${esc(newIssueUrl(j))}" target="_blank" rel="noopener">GitHub'da aç</a>`);
    if (j.number) acts.push(`<a href="https://github.com/${esc(REPO)}/issues/${j.number}" target="_blank" rel="noopener">Issue #${j.number}</a>`);
    if (j.run) acts.push(`<a href="${esc(j.run)}" target="_blank" rel="noopener">Günlük</a>`);
    if (j.info) acts.push(`<button class="ghost small" data-act="formats" data-id="${j.id}">Formatları göster</button>`);
    if (["done", "error"].includes(j.status)) acts.push(`<button class="ghost small" data-act="retry" data-id="${j.id}">Tekrar</button>`);
    acts.push(`<button class="ghost small" data-act="del" data-id="${j.id}">Sil</button>`);
    return `<div class="job">
      <div class="row1"><span class="t" title="${esc(title)}">${esc(title)}</span><span class="badge ${cls}">${spinning}${label}</span></div>
      <div class="meta">${esc(describe(j.req))} · ${esc(j.req.url)} · ${new Date(j.created).toLocaleString("tr-TR")}</div>
      ${extra}
      <div class="actions">${acts.join("")}</div>
    </div>`;
  }).join("");
}

function showFormats(info, job) {
  if (!info) return;
  const box = $("#formatsBox");
  box.hidden = false;
  box.dataset.url = job?.req.url || "";
  $("#fTitle").textContent = info.title || "";
  $("#fMeta").textContent = [info.uploader, fmtDur(info.duration), info.extractor, `${info.formats.length} format`].filter(Boolean).join(" · ");
  $("#fThumb").src = info.thumbnail || "";
  $("#fThumb").hidden = !info.thumbnail;
  const filter = $('input[name="ff"]:checked').value;
  const rows = info.formats.filter((f) => filter === "all" || (filter === "video" ? f.vc : !f.vc && f.ac));
  $("#fTable tbody").innerHTML = rows.slice().reverse().map((f) => {
    const kind = f.vc && f.ac ? "av" : f.vc ? "v" : "a";
    const br = f.tbr ? f.tbr + "k" : f.abr ? f.abr + "k" : "";
    return `<tr data-id="${esc(f.id)}" data-kind="${kind}">
      <td><b>${esc(f.id)}</b></td><td>${esc(f.ext)}</td><td>${esc(f.res || "")}${f.dr && f.dr !== "SDR" ? " " + esc(f.dr) : ""}</td>
      <td>${esc(f.fps || "")}</td><td>${esc(f.vc || "—")}</td><td>${esc(f.ac || "—")}${f.asr ? " " + f.asr / 1000 + "k" : ""}</td>
      <td>${br}</td><td>${fmtSize(f.size)}</td><td>${esc([f.note, f.lang].filter(Boolean).join(" "))}</td></tr>`;
  }).join("");
  box._info = info;
}

/* ----------------------------------------------------------- olaylar --- */

$$(".tab[data-mode]").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
$$(".chips").forEach((c) => c.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $$("button", c).forEach((x) => x.classList.toggle("on", x === b));
  if (c.dataset.name === "quality") $("#format_id").value = "";
  refreshUi();
}));
$("#form").addEventListener("input", refreshUi);
$("#form").addEventListener("change", refreshUi);
$("#form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
$("#infoBtn").addEventListener("click", () => submit("info"));
$("#pasteBtn").addEventListener("click", async () => {
  try { $("#url").value = (await navigator.clipboard.readText()).trim(); } catch { toast("Pano okunamadı; elle yapıştır."); }
});

$("#jobs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const j = jobs.find((x) => x.id === b.dataset.id);
  if (!j) return;
  if (b.dataset.act === "del") jobs = jobs.filter((x) => x !== j);
  if (b.dataset.act === "formats") { showFormats(j.info, j); $("#formatsBox").scrollIntoView({ behavior: "smooth" }); }
  if (b.dataset.act === "retry") { $("#url").value = j.req.url; window.scrollTo({ top: 0, behavior: "smooth" }); }
  saveJobs();
  render();
});
$("#clearBtn").addEventListener("click", () => {
  if (!confirm("Tüm indirme geçmişi bu tarayıcıdan silinsin mi? (GitHub'daki dosyalar etkilenmez)")) return;
  jobs = []; saveJobs(); render();
});

$("#fClose").addEventListener("click", () => ($("#formatsBox").hidden = true));
$$('input[name="ff"]').forEach((r) => r.addEventListener("change", () => showFormats($("#formatsBox")._info)));
$("#fTable tbody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const id = tr.dataset.id, kind = tr.dataset.kind;
  $$("#fTable tr.sel").forEach((x) => x.classList.remove("sel"));
  tr.classList.add("sel");
  const url = $("#formatsBox").dataset.url;
  if (url) $("#url").value = url;
  setMode("video");
  $("#format_id").value = kind === "v" ? `${id}+ba` : id;
  if (kind === "a") $("#container").value = "mkv";
  refreshUi();
  toast(`Format ${$("#format_id").value} seçildi — “İndir”e bas.`);
  $("#form").scrollIntoView({ behavior: "smooth" });
});

const dlg = $("#settings");
$("#settingsBtn").addEventListener("click", () => {
  $("#sRepo").value = REPO;
  $("#sToken").value = TOKEN;
  dlg.showModal();
});
dlg.addEventListener("close", () => {
  if (dlg.returnValue !== "save") return;
  const repo = $("#sRepo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) { REPO = repo; store.set(LS.repo, repo); }
  TOKEN = $("#sToken").value.trim();
  store.set(LS.token, TOKEN);
  etags.clear();
  setRepoLink();
  render();
  toast("Kaydedildi.");
  poll(true);
});

function setRepoLink() {
  $("#repoLink").innerHTML = `<a href="https://github.com/${esc(REPO)}" target="_blank" rel="noopener">${esc(REPO)}</a>`;
}

// URL'de ?url=… varsa doldur (paylaşım / yer imi için)
const qp = new URLSearchParams(location.search).get("url");
if (qp) $("#url").value = qp;

document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(false); });

loadForm();
setRepoLink();
refreshUi();
render();
poll(true);
