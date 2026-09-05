// NearPulse REST API — 路由表化; 每條路由 (method, regex, handler)
"use strict";

const QRCode = require("qrcode");
const { Store } = require("./store");
const { Geo } = require("./geo");
const { AI } = require("../ai-engine");
const { Agent } = require("../llm-agent");
const { DrillBot } = require("../drill-bot");
const { Hub } = require("./ws-hub");
const { Geo2 } = require("./semloc");
const { Consensus } = require("./consensus");
const { Db } = require("./db");
const config = require("../config");

const now = () => Date.now();

// 兩點球面距離 (公尺)
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 群播注入 (server 啟動時注入; 這裡給安全守衛)
let pushSystem = (ev, kind, text, extra) => {
  console.error("[api] pushSystem 未注入");
  return null;
};
function bindSystem(fn) { pushSystem = fn; }

async function qrFor(req, code) {
  const host = req.headers.host || "localhost";
  return QRCode.toDataURL(`http://${host}/?join=${code}`, { width: 320, margin: 1 });
}

const routes = [
  // ------------------------------------------------ meta / health
  ["GET", /^\/api\/meta\/kinds$/, async () => [200, {
    kinds: AI.KINDS, severities: AI.SEVERITIES, zones: Store.ZONES,
    spaces: Geo2.SPACES, levels: Geo2.LEVELS,
    llm: Agent.llmReady(),
  }]],

  ["GET", /^\/api\/health$/, async () => [200, { ok: true, events: Store.listActive().length, llm: Agent.llmReady(), ts: now() }]],

  // ------------------------------------------------ 通報建立
  ["POST", /^\/api\/events$/, async (m, req, res, body) => {
    const text = String(body.text || "").trim();
    if (!text) return [400, { error: "text 必填" }];
    const payload = { ...body };
    // 位置自動判斷 (不丟選項給使用者): 明確快選 > 文字抽取 > 語境猜測空間 > GPS
    const spaceK = (body.space && Geo2.SPACES[body.space]) ? body.space : Geo2.guessSpace(text);
    if (spaceK) {
      payload.space = spaceK;
      payload.semantic = body.semantic || Geo2.extractSemantic(text) || Geo2.semanticLocation(spaceK, body.anchor, body.level);
    } else if (!payload.semantic) {
      payload.semantic = Geo2.extractSemantic(text);
    }
    const ev = Store.create(payload);
    ev.title = AI.titleFrom(body.kind, text);
    ev.spaceKey = spaceK || null;
    if (payload.semantic && !ev.facts.location) {
      ev.facts.location = payload.semantic;
      ev.factsTs.location = now();
    }
    // LLM 判讀的位置事實不覆蓋已確定的語意座標

    // AI Agent 解讀 (類別/嚴重度/事實) — 雙引擎融合: LLM 為主, 缺漏處規則引擎補抽
    const first = await Agent.interpret(text, body.kind, ev.facts);
    const fusedFacts = { ...(first.facts || {}) };
    const rulesFacts = AI.extractFacts(text);
    for (const k of ["location", "injured", "threat"]) {
      if (!fusedFacts[k] && rulesFacts[k]) fusedFacts[k] = rulesFacts[k];
    }
    for (const k of ["location", "injured", "threat"]) {
      if (fusedFacts[k] && !ev.facts[k]) {
        ev.facts[k] = fusedFacts[k];
        ev.factsTs[k] = now();
      }
    }
    ev.facts.sourceCount = 1;
    if (!ev.severity || ev.severity === 2) ev.severity = first.severity; // 使用者未明選時採 AI 判讀

    const via = first.engine === "llm" ? "AI Agent" : "AI (本地引擎)";
    pushSystem(ev, "report", `新事件通報: ${ev.title} — ${via}研判「${first.kindLabel}」嚴重度「${AI.SEVERITIES[ev.severity - 1].label}」。${first.advice}`);
    if (first.reading) pushSystem(ev, "fact", `AI 指揮官: ${first.reading}`);

    if (isFinite(Number(body.lat)) && isFinite(Number(body.lng))) {
      Geo.reverseGeocode(Number(body.lat), Number(body.lng), (place) => {
        if (place && ev.status === "active" && !ev.facts.location) {
          ev.facts.location = place;
          pushSystem(ev, "fact", `AI 指揮官: GPS 定點完成 — ${place}`);
        }
      });
    }

    const q = AI.nextQuestion(ev.facts);
    if (q) pushSystem(ev, "ask", `AI 指揮官: ${q}`);

    // AI 自動引導: 事件建立即廣播疏散/應對方向 (後台沒人也能運作)
    const guide = Geo2.generateGuidance(ev.spaceKey, ev.level, ev.facts.threat);
    pushSystem(ev, "guide", `AI 引導: ${guide.join("；")}`);

    Hub.startMissionTimer(ev); // 45 秒週期追蹤 (資訊完整度不足時)
    Store.persist(ev);

    return [200, { ...Store.publicView(ev), severity: ev.severity, qr: await qrFor(req, ev.code), timeline: ev.timeline }];
  }],

  // ------------------------------------------------ 1-Tap 驗證 (REST; 供掃碼未進群的路人)
  ["POST", /^\/api\/events\/([^/]+)\/verify$/, async (m, req, res, body) => {
    const ev = Store.find(m[1]);
    if (!ev) return [404, { error: "事件不存在" }];
    if (ev.status !== "active") return [409, { error: "事件已落幕" }];
    const voter = String(body.voter || (req.socket.remoteAddress || "anon")).slice(0, 40);
    const agree = !!body.agree;
    Consensus.vote(ev.votes, voter, agree);
    Db.saveVote(ev.id, voter, agree);
    const c = Consensus.publicView(ev.votes);
    Hub.pushSystem(ev, "vote", `1-Tap 驗證: ${agree ? "有人確認此事" : "有人回報未見/安全"} — 信心 ${c.score} 分 (${c.label.v})`, { consensus: c });
    return [200, { consensus: c }];
  }],

  // ------------------------------------------------ 後台統計
  ["GET", /^\/api\/admin\/stats$/, async () => [200, { db: Db.stats(), active: Store.listActive().length, llm: Agent.llmReady(), mode: Db.mode }]],

  // ------------------------------------------------ Demo 重置: 事件歸零, 乾淨起始狀態
  ["POST", /^\/api\/admin\/reset$/, async () => {
    Store.clear();
    Db.reset();
    return [200, { ok: true, active: 0, db: Db.stats() }];
  }],

  // ------------------------------------------------ Demo 情境劇本: 一鍵注入完整可演事件
  // paris: 異國地鐵 (GPS失效/多語群眾) | airport: 登機門昏倒 | mall: 百貨走失
  ["POST", /^\/api\/admin\/scenario$/, async (m, req, res, body) => {
    const name = String(body.name || "paris");
    const SCENARIOS = {
      paris: {
        kind: "medical", text: "Someone collapsed near the platform! 有人昏倒了，需要幫助",
        space: "platform", anchor: "3", level: "B2", severity: 4,
        title: "傷病 — 巴黎地鐵 月台門 3",
        lat: 48.8566, lng: 2.3522, // demo: 巴黎市中心 (Châtelet 附近)
        sim: [
          { at: 4000,  who: "Local A",  text: "Je ne comprends pas… is someone hurt there?" },
          { at: 9000,  who: "旅客 B",   text: "我看到月台門 3 那邊有人倒著不動" },
          { at: 15000, who: "Local C",  text: "There is an exit sign SORTIE 3 just above the stairs" },
          { at: 22000, who: "旅客 D",   text: "這站是 Châtelet，我在地下二層，指標全看不懂" },
        ],
      },
      airport: {
        kind: "medical", text: "一位旅客在登機門 B12 附近突然昏倒，臉色發白",
        space: "gate", anchor: "B12", level: "2F", severity: 4,
        title: "傷病 — 機場 登機門 B12",
        lat: 25.0777, lng: 121.2327, // demo: 桃園機場 T2
        sim: [
          { at: 4000,  who: "地勤 A", text: "B12 這裡需要醫護，廣播已經呼叫了" },
          { at: 9000,  who: "旅客 B", text: "我看到機場有 AED 標示，在 B11 旁邊" },
          { at: 15000, who: "旅客 C", text: "昏倒的是一位老先生，現在有意識了" },
        ],
      },
      mall: {
        kind: "crowd", text: "小孩與家人走失，在專櫃 ZARA 附近哭泣",
        space: "mall", anchor: "ZARA", level: "3F", severity: 3,
        title: "人群 — 百貨 3F 走失",
        lat: 25.0330, lng: 121.5644, // demo: 台北車站周邊商圈
        sim: [
          { at: 4000,  who: "店員 A", text: "小孩在我們櫃上，約 5 歲，很緊張" },
          { at: 9000,  who: "顧客 B", text: "服務台可以廣播尋人，我帶他去" },
          { at: 15000, who: "媽媽",   text: "我在 2F 化妝品區，馬上上來，謝謝大家" },
        ],
      },
    };
    const sc = SCENARIOS[name];
    if (!sc) return [400, { error: "劇本不存在: paris|airport|mall" }];

    const ev = Store.create({
      ...sc,
      semantic: Geo2.semanticLocation(sc.space, sc.anchor, sc.level),
    });
    ev.title = sc.title;
    ev.spaceKey = sc.space;
    const first = await Agent.interpret(sc.text, sc.kind, ev.facts);
    for (const k of ["location", "injured", "threat"]) {
      if (first.facts[k] && !ev.facts[k]) ev.facts[k] = first.facts[k];
    }
    if (!ev.facts.location && ev.semantic) ev.facts.location = ev.semantic;
    ev.facts.sourceCount = 1;
    ev.severity = sc.severity;
    pushSystem(ev, "report", `新事件通報: ${ev.title} — 模擬情境「${name}」。${first.advice}`);

    // AI 自動引導 (劇本事件同樣享受)
    const guide = Geo2.generateGuidance(sc.space, sc.level, first.facts.threat);
    pushSystem(ev, "guide", `AI 引導: ${guide.join("；")}`);

    // 劇本注入器 (定時推 sim 訊息, 進 timeline 並走 agent 吸收)
    ev._scenario = { plan: sc.sim.map((s) => ({ ...s })), startedAt: now() };
    const qr = await qrFor(req, ev.code);
    Store.persist(ev);
    return [200, { ...Store.publicView(ev), qr, timeline: ev.timeline }];
  }],

  // ------------------------------------------------ 演習 (放 :key 之前)
  ["POST", /^\/api\/events\/drill\/start$/, async (m, req, res, body) => {
    const ev = Store.create({});
    ev.title = `[演習] ${body.org || "組織"}${body.scenario === "medical" ? "人員受傷" : "火警"}情境`;
    ev.drill = { scores: new Map(), scenario: body.scenario === "medical" ? "medical" : "fire" };
    ev.drill.bot = new DrillBot((msg) => pushSystem(ev, msg.kind, msg.text, msg.meta));
    pushSystem(ev, "drill", `演習模式啟動 — 情境: ${ev.drill.scenario === "medical" ? "人員受傷" : "火警"}。目標: 補齊事實、多模態回報、導流、落幕。`);
    ev.drill.bot.start();
    Store.persist(ev); // 標題確定後歸檔
    const qr = await qrFor(req, ev.code);
    return [200, { ...Store.publicView(ev), qr, timeline: ev.timeline }];
  }],

  // ------------------------------------------------ 單一事件
  ["GET", /^\/api\/events$/, async () => [200, Store.listActive().map(Store.publicView)]],

  ["GET", /^\/api\/events\/([^/]+)$/, async (m) => {
    const ev = Store.find(m[1]);
    if (!ev) return [404, { error: "事件不存在" }];
    const members = [...ev.members].map((c) => ({ name: c.member?.name || "匿名", role: c.member?.role || "bystander" }));
    return [200, { ...Store.publicView(ev), timeline: ev.timeline.slice(-80), members, zones: Store.ZONES }];
  }],

  // 分區導流 (zone 需屬於白名單)
  ["PATCH", /^\/api\/events\/([^/]+)$/, async (m, req, res, body) => {
    const ev = Store.find(m[1]);
    if (!ev) return [404, { error: "事件不存在" }];
    if (body.zone) {
      if (!Store.ZONES.includes(body.zone)) return [400, { error: "zone 不合法" }];
      ev.zone = body.zone;
      pushSystem(ev, "zone", `AI 指揮官: 風險分區已更新 — 請避開 ${body.zone}，依「分區導流」指引疏散`);
      Store.persist(ev);
    }
    return [200, Store.publicView(ev)];
  }],

  // 摘要卡
  ["GET", /^\/api\/events\/([^/]+)\/summary$/, async (m) => {
    const ev = Store.find(m[1]);
    if (!ev) return [404, { error: "事件不存在" }];
    return [200, { event: Store.publicView(ev), summary: AI.summarize(ev) }];
  }],

  // QR
  ["GET", /^\/api\/events\/([^/]+)\/qr$/, async (m, req) => {
    const ev = Store.find(m[1]);
    if (!ev) return [404, { error: "事件不存在" }];
    return [200, { code: ev.code, qr: await qrFor(req, ev.code) }];
  }],

  // 落幕報告
  ["GET", /^\/api\/events\/([^/]+)\/report$/, async (m) => {
    const ev = Store.find(m[1]);
    if (!ev) return [404, { error: "事件不存在" }];
    if (ev.status !== "resolved") return [409, { error: "事件仍在進行中" }];
    return [200, { event: Store.publicView(ev), report: AI.report(ev) }];
  }],

  // 落幕
  ["POST", /^\/api\/events\/([^/]+)\/resolve$/, async (m) => {
    const ev = Store.find(m[1]);
    if (!ev) return [404, { error: "事件不存在" }];
    if (ev.status === "resolved") return [409, { error: "已落幕" }];
    if (ev.drill) return [409, { error: "演習事件請用 /drill/stop 結束" }];
    ev.status = "resolved";
    ev.resolvedAt = now();
    pushSystem(ev, "resolved", "事件已落幕，群組將自動解散。結案報告已生成。");
    const report = AI.report(ev);
    for (const c of [...ev.members]) c.close(4000, "resolved");
    ev.members.clear();
    Store.persist(ev);
    Store.scheduleCleanup(ev);
    return [200, { event: Store.publicView(ev), report }];
  }],

  // 演習: 結束 + 評分
  ["POST", /^\/api\/events\/([^/]+)\/drill\/stop$/, async (m) => {
    const ev = Store.find(m[1]);
    if (!ev || !ev.drill) return [404, { error: "演習事件不存在" }];
    if (ev.status === "resolved") return [409, { error: "演習已結束" }];
    ev.status = "resolved";
    ev.resolvedAt = now();
    const scores = ev.drill.bot.stop(ev);
    pushSystem(ev, "drill", "演習結束 — AI 評分已生成。");
    const report = AI.report(ev);
    for (const c of [...ev.members]) c.close(4000, "resolved");
    ev.members.clear();
    Store.persist(ev);
    Store.scheduleCleanup(ev);
    return [200, { event: Store.publicView(ev), scores, report }];
  }],

  // ------------------------------------------------ AI / Geo
  ["POST", /^\/api\/ai\/interpret$/, async (m, req, res, body) => {
    const text = String(body.text || "").trim();
    if (!text) return [400, { error: "text 必填" }];
    const result = await Agent.interpret(text, body.kind, body.facts);
    return [200, result];
  }],

  ["GET", /^\/api\/geo\/reverse$/, async (m, req, res, body, params) => {
    const lat = Number(params.get("lat")), lng = Number(params.get("lng"));
    if (!isFinite(lat) || !isFinite(lng)) return [400, { error: "lat/lng 必填" }];
    return await new Promise((resolve) => {
      Geo.reverseGeocode(lat, lng, (place) => resolve([200, { place }]));
    });
  }],

  // 逃脫導航: 事故點 + 使用者位置 → 安全目標點 (戶外開闊地優先) + Google Maps 深連結
  // 距離過遠 (>2km, 可能是異國 demo 座標) → 回 near=false, 前端降級為純語意引導
  ["GET", /^\/api\/geo\/forward$/, async (m, req, res, body, params) => {
    const lat = Number(params.get("lat")), lng = Number(params.get("lng"));
    const elat = Number(params.get("elat")), elng = Number(params.get("elng"));
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(elat) || !isFinite(elng)) {
      return [400, { error: "lat/lng/elat/elng 必填" }];
    }
    const dist = haversine(lat, lng, elat, elng);
    // 安全點: 從事故點往使用者方向延伸 220m (遠離危險源) 的戶外目標
    const bearing = Math.atan2(elng - lng, elat - lat);
    const SAFE_DIST = 0.0022; // ~220m 經度近似
    const safeLat = elat + SAFE_DIST * Math.cos(bearing) * 1.4;
    const safeLng = elng + SAFE_DIST * Math.sin(bearing) * 1.4;
    const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${elat},${elng}&destination=${safeLat.toFixed(6)},${safeLng.toFixed(6)}&travelmode=walking&dir_action=navigate`;
    return [200, {
      near: dist <= 2000,
      distM: Math.round(dist),
      safe: { lat: Number(safeLat.toFixed(6)), lng: Number(safeLng.toFixed(6)) },
      gmaps,
    }];
  }],
];

// 分發: 回傳 [status, obj] 或 null (未匹配)
async function dispatch(req, res, pathname, params, body) {
  for (const [method, re, handler] of routes) {
    if (req.method !== method) continue;
    const m = pathname.match(re);
    if (!m) continue;
    try {
      return await handler(m, req, res, body, params);
    } catch (e) {
      return [500, { error: String((e && e.message) || e) }];
    }
  }
  return null;
}

module.exports = { Api: { dispatch, bindSystem } };
