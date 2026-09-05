// NearPulse WebSocket Hub — 事件頻道: chat / voice / photo / locate / verify
// observer 角色: 後台旁聽 (不計入會員/不被指派/可收全部廣播)
"use strict";

const { WebSocketServer } = require("ws");
const { Store } = require("./store");
const { AI } = require("../ai-engine");
const { Agent } = require("../llm-agent");
const { Geo } = require("./geo");
const { Consensus } = require("./consensus");
const { Db } = require("./db");
const config = require("../config");

const now = () => Date.now();
const LATE_JOIN_MS = 15000;
const CONTRA_THROTTLE_MS = 5000;
const ASSIGN_TIMEOUT_MS = 30000;
const FACT_STALE_MS = 120000;

function broadcast(ev, obj) {
  const raw = JSON.stringify(obj);
  for (const c of ev.members) if (c.readyState === 1) c.send(raw);
}

function pushSystem(ev, kind, text, extra) {
  const msg = { ts: now(), who: "system", kind, text, ...(extra || {}) };
  ev.timeline.push(msg);
  broadcast(ev, { type: "timeline", msg });
  Store.persistMessage(ev, msg); // 持久化
  return msg;
}

// 現行事實精簡視圖
function currentFacts(ev) {
  return Object.fromEntries(["location", "injured", "threat"].filter((k) => ev.facts[k]).map((k) => [k, ev.facts[k]]));
}

// 統一矛盾偵測
function detectContradiction(ev, incoming) {
  const diffs = AI.contradictions(currentFacts(ev), incoming);
  if (!diffs.length) return;
  if (now() - (ev._lastContraTs || 0) <= CONTRA_THROTTLE_MS) {
    ev.contradictions.push({ ts: now(), detail: diffs.join("; ") });
    return;
  }
  ev._lastContraTs = now();
  ev.contradictions.push({ ts: now(), detail: diffs.join("; ") });
  pushSystem(ev, "contra", `闢謠引擎: 偵測到矛盾 — ${diffs.join("; ")}。已標記「未經證實」，請以官方資訊為準。`);
}

// ---------------------------------------------------------------- 微任務指派
function memberNames(ev) {
  return [...ev.members].filter((c) => !c.member?.observer).map((c) => c.member?.name).filter(Boolean);
}

function assignMicroTask(ev, factKey) {
  const names = memberNames(ev);
  if (!names.length || ev.pending) return;
  const to = names[Math.floor(Math.random() * names.length)];
  const q = AI.nextQuestion(ev.facts) || AI.ASK_ORDER[factKey];
  ev.pending = { to, question: q, factKey, ts: now(), escalated: false };
  pushSystem(ev, "assign", `AI 指揮官 @${to}: 請回報「${q}」— 這項資訊目前缺失，你的回覆將即時更新全員事實面板。`, { assign: { to, question: q } });
}

function checkAssignTimeout(ev) {
  if (!ev.pending || ev.pending.escalated) return;
  if (now() - ev.pending.ts > ASSIGN_TIMEOUT_MS) {
    ev.pending.escalated = true;
    pushSystem(ev, "ask", `AI 指揮官: @${ev.pending.to} 30 秒未回應，改請全員回報 — ${ev.pending.question}`);
  }
}

function tryAnswerAssignment(ev, name, text) {
  if (!ev.pending) return false;
  if (ev.pending.escalated || ev.pending.to === name) {
    ev.assignLog.push({ ...ev.pending, answeredBy: name, answerAt: now() });
    pushSystem(ev, "fact", `AI 指揮官: @${name} 已回應指派，感謝。該資訊將立即同步全員。`);
    ev.pending = null;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 統一吸收
// 雙引擎互補: LLM 判讀為主, 其 facts 缺漏處用規則引擎補抽 (模型有時把資訊放 reading)
async function agentAbsorb(ev, msg) {
  const result = await Agent.interpret(msg.text, null, ev.facts);

  // 融合: LLM facts + 規則引擎補抽 (只補 LLM 沒給的欄位)
  const fusedFacts = { ...(result.facts || {}) };
  const rulesFacts = AI.extractFacts(msg.text);
  for (const k of ["location", "injured", "threat"]) {
    if (!fusedFacts[k] && rulesFacts[k]) fusedFacts[k] = rulesFacts[k];
  }

  if (Object.keys(fusedFacts).length) {
    detectContradiction(ev, fusedFacts);
    const merged = AI.mergeFacts(ev.facts, fusedFacts);
    const list = Object.keys(merged.changed).map((k) => `${k}: ${merged.facts[k]}`);
    if (list.length) {
      ev.facts = merged.facts;
      ev.facts.sourceCount++;
      for (const k of Object.keys(merged.changed)) ev.factsTs[k] = now();
      pushSystem(ev, "fact", `AI 指揮官: 事實更新 — ${list.join(" / ")}`);
    }
  }

  if (result.severity >= 3 && result.reading) {
    pushSystem(ev, "fact", `AI 指揮官: ${result.reading} — ${result.advice}`);
  }

  const q = AI.nextQuestion(ev.facts);
  if (q) {
    if (memberNames(ev).length >= 2) assignMicroTask(ev, Object.keys(AI.ASK_ORDER).find((k) => !ev.facts[k]));
    else pushSystem(ev, "ask", `AI 指揮官: ${q}`);
  }
}

function startMissionTimer(ev) {
  if (ev.status !== "active" || ev._missionTimer) return;
  const tick = () => {
    if (ev.status !== "active") { ev._missionTimer = null; return; }
    const pct = AI.factPercent(ev.facts);
    if (pct < 100) {
      const q = AI.nextQuestion(ev.facts);
      if (q) pushSystem(ev, "ask", `AI 指揮官(追蹤): ${q} (目前資訊完整度 ${pct}%)`);
    }
    ev._missionTimer = setTimeout(tick, config.askIntervalMs);
  };
  ev._missionTimer = setTimeout(tick, config.askIntervalMs);
}

// ---------------------------------------------------------------- WS setup
function setup(server) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1 << 20 }); // 1MB 上限

  wss.on("connection", (conn, req) => {
    const u = new URL(req.url, "http://x");
    const key = u.searchParams.get("event") || "";
    const name = (u.searchParams.get("name") || "匿名").slice(0, 20);
    const roleParam = u.searchParams.get("role");
    const role = ["bystander", "reporter", "rescuer", "observer"].includes(roleParam) ? roleParam : "bystander";
    const observer = role === "observer";
    const ev = Store.find(key);

    conn.member = { name, role, observer, joinedAt: now() };
    if (!ev || ev.status !== "active") {
      conn.send(JSON.stringify({ type: "error", text: "事件不存在或已落幕" }));
      return conn.close(4000, "no-event");
    }
    ev.members.add(conn); // observer 也在 members 集合 (方便廣播), 但計數分開

    if (observer) {
      // 後台: 完整視圖 + 全部 timeline
      conn.send(JSON.stringify({
        type: "welcome",
        event: Store.publicView(ev),
        member: { ...conn.member, name: "console" },
        lateJoiner: true,
        summary: AI.summarize(ev),
        timeline: ev.timeline.slice(-200),
        zones: Store.ZONES,
        serverTime: now(),
      }));
      return; // observer 不推播加入訊息、不觸發 catch-up 廣播
    }

    const lateJoiner = now() - ev.createdAt > LATE_JOIN_MS;
    conn.send(JSON.stringify({
      type: "welcome",
      event: Store.publicView(ev),
      member: conn.member,
      lateJoiner,
      summary: AI.summarize(ev),
      timeline: ev.timeline.slice(-60),
      zones: Store.ZONES,
      serverTime: now(),
    }));
    if (lateJoiner) pushSystem(ev, "fact", `${name} 晚加入 — 已送出 Catch-up 摘要卡`);

    if (ev.drill) ev.drill.scores.set(name, ev.drill.scores.get(name) || { actions: 0, facts: 0, helpful: 0 });

    conn.on("message", async (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (ev.status !== "active") return;
      if (conn.member.observer) return; // 後台唯讀: 透過 REST 操作

      if (m.type === "chat" || m.type === "voice") {
        const text = String(m.text || m.note || "").slice(0, 500).trim();
        if (!text) return;
        const msg = { ts: now(), who: conn.member.name, kind: m.type, text };
        ev.timeline.push(msg);
        broadcast(ev, { type: "timeline", msg });
        Store.persistMessage(ev, msg);
        tryAnswerAssignment(ev, conn.member.name, text);
        if (ev.drill) {
          const s = ev.drill.scores.get(conn.member.name) || { actions: 0, facts: 0, helpful: 0 };
          s.actions++;
          if (ev.assignLog.length) s.facts++;
          ev.drill.scores.set(conn.member.name, s);
        }
        agentAbsorb(ev, msg).catch((e) => console.error("[agentAbsorb]", e.message));
      } else if (m.type === "photo") {
        const desc = AI.visionMock(m.note || "");
        const msg = { ts: now(), who: conn.member.name, kind: "photo", text: desc.caption, meta: { structured: desc.structured, image: m.image ? String(m.image).slice(0, 200000) : undefined } };
        ev.timeline.push(msg);
        broadcast(ev, { type: "timeline", msg });
        Store.persistMessage(ev, msg);
        const merged = AI.mergeFacts(ev.facts, desc.structured);
        if (Object.keys(merged.changed).length) {
          detectContradiction(ev, desc.structured);
          ev.facts = merged.facts;
          for (const k of Object.keys(merged.changed)) ev.factsTs[k] = now();
          pushSystem(ev, "fact", `AI 指揮官(多模態): 照片解析為結構化事實 — ${Object.keys(merged.changed).map((k) => `${k}: ${merged.facts[k]}`).join(" / ")}`);
        }
      } else if (m.type === "locate") {
        const lat = Number(m.lat), lng = Number(m.lng);
        if (!isFinite(lat) || !isFinite(lng)) return;
        Geo.reverseGeocode(lat, lng, (place) => {
          if (place && ev.status === "active" && !ev.facts.location) {
            ev.facts.location = place;
            pushSystem(ev, "fact", `AI 指揮官: ${conn.member.name} 的定位 — ${place}`);
          }
        });
      } else if (m.type === "verify") {
        // 1-Tap 驗證: {type:'verify', agree: true|false, voter: 'id'}
        const voter = String(m.voter || conn.member.name).slice(0, 40);
        const agree = !!m.agree;
        Consensus.vote(ev.votes, voter, agree);
        Db.saveVote(ev.id, voter, agree);
        const c = Consensus.publicView(ev.votes);
        pushSystem(ev, "vote", `1-Tap 驗證: ${agree ? "有人確認此事" : "有人回報未見/安全"} — 目前信心 ${c.score} 分 (${c.label.v})`, { consensus: c });
      }
    });

    conn.on("close", () => ev.members.delete(conn));
  });

  // 週期推進: 演習機器人 / 劇本注入 / 微任務逾時 / 事實保鮮覆核
  setInterval(() => {
    for (const ev of Store.listActive()) {
      if (ev.drill) ev.drill.bot.tick();
      if (ev._scenario) {
        const el = now() - ev._scenario.startedAt;
        while (ev._scenario.plan.length && ev._scenario.plan[0].at <= el) {
          const p = ev._scenario.plan.shift();
          const msg = { ts: now(), who: p.who, kind: "chat", text: p.text };
          ev.timeline.push(msg);
          broadcast(ev, { type: "timeline", msg });
          Store.persistMessage(ev, msg);
          agentAbsorb(ev, msg).catch(() => {});
        }
        if (!ev._scenario.plan.length) ev._scenario = null;
      }
      checkAssignTimeout(ev);
      const staleKeys = ["location", "injured", "threat"].filter(
        (k) => ev.facts[k] && ev.factsTs[k] && now() - ev.factsTs[k] > FACT_STALE_MS
      );
      if (staleKeys.length && now() - (ev._staleRemindTs || 0) > FACT_STALE_MS) {
        ev._staleRemindTs = now();
        pushSystem(ev, "ask", `AI 指揮官: 「${staleKeys.map((k) => ({ location: "位置", injured: "傷患", threat: "威脅" }[k])).join("、")}」已超過 2 分鐘未再確認，狀況可能已變化 — 請在場人員回報最新情況。`);
      }

      // 智慧解散: 無活動逾時 → AI 自動落幕生成報告 (後台沒人也能運作)
      const last = Math.max(
        ev.createdAt,
        ...ev.timeline.map((m) => m.ts || 0)
      );
      if (!ev.drill && now() - last > config.autoResolveMs) {
        autoResolve(ev);
      }
    }
  }, 8000);
}

// AI 自動落幕 (智慧解散) — 通知、生成報告、斷線、歸檔
function autoResolve(ev) {
  ev.status = "resolved";
  ev.resolvedAt = now();
  pushSystem(ev, "resolved", "AI 判定事件已平息 (無新活動 5 分鐘) — 自動落幕，報告已生成。感謝現場所有人的回報。");
  const { AI } = require("../ai-engine");
  const report = AI.report(ev);
  for (const c of [...ev.members]) { try { c.close(4000, "resolved"); } catch {} }
  ev.members.clear();
  Store.persist(ev);
  Store.scheduleCleanup(ev);
  console.log(`[auto-resolve] ${ev.code} ${ev.title}`);
}

module.exports = { Hub: { setup, pushSystem, broadcast, startMissionTimer, agentAbsorb } };
