// NearPulse 設定 — .env 載入 (零依賴) + 環境變數集中; 金鑰只在伺服器端
"use strict";

// 極簡 .env 載入: KEY=VALUE 每行一組, 不覆蓋既有環境變數
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch { /* .env 讀取失敗時退回純環境變數 */ }

const env = (k, d) => process.env[k] || d;

module.exports = {
  port: Number(env("PORT", 8080)),

  // LLM Agent (OpenAI 相容協定; 未設定金鑰時自動降級為本地規則引擎)
  llm: {
    apiKey: env("LLM_API_KEY", ""),
    baseUrl: env("LLM_BASE_URL", "https://api.openai.com/v1"),
    model: env("LLM_MODEL", "gpt-4o-mini"),
    timeoutMs: Number(env("LLM_TIMEOUT_MS", 45000)),
  },

  // 地理
  geo: {
    nominatimBase: "https://nominatim.openstreetmap.org",
    timeoutMs: 3000,
  },

  // AI 指揮官追問週期
  askIntervalMs: 45000,

  // 智慧解散: 無新活動超過此時間, AI 自動落幕並生成報告 (後台沒人也能運作)
  autoResolveMs: 5 * 60 * 1000,

  // 事件落幕後保留 30 分鐘供查閱報告
  eventRetentionMs: 30 * 60 * 1000,
};
