// NearPulse AI 引擎 — 事實抽取 / 追問 / 矛盾 / 摘要 / 報告
// 介面為純函式; rulesInterpret 是 LLM 降級時的本地解讀
"use strict";

// ---------------------------------------------------------------- 通報分類
// 7 大類 x 細項 (前端快速情境按鈕對應 sub)
const KINDS = {
  fire:     { label: "火災",    subs: ["濃煙", "明火", "燒焦味", "警報響起"] },
  medical:  { label: "傷病",    subs: ["昏倒", "外傷流血", "呼吸困難", "心臟不適", "癲癇"] },
  crowd:    { label: "人群",    subs: ["推擠", "走失", "恐慌奔逃", "大排長龍"] },
  hazard:   { label: "環境",    subs: ["地面濕滑", "坍塌落石", "漏水", "停電", "異味"] },
  traffic:  { label: "交通",    subs: ["車輛故障", "追撞", "號誌異常", "軌道異物"] },
  security: { label: "治安",    subs: ["糾紛衝突", "竊盜", "可疑物品", "持械"] },
  other:    { label: "其他",    subs: [] },
};

const SEVERITIES = [
  { v: 1, label: "輕微", desc: "可自行處理或等待" },
  { v: 2, label: "注意", desc: "需要留意但不危急" },
  { v: 3, label: "緊急", desc: "建議立即通報 119/110" },
  { v: 4, label: "危急", desc: "立即撤離並呼叫救援" },
];

// ---------------------------------------------------------------- 事實抽取
function extractFacts(text) {
  const t = String(text || "");
  const out = {};

  const locMatch =
    t.match(/(\d+\s*(?:樓|F|f))/) ||
    t.match(/([A-Da-d]\s*區)/) ||
    t.match(/((?:捷運|台鐵|高鐵)?[\u4e00-\u9fa5]{2,6}(?:站|出口|月台))/) ||
    t.match(/(地下街[\u4e00-\u9fa5\d]*區?)/) ||
    t.match(/在([\u4e00-\u9fa5]{2,10}(?:路口|廣場|大廳|穿堂))/);
  if (locMatch && locMatch[1]) out.location = locMatch[1].trim();

  const noInj = /(沒有|無|沒)(?:人)?(?:受傷|傷患|人員受困)/.test(t) && !/(還|又|但|不過)[\u4e00-\u9fa5]{0,6}(受傷|倒地|受困)/.test(t);
  const injMatch =
    t.match(/(\d+\s*(?:人|名)[\u4e00-\u9fa5]{0,4}(?:受傷|流血|倒地|昏迷|受困))/) ||
    t.match(/((?:有|多人|一名|一位|幾名|兩人|三人)[\u4e00-\u9fa5]{0,3}(?:受傷|流血|倒地|昏迷|受困|昏倒))/) ||
    t.match(/(昏倒|昏迷|癲癇)/);
  if (noInj) out.injured = "無人受傷";
  else if (injMatch) out.injured = injMatch[0];

  const thrMatch = t.match(/(濃煙|明火|火勢|爆炸|瓦斯|刺鼻味|臭味|漏水|停電|坍塌|電梯故障|攻擊|鬥毆|持刀|可疑物|恐慌|推擠)/);
  if (thrMatch) out.threat = thrMatch[0];

  return out;
}

// ---------------------------------------------------------------- 事實合併
function mergeFacts(facts, incoming) {
  const changed = {};
  for (const k of ["location", "injured", "threat"]) {
    if (incoming[k] && incoming[k] !== facts[k]) changed[k] = incoming[k];
  }
  return { facts: { ...facts, ...changed }, changed };
}

// ---------------------------------------------------------------- 追問缺失
const ASK_ORDER = {
  location: "目前確切位置在哪裡? (地標/樓層/分區)",
  injured: "現場是否有人受傷或受困?",
  threat: "現場是否有立即威脅? (煙/火/爆裂物/其他)",
};

function nextQuestion(facts) {
  for (const k of ["location", "injured", "threat"]) {
    if (!facts[k]) return ASK_ORDER[k];
  }
  return null;
}

function factPercent(f) {
  const keys = ["location", "injured", "threat"];
  return Math.round((keys.filter((k) => f[k]).length / keys.length) * 100);
}

// ---------------------------------------------------------------- 矛盾偵測
function contradictions(current, incoming) {
  const out = [];
  if (!current || !incoming) return out;
  for (const k of ["location", "injured", "threat"]) {
    if (current[k] && incoming[k] && String(current[k]).trim() !== String(incoming[k]).trim()) {
      out.push(`${k}衝突: 「${current[k]}」vs「${incoming[k]}」`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Catch-up 摘要
function summarize(ev) {
  const facts = ev.facts || {};
  const dur = Math.max(1, Math.round((Date.now() - ev.createdAt) / 1000));
  const chatCount = ev.timeline.filter((m) => ["chat", "voice", "photo"].includes(m.kind)).length;
  const reportedBy = ev.timeline.find((m) => m.kind === "report")?.who || "目擊者";

  // 地標式引導 (無經緯度也能給方向)
  const { Geo2 } = require("./lib/semloc");
  let guidance = [
    ev.zone ? `避開 ${ev.zone}，依分區導流指示疏散` : "如需疏散，跟隨現場分區指示",
    "所有資訊以官方(119/110/站務人員)為準",
  ];
  if (ev.semantic && ev.spaceKey) {
    guidance = Geo2.generateGuidance(ev.spaceKey, ev.level, facts.threat);
  }

  return {
    headline: `事件「${ev.title}」${ev.status === "active" ? "進行中" : "已落幕"}，已持續約 ${dur >= 60 ? Math.round(dur / 60) + " 分鐘" : dur + " 秒"}`,
    what: ev.title,
    where: facts.location || "尚未確認",
    injured: facts.injured || "尚未確認",
    threat: facts.threat || "尚未確認",
    status: ev.status,
    stats: { messages: chatCount, members: ev.members ? ev.members.size : 0, reportedBy },
    guidance,
    caution: (ev.contradictions || []).length
      ? `注意: 偵測到 ${ev.contradictions.length} 件矛盾資訊，已標記未經證實。`
      : "目前無矛盾資訊。",
  };
}

// ---------------------------------------------------------------- 落幕報告
function report(ev) {
  const t0 = new Date(ev.createdAt);
  const t1 = new Date(ev.resolvedAt || Date.now());
  const durMin = Math.max(1, Math.round((t1 - t0) / 60000));
  const chat = ev.timeline.filter((m) => ["chat", "voice", "photo"].includes(m.kind));
  const systemMsgs = ev.timeline.filter((m) => m.who === "system");

  return {
    title: `落幕報告書 — ${ev.title}`,
    period: `${t0.toLocaleString("zh-TW")} ~ ${t1.toLocaleString("zh-TW")} (${durMin} 分鐘)`,
    factsAtClose: {
      location: ev.facts.location || "未確認",
      injured: ev.facts.injured || "未確認",
      threat: ev.facts.threat || "未確認",
    },
    stats: {
      participants: Math.max(ev.members.size, chat.length ? new Set(chat.map((m) => m.who)).size : 0),
      messages: chat.length,
      aiInterventions: systemMsgs.length,
      contradictions: (ev.contradictions || []).length,
      peakFactsComplete: factPercent(ev.facts),
    },
    aiNote: (ev.contradictions || []).length
      ? "資訊品質: 偵測到矛盾資訊並已標記，建議檢討來源可信度。"
      : "資訊品質: 無明顯矛盾，資訊迴路運作良好。",
    timeline: ev.timeline.slice(-20).map((m) => `[${new Date(m.ts).toLocaleTimeString("zh-TW")}] ${m.who === "system" ? "AI" : m.who}: ${m.text.slice(0, 60)}`),
    disclaimer: "本報告由系統自動生成，僅供演練與檢討使用，不取代官方事故調查。",
  };
}

// ---------------------------------------------------------------- 多模態 (照片) — mock, 接 Vision API 時替換
// 多語地標: EXIT/SORTIE/GATE/USCITA/AUSGANG/floor — 異國照片也能抽位置
function visionMock(note) {
  const n = String(note || "");
  if (/已無煙|沒有煙|無|無煙|煙散/.test(n)) return { caption: "照片解析: 現場已無明顯煙霧", structured: { threat: "已無煙霧" } };
  if (/火|煙|smoke|fire/i.test(n)) return { caption: "照片解析: 偵測到疑似濃煙", structured: { threat: "濃煙" } };
  if (/傷|倒|血|injur|fall|bless[eé]| Bless/i.test(n)) return { caption: "照片解析: 偵測到疑似傷患倒地", structured: { injured: "疑似 1 名傷患倒地" } };
  // 多語出口/地標 → 位置
  const exitMatch = n.match(/(?:exit|sortie|uscita|ausgang|salida|出口)\s*([0-9]{1,2})/i);
  if (exitMatch) return { caption: `照片解析: 偵測到出口標示 — ${exitMatch[0]}`, structured: { location: `近 ${exitMatch[1]} 號出口` } };
  const gateMatch = n.match(/(?:gate|登機門)\s*([A-Z]?\d{1,2}[a-z]?)/i);
  if (gateMatch) return { caption: `照片解析: 偵測到登機門 — ${gateMatch[0]}`, structured: { location: `登機門 ${gateMatch[1]}` } };
  const floorMatch = n.match(/(?:floor|樓|F)\s*([0-9])/i);
  if (floorMatch) return { caption: `照片解析: 樓層標示 — ${floorMatch[0]}`, structured: { location: `${floorMatch[1]}F 附近` } };
  const shopMatch = n.match(/(?:zara|uniqlo|starbucks|麥當勞|mcdonald|7-11|7-eleven|lv|gucci)/i);
  if (shopMatch) return { caption: `照片解析: 偵測到店名招牌 — ${shopMatch[0]}`, structured: { location: `${shopMatch[0]} 專櫃附近` } };
  const z = n.match(/([A-D]) 區/);
  if (z) return { caption: `照片解析: 定位於 ${z[1]} 區`, structured: { location: `${z[1]} 區` } };
  if (/電梯|樓梯|疏散|exit/i.test(n)) return { caption: "照片解析: 疏散動線狀況", structured: { location: "疏散動線附近" } };
  return { caption: `照片解析: ${n ? "場景「" + n.slice(0, 20) + "」" : "一般現場照"}`, structured: {} };
}

// ---------------------------------------------------------------- 本地規則解讀 (LLM 降級路徑)
// 回傳結構與 llm-agent interpret() 完全一致
function rulesInterpret(text, kindHint, facts) {
  const t = String(text || "");
  const ex = extractFacts(t);

  // 類別推斷
  let kind = kindHint && KINDS[kindHint] ? kindHint : null;
  if (!kind) {
    if (/火|煙|燒/.test(t)) kind = "fire";
    else if (/傷|昏|血|倒|癲癇|呼吸/.test(t)) kind = "medical";
    else if (/擠|恐慌|走失/.test(t)) kind = "crowd";
    else if (/坍塌|漏|停電|異味|濕滑/.test(t)) kind = "hazard";
    else if (/車|追撞|號誌|軌道/.test(t)) kind = "traffic";
    else if (/糾紛|竊|持刀|可疑物/.test(t)) kind = "security";
    else kind = "other";
  }

  // 嚴重度推斷
  let severity = 2;
  if (/爆炸|持刀|明火|火勢|坍塌|攻擊|恐慌|大量流血/.test(t)) severity = 4;
  else if (/濃煙|受傷|昏迷|倒地|癲癇|受困|推擠/.test(t)) severity = 3;
  else if (/輕微|小|無人|沒事/.test(t)) severity = 1;

  const sub = KINDS[kind].subs.find((s) => t.includes(s)) || null;
  const known = facts || {};
  const merged = mergeFacts(known, ex);

  return {
    ok: true,
    engine: "rules",
    kind,
    kindLabel: KINDS[kind].label,
    sub,
    severity,
    severityLabel: SEVERITIES[severity - 1].label,
    facts: ex,
    shouldUpdate: Object.keys(merged.changed).length > 0,
    reading: `以「${KINDS[kind].label}」情境解讀${sub ? " (細項: " + sub + ")" : ""}，研判嚴重度「${SEVERITIES[severity - 1].label}」`,
    advice: severity >= 3
      ? "建議: 立即通報 119/110，並保持現場資訊回報"
      : "建議: 持續觀察，若有變化立即回報",
  };
}

// ---------------------------------------------------------------- 事件標題
function titleFrom(kind, text) {
  const label = (KINDS[kind] && KINDS[kind].label) || "突發狀況";
  const loc = extractFacts(text || "").location;
  return loc ? `${label} — ${loc}` : `${label}事件`;
}

module.exports = {
  AI: {
    KINDS, SEVERITIES, ASK_ORDER,
    extractFacts, mergeFacts, nextQuestion, factPercent,
    contradictions, summarize, report, visionMock,
    rulesInterpret, titleFrom,
  },
};
