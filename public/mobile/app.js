// NearPulse 手機版 — 白癡化: 按住說話 → AI 判讀 → 一鍵送出 → 狀況引導
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const api = async (p, o) => {
  const r = await fetch(p, { headers: { "Content-Type": "application/json" }, ...o });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("zh-TW", { hour12: false });

let lang = localStorage.getItem("np_lang") || "zh";
const T = {
  zh: {
    big: "怎麼了？<br/>用說的就好", sub: "按住說話，AI 會自動判斷狀況、整理位置與引導方向",
    hold: "按住開始說話", rec: "正在聽…放開結束", sending: "AI 判讀中…",
    heard: "AI 聽到了：", confirm: "確認送出", redo: "重講一次",
    notHeard: "沒有聽到內容，再試一次",
    gpsIng: "定位中…", gpsOk: "已取得位置", gpsFail: "GPS 無法使用（沒關係，AI 會從你說的話判斷位置）",
    live: "事件進行中", what: "你該怎麼做", safe: "我已到安全處 / 事件結束了",
    more: "補充現況（一樣用說的）", browse: "當前發生狀況",
    noSit: "附近目前沒有回報中的狀況", back: "回到通報",
    thanks: "已送出。AI 正在引導現場，保持手機在身邊",
  },
  en: {
    big: "What happened?<br/>Just say it", sub: "Hold to speak. AI judges the situation, location and guidance",
    hold: "Hold to talk", rec: "Listening… release to finish", sending: "AI analyzing…",
    heard: "AI heard:", confirm: "Confirm & send", redo: "Say again",
    notHeard: "Didn't catch that, try again",
    gpsIng: "Locating…", gpsOk: "Location acquired", gpsFail: "No GPS (that's fine — AI reads your words)",
    live: "LIVE", what: "What you should do", safe: "I'm safe / it's over",
    more: "Add an update (speak again)", browse: "Current situations",
    noSit: "No active reports nearby", back: "Back to report",
    thanks: "Sent. AI is guiding the scene — keep your phone with you",
  },
};
const t = (k) => (T[lang] || T.zh)[k];

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2400);
}

// ---------------------------------------------------------------- 視圖切換
function show(view) {
  for (const id of ["step-say", "step-check", "step-live", "step-browse"]) $("#" + id).classList.add("hidden");
  $("#step-" + view).classList.remove("hidden");
}
$$(".nav-btn").forEach((b) => (b.onclick = () => {
  $$(".nav-btn").forEach((x) => x.classList.toggle("on", x === b));
  show(b.dataset.v === "say" ? "say" : b.dataset.v);
  if (b.dataset.v === "browse") loadBrowse();
}));
$("#btn-browse-back").onclick = () => { $$(".nav-btn")[0].click(); };

// 語言
function applyLang() {
  $("#t-big").innerHTML = t("big");
  $("#t-sub").textContent = t("sub");
  $("#mic-state").textContent = t("hold");
  $("#heard").previousElementSibling || null;
  const h2s = { "step-check": t("heard") };
  const checkH = $("#step-check h2");
  if (checkH) checkH.textContent = t("heard");
  $("#live-label").textContent = t("live");
  $(".g-head").textContent = t("what");
  $("#btn-safe").textContent = t("safe");
  $("#btn-more").textContent = t("more");
  $("#btn-confirm").textContent = t("confirm");
  $("#btn-redo").textContent = t("redo");
  $("#browse-title").textContent = t("browse");
  $("#btn-browse-back").textContent = t("back");
  $("#lang-toggle").textContent = lang === "zh" ? "EN" : "中";
}
$("#lang-toggle").onclick = () => {
  lang = lang === "zh" ? "en" : "zh";
  localStorage.setItem("np_lang", lang);
  applyLang();
};

// ---------------------------------------------------------------- GPS (自動, 失效不擋)
const gps = { lat: null, lng: null };
function requestGps() {
  const el = $("#gps-txt");
  el.textContent = t("gpsIng");
  if (!navigator.geolocation) { el.textContent = t("gpsFail"); return; }
  navigator.geolocation.getCurrentPosition(
    (p) => { gps.lat = p.coords.latitude; gps.lng = p.coords.longitude; el.innerHTML = "<b>" + t("gpsOk") + "</b>"; },
    () => { el.textContent = t("gpsFail"); },
    { timeout: 5000 }
  );
}

// ---------------------------------------------------------------- 語音輸入 (SpeechRecognition — 說的內容是「輸入」，判斷全交給 AI)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recActive = false, pendingText = "";

function startRecognition(onText, onEnd) {
  if (!SR) { toast("此瀏覽器不支援語音（Chrome 最佳）— 可用打字備援"); return false; }
  rec = new SR();
  rec.lang = lang === "zh" ? "zh-TW" : "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  let final = "";
  rec.onresult = (e) => {
    let interim = "";
    for (const r of e.results) r.isFinal ? (final += r[0].transcript) : (interim += r[0].transcript);
    onText(final + interim);
  };
  rec.onend = () => { recActive = false; onEnd(final.trim()); };
  rec.onerror = () => { recActive = false; onEnd(final.trim()); };
  try { rec.start(); recActive = true; } catch { return false; }
  return true;
}

const mic = $("#mic");
mic.addEventListener("pointerdown", (e) => { e.preventDefault(); startMic(); });
mic.addEventListener("pointerup", (e) => { e.preventDefault(); stopMic(); });
mic.addEventListener("pointerleave", () => { if (recActive) stopMic(); });

function startMic() {
  if (recActive) return;
  const okStart = startRecognition(
    (txt) => { pendingText = txt; },
    (txt) => {
      mic.classList.remove("rec");
      $("#mic-state").classList.remove("rec");
      $("#mic-state").textContent = t("hold");
      const final = (txt || pendingText).trim();
      if (!final) { toast(t("notHeard")); return; }
      interpretAndShow(final);
    }
  );
  if (okStart) {
    pendingText = "";
    mic.classList.add("rec");
    $("#mic-state").classList.add("rec");
    $("#mic-state").textContent = t("rec");
  }
}
function stopMic() { if (recActive && rec) { try { rec.stop(); } catch {} } }

// 打字備援
$("#type-send").onclick = () => {
  const v = $("#type-fallback").value.trim();
  if (!v) return;
  $("#type-fallback").value = "";
  interpretAndShow(v);
};

// ---------------------------------------------------------------- AI 判讀卡 (本地即時回饋 + 後端 LLM/規則引擎)
async function interpretAndShow(text) {
  $("#heard-text").textContent = text;
  show("check");
  $("#verdict").innerHTML = `<div class="v-row"><span class="t">${esc(t("sending"))}</span></div>`;
  let v;
  try { v = await api("/api/ai/interpret", { method: "POST", body: JSON.stringify({ text }) }); }
  catch { v = null; }
  renderVerdict(text, v);
  window._pendingReport = { text, v };
}

function renderVerdict(text, v) {
  if (!v) {
    $("#verdict").innerHTML = `<div class="v-row"><span class="t">AI 暫時無回應，仍可直接送出</span></div>`;
    return;
  }
  const sevClass = "s" + (v.severity || 2);
  $("#verdict").innerHTML = `
    <div class="v-row"><span class="k">類型</span><span class="t">${esc(v.kindLabel || "狀況")}${v.sub ? " · " + esc(v.sub) : ""}<span class="v-sev ${sevClass}">${esc(v.severityLabel || "")}</span></span></div>
    ${v.facts.location ? `<div class="v-row"><span class="k">位置</span><span class="t">${esc(v.facts.location)}</span></div>` : ""}
    ${v.facts.injured ? `<div class="v-row"><span class="k">傷患</span><span class="t">${esc(v.facts.injured)}</span></div>` : ""}
    ${v.facts.threat ? `<div class="v-row"><span class="k">威脅</span><span class="t">${esc(v.facts.threat)}</span></div>` : ""}
    ${v.reading ? `<div class="v-row"><span class="k">研判</span><span class="t">${esc(v.reading)}</span></div>` : ""}`;
}

$("#btn-redo").onclick = () => { window._pendingReport = null; show("say"); };

// 確認送出 → 建立事件 → 進入狀況引導視圖
$("#btn-confirm").onclick = async () => {
  const p = window._pendingReport;
  if (!p || !p.text) return;
  const payload = { kind: (p.v && p.v.kind) || "other", text: p.text, severity: (p.v && p.v.severity) || 2 };
  if (p.v && p.v.facts && p.v.facts.location) payload.semantic = p.v.facts.location;
  if (gps.lat) { payload.lat = gps.lat; payload.lng = gps.lng; }
  const btn = $("#btn-confirm");
  btn.disabled = true; btn.textContent = "送出中…";
  try {
    const ev = await api("/api/events", { method: "POST", body: JSON.stringify(payload) });
    toast(t("thanks"));
    enterLive(ev);
  } catch (e) { toast("送出失敗: " + e.message); }
  btn.disabled = false; btn.textContent = t("confirm");
};

// ---------------------------------------------------------------- 狀況引導視圖
let ev = null, ws = null, myVoted = null;

function enterLive(eventData) {
  ev = eventData;
  myVoted = null;
  show("live");
  renderLive();
  openWs(ev.code);
}

function openWs(code) {
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?event=${encodeURIComponent(code)}&name=User${Math.floor(100 + Math.random() * 900)}`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "welcome") {
      Object.assign(ev, m.event, { timeline: m.timeline });
      renderLive();
      if (gps.lat) ws.send(JSON.stringify({ type: "locate", lat: gps.lat, lng: gps.lng }));
    } else if (m.type === "timeline") {
      ev.timeline.push(m.msg);
      appendUpdate(m.msg);
      refreshLiveState();
    }
  };
  ws.onclose = (e) => {
    if (e.code === 4000) { toast("事件已落幕"); show("browse"); loadBrowse(); }
    else if (ev) setTimeout(() => openWs(code), 2500);
  };
}

async function refreshLiveState() {
  if (!ev) return;
  try {
    const j = await api(`/api/events/${ev.code}`);
    Object.assign(ev, j);
    renderLive();
  } catch {}
}

function renderLive() {
  if (!ev) return;
  $("#live-title").textContent = ev.title;
  // 引導 (事件內建 guide 訊息)
  const guides = ev.timeline.filter((m) => m.kind === "guide").map((m) => m.text.replace(/^AI 引導: ?/, ""));
  const list = $("#guide-list");
  list.innerHTML = guides.length
    ? guides.slice(-3).map((g) => `<div>${esc(g)}</div>`).join("")
    : `<div>跟隨現場廣播與 AI 更新</div>`;
  // 事實
  const f = ev.facts || {};
  const pills = [];
  if (f.location) pills.push(`位置 <b>${esc(f.location)}</b>`);
  if (f.injured) pills.push(`傷患 <b>${esc(f.injured)}</b>`);
  if (f.threat) pills.push(`威脅 <b>${esc(f.threat)}</b>`);
  $("#fact-strip").innerHTML = pills.length ? pills.map((p) => `<div class="fact-pill">${p}</div>`).join("") : "";
  // 共識
  const c = ev.consensus;
  $("#consensus").innerHTML = c ? `
    <span class="num">${c.score}</span>
    <div class="bar"><i style="width:${c.score}%"></i></div>
    <div class="vote-btns">
      <button class="ok ${myVoted === true ? "on" : ""}" id="v-yes" type="button">看到</button>
      <button class="no ${myVoted === false ? "on" : ""}" id="v-no" type="button">沒看到</button>
    </div>` : "";
  const vy = $("#v-yes"), vn = $("#v-no");
  if (vy) vy.onclick = () => vote(true);
  if (vn) vn.onclick = () => vote(false);
  // 更新流
  const ups = $("#updates");
  ups.innerHTML = "";
  for (const m of (ev.timeline || []).slice(-30)) appendUpdate(m, true);
  ups.scrollTop = ups.scrollHeight;
}

function appendUpdate(m, silent) {
  const ups = $("#updates");
  if (!ups) return;
  if (!["guide", "fact", "ask", "contra", "vote", "resolved", "report", "assign"].includes(m.kind)) return;
  const d = document.createElement("div");
  d.className = "update " + m.kind;
  d.innerHTML = `<span class="u-time">${fmtTime(m.ts)}</span> ${esc(m.text)}`;
  ups.appendChild(d);
  if (!silent) ups.scrollTop = ups.scrollHeight;
}

function vote(agree) {
  if (!ws || ws.readyState !== 1 || !ev) return;
  myVoted = agree;
  ws.send(JSON.stringify({ type: "verify", agree, voter: "mobile-" + Math.floor(Math.random() * 1e6) }));
  renderLive();
}

// 補充現況: 回到說話 (同一事件, 送出為 chat)
$("#btn-more").onclick = () => {
  if (!ev) return;
  const okStart = startRecognition(
    () => {},
    (txt) => {
      mic.classList.remove("rec");
      if (!txt.trim()) return;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "chat", text: txt.trim() }));
      toast("已補充，AI 更新中");
    }
  );
  if (okStart) { mic.classList.add("rec"); toast(t("rec")); }
};

// 我安全了 → 離開
$("#btn-safe").onclick = async () => {
  if (ev) { try { await api(`/api/events/${ev.code}/verify`, { method: "POST", body: JSON.stringify({ voter: "mobile", agree: false }) }); } catch {} }
  ev = null;
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
  show("say");
};

// ---------------------------------------------------------------- 當前發生狀況
async function loadBrowse() {
  let list;
  try { list = await api("/api/events"); } catch { return; }
  const holder = $("#browse-list");
  if (!list.length) { holder.innerHTML = `<div class="empty">${esc(t("noSit"))}</div>`; return; }
  holder.innerHTML = "";
  for (const e of list) {
    const d = document.createElement("div");
    d.className = "sit-item";
    d.innerHTML = `
      <div class="s-t">${esc(e.title)}</div>
      <div class="s-s">${esc(e.semantic || (e.mode === "gps" ? "GPS 定位" : "位置判斷中"))} · ${e.memberCount} 人在場 · 信心 ${e.consensus ? e.consensus.score : "-"} · ${fmtTime(e.createdAt)}</div>
      <div class="s-g">點擊查看引導與最新狀況</div>`;
    d.onclick = () => enterLive(e);
    holder.appendChild(d);
  }
}

// ---------------------------------------------------------------- 啟動
applyLang();
requestGps();
// QR / 網址帶入 (?join=CODE) — 直接進該事件狀況視圖
const urlJoin = new URLSearchParams(location.search).get("join");
if (urlJoin) {
  api(`/api/events/${urlJoin}`).then((e) => enterLive(e)).catch(() => {});
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
setInterval(() => { if (!$("#step-browse").classList.contains("hidden")) loadBrowse(); }, 5000);
