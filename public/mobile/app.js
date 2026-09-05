// NearPulse 前端 — 語音優先通報 / GPS 自動請求 / 極簡操作
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const api = async (path, opts) => {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
};

let ws = null;
let ev = null;
let myName = null;
let meta = { kinds: {}, severities: [], zones: [] };

// ---------------------------------------------------------------- i18n (zh / en — 異國旅客情境)
const I18N_TEXT = {
  zh: {
    tagline: "事件觸發的臨時群組 — 掃碼即入、AI 整理、用完即散",
    gpsLabel: "定位", gpsRequesting: "請求中…", gpsOk: "已取得",
    gpsFail: "GPS 無法使用 — 沒關係，用下方「看周遭大字」定位",
    reportTitle: "通報突發事件",
    reportDesc: "目擊現場狀況？可以用說的。AI 會即時轉文字並判讀情境，代填表單。",
    whereAreYou: "你在哪裡？",
    whereHint: "看周遭的大字告訴系統 — 不確定就跳過",
    voiceBtn: "用說的通報", createBtn: "建立事件群組",
  },
  en: {
    tagline: "Event-based temporary groups — scan to join, AI-organized, gone when done",
    gpsLabel: "Location", gpsRequesting: "requesting…", gpsOk: "acquired",
    gpsFail: "No GPS down here — that's fine: tell us what signs you see below",
    reportTitle: "Report an incident",
    reportDesc: "Speak, don't type. AI transcribes and fills the form for you.",
    whereAreYou: "Where are you?",
    whereHint: "Tell us the big letters/signs around you — skip if unsure",
    voiceBtn: "Report by voice", createBtn: "Create event group",
  },
};
let lang = localStorage.getItem("np_lang") || "zh";
function I18N() { return I18N_TEXT[lang] || I18N_TEXT.zh; }
function applyI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const k = el.dataset.i18n;
    if (I18N()[k]) el.textContent = I18N()[k];
  }
  const lt = $("#lang-toggle");
  if (lt) lt.textContent = lang === "zh" ? "EN" : "中";
}
$("#lang-toggle").onclick = () => {
  lang = lang === "zh" ? "en" : "zh";
  localStorage.setItem("np_lang", lang);
  applyI18n();
  requestGps(); // 重刷 GPS 行文案
};
applyI18n();

// ---------------------------------------------------------------- toast / util
function toast(t) {
  const el = $("#toast");
  el.textContent = t;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("zh-TW", { hour12: false });

// ---------------------------------------------------------------- 隱藏拉出選單 (電腦版)
const drawer = $("#drawer");
$("#drawer-handle").onclick = () => drawer.classList.add("open");
$("#drawer-close").onclick = () => drawer.classList.remove("open");
$("#drawer-scrim").onclick = () => drawer.classList.remove("open");

// ---------------------------------------------------------------- GPS: 進頁自動請求
const gps = { lat: null, lng: null, addr: null };
function requestGps() {
  if (!navigator.geolocation) { $("#gps-txt").textContent = I18N()[GPS_FAIL_KEY]; return; }
  $("#gps-txt").textContent = I18N().gpsRequesting;
  navigator.geolocation.getCurrentPosition(
    async (p) => {
      gps.lat = p.coords.latitude;
      gps.lng = p.coords.longitude;
      $("#gps-txt").textContent = I18N().gpsOk;
      try {
        const g = await api(`/api/geo/reverse?lat=${gps.lat}&lng=${gps.lng}`);
        if (g.place) {
          gps.addr = g.place;
          $("#gps-addr").textContent = " — " + g.place;
        }
      } catch { /* 反查失敗不影響 */ }
    },
    () => { $("#gps-txt").textContent = I18N()[GPS_FAIL_KEY]; },
    { timeout: 6000, enableHighAccuracy: true }
  );
}
const GPS_FAIL_KEY = "gpsFail";
$("#gps-txt").closest(".gps-line").onclick = () => { if (!gps.lat) requestGps(); };
requestGps(); // 進頁即自動請求

// ---------------------------------------------------------------- 語音引擎 (SpeechRecognition)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recActive = false;
function startRecognition(onText, onEnd) {
  if (!SR) { toast("此瀏覽器不支援語音辨識 (建議 Chrome)"); return false; }
  rec = new SR();
  rec.lang = "zh-TW";
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (const r of e.results) r.isFinal ? (finalText += r[0].transcript) : (interim += r[0].transcript);
    onText(finalText + interim);
  };
  rec.onend = () => { recActive = false; onEnd(finalText.trim()); };
  rec.onerror = () => { recActive = false; onEnd(finalText.trim()); };
  rec.start();
  recActive = true;
  return true;
}

// ---------------------------------------------------------------- 通報表單: 分類/細項/嚴重度 (由 meta 動態生成)
let repKind = null;
let repSub = null;
let repSev = null;

function renderKinds() {
  const k = $("#kinds");
  k.innerHTML = "";
  for (const [id, def] of Object.entries(meta.kinds)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = def.label;
    b.onclick = () => {
      repKind = id; repSub = null;
      $$("#kinds button").forEach((x) => x.classList.toggle("on", x === b));
      renderSubs();
    };
    k.appendChild(b);
  }
  $("#sev-row").innerHTML = "";
  for (const s of meta.severities) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.s = s.v;
    b.textContent = s.label;
    b.onclick = () => {
      repSev = s.v;
      $$("#sev-row button").forEach((x) => x.classList.toggle("on", x === b));
      $("#sev-desc").textContent = s.desc;
    };
    $("#sev-row").appendChild(b);
  }
}

function renderSubs() {
  const holder = $("#subs");
  holder.innerHTML = "";
  const subs = (meta.kinds[repKind] && meta.kinds[repKind].subs) || [];
  for (const s of subs) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    b.onclick = () => {
      repSub = repSub === s ? null : s;
      $$("#subs button").forEach((x) => x.classList.toggle("on", x.textContent === repSub));
    };
    holder.appendChild(b);
  }
}

// ---------------------------------------------------------------- 語音通報 -> AI 判讀 -> 代填
$("#voice-report").onclick = () => {
  if (recActive) { try { rec.stop(); } catch {} return; }
  const btn = $("#voice-report");
  const done = (text) => {
    btn.classList.remove("rec");
    $("#voice-label").textContent = "用說的通報";
    if (!text) return;
    $("#r-text").value = text;
    interpretToForm(text);
  };
  const okStart = startRecognition(
    (t) => { $("#r-text").value = t; },
    done
  );
  if (okStart) {
    btn.classList.add("rec");
    $("#voice-label").textContent = "聽…再按一次結束";
    $("#ai-hint").innerHTML = "";
  }
};

async function interpretToForm(text) {
  $("#ai-hint").textContent = "AI 判讀中…";
  try {
    const r = await api("/api/ai/interpret", { method: "POST", body: JSON.stringify({ text }) });
    if (r.kind && meta.kinds[r.kind]) {
      repKind = r.kind;
      $$("#kinds button").forEach((b) => b.classList.toggle("on", b.textContent === meta.kinds[r.kind].label));
      renderSubs();
    }
    if (r.sub) {
      repSub = r.sub;
      $$("#subs button").forEach((b) => b.classList.toggle("on", b.textContent === r.sub));
    }
    if (r.severity) {
      repSev = r.severity;
      $$("#sev-row button").forEach((b) => b.classList.toggle("on", Number(b.dataset.s) === r.severity));
      const sd = meta.severities.find((s) => s.v === r.severity);
      if (sd) $("#sev-desc").textContent = sd.desc;
    }
    $("#ai-hint").innerHTML = `<b>${r.kindLabel}${r.sub ? " · " + esc(r.sub) : ""}</b> · 嚴重度 <b>${esc(r.severityLabel)}</b> — ${esc(r.reading)}`;
  } catch {
    $("#ai-hint").textContent = "AI 判讀暫時無回應，可直接手動選擇分類";
  }
}

// 指派卡倒數 + 事實保鮮顯示 (每秒刷新, 僅 app 介面)
setInterval(() => {
  if (ev && !$("#app").classList.contains("hidden")) {
    renderAssignment();
    const active = $("#view-facts");
    if (!active.classList.contains("hidden")) renderFacts();
  }
}, 1000);

// ---------------------------------------------------------------- 語意座標兩階快選 (取代地下失效 GPS)
// 異國容錯: 大類可跳、錨點可跳、樓層可跳 — 全跳過仍可通報
let selSpace = null, selAnchor = null, selLevel = null;

function renderSpaces() {
  const holder = $("#spaces");
  holder.innerHTML = "";
  if (!meta.spaces) return;
  for (const [id, sp] of Object.entries(meta.spaces)) {
    const b = document.createElement("button");
    b.type = "button";
    // 圖示 (SVG via DOM, 跨語言可辨識)
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "17"); svg.setAttribute("height", "17");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("style", "vertical-align:-3px;margin-right:4px");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", sp.icon || "M12 21s-7-4.5-7-11a7 7 0 0114 0c0 6.5-7 11-7 11z");
    svg.appendChild(path);
    b.appendChild(svg);
    b.appendChild(document.createTextNode(sp.label));
    b.onclick = () => {
      if (selSpace === id) { // 再點一次 = 取消 (可跳過)
        selSpace = null; selAnchor = null;
        $("#anchor-zone").classList.add("hidden");
      } else {
        selSpace = id; selAnchor = null;
        $("#anchor-zone").classList.remove("hidden");
        $("#anchor-hint").textContent = sp.anchorHint;
        renderAnchors();
      }
      $$("#spaces button").forEach((x) => x.classList.toggle("on", x.dataset.k === selSpace));
    };
    b.dataset.k = id;
    holder.appendChild(b);
  }
  // 樓層 (可跳)
  const lv = $("#levels");
  lv.innerHTML = "";
  for (const L of meta.levels || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = L;
    b.onclick = () => {
      selLevel = selLevel === L ? null : L;
      $$("#levels button").forEach((x) => x.classList.toggle("on", x.textContent === selLevel));
    };
    lv.appendChild(b);
  }
}

function renderAnchors() {
  const sp = meta.spaces && meta.spaces[selSpace];
  if (!sp) return;
  const holder = $("#anchors");
  holder.innerHTML = "";
  // 預設錨點 (月台門數字/出口號等)
  for (const a of sp.anchors || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a;
    b.onclick = () => {
      selAnchor = selAnchor === a ? null : a;
      $$("#anchors button").forEach((x) => x.classList.toggle("on", x.textContent === selAnchor));
    };
    holder.appendChild(b);
  }
  // 自由錨定: 異國看不懂選項時, 直接輸入看到的字 (SORTIE 3 / ZARA / B12)
  const freeRow = $("#free-anchor-row");
  if (sp.free) {
    freeRow.classList.remove("hidden");
    const inp = $("#free-anchor");
    inp.placeholder = (sp.freeHint ? sp.freeHint + " — " : "") + "輸入你看到的字";
    inp.oninput = () => { selAnchor = inp.value.trim() || null; };
  } else {
    freeRow.classList.add("hidden");
  }
}

// ---------------------------------------------------------------- 照片: 前端壓縮 + Laplacian 模糊篩檢 (邊緣運算)
// Canvas 最長邊 800px + WebP q0.5 → <30KB; Laplacian 變異數過低 = 廢片攔截
async function compressAndCheck(file) {
  const img = await new Promise((r, j) => {
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(i.src); r(i); };
    i.onerror = j;
    i.src = URL.createObjectURL(file);
  });
  const maxDim = 800;
  let { width, height } = img;
  if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
  else if (height >= width && height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }

  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  // Laplacian variance (128px 縮圖上計算, ~20ms)
  const sc = document.createElement("canvas");
  sc.width = 128; sc.height = 128;
  sc.getContext("2d").drawImage(c, 0, 0, 128, 128);
  const d = sc.getContext("2d").getImageData(0, 0, 128, 128).data;
  const lum = [];
  for (let i = 0; i < d.length; i += 4) lum.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < 127; y++) {
    for (let x = 1; x < 127; x++) {
      const i = y * 128 + x;
      const lap = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - 128] - lum[i + 128];
      sum += lap; sq += lap * lap; n++;
    }
  }
  const variance = n ? sq / n - (sum / n) ** 2 : 0;
  const blurry = variance < 45; // 門檻: 低於此 = 全黑/全糊/手指

  // 亮度檢查 (全黑攔截)
  const avgLum = lum.reduce((a, b) => a + b, 0) / lum.length;
  const tooDark = avgLum < 12;

  const dataUrl = c.toDataURL("image/webp", 0.5);
  return { dataUrl, kb: Math.round((dataUrl.length * 0.75) / 1024), variance: Math.round(variance), blurry, tooDark };
}

// ---------------------------------------------------------------- 模式 / 建立
let useGps = true;
$("#m-gps").onclick = () => { useGps = true; $("#m-gps").classList.add("on"); $("#m-nogps").classList.remove("on"); };
$("#m-nogps").onclick = () => { useGps = false; $("#m-nogps").classList.add("on"); $("#m-gps").classList.remove("on"); };

$("#btn-report").onclick = async () => {
  const text = $("#r-text").value.trim();
  if (!text && !selSpace) return toast("請描述狀況，或先選擇所在位置");
  const payload = { kind: repKind || "other", text: text || "現場回報", severity: repSev || 2 };
  if (repSub) payload.sub = repSub;
  if (selSpace) { payload.space = selSpace; if (selAnchor) payload.anchor = selAnchor; }
  if (selLevel) payload.level = selLevel;
  if (useGps && gps.lat) { payload.lat = gps.lat; payload.lng = gps.lng; }
  const btn = $("#btn-report");
  btn.disabled = true; btn.textContent = "建立中…";
  try {
    const created = await api("/api/events", { method: "POST", body: JSON.stringify(payload) });
    showModal(created.qr, created.code, true);
  } catch (e) { toast("建立失敗: " + e.message); }
  btn.disabled = false; btn.textContent = "建立事件群組";
};

// ---------------------------------------------------------------- 加入 / 演習
$("#btn-join").onclick = () => {
  const code = $("#j-code").value.trim();
  if (!/^\d{4}$/.test(code)) return toast("請輸入 4 位數代碼");
  enterEvent(code);
};
$("#j-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-join").click(); });

$("#btn-drill").onclick = async () => {
  try {
    const d = await api("/api/events/drill/start", {
      method: "POST",
      body: JSON.stringify({ org: $("#d-org").value, scenario: $("#d-scenario").value }),
    });
    showModal(d.qr, d.code, false);
  } catch (e) { toast("演習啟動失敗: " + e.message); }
};

// ---------------------------------------------------------------- 事件列表
async function refreshEvents() {
  let list;
  try { list = await api("/api/events"); } catch { return; } // 伺服器暫離時靜默, 下輪重試
  $("#ev-count").textContent = list.length + " 進行中";
  const holder = $("#events-list");
  if (!list.length) { holder.innerHTML = '<div class="empty">目前無進行中事件</div>'; return; }
  holder.innerHTML = "";
  for (const e of list) {
    const item = document.createElement("div");
    item.className = "ev-item";
    item.innerHTML = `<div><div class="t">${esc(e.title)}</div><div class="s">${e.mode === "gps" ? "GPS" : "掃碼"} · ${e.memberCount} 人在場 · 代碼 ${e.code}${e.isDrill ? " · [演習]" : ""}</div></div><div class="join">進入</div>`;
    item.onclick = () => enterEvent(e.code);
    holder.appendChild(item);
  }
}

// QR 掃碼進入
const urlJoin = new URLSearchParams(location.search).get("join");
if (urlJoin) enterEvent(urlJoin);

function showModal(qr, code, isCreator) {
  $("#modal-box").innerHTML = `
    <div style="font-size:14px;font-weight:800">事件已建立 — 代碼</div>
    <div class="code-display">${code}</div>
    <div class="code-label">請現場人員掃描 QR 碼或輸入代碼加入</div>
    <div class="qrbox"><img src="${qr}" alt="QR" /></div>
    <button class="btn-solid" id="m-enter" type="button">${isCreator ? "進入我的事件群組" : "進入演習控制台"}</button>
    <div style="height:8px"></div>
    <button class="btn-soft" id="m-close" type="button">稍後</button>`;
  $("#modal").classList.remove("hidden");
  $("#m-enter").onclick = () => { $("#modal").classList.add("hidden"); enterEvent(code); };
  $("#m-close").onclick = () => $("#modal").classList.add("hidden");
}

// ---------------------------------------------------------------- 進入事件 (WS)
// 重連狀態: 固定名稱 + 指數退避
let reconnectAttempts = 0;
function enterEvent(key) {
  if (!myName) myName = "User" + Math.floor(100 + Math.random() * 900); // 重連沿用同名
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?event=${encodeURIComponent(key)}&name=${myName}`);

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "welcome") {
      ev = { ...m.event, timeline: m.timeline, zones: m.zones, summary: m.summary, lateJoiner: m.lateJoiner };
      $("#gate").classList.add("hidden");
      $("#app").classList.remove("hidden");
      renderAll();
      if (m.lateJoiner) {
        renderSummaryCard(m.summary);
        toast("你是晚加入者 — 已收到 Catch-up 摘要卡");
      }
      if (ev.isDrill) addTab("drill", "演習評分");
      if (gps.lat) ws.send(JSON.stringify({ type: "locate", lat: gps.lat, lng: gps.lng }));
      reconnectAttempts = 0; // 連線成功, 重置退避
    } else if (m.type === "timeline") {
      ev.timeline.push(m.msg);
      renderTimeline();
      if (["fact", "ask", "zone", "report", "contra", "assign"].includes(m.msg.kind)) refreshEventState();
    } else if (m.type === "error") {
      toast(m.text);
    }
  };
  ws.onclose = (e) => {
    if (e.code === 4000 && ev) {
      openReport(ev.code);
    } else if (ev) {
      // 指數退避重連 (1.5s -> 3s -> 6s -> 12s, 上限 30s)
      const delay = Math.min(30000, 1500 * Math.pow(2, reconnectAttempts++));
      toast("連線中斷，" + Math.round(delay / 1000) + " 秒後重連…");
      setTimeout(() => enterEvent(key), delay);
    }
  };
}

async function refreshEventState() {
  if (!ev) return;
  try {
    const j = await api(`/api/events/${ev.code}`);
    Object.assign(ev, j);
    renderHeader();
    renderFacts();
    renderContra();
    renderZone();
    renderAssignment();
    renderVerify();
  } catch {}
}

// 1-Tap 驗證卡 (共識分數)
let myVoted = null;
function renderVerify() {
  const holder = $("#verify-holder");
  if (!ev || !ev.consensus) { holder.innerHTML = ""; return; }
  const c = ev.consensus;
  holder.innerHTML = `
    <div class="verify-card ${c.label.tone}">
      <div class="v-row">
        <div>
          <div class="v-score">${c.score}<span>分</span></div>
          <div class="v-label">${c.label.v} · ${c.confirm} 確認 / ${c.deny} 未見</div>
        </div>
        <div class="v-btns">
          <button class="v-btn ok ${myVoted === true ? "on" : ""}" id="v-yes" type="button">我看到了</button>
          <button class="v-btn no ${myVoted === false ? "on" : ""}" id="v-no" type="button">沒看到 / 安全</button>
        </div>
      </div>
      <div class="v-hint">1-Tap 群眾驗證 — 你的確認會即時拉升信心分，惡作劇會被「沒看到」壓制</div>
    </div>`;
  $("#v-yes").onclick = () => voteViaWs(true);
  $("#v-no").onclick = () => voteViaWs(false);
}

function voteViaWs(agree) {
  if (!myName) return;
  myVoted = agree;
  send({ type: "verify", agree, voter: myName });
  renderVerify();
}

// ---------------------------------------------------------------- render
function renderAll() {
  renderHeader();
  renderTimeline();
  renderFacts();
  renderContra();
  renderZone();
  renderAssignment();
  renderVerify();
}

function renderHeader() {
  if (!ev) return;
  $("#a-title").textContent = ev.title;
  $("#a-meta").textContent = `${ev.memberCount} 人在場 · ${ev.status === "active" ? "進行中" : "已落幕"}`;
  $("#a-mode").textContent = ev.mode === "gps" ? "GPS 模式" : "掃碼模式";
  $("#btn-resolve").textContent = ev.isDrill ? "結束演習" : "落幕";
}

const SYS_LABEL = { report: "系統", fact: "AI 指揮官", ask: "AI 指揮官", contra: "闢謠引擎", zone: "AI 指揮官", resolved: "系統", drill: "演習", assign: "AI 指揮官", vote: "共識" };

function renderTimeline() {
  const tl = $("#timeline");
  if (!tl) return;
  tl.innerHTML = "";
  for (const m of ev.timeline.slice(-60)) {
    const d = document.createElement("div");
    const mine = m.who === myName;
    if (m.who === "system") {
      d.className = "msg system " + m.kind;
      d.innerHTML = `<div class="m-head"><b>${SYS_LABEL[m.kind] || "系統"}</b><span class="time">${fmtTime(m.ts)}</span></div><div class="m-body">${esc(m.text)}</div>`;
    } else {
      d.className = "msg " + m.kind + (mine ? " me" : "");
      const imgTag = m.meta?.image ? `<img class="photo-img" src="${m.meta.image}" alt="現場照片" />` : "";
      d.innerHTML = `<div class="m-head">${esc(m.who)}<span class="time">${fmtTime(m.ts)}</span></div><div class="m-body">${esc(m.text)}</div>${imgTag}`;
    }
    tl.appendChild(d);
  }
  const body = $("#view-tl");
  body.scrollTop = body.scrollHeight;
}

// 事實保鮮: 顯示最後確認時間
const FACT_LABEL = { location: "位置", injured: "傷患", threat: "威脅" };
const FACT_STALE_MS = 120000;

function renderFacts() {
  if (!ev) return;
  const f = ev.facts || {};
  const ts = ev.factsTs || {};
  const keys = ["location", "injured", "threat"];
  const got = keys.filter((k) => f[k]).length;
  const pct = Math.round((got / keys.length) * 100);
  $("#facts-pct").textContent = pct + "%";
  $("#facts-meter").style.width = pct + "%";
  $("#facts-grid").innerHTML = keys
    .map((k) => {
      let fresh = "";
      if (f[k] && ts[k]) {
        const age = Date.now() - ts[k];
        const label = age < 60000 ? Math.round(age / 1000) + " 秒" : Math.round(age / 60000) + " 分";
        const cls = age > FACT_STALE_MS ? "stale" : "ok";
        fresh = `<div class="fresh ${cls}">${age > FACT_STALE_MS ? "待覆核" : label + "前確認"}</div>`;
      }
      return `<div class="fact-cell ${f[k] ? "ok" : "miss"}"><div class="k">${FACT_LABEL[k]}</div><div class="v">${f[k] ? esc(String(f[k])) : "待確認"}</div>${fresh}</div>`;
    })
    .join("");
}

// 微任務指派卡 (進行中)
function renderAssignment() {
  const holder = $("#assign-holder");
  if (!ev || !ev.pending) { holder.innerHTML = ""; return; }
  const p = ev.pending;
  const left = Math.max(0, 30 - Math.round((Date.now() - p.ts) / 1000));
  holder.innerHTML = `
    <div class="assign-card">
      <div class="who">AI 指揮官 @${esc(p.to)}</div>
      <div class="q">${esc(p.question)}</div>
      <div class="meta">${p.escalated ? "已升級為全員提問" : `${left} 秒未回應將請全員回報`} — 被指名者的訊息會直接更新事實面板</div>
    </div>`;
}

function renderContra() {
  const cs = ev.contradictions || [];
  $("#contra-list").innerHTML = cs.length
    ? cs.map((c) => `<div class="sum-note" style="color:var(--bad)">${fmtTime(c.ts)} — ${esc(c.detail)} <b>[未經證實]</b></div>`).join("")
    : '<div class="empty">尚未偵測到矛盾資訊</div>';
}

function renderZone() {
  const row = $("#zone-row");
  const zs = ev.zones || meta.zones || ["A 區", "B 區", "C 區", "D 區"];
  row.innerHTML = "";
  for (const z of zs) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = z;
    if (ev.zone === z) b.classList.add("on");
    b.onclick = async () => {
      await api(`/api/events/${ev.code}`, { method: "PATCH", body: JSON.stringify({ zone: z }) });
      ev.zone = z;
      renderZone();
      toast(`已廣播: 避開 ${z}`);
    };
    row.appendChild(b);
  }
  $("#zone-note").textContent = ev.zone ? `風險分區: ${ev.zone} — 全員已收到導流廣播` : "尚未設定風險分區";
}

function renderSummaryCard(s) {
  if (!s) return;
  const guideHtml = (s.guidance || []).length
    ? `<div class="sum-guide"><b>引導方向</b><br/>${s.guidance.map(esc).join("<br/>")}</div>`
    : "";
  $("#summary-holder").innerHTML = `
    <div class="sum-card">
      <div class="badge">CATCH-UP 摘要卡 — 10 秒看懂全貌</div>
      <h2>${esc(s.headline)}</h2>
      <div class="sum-row"><span class="k">事件</span><span>${esc(s.what)}</span></div>
      <div class="sum-row"><span class="k">位置</span><span>${esc(s.where)}</span></div>
      <div class="sum-row"><span class="k">傷患</span><span>${esc(s.injured)}</span></div>
      <div class="sum-row"><span class="k">威脅</span><span>${esc(s.threat)}</span></div>
      ${guideHtml}
      <div class="sum-note">${esc(s.caution)}</div>
    </div>`;
}

// ---------------------------------------------------------------- tabs
// 靜態 tab 在 DOMContentLoaded 時綁定一次; 動態 tab 由 addTab 綁定
function addTab(id, label) {
  if ($(`#tabs button[data-t="${id}"]`)) return;
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.t = id;
  b.textContent = label;
  b.onclick = () => switchTab(id);
  $("#tabs").appendChild(b);
}
$$("#tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.t)));
function switchTab(t) {
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  ["tl", "facts", "zone", "drill", "report"].forEach((v) => {
    const el = $(`#view-${v}`);
    if (el) el.classList.toggle("hidden", v !== t);
  });
  $("#foot-chat").style.display = ["tl", "facts", "zone"].includes(t) ? "" : "none";
}

// ---------------------------------------------------------------- 聊天 + 多模態
function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  else toast("連線中…");
}

$("#ib-send").onclick = () => {
  const v = $("#chat-input").value.trim();
  if (!v) return;
  send({ type: "chat", text: v });
  $("#chat-input").value = "";
};
$("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#ib-send").click(); });

// 「回報」popover (真實照片拍攝/定位) — 邊緣壓縮 + Laplacian 篩檢
$("#ib-plus").onclick = (e) => {
  closePopover();
  const pop = document.createElement("div");
  pop.id = "popover";
  const rect = e.currentTarget.getBoundingClientRect();
  pop.style.left = Math.max(8, rect.left - 20) + "px";
  pop.style.bottom = window.innerHeight - rect.top + 6 + "px";
  pop.innerHTML = `
    <button data-a="camera">拍照回報 (AI 解析 + 邊緣壓縮)</button>
    <button data-a="photo" data-n="濃煙">示範照片 — 濃煙</button>
    <button data-a="photo" data-n="現場已無煙">示範照片 — 已無煙 (供闢謠)</button>
    <div class="sep"></div>
    <button data-a="locate">回報我的 GPS 定位</button>`;
  document.body.appendChild(pop);
  const close = (ev2) => {
    if (!pop.contains(ev2.target) && ev2.target !== e.currentTarget) closePopover();
  };
  setTimeout(() => document.addEventListener("click", close, { once: true }), 10);

  pop.onclick = async (ev2) => {
    const a = ev2.target.dataset?.a;
    const note = ev2.target.dataset?.n;
    closePopover();
    if (a === "camera") {
      // 動態建立 file input 觸發相機
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/*";
      inp.capture = "environment";
      inp.onchange = async () => {
        const file = inp.files?.[0];
        if (!file) return;
        toast("邊緣運算中 (壓縮 + 模糊篩檢)…");
        try {
          const r = await compressAndCheck(file);
          if (r.tooDark) return toast("照片過暗 (疑似遮鏡頭) — 已在端點攔截，請重拍");
          if (r.blurry) return toast(`照片模糊 (清晰度 ${r.variance}) — 已在端點攔截，請重拍`);
          send({ type: "photo", note: "現場照片", image: r.dataUrl });
          toast(`已送出 ${r.kb}KB (邊緣篩檢通過, 清晰度 ${r.variance})`);
        } catch { toast("照片處理失敗"); }
      };
      inp.click();
    }
    if (a === "photo") {
      send({ type: "photo", note });
      toast("示範照片已送出 — AI 解析中");
    }
    if (a === "locate") {
      if (!gps.lat) return toast("尚未取得 GPS，請回首頁允許定位");
      send({ type: "locate", lat: gps.lat, lng: gps.lng });
      toast("已回報定位");
    }
  };
};
function closePopover() { const p = $("#popover"); if (p) p.remove(); }

// 按住說話: 群內語音回報 (辨識 -> 顯示文字 -> agent 吸收)
$("#ib-voice").onclick = () => {
  if (recActive) { try { rec.stop(); } catch {} return; }
  const btn = $("#ib-voice");
  btn.textContent = "聽…";
  const done = (text) => {
    btn.textContent = "按住說話";
    if (!text) return toast("沒有聽到內容");
    send({ type: "voice", text });
    toast("語音已轉文字送出");
  };
  const okStart = startRecognition((t) => { $("#chat-input").value = t; }, done);
  if (!okStart) btn.textContent = "按住說話";
};

// ---------------------------------------------------------------- 多語播報 / 落幕
$("#btn-speak").onclick = () => {
  if (!ev) return;
  const s = ev.facts || {};
  const brief = {
    "zh-TW": `事件 ${ev.title}。位置 ${s.location || "未確認"}。傷患 ${s.injured || "未確認"}。威脅 ${s.threat || "未確認"}。`,
    "en-US": `Event: ${ev.title}. Location: ${s.location || "unconfirmed"}. Injured: ${s.injured || "unconfirmed"}. Threat: ${s.threat || "unconfirmed"}.`,
    "ja-JP": `事件 ${ev.title}。位置 ${s.location || "未確認"}。負傷者 ${s.injured || "未確認"}。脅威 ${s.threat || "未確認"}。`,
  };
  speechSynthesis.cancel();
  const langs = Object.keys(brief);
  let i = 0;
  const speakNext = () => {
    if (i >= langs.length) return;
    const u = new SpeechSynthesisUtterance(brief[langs[i]]);
    u.lang = langs[i];
    u.rate = 1.05;
    u.onend = () => { i++; speakNext(); };
    speechSynthesis.speak(u);
  };
  speakNext();
  toast("多語播報: 中文 → English → 日本語");
};

$("#btn-resolve").onclick = async () => {
  if (!ev) return;
  try {
    if (ev.isDrill) {
      const j = await api(`/api/events/${ev.code}/drill/stop`, { method: "POST" });
      addTab("report", "落幕報告");
      showScore(j.scores);
      openReportInline(j.report);
    } else {
      const j = await api(`/api/events/${ev.code}/resolve`, { method: "POST" });
      addTab("report", "落幕報告");
      openReportInline(j.report);
    }
  } catch (e) { toast(e.message); }
};

function showScore(sc) {
  if (!sc) return;
  $("#drill-score-holder").innerHTML = `
    <div class="score-big">
      <div class="num">${sc.totalPercent}</div>
      <div class="grade">評等 ${esc(sc.grade)} · 用時 ${sc.durationMin} 分鐘</div>
    </div>
    <div class="steps-list">${sc.steps.map((s) => `<div class="step-line ${s.done ? "ok" : ""}"><span>${esc(s.label)}</span><span class="mark">${s.done ? "完成" : "未完成"}</span></div>`).join("")}</div>
    <p style="font-size:12.5px;color:var(--sub);margin-top:10px">${esc(sc.comment)}</p>`;
}

async function openReport(code) {
  try {
    const j = await api(`/api/events/${code}/report`);
    addTab("report", "落幕報告");
    openReportInline(j.report);
    switchTab("report");
  } catch { toast("事件已落幕 — 報告載入失敗"); }
}

function openReportInline(r) {
  $("#report-holder").innerHTML = `
    <div class="report-block">
      <h4>${esc(r.title)}</h4>
      <p>${esc(r.period)}</p>
      <p>資訊完整度 <span class="hl">${r.stats.peakFactsComplete}%</span> · 參與 <span class="hl">${r.stats.participants}</span> 人 · 訊息 <span class="hl">${r.stats.messages}</span> 則 · AI 介入 <span class="hl">${r.stats.aiInterventions}</span> 次 · 矛盾 <span class="hl">${r.stats.contradictions}</span> 件</p>
    </div>
    <div class="report-block">
      <h4>結案時關鍵事實</h4>
      <p>位置 <span class="hl">${esc(r.factsAtClose.location)}</span></p>
      <p>傷患 <span class="hl">${esc(r.factsAtClose.injured)}</span></p>
      <p>威脅 <span class="hl">${esc(r.factsAtClose.threat)}</span></p>
      <p style="margin-top:6px">${esc(r.aiNote)}</p>
    </div>
    <div class="report-block">
      <h4>事件時間軸 (最後 20 則)</h4>
      <div class="mini-tl">${r.timeline.map(esc).join("<div></div>")}</div>
    </div>
    <p style="font-size:12px;color:var(--sub)">${esc(r.disclaimer)}</p>`;
  switchTab("report");
}

// ---------------------------------------------------------------- 啟動
(async () => {
  try {
    meta = await api("/api/meta/kinds");
  } catch { meta = { kinds: {}, severities: [], zones: [] }; }
  renderKinds();
  renderSpaces();
  refreshEvents();
  setInterval(refreshEvents, 5000);
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
