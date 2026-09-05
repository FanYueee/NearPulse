// NearPulse 手機版 — 白癡化: 按住說話 → AI 判讀 → 逃脫引導 (大字 + 逃脫地圖)
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
    hold: "按住開始說話", rec: "正在聽…放開結束",
    heard: "AI 聽到了：", confirm: "確認送出", redo: "重講一次",
    notHeard: "沒有聽到內容，再試一次",
    gpsOk: "已取得定位", gpsFail: "GPS 無法使用（沒關係，AI 會從你說的話判斷位置）",
    what: "你該怎麼做", safe: "我已到安全處 / 事件結束了",
    browse: "當前發生狀況", noSit: "附近目前沒有回報中的狀況", back: "回到通報",
    thanks: "已送出 — 依上方引導行動，保持手機在身邊",
    moreTitle: "有新狀況？用說的補充", moreHold: "按住補充",
    alertSub: "有人在附近回報事件 — 是你這裡嗎？", alertYes: "是我這裡", alertNo: "不是我",
    nav: "開始導航", far: "你距離回報地點較遠 — 引導以現場標示為準",
  },
  en: {
    big: "What happened?<br/>Just say it", sub: "Hold to speak. AI judges the situation and guides you",
    hold: "Hold to talk", rec: "Listening… release to finish",
    heard: "AI heard:", confirm: "Confirm & send", redo: "Say again",
    notHeard: "Didn't catch that, try again",
    gpsOk: "Location acquired", gpsFail: "No GPS (that's fine — AI reads your words)",
    what: "What you should do", safe: "I'm safe / it's over",
    browse: "Current situations", noSit: "No active reports nearby", back: "Back to report",
    thanks: "Sent — follow the guidance above, keep your phone with you",
    moreTitle: "New development? Speak to add", moreHold: "Hold to add",
    alertSub: "Someone reported an incident nearby — is it here?", alertYes: "It's here", alertNo: "Not here",
    nav: "Navigate", far: "You're far from the report — follow on-site signage",
  },
};
const t = (k) => (T[lang] || T.zh)[k];

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------- 視圖切換
let inEvent = false; // 事件中: 隱藏底部導航與 EN 切換 (逃命不需要)
function show(view) {
  for (const id of ["step-say", "step-check", "step-live", "step-browse"]) $("#" + id).classList.add("hidden");
  $("#step-" + view).classList.remove("hidden");
  const live = view === "live";
  inEvent = live;
  $("#nav").classList.toggle("hidden", live);
  $("#lang-toggle").classList.toggle("hidden", live);
}
$$(".nav-btn").forEach((b) => (b.onclick = () => {
  $$(".nav-btn").forEach((x) => x.classList.toggle("on", x === b));
  show(b.dataset.v === "say" ? "say" : b.dataset.v);
  if (b.dataset.v === "browse") loadBrowse();
}));
$("#btn-browse-back").onclick = () => { $$(".nav-btn")[0].click(); };

// 語言 (label 修正: 顯示「切過去的那個語言」)
function applyLang() {
  $("#t-big").innerHTML = t("big");
  $("#t-sub").textContent = t("sub");
  $("#mic-state").textContent = t("hold");
  const checkH = $("#step-check h2");
  if (checkH) checkH.textContent = t("heard");
  $(".g-head").textContent = t("what");
  $("#btn-safe").textContent = t("safe");
  $("#btn-confirm").textContent = t("confirm");
  $("#btn-redo").textContent = t("redo");
  $("#browse-title").textContent = t("browse");
  $("#btn-browse-back").textContent = t("back");
  $("#more-title") && ($("#more-title").textContent = t("moreTitle"));
  $("#mic2-state") && ($("#mic2-state").textContent = t("moreHold"));
  $("#alert-sub").textContent = t("alertSub");
  $("#alert-yes").textContent = t("alertYes");
  $("#alert-no").textContent = t("alertNo");
  $("#btn-nav") && ($("#btn-nav").textContent = t("nav"));
  // 切換鈕顯示「將切換到的語言」: 中文介面顯示 EN、英文介面顯示 中
  $("#lang-toggle").textContent = lang === "zh" ? "EN" : "中文";
  $("#btn-imok") && ($("#btn-imok").textContent = lang === "zh" ? "報平安 — 告訴家人我安全了" : "I'm OK — tell my family");
  if (!sirenOn) $("#sos-siren").textContent = lang === "zh" ? "聲光警報" : "Siren";
}
$("#lang-toggle").onclick = () => {
  lang = lang === "zh" ? "en" : "zh";
  localStorage.setItem("np_lang", lang);
  applyLang();
  requestGps();
};

// ---------------------------------------------------------------- SOS 工具 (聲光警報 + 快撥)
// 雙頻交替警笛 (WebAudio) + 螢幕閃光 — 危急時引起周圍注意, 不需思考
let sirenCtx = null, sirenOn = false, sirenTimer = null;
$("#sos-siren").onclick = () => {
  if (sirenOn) { stopSiren(); return; }
  sirenOn = true;
  $("#sos-siren").classList.add("active");
  $("#sos-siren").textContent = "停止警報";
  try {
    sirenCtx = sirenCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = sirenCtx.createOscillator();
    const gain = sirenCtx.createGain();
    osc.type = "sawtooth";
    osc.connect(gain);
    gain.connect(sirenCtx.destination);
    gain.gain.value = 0.35;
    osc.start();
    let hi = false;
    sirenTimer = setInterval(() => {
      hi = !hi;
      osc.frequency.setTargetAtTime(hi ? 950 : 620, sirenCtx.currentTime, 0.02);
    }, 450);
    window._sirenOsc = osc;
  } catch { /* 靜音模式裝置仍可閃光 */ }
  // 螢幕閃光
  const flash = document.createElement("div");
  flash.id = "siren-flash";
  document.body.appendChild(flash);
  // 震動
  if (navigator.vibrate) { try { navigator.vibrate([300, 150, 300, 150, 300]); } catch {} }
};

function stopSiren() {
  sirenOn = false;
  $("#sos-siren").classList.remove("active");
  $("#sos-siren").textContent = lang === "zh" ? "聲光警報" : "Siren";
  if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = null; }
  try { if (window._sirenOsc) window._sirenOsc.stop(); } catch {}
  const f = $("#siren-flash");
  if (f) f.remove();
}

// 報平安: 分享「我安全了 + 位置」給家人 (Web Share → 降級 SMS)
$("#btn-imok").onclick = async () => {
  const msg = lang === "zh"
    ? "我在這裡，我安全了。位置："
    : "I'm safe here. Location: ";
  const locPart = gps.lat
    ? `https://maps.google.com/?q=${gps.lat},${gps.lng}`
    : (ev && ev.facts && ev.facts.location ? ev.facts.location : (lang === "zh" ? "位置待確認" : "location TBD"));
  const full = msg + locPart;
  if (navigator.share) {
    try { await navigator.share({ title: "NearPulse", text: full }); return; } catch {}
  }
  location.href = `sms:?&body=${encodeURIComponent(full)}`;
};

// ---------------------------------------------------------------- GPS (自動)
const gps = { lat: null, lng: null };
function requestGps() {
  const el = $("#gps-txt");
  if (!navigator.geolocation) { el.textContent = t("gpsFail"); return; }
  el.textContent = lang === "zh" ? "定位中…" : "Locating…";
  navigator.geolocation.getCurrentPosition(
    (p) => { gps.lat = p.coords.latitude; gps.lng = p.coords.longitude; el.innerHTML = "<b>" + t("gpsOk") + "</b>"; },
    () => { el.textContent = t("gpsFail"); },
    { timeout: 5000 }
  );
}

// ---------------------------------------------------------------- 語音 (說的內容是輸入, 判斷全交給 AI)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recActive = false, pendingText = "";

function startRecognition(onText, onEnd) {
  if (!SR) { toast(lang === "zh" ? "此瀏覽器不支援語音（Chrome 最佳）" : "Voice unsupported (Chrome best)"); return false; }
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

function bindMic(btnSel, stateSel, onDone) {
  const btn = $(btnSel), st = $(stateSel);
  const start = (e) => {
    e.preventDefault();
    if (recActive) return;
    const okStart = startRecognition(() => {}, (txt) => {
      btn.classList.remove("rec");
      st.classList.remove("rec");
      st.textContent = btnSel === "#mic" ? t("hold") : t("moreHold");
      onDone(txt || "");
    });
    if (okStart) { btn.classList.add("rec"); st.classList.add("rec"); st.textContent = t("rec"); }
  };
  const stop = (e) => { e.preventDefault(); if (recActive && rec) { try { rec.stop(); } catch {} } };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", () => { if (recActive) stop(new Event("x")); });
}

// 主麥克風: 說完 → AI 判讀卡
bindMic("#mic", "#mic-state", (txt) => {
  if (!txt) { toast(t("notHeard")); return; }
  interpretAndShow(txt);
});

// 補充麥克風: 說完 → 送進當前事件
bindMic("#mic2", "#mic2-state", (txt) => {
  if (!txt) { toast(t("notHeard")); return; }
  if (ws && ws.readyState === 1 && ev) {
    ws.send(JSON.stringify({ type: "chat", text: txt }));
    toast(lang === "zh" ? "已補充，AI 更新中" : "Added — AI updating");
  }
});

// 打字備援
$("#type-send").onclick = () => {
  const v = $("#type-fallback").value.trim();
  if (!v) return;
  $("#type-fallback").value = "";
  interpretAndShow(v);
};

// ---------------------------------------------------------------- AI 判讀卡
async function interpretAndShow(text) {
  $("#heard-text").textContent = text;
  show("check");
  $("#verdict").innerHTML = `<div class="v-row"><span class="t">${esc(lang === "zh" ? "AI 判讀中…" : "AI analyzing…")}</span></div>`;
  let v;
  try { v = await api("/api/ai/interpret", { method: "POST", body: JSON.stringify({ text }) }); }
  catch { v = null; }
  renderVerdict(v);
  window._pendingReport = { text, v };
}

function renderVerdict(v) {
  if (!v) {
    $("#verdict").innerHTML = `<div class="v-row"><span class="t">${esc(lang === "zh" ? "AI 暫時無回應，仍可直接送出" : "No AI response — you can still send")}</span></div>`;
    return;
  }
  const sevClass = "s" + (v.severity || 2);
  $("#verdict").innerHTML = `
    <div class="v-row"><span class="k">${lang === "zh" ? "類型" : "Type"}</span><span class="t">${esc(v.kindLabel || "")}${v.sub ? " · " + esc(v.sub) : ""}<span class="v-sev ${sevClass}">${esc(v.severityLabel || "")}</span></span></div>
    ${v.facts.location ? `<div class="v-row"><span class="k">${lang === "zh" ? "位置" : "Where"}</span><span class="t">${esc(v.facts.location)}</span></div>` : ""}
    ${v.facts.injured ? `<div class="v-row"><span class="k">${lang === "zh" ? "傷患" : "Injured"}</span><span class="t">${esc(v.facts.injured)}</span></div>` : ""}
    ${v.facts.threat ? `<div class="v-row"><span class="k">${lang === "zh" ? "威脅" : "Threat"}</span><span class="t">${esc(v.facts.threat)}</span></div>` : ""}
    ${v.reading ? `<div class="v-row"><span class="k">${lang === "zh" ? "研判" : "Note"}</span><span class="t">${esc(v.reading)}</span></div>` : ""}`;
}

$("#btn-redo").onclick = () => { window._pendingReport = null; show("say"); };

$("#btn-confirm").onclick = async () => {
  const p = window._pendingReport;
  if (!p || !p.text) return;
  const payload = { kind: (p.v && p.v.kind) || "other", text: p.text, severity: (p.v && p.v.severity) || 2 };
  if (p.v && p.v.facts && p.v.facts.location) payload.semantic = p.v.facts.location;
  if (gps.lat) { payload.lat = gps.lat; payload.lng = gps.lng; }
  const btn = $("#btn-confirm");
  btn.disabled = true; btn.textContent = lang === "zh" ? "送出中…" : "Sending…";
  try {
    const evn = await api("/api/events", { method: "POST", body: JSON.stringify(payload) });
    toast(t("thanks"));
    enterLive(evn);
  } catch (e) { toast("Send failed: " + e.message); }
  btn.disabled = false; btn.textContent = t("confirm");
};

// ---------------------------------------------------------------- 協助頁 (事件中)
let ev = null, ws = null;

function enterLive(eventData) {
  ev = eventData;
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
      refreshLiveState();
    }
  };
  ws.onclose = (e) => {
    if (e.code === 4000) { toast(lang === "zh" ? "事件已落幕" : "Event resolved"); show("browse"); loadBrowse(); }
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
  $("#live-title") && ($("#live-title").textContent = ev.title);
  // 引導 (大字)
  const guides = ev.timeline.filter((m) => m.kind === "guide").map((m) => m.text.replace(/^AI 引導: ?/, ""));
  const list = $("#guide-list");
  list.innerHTML = guides.length
    ? guides.slice(-3).map((g) => `<div>${esc(g)}</div>`).join("")
    : `<div>${lang === "zh" ? "跟隨現場廣播與 AI 更新" : "Follow announcements and AI updates"}</div>`;
  // 事實膠囊
  const f = ev.facts || {};
  const pills = [];
  if (f.location) pills.push(`${lang === "zh" ? "位置" : "Where"} <b>${esc(f.location)}</b>`);
  if (f.injured) pills.push(`${lang === "zh" ? "傷患" : "Injured"} <b>${esc(f.injured)}</b>`);
  if (f.threat) pills.push(`${lang === "zh" ? "威脅" : "Threat"} <b>${esc(f.threat)}</b>`);
  $("#fact-strip").innerHTML = pills.length ? pills.map((p) => `<div class="fact-pill">${p}</div>`).join("") : "";
  renderEscapeMap();
}

// ---------------------------------------------------------------- 逃脫地圖 (OSM + Leaflet)
let escapeMap = null, escapeReady = null;

function loadLeaflet() {
  if (escapeReady) return escapeReady;
  escapeReady = new Promise((resolve) => {
    if (typeof L !== "undefined") return resolve(true);
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return escapeReady;
}

async function renderEscapeMap() {
  if (!ev) return;
  const wrap = $("#escape-wrap");
  // 事故點 + 使用者定位都齊才有逃脫地圖; 否則只靠語意引導
  const evLat = ev.lat, evLng = ev.lng;
  if (!isFinite(evLat) || !isFinite(evLng) || !gps.lat) { wrap.classList.add("hidden"); return; }
  const ok = await loadLeaflet();
  if (!ok) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  try {
    const fwd = await api(`/api/geo/forward?lat=${evLat}&lng=${evLng}&elat=${gps.lat}&elng=${gps.lng}`);
    if (!fwd.near) {
      // 距離過遠 (demo 座標在異國): 只顯示提示不畫地圖
      wrap.classList.add("hidden");
      toast(t("far"));
      return;
    }
    $("#btn-nav").onclick = () => { window.open(fwd.gmaps, "_blank"); };
    if (!escapeMap) {
      escapeMap = L.map("escape-map", { zoomControl: false, attributionControl: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(escapeMap);
      // 危險點 (紅)
      L.marker([evLat, evLng], {
        icon: L.divIcon({ className: "", html: `<div class="np-danger"><span>!</span></div>`, iconSize: [22, 22], iconAnchor: [11, 22] }),
      }).addTo(escapeMap).bindPopup(lang === "zh" ? "事故地點" : "Incident");
      // 使用者 (藍)
      L.marker([gps.lat, gps.lng], {
        icon: L.divIcon({ className: "", html: `<div class="np-you"><span></span></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
      }).addTo(escapeMap).bindPopup(lang === "zh" ? "你的位置" : "You");
      // 安全方向 (綠, 可點開導航)
      L.marker([fwd.safe.lat, fwd.safe.lng], {
        icon: L.divIcon({ className: "", html: `<div class="np-safe"><span>&#10003;</span></div>`, iconSize: [24, 24], iconAnchor: [12, 24] }),
      }).addTo(escapeMap)
        .bindPopup(lang === "zh" ? "建議前往的安全方向<br/>點「開始導航」" : "Suggested safe direction");
      escapeMap.fitBounds([[evLat, evLng], [gps.lat, gps.lng], [fwd.safe.lat, fwd.safe.lng]], { padding: [24, 24] });
    }
  } catch { wrap.classList.add("hidden"); }
}

// 我安全了 → 回主畫面
$("#btn-safe").onclick = () => {
  ev = null;
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
  show("say");
  $$(".nav-btn").forEach((x) => x.classList.toggle("on", x.dataset.v === "say"));
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
      <div class="s-s">${esc(e.semantic || "")} · ${fmtTime(e.createdAt)}</div>
      <div class="s-g">${lang === "zh" ? "點擊查看引導" : "Tap for guidance"}</div>`;
    d.onclick = () => enterLive(e);
    holder.appendChild(d);
  }
}

// ---------------------------------------------------------------- 緊急橫幅: 後台測試 → 附近有狀況?
let alertedCodes = new Set(JSON.parse(localStorage.getItem("np_alerted") || "[]"));
let bannerPollTimer = null;

async function pollAlerts() {
  if (inEvent || !$("#alert-banner").classList.contains("hidden")) return;
  let list;
  try { list = await api("/api/events"); } catch { return; }
  const near = list.filter((e) => !alertedCodes.has(e.code));
  if (!near.length) return;
  // 有定位 → 只推 2km 內; 沒定位 → 全推 (寧可誤報不可漏報)
  const target = near[0];
  $("#alert-title").textContent = target.title;
  $("#alert-banner").classList.remove("hidden");
  // 震動提醒 (支援的裝置)
  if (navigator.vibrate) { try { navigator.vibrate([180, 90, 180]); } catch {} }
  $("#alert-yes").onclick = () => {
    $("#alert-banner").classList.add("hidden");
    alertedCodes.add(target.code);
    localStorage.setItem("np_alerted", JSON.stringify([...alertedCodes]));
    enterLive(target);
  };
  $("#alert-no").onclick = () => {
    $("#alert-banner").classList.add("hidden");
    alertedCodes.add(target.code);
    localStorage.setItem("np_alerted", JSON.stringify([...alertedCodes]));
  };
}

// ---------------------------------------------------------------- 啟動
applyLang();
requestGps();
const urlJoin = new URLSearchParams(location.search).get("join");
if (urlJoin) {
  api(`/api/events/${urlJoin}`).then((e) => enterLive(e)).catch(() => {});
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
setInterval(() => {
  if (!$("#step-browse").classList.contains("hidden")) loadBrowse();
  pollAlerts(); // 緊急橫幅輪詢 (後台測試 → 手機即時收到)
}, 5000);
