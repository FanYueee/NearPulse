// NearPulse 事件儲存 — 記憶體權威 + SQLite 持久化 (雙寫)
"use strict";

const crypto = require("crypto");
const config = require("../config");
const { Db } = require("./db");
const { Consensus } = require("./consensus");

const ZONES = ["A 區", "B 區", "C 區", "D 區"];

/** Map<eventId, ev> */
const events = new Map();
/** Map<joinCode, eventId> */
const codeIndex = new Map();

const uid = (p) => p + "_" + crypto.randomBytes(5).toString("hex");
const now = () => Date.now();

// 4 位數代碼, 碰撞時重抽 (上限 5 次)
function genCode() {
  for (let i = 0; i < 5; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!codeIndex.has(c)) return c;
  }
  throw new Error("代碼空間不足");
}

function create(payload) {
  const p = payload || {};
  const ev = {
    id: uid("ev"),
    code: genCode(),
    title: "未命名事件",
    status: "active",
    mode: isFinite(Number(p.lat)) && Number(p.lat) !== 0 ? "gps" : "nogps",
    zone: null,
    lat: isFinite(Number(p.lat)) ? Number(p.lat) : null,
    lng: isFinite(Number(p.lng)) ? Number(p.lng) : null,
    semantic: p.semantic || null, // 語意座標: "月台 · 月台門 3 (B2)"
    level: p.level || null,       // 樓層標籤: B1/B2/B3/地面層
    severity: [1, 2, 3, 4].includes(Number(p.severity)) ? Number(p.severity) : 2,
    createdAt: now(),
    resolvedAt: null,
    facts: { location: null, injured: null, threat: null, sourceCount: 0 },
    factsTs: { location: null, injured: null, threat: null },
    pending: null,
    assignLog: [],
    members: new Set(),
    timeline: [],
    contradictions: [],
    votes: Consensus.newBucket(), // 1-Tap 共識桶
    drill: null,
  };
  events.set(ev.id, ev);
  codeIndex.set(ev.code, ev.id);
  Db.saveEvent(ev);
  return ev;
}

// 持久化 (在關鍵狀態變更時呼叫; 內部攜帶不可序列化欄位會被剝除)
function persist(ev) {
  Db.saveEvent(ev);
}

// 訊息入庫 (由 ws-hub pushSystem / 使用者訊息時呼叫)
function persistMessage(ev, msg) {
  Db.saveMessage(ev.id, msg);
}

// 依 4 位代碼或完整 id 查找
function find(key) {
  if (!key) return undefined;
  if (/^\d{4}$/.test(key)) return events.get(codeIndex.get(key));
  if (key.startsWith("ev_")) return events.get(key);
  return undefined;
}

function listActive() {
  return [...events.values()].filter((e) => e.status === "active");
}

// 落幕後清理 (供報告保留; 只刪仍指向本事件的映射)
function scheduleCleanup(ev) {
  setTimeout(() => {
    if (codeIndex.get(ev.code) === ev.id) codeIndex.delete(ev.code);
    events.delete(ev.id);
  }, config.eventRetentionMs);
}

// Demo 重置: 清空全部記憶體事件 (定時器一併停止)
function clear() {
  for (const ev of events.values()) {
    if (ev._missionTimer) clearTimeout(ev._missionTimer);
    ev.status = "resolved";
    for (const c of ev.members) { try { c.close(4000, "reset"); } catch {} }
  }
  events.clear();
  codeIndex.clear();
}

function publicView(ev) {
  // 深拷貝, 避免外部改動 store 內部狀態
  return {
    id: ev.id,
    code: ev.code,
    title: ev.title,
    status: ev.status,
    mode: ev.mode,
    zone: ev.zone,
    semantic: ev.semantic,
    level: ev.level,
    severity: ev.severity || null,
    createdAt: ev.createdAt,
    resolvedAt: ev.resolvedAt,
    facts: { ...ev.facts },
    factsTs: { ...(ev.factsTs || {}) },
    pending: ev.pending ? { ...ev.pending } : null,
    memberCount: [...ev.members].filter((c) => !c.member?.observer).length,
    observerCount: [...ev.members].filter((c) => c.member?.observer).length,
    contradictions: ev.contradictions.map((c) => ({ ...c })),
    consensus: Consensus.publicView(ev.votes),
    isDrill: !!ev.drill,
  };
}

module.exports = { Store: { ZONES, create, find, listActive, scheduleCleanup, publicView, persist, persistMessage, clear } };
