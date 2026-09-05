// NearPulse 後台 — 指揮中心: 測試情境面板 + 事件監控 + OSM 地圖 + 手機預覽同步
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

const SYS_LABEL = { report: "系統", fact: "AI 指揮官", ask: "AI 指揮官", contra: "闢謠引擎", zone: "AI 指揮官", resolved: "系統", drill: "演習", assign: "AI 指揮官", vote: "共識", guide: "AI 引導" };

let current = null;
let ws = null;
let zoneOpen = false;
let reconnectAttempts = 0;

// ---------------------------------------------------------------- 事件列表
async function refreshList() {
  let list;
  try { list = await api("/api/events"); } catch { return; }
  refreshMap(list);
  const holder = $("#ev-list");
  if (!list.length) { holder.innerHTML = '<div class="ev-empty">目前無進行中事件 — 按「測試」注入情境，或用任何手機開 nearpulse 網址通報</div>'; return; }
  holder.innerHTML = "";
  for (const e of list) {
    const d = document.createElement("div");
    d.className = "ev-item" + (current && current.code === e.code ? " on" : "");
    const sev = e.severity || 2;
    d.innerHTML = `<div class="t">${esc(e.title)}<span class="ev-sev s${sev}">${sev >= 4 ? "危急" : sev === 3 ? "緊急" : sev === 2 ? "注意" : "輕微"}</span></div>
      <div class="s">${esc(e.semantic || (e.mode === "gps" ? "GPS" : "位置判斷中"))} · ${e.memberCount} 人 · 信心 ${e.consensus ? e.consensus.score : "-"} · ${e.consensus && e.consensus.label ? e.consensus.label.v : ""}</div>`;
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
  $("#db-mode").textContent = (s.llm ? "AI: MiniMax M3" : "AI: 規則引擎") + " · " + (s.mode === "sqlite" ? "已歸檔" : "JSON 模式");
  $("#stat-grid").innerHTML = `
    <div class="stat"><div class="n">${s.db.total_events}</div><div class="l">協助過的狀況</div></div>
    <div class="stat"><div class="n">${s.active}</div><div class="l">進行中</div></div>
    <div class="stat"><div class="n">${s.db.total_messages}</div><div class="l">收到的回報</div></div>
    <div class="stat"><div class="n">${s.db.total_confirms}</div><div class="l">現場確認</div></div>`;
}

// ---------------------------------------------------------------- 測試情境面板 (一鍵開演, 手機預覽同步)
const SCENARIOS = {
  paris:   { label: "巴黎地鐵 B2", desc: "GPS 失效 · 法/中多語群眾 · 月台昏倒", btn: "#sc-paris" },
  airport: { label: "機場登機門 B12", desc: "複雜樓層 · 旅客昏倒 · 地勤/旅客接力", btn: "#sc-airport" },
  mall:    { label: "百貨 3F 走失", desc: "溫柔版 · 店員/顧客/媽媽", btn: "#sc-mall" },
  drill:   { label: "演習模式", desc: "機器人注入雜訊 · 五目標 AI 評分", btn: "#sc-drill" },
};

$("#test-btn").onclick = () => {
  $("#sc-panel").classList.toggle("hidden");
  $("#test-btn").classList.toggle("on");
};
$("#sc-panel-close").onclick = () => { $("#sc-panel").classList.add("hidden"); $("#test-btn").classList.remove("on"); };

async function runScenario(name) {
  try {
    let ev;
    if (name === "drill") {
      ev = await api("/api/events/drill/start", { method: "POST", body: JSON.stringify({ org: "學校", scenario: "fire" }) });
    } else {
      ev = await api("/api/admin/scenario", { method: "POST", body: JSON.stringify({ name }) });
    }
    toastOnConsole(`情境已建立 — 事件代碼 ${ev.code}`);
    $("#sc-panel").classList.add("hidden");
    $("#test-btn").classList.remove("on");
    refreshList(); refreshStats();
    selectEvent(ev.code);
    // 三畫面同步: 預覽 iframe 導向同一事件 (與手機 ?join=CODE 相同畫面)
    $("#preview-frame").src = `/mobile/?join=${ev.code}`;
    $$(".frame-src button").forEach((x) => x.classList.remove("on"));
  } catch (e) { toastOnConsole("情境注入失敗: " + e.message); }
}
for (const [name, sc] of Object.entries(SCENARIOS)) {
  $(sc.btn).onclick = () => {
    if (!window.confirm(`開始「${sc.label}」情境測試？\n\n${sc.desc}\n\n建立後: 後台自動監控、右側手機預覽同步進入該事件（與真手機掃 QR 同畫面）。`)) return;
    runScenario(name);
  };
}

$("#demo-reset").onclick = async () => {
  if (!window.confirm("重置？所有事件與統計歸零，回到乾淨 Demo 起始狀態。")) return;
  try {
    const r = await api("/api/admin/reset", { method: "POST" });
    toastOnConsole(`已重置 — 全部歸零`);
    current = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
    $("#mon-title").textContent = "已重置 — 按「測試」開始，或從手機通報";
    $("#mon-body").classList.add("hidden");
    $("#qr-holder").innerHTML = '<div class="ev-empty">選擇事件後顯示</div>';
    $("#preview-frame").src = "/mobile/";
    $$(".frame-src button").forEach((x) => x.classList.toggle("on", x.dataset.src === "/mobile/"));
    refreshList(); refreshStats();
  } catch (e) { toastOnConsole("重置失敗: " + e.message); }
};

// ---------------------------------------------------------------- 選擇事件 → observer WS
function selectEvent(code) {
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
  reconnectAttempts = 0;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?event=${encodeURIComponent(code)}&name=console&role=observer`);
  const myWs = ws;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "welcome") {
      current = { ...m.event, timeline: m.timeline };
      reconnectAttempts = 0;
      renderMon();
      loadQr(code);
      // 預覽同步到該事件 (若預覽還在通報頁)
      if (!$("#preview-frame").src.includes("join=")) $("#preview-frame").src = `/mobile/?join=${code}`;
    } else if (m.type === "error") {
      if (myWs === ws) $("#mon-title").textContent = `事件 ${code} 已落幕或不存在`;
    } else if (m.type === "timeline") {
      current.timeline.push(m.msg);
      appendMsg(m.msg);
      refreshMeta();
    }
  };
  ws.onclose = (e) => {
    if (myWs !== ws) return;
    if (e.code === 4000) {
      $("#mon-title").textContent = (current ? current.title + " — 已落幕" : "已落幕") + "（AI 自動或人工）";
      refreshList();
      return;
    }
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
    renderGuides();
    $("#mon-meta").textContent = `${current.memberCount} 人在場 · ${current.semantic || (current.mode === "gps" ? "GPS 定位" : "文字地標")}`;
  } catch {}
}

function renderMon() {
  $("#mon-title").textContent = current.title;
  refreshMeta();
  renderFactsRow();
  renderGuides();
  renderZoneSel();
  const tl = $("#mon-tl");
  tl.innerHTML = "";
  for (const m of current.timeline.slice(-100)) appendMsg(m, true);
  tl.scrollTop = tl.scrollHeight;
  $("#a-resolve").textContent = current.isDrill ? "結束演習並評分" : "立即落幕";
}

function renderGuides() {
  const guides = (current.timeline || []).filter((m) => m.kind === "guide");
  const holder = $("#guide-holder");
  if (!guides.length) { holder.innerHTML = '<div class="ev-empty">建立事件後 AI 自動引導</div>'; return; }
  holder.innerHTML = guides.slice(-1).map((g) => esc(g.text.replace(/^AI 引導: ?/, ""))).join("<br/>");
}

function appendMsg(m, silent) {
  const tl = $("#mon-tl");
  const d = document.createElement("div");
  d.className = "msg " + m.kind;
  const who = m.who === "system" ? (SYS_LABEL[m.kind] || "系統") : m.who;
  const img = m.meta?.image ? `<img class="photo-img" src="${m.meta.image}" alt="照片" />` : "";
  d.innerHTML = `<div class="mh">${esc(who)} · ${fmtTime(m.ts)}</div><div class="mb">${esc(m.text)}</div>${img}`;
  tl.appendChild(d);
  if (!silent) tl.scrollTop = tl.scrollHeight;
  if (["fact", "ask", "zone", "vote", "report", "contra", "assign", "resolved", "guide"].includes(m.kind)) refreshMeta();
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

// ---------------------------------------------------------------- 進階操作 (AI 自動為主, 人工為輔)
$("#a-zone").onclick = () => { zoneOpen = !zoneOpen; $("#zone-select").classList.toggle("hidden", !zoneOpen); };
$("#a-resolve").onclick = async () => {
  if (!current) return;
  try {
    if (current.isDrill) {
      const j = await api(`/api/events/${current.code}/drill/stop`, { method: "POST" });
      showReport(j.report); showScore(j.scores);
    } else {
      showReport((await api(`/api/events/${current.code}/resolve`, { method: "POST" })).report);
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
  $("#report-out").insertAdjacentHTML("beforeend", `
    <div style="background:var(--accent-soft);border-radius:11px;padding:13px 15px;margin-top:8px">
      <b style="font-size:14px">演習評分 ${sc.totalPercent} / ${sc.grade}</b>
      <p style="font-size:12px;color:var(--sub);margin-top:3px">${esc(sc.comment)}</p>
    </div>`);
}

function toastOnConsole(txt) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#101828;color:#fff;font-size:13px;font-weight:600;border-radius:999px;padding:9px 18px;z-index:99";
  el.textContent = txt;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

// ---------------------------------------------------------------- QR
async function loadQr(code) {
  try {
    const j = await api(`/api/events/${code}/qr`);
    $("#qr-code-label").textContent = "代碼 " + j.code;
    $("#qr-holder").innerHTML = `<img class="qr-mini" src="${j.qr}" alt="QR" /><div class="preview-note">現場張貼此碼，掃描即進入狀況頁</div>`;
  } catch {}
}

// ---------------------------------------------------------------- OSM 地圖 (Leaflet + OpenStreetMap)
let map = null;
let mapMarkers = [];
function initMap() {
  if (typeof L === "undefined") return;
  map = L.map("map", { zoomControl: true }).setView([25.033, 121.565], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
}
function refreshMap(list) {
  if (!map) return;
  for (const mk of mapMarkers) map.removeLayer(mk);
  mapMarkers = [];
  let first = true;
  for (const e of list) {
    if (e.mode !== "gps") continue;
    try {
      const mk = L.marker([e.lat, e.lng], {
        icon: L.divIcon({ className: "", html: `<div class="np-marker"><span>${e.severity >= 4 ? "!" : e.severity >= 3 ? "3" : "2"}</span></div>`, iconSize: [18, 18], iconAnchor: [9, 18] }),
      }).addTo(map).bindPopup(`<b>${esc(e.title)}</b><br/>代碼 ${e.code} · 信心 ${e.consensus ? e.consensus.score : "-"}${e.semantic ? "<br/>" + esc(e.semantic) : ""}`);
      mapMarkers.push(mk);
      if (first) { map.setView([e.lat, e.lng], 16); first = false; }
    } catch {}
  }
  const note = $("#map-note");
  if (note) note.textContent = mapMarkers.length
    ? `${mapMarkers.length} 個 GPS 事件標記 · 語意座標事件（地下/室內）依設計不落圖`
    : "GPS 事件自動標記（地下/室內事件走語意座標）";
}

// ---------------------------------------------------------------- 預覽切換
$$(".frame-src button").forEach((b) => {
  b.onclick = () => {
    $$(".frame-src button").forEach((x) => x.classList.toggle("on", x === b));
    $("#preview-frame").src = b.dataset.src;
  };
});

// ---------------------------------------------------------------- 啟動
refreshList();
refreshStats();
initMap();
setInterval(() => { refreshList(); refreshStats(); }, 5000);
