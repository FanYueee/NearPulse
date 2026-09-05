// NearPulse 後台 — 事件監控 (observer WS) / 統計 / 導流 / 落幕 / 手機預覽
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

let current = null;   // {code, ...event, timeline}
let ws = null;
let zoneOpen = false;

// ---------------------------------------------------------------- 事件列表
async function refreshList() {
  let list;
  try { list = await api("/api/events"); } catch { return; }
  refreshMap(list);
  const holder = $("#ev-list");
  if (!list.length) { holder.innerHTML = '<div class="ev-empty">目前無進行中事件 — 可在手機預覽發起通報</div>'; return; }
  holder.innerHTML = "";
  for (const e of list) {
    const d = document.createElement("div");
    d.className = "ev-item" + (current && current.code === e.code ? " on" : "");
    const sev = e.severity || 2;
    d.innerHTML = `<div class="t">${esc(e.title)}<span class="ev-sev s${sev}">${sev >= 4 ? "危急" : sev === 3 ? "緊急" : sev === 2 ? "注意" : "輕微"}</span></div>
      <div class="s">${e.mode === "gps" ? "GPS" : "掃碼"} · ${e.memberCount} 人 · 信心 ${e.consensus ? e.consensus.score : "-"} · ${e.consensus && e.consensus.label ? e.consensus.label.v : ""} · 代碼 ${e.code}${e.isDrill ? " · [演習]" : ""}</div>`;
    d.onclick = () => selectEvent(e.code);
    holder.appendChild(d);
  }
}

// ---------------------------------------------------------------- 統計
async function refreshStats() {
  let s;
  try { s = await api("/api/admin/stats"); } catch { return; }
  $("#st-active").textContent = s.active;
  $("#st-total").textContent = s.db.total_events;
  $("#st-msgs").textContent = s.db.total_messages;
  $("#st-confirms").textContent = s.db.total_confirms;
  $("#db-mode").textContent = "儲存: " + s.mode + (s.llm ? " · LLM 啟用" : " · 規則引擎");
  $("#stat-grid").innerHTML = `
    <div class="stat"><div class="n">${s.db.total_events}</div><div class="l">歷史事件</div></div>
    <div class="stat"><div class="n">${s.db.resolved_events}</div><div class="l">已落幕</div></div>
    <div class="stat"><div class="n">${s.db.total_messages}</div><div class="l">總訊息</div></div>
    <div class="stat"><div class="n">${s.db.total_confirms}/${s.db.total_denies}</div><div class="l">確認/未見票</div></div>`;
}

// ---------------------------------------------------------------- 選擇事件 → observer WS
let reconnectAttempts = 0;
function selectEvent(code) {
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
  reconnectAttempts = 0;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?event=${encodeURIComponent(code)}&name=console&role=observer`);
  const myWs = ws; // 閉包防切換劫持
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "welcome") {
      current = { ...m.event, timeline: m.timeline };
      reconnectAttempts = 0;
      renderMon();
      loadQr(code);
    } else if (m.type === "error") {
      // 事件不存在/已落幕 — 停止重連
      if (myWs === ws) { $("#mon-title").textContent = `事件 ${code} 已落幕或不存在`; }
    } else if (m.type === "timeline") {
      current.timeline.push(m.msg);
      appendMsg(m.msg);
      refreshMeta();
    }
  };
  ws.onclose = (e) => {
    if (myWs !== ws) return; // 已切換到別的事件 — 忽略
    if (e.code === 4000) { // 事件落幕 (server 主動斷)
      $("#mon-title").textContent = current ? current.title + " — 已落幕" : "已落幕";
      refreshList();
      return;
    }
    // 指數退避重連, 上限 5 次
    if (reconnectAttempts >= 5) { $("#mon-title").textContent = "連線失敗 — 請重新選擇事件"; return; }
    const delay = 3000 * Math.pow(2, reconnectAttempts++);
    setTimeout(() => { if (myWs === ws && current && current.status === "active") selectEvent(code); }, delay);
  };
  $("#mon-title").textContent = "連線中…";
  $("#mon-body").classList.remove("hidden");
}

async function refreshMeta() {
  if (!current) return;
  try {
    const j = await api(`/api/events/${current.code}`);
    Object.assign(current, j);
    renderFactsRow();
    renderConsensus();
    $("#mon-meta").textContent = `${current.memberCount} 人 · 觀察台 ${current.observerCount} · ${current.semantic ? current.semantic : (current.mode === "gps" ? "GPS" : "掃碼")}`;
  } catch {}
}

function renderMon() {
  $("#mon-title").textContent = current.title;
  refreshMeta();
  renderFactsRow();
  renderConsensus();
  renderZoneSel();
  const tl = $("#mon-tl");
  tl.innerHTML = "";
  for (const m of current.timeline.slice(-100)) appendMsg(m, true);
  tl.scrollTop = tl.scrollHeight;
  $("#a-resolve").textContent = current.isDrill ? "結束演習" : "落幕解散";
}

function appendMsg(m, silent) {
  const tl = $("#mon-tl");
  const d = document.createElement("div");
  d.className = "msg " + m.kind;
  const who = m.who === "system"
    ? ({ report: "系統", fact: "AI 指揮官", ask: "AI 指揮官", contra: "闢謠引擎", zone: "AI 指揮官", resolved: "系統", drill: "演習", assign: "AI 指揮官", vote: "共識" }[m.kind] || "系統")
    : m.who;
  const img = m.meta?.image ? `<img class="photo-img" src="${m.meta.image}" alt="照片" />` : "";
  d.innerHTML = `<div class="mh">${esc(who)} · ${fmtTime(m.ts)}</div><div class="mb">${esc(m.text)}</div>${img}`;
  tl.appendChild(d);
  if (!silent) tl.scrollTop = tl.scrollHeight;
  if (["fact", "ask", "zone", "vote", "report", "contra", "assign", "resolved"].includes(m.kind)) refreshMeta();
}

function renderFactsRow() {
  const f = current.facts || {};
  const ts = current.factsTs || {};
  const cells = [["location", "位置"], ["injured", "傷患"], ["threat", "威脅"]];
  $("#facts-row").innerHTML = cells.map(([k, label]) => {
    let fresh = "";
    if (f[k] && ts[k]) {
      const age = Date.now() - ts[k];
      fresh = `<div class="fresh ${age > 120000 ? "stale" : ""}">${age > 120000 ? "待覆核" : Math.round(age / 1000) + " 秒前"}</div>`;
    }
    return `<div class="fact-cell ${f[k] ? "ok" : "miss"}"><div class="k">${label}</div><div class="v">${f[k] ? esc(String(f[k])) : "待確認"}</div>${fresh}</div>`;
  }).join("");
}

function renderConsensus() {
  const c = current.consensus;
  if (!c) { $("#consensus-bar").innerHTML = ""; return; }
  const tone = c.score >= 75 ? "ok" : c.score >= 45 ? "warn" : "bad";
  $("#consensus-bar").innerHTML = `
    <div class="num">${c.score}</div>
    <div class="meter"><i class="${tone}" style="width:${c.score}%"></i></div>
    <div style="font-size:11.5px;color:var(--sub)">${c.label.v}<br/>${c.confirm} 確認 · ${c.deny} 未見</div>`;
}

function renderZoneSel() {
  const row = $("#zone-select");
  row.innerHTML = "";
  for (const z of current.zones || ["A 區", "B 區", "C 區", "D 區"]) {
    const b = document.createElement("button");
    b.textContent = z;
    if (current.zone === z) b.classList.add("on");
    b.onclick = async () => {
      await api(`/api/events/${current.code}`, { method: "PATCH", body: JSON.stringify({ zone: z }) });
      current.zone = z;
      renderZoneSel();
    };
    row.appendChild(b);
  }
}

// ---------------------------------------------------------------- 操作
$("#a-zone").onclick = () => { zoneOpen = !zoneOpen; $("#zone-select").classList.toggle("hidden", !zoneOpen); };

$("#a-report").onclick = async () => {
  if (!current) return;
  try {
    const j = await api(`/api/events/${current.code}/report`);
    showReport(j.report);
  } catch (e) { toastOnConsole(e.message); }
};

$("#a-resolve").onclick = async () => {
  if (!current) return;
  try {
    if (current.isDrill) {
      const j = await api(`/api/events/${current.code}/drill/stop`, { method: "POST" });
      showReport(j.report);
      showScore(j.scores);
    } else {
      const j = await api(`/api/events/${current.code}/resolve`, { method: "POST" });
      showReport(j.report);
    }
    refreshList(); refreshStats();
  } catch (e) { toastOnConsole(e.message); }
};

function showReport(r) {
  const out = $("#report-out");
  out.classList.remove("hidden");
  out.innerHTML = `
    <div style="background:var(--bg);border-radius:11px;padding:13px 15px">
      <b style="font-size:13.5px">${esc(r.title)}</b>
      <p style="font-size:12px;color:var(--sub);margin-top:4px">${esc(r.period)}</p>
      <p style="font-size:12px;color:var(--sub)">完整度 ${r.stats.peakFactsComplete}% · 參與 ${r.stats.participants} 人 · 訊息 ${r.stats.messages} 則 · AI 介入 ${r.stats.aiInterventions} 次 · 矛盾 ${r.stats.contradictions} 件</p>
      <p style="font-size:12px;color:var(--sub);margin-top:4px">${esc(r.aiNote)}</p>
    </div>`;
}

function showScore(sc) {
  const out = $("#report-out");
  out.insertAdjacentHTML("beforeend", `
    <div style="background:var(--accent-soft);border-radius:11px;padding:13px 15px;margin-top:8px">
      <b style="font-size:14px">演習評分 ${sc.totalPercent} / ${sc.grade}</b>
      <p style="font-size:12px;color:var(--sub);margin-top:3px">${esc(sc.comment)}</p>
    </div>`);
}

function toastOnConsole(t) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#101828;color:#fff;font-size:13px;font-weight:600;border-radius:999px;padding:9px 18px;z-index:99";
  el.textContent = t;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

// ---------------------------------------------------------------- QR
async function loadQr(code) {
  try {
    const j = await api(`/api/events/${code}/qr`);
    $("#qr-code-label").textContent = "代碼 " + j.code;
    $("#qr-holder").innerHTML = `<img class="qr-mini" src="${j.qr}" alt="QR" /><div class="preview-note">現場張貼此碼，掃描即入</div>`;
  } catch {}
}

// ---------------------------------------------------------------- 預覽切換
$$(".frame-src button").forEach((b) => {
  b.onclick = () => {
    $$(".frame-src button").forEach((x) => x.classList.toggle("on", x === b));
    $("#preview-frame").src = b.dataset.src;
  };
});

// ---------------------------------------------------------------- OSM 即時地圖 (Leaflet + OpenStreetMap, 零 API key)
let map = null;
let mapMarkers = [];
function initMap() {
  if (typeof L === "undefined") return; // 離線時靜默
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([25.033, 121.565], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
}
function refreshMap(list) {
  if (!map) return;
  for (const mk of mapMarkers) map.removeLayer(mk);
  mapMarkers = [];
  let first = true;
  for (const e of list) {
    // 僅 GPS 事件有座標; 語意座標事件不落在地圖 (概念即「地圖之外」)
    if (e.mode !== "gps") continue;
    try {
      const detail = (e.facts && e.facts.location) ? "" : "";
      const mk = L.marker([e.lat, e.lng], {
        icon: L.divIcon({ className: "", html: `<div class="np-marker"><span>${e.severity >= 4 ? "!" : e.severity >= 3 ? "3" : "2"}</span></div>`, iconSize: [18, 18], iconAnchor: [9, 18] }),
      }).addTo(map)
        .bindPopup(`<b>${esc(e.title)}</b><br/>代碼 ${e.code} · 信心 ${e.consensus ? e.consensus.score : "-"}${e.semantic ? "<br/>" + esc(e.semantic) : ""}`);
      mapMarkers.push(mk);
      if (first) { map.setView([e.lat, e.lng], 16); first = false; }
    } catch {}
  }
  $("#map-note").textContent = mapMarkers.length
    ? `${mapMarkers.length} 個 GPS 事件已標記 (點標記看詳情)`
    : "GPS 事件建立後自動標記 (語意座標事件顯示於列表)";
}

// ---------------------------------------------------------------- Demo 控制 (重置 + 三情境劇本)
function confirmAction(msg) { return window.confirm(msg); }

$("#demo-reset").onclick = async () => {
  if (!confirmAction("確定重置？所有事件與統計將歸零，回到乾淨 Demo 起始狀態。")) return;
  try {
    const r = await api("/api/admin/reset", { method: "POST" });
    toastOnConsole(`已重置 — 事件 ${r.db.total_events} / 訊息 ${r.db.total_messages} 全部歸零`);
    current = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
    $("#mon-title").textContent = "已重置 — 選擇事件或從手機發起新通報";
    $("#mon-body").classList.add("hidden");
    $("#qr-holder").innerHTML = '<div class="ev-empty">選擇左側事件後顯示</div>';
    refreshList(); refreshStats(); refreshMap([]);
  } catch (e) { toastOnConsole("重置失敗: " + e.message); }
};

const SC_LABEL = { paris: "巴黎地鐵 (異國 GPS 失效)", airport: "機場 (登機門 B12)", mall: "百貨 (3F 走失)" };
for (const [btnId, name] of [["#sc-paris", "paris"], ["#sc-airport", "airport"], ["#sc-mall", "mall"]]) {
  $(btnId).onclick = async () => {
    if (!confirmAction(`注入情境「${SC_LABEL[name]}」？將自動建立事件並陸續出現模擬群眾回報。`)) return;
    try {
      const r = await api("/api/admin/scenario", { method: "POST", body: JSON.stringify({ name }) });
      toastOnConsole(`情境已建立 — 事件代碼 ${r.code}，模擬群眾將陸續回報`);
      refreshList(); refreshStats();
      selectEvent(r.code); // 自動開始監控
    } catch (e) { toastOnConsole("情境注入失敗: " + e.message); }
  };
}

// ---------------------------------------------------------------- 啟動
refreshList();
refreshStats();
initMap();
setInterval(() => { refreshList(); refreshStats(); }, 5000);
