// NearPulse 持久層 — better-sqlite3 優先, 無法載入時降級為 JSON 檔案
// (開源務實性: clone 下來 npm install 即可跑, 不強迫原生編譯)
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "nearpulse.db");
const JSON_FILE = path.join(DATA_DIR, "fallback.json");

let db = null;      // better-sqlite3 實例或 null
let mode = "json";   // "sqlite" | "json"

try {
  const Database = require("better-sqlite3");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  mode = "sqlite";

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, code TEXT, title TEXT, status TEXT, mode TEXT,
      zone TEXT, severity INTEGER, semantic TEXT, level TEXT,
      created_at INTEGER, resolved_at INTEGER, raw TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, ts INTEGER,
      who TEXT, kind TEXT, text TEXT, raw TEXT
    );
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, ts INTEGER,
      voter TEXT, agree INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_event ON messages(event_id, ts);
    CREATE INDEX IF NOT EXISTS idx_votes_event ON votes(event_id);
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
  `);
} catch (e) {
  try { if (db) db.close(); } catch {}
  db = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------- 通用介面
const stmts = mode === "sqlite"
  ? {
      upsertEvent: db.prepare(`INSERT INTO events (id,code,title,status,mode,zone,severity,semantic,level,created_at,resolved_at,raw)
        VALUES (@id,@code,@title,@status,@mode,@zone,@severity,@semantic,@level,@created_at,@resolved_at,@raw)
        ON CONFLICT(id) DO UPDATE SET status=@status, zone=@zone, severity=@severity, semantic=@semantic,
          level=@level, resolved_at=@resolved_at, raw=@raw`),
      insertMsg: db.prepare(`INSERT INTO messages (event_id,ts,who,kind,text,raw) VALUES (?,?,?,?,?,?)`),
      insertVote: db.prepare(`INSERT INTO votes (event_id,ts,voter,agree) VALUES (?,?,?,?)`),
      activeEvents: db.prepare(`SELECT raw FROM events WHERE status='active' ORDER BY created_at DESC LIMIT 200`),
      recentMsgs: db.prepare(`SELECT raw FROM messages WHERE event_id=? ORDER BY ts DESC LIMIT 200`),
      stats: db.prepare(`SELECT
          (SELECT COUNT(*) FROM events) AS total_events,
          (SELECT COUNT(*) FROM events WHERE status='resolved') AS resolved_events,
          (SELECT COUNT(*) FROM events WHERE title LIKE '[演習]%') AS drills,
          (SELECT COUNT(*) FROM messages) AS total_messages,
          (SELECT COUNT(*) FROM votes WHERE agree=1) AS total_confirms,
          (SELECT COUNT(*) FROM votes WHERE agree=0) AS total_denies`),
    }
  : null;

// JSON 降級層
function jsonLoad() {
  try { return JSON.parse(fs.readFileSync(JSON_FILE, "utf8")); } catch { return { events: [], messages: [], votes: [] }; }
}
function jsonSave(d) {
  const tmp = JSON_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, JSON_FILE);
}

// ---------------------------------------------------------------- API
// 序列化安全視圖: 白名單欄位 (防 circular Set/Map/Timeout 洩入)
const EVENT_FIELDS = ["id", "code", "title", "status", "mode", "zone", "severity", "semantic", "level", "createdAt", "resolvedAt", "facts", "contradictions"];
function serializable(ev) {
  const out = {};
  for (const k of EVENT_FIELDS) {
    if (ev[k] === undefined) continue;
    if (k === "facts") out[k] = { ...ev[k] };
    else if (k === "contradictions") out[k] = (ev[k] || []).map((c) => ({ ...c }));
    else out[k] = ev[k];
  }
  return out;
}

function saveEvent(ev) {
  let raw;
  try { raw = JSON.stringify(serializable(ev)); } catch (e) { console.error("[db] saveEvent serialize:", e.message); return; }
  try {
    if (mode === "sqlite") {
      stmts.upsertEvent.run({
        id: ev.id, code: ev.code, title: ev.title || "", status: ev.status, mode: ev.mode || "",
        zone: ev.zone || "", severity: ev.severity || 2, semantic: ev.semantic || "", level: ev.level || "",
        created_at: ev.createdAt, resolved_at: ev.resolvedAt || null, raw,
      });
    } else {
      const d = jsonLoad();
      const i = d.events.findIndex((e) => e.id === ev.id);
      const rec = { id: ev.id, code: ev.code, title: ev.title, status: ev.status, mode: ev.mode, zone: ev.zone, severity: ev.severity, semantic: ev.semantic, level: ev.level, createdAt: ev.createdAt, resolvedAt: ev.resolvedAt, raw };
      if (i >= 0) d.events[i] = rec; else d.events.push(rec);
      jsonSave(d);
    }
  } catch (e) { console.error("[db] saveEvent:", e.message); }
}

function saveMessage(evId, msg) {
  if (mode === "sqlite") {
    stmts.insertMsg.run(evId, msg.ts, String(msg.who || ""), msg.kind || "", String(msg.text || "").slice(0, 500), JSON.stringify(msg));
  } else {
    const d = jsonLoad();
    d.messages.push({ event_id: evId, ...msg });
    if (d.messages.length > 5000) d.messages = d.messages.slice(-3000);
    jsonSave(d);
  }
}

function saveVote(evId, voter, agree) {
  if (mode === "sqlite") {
    stmts.insertVote.run(evId, Date.now(), String(voter).slice(0, 40), agree ? 1 : 0);
  } else {
    const d = jsonLoad();
    d.votes.push({ event_id: evId, ts: Date.now(), voter: String(voter).slice(0, 40), agree: !!agree });
    jsonSave(d);
  }
}

function stats() {
  if (mode === "sqlite") return stmts.stats.get();
  const d = jsonLoad();
  return {
    total_events: d.events.length,
    resolved_events: d.events.filter((e) => e.status === "resolved").length,
    drills: d.events.filter((e) => (e.title || "").startsWith("[演習]")).length,
    total_messages: d.messages.length,
    total_confirms: d.votes.filter((v) => v.agree).length,
    total_denies: d.votes.filter((v) => !v.agree).length,
  };
}

// Demo 重置: 清空所有資料表 (SQLite / JSON 皆清)
function reset() {
  try {
    if (mode === "sqlite") {
      db.exec("DELETE FROM events; DELETE FROM messages; DELETE FROM votes;");
    } else {
      jsonSave({ events: [], messages: [], votes: [] });
    }
  } catch (e) { console.error("[db] reset:", e.message); }
}

module.exports = { Db: { mode, saveEvent, saveMessage, saveVote, stats, reset } };
