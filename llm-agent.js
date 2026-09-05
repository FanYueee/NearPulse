// NearPulse LLM Agent — OpenAI 相容 API; 未設定金鑰時降級為本地規則引擎
// 語音 -> 文字後, 由 agent 解讀情境 (類別/嚴重度/事實抽取/建議)
"use strict";

const { AI } = require("./ai-engine");
const config = require("./config");

function llmReady() {
  if (process.env.LLM_OFF === "1") return false; // 測試/離線強制規則引擎
  return !!config.llm.apiKey;
}

// 呼叫 OpenAI 相容 /chat/completions (不依賴 response_format — 相容端點多半不支援)
async function chat(messages, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs || config.llm.timeoutMs, 30000));
  try {
    const r = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        temperature: 0.2,
      }),
    });
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

// 從模型輸出穩定抽取 JSON (剝 markdown 圍欄/前後綴文字)
function extractJson(raw) {
  const t = String(raw || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : t;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no json in response");
  return JSON.parse(candidate.slice(start, end + 1));
}

const INTERPRET_SYSTEM = `你是公共場所突發事件的指揮官 AI。用 JSON 回應。
輸入: 民眾的口語回報 (可能來自語音辨識, 有錯字)、目前已知事實。
輸出 JSON 欄位:
- kind: 火災fire/傷病medical/人群crowd/環境hazard/交通traffic/治安security/其他other 擇一 (英文鍵)
- sub: 對應細項 (無則 null)
- severity: 1輕微 2注意 3緊急 4危急 (數字)
- facts: {location, injured, threat} 從回報抽取, 無法抽取則該鍵為 null
- reading: 一句話情境研判 (繁體中文, 20 字內)
- advice: 一句話建議行動 (繁體中文, 20 字內)
- shouldUpdate: facts 是否比已知事實有新資訊 (true/false)
只用 JSON, 不加其他文字。`;

// 解讀回報 -> {ok, engine, kind, kindLabel, sub, severity, severityLabel, facts, shouldUpdate, reading, advice}
// 現場語境: 8 秒內沒回應就走規則引擎 (人群等不起), 不影響事件流程
const INTERPRET_TIMEOUT_MS = 8000;

async function interpret(text, kindHint, facts) {
  const user = `回報: ${text}\n已知事實: ${JSON.stringify(facts || {})}`;

  // 降級: 無金鑰
  if (!llmReady()) return AI.rulesInterpret(text, kindHint, facts);

  try {
    const raw = await chat([
      { role: "system", content: INTERPRET_SYSTEM },
      { role: "user", content: user },
    ], INTERPRET_TIMEOUT_MS);
    const j = extractJson(raw);

    // 驗證 + 正規化 (LLM 輸出不可全信)
    const kind = AI.KINDS[j.kind] ? j.kind : "other";
    const severity = [1, 2, 3, 4].includes(Number(j.severity)) ? Number(j.severity) : 2;
    const known = facts || {};
    const incoming = {};
    for (const k of ["location", "injured", "threat"]) {
      if (j.facts && typeof j.facts[k] === "string" && j.facts[k].trim()) incoming[k] = j.facts[k].trim();
    }
    const merged = AI.mergeFacts(known, incoming);

    return {
      ok: true,
      engine: "llm",
      kind, kindLabel: AI.KINDS[kind].label,
      sub: (typeof j.sub === "string" && AI.KINDS[kind].subs.includes(j.sub)) ? j.sub : null,
      severity, severityLabel: AI.SEVERITIES[severity - 1].label,
      facts: incoming,
      shouldUpdate: Object.keys(merged.changed).length > 0,
      reading: String(j.reading || "").slice(0, 60) || "情境解讀中",
      advice: String(j.advice || "").slice(0, 60) || "持續觀察",
    };
  } catch (e) {
    // 網路/逾時/格式錯誤 -> 降級規則引擎, 服務不中斷
    const fallback = AI.rulesInterpret(text, kindHint, facts);
    fallback.engine = "rules-fallback";
    return fallback;
  }
}

module.exports = { Agent: { llmReady, interpret } };
