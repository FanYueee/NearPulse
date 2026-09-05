// NearPulse 1-Tap 共識引擎 — Waze 式群眾驗證 (rule-based, 公式透明)
// 每事件維護投票桶: {confirm: Set<voterId>, deny: Set<voterId>} 單人單票可改票
"use strict";

const now = () => Date.now();

// 信心分數 (0-100), 全透明公式:
//   base 20 (第一手回報)
//   + confirm 12/票 (上限 60)  — 多人獨立確認快速拉升
//   - deny 15/票 (權重高於 confirm — 安全反向信號壓制惡作劇)
//   時間衰減: 每 120 秒 -4 (事實保鮮概念延伸到事件層)
const W = { base: 20, confirm: 12, confirmCap: 60, deny: 15, decayPer2min: 4 };

function newBucket() {
  return { confirm: new Set(), deny: new Set(), updatedAt: now(), history: [] };
}

function vote(bucket, voterId, agree) {
  if (!bucket) return null;
  // 改票: 從另一桶移除
  if (agree) {
    bucket.deny.delete(voterId);
    bucket.confirm.add(voterId);
  } else {
    bucket.confirm.delete(voterId);
    bucket.deny.add(voterId);
  }
  bucket.updatedAt = now();
  bucket.history.push({ ts: now(), voterId: voterId.slice(0, 8), agree });
  return score(bucket);
}

function score(bucket) {
  if (!bucket) return W.base;
  const ageMin = (now() - (bucket.updatedAt || now())) / 60000;
  const decay = Math.floor(ageMin / 2) * W.decayPer2min;
  const s = W.base + Math.min(bucket.confirm.size * W.confirm, W.confirmCap) - bucket.deny.size * W.deny - decay;
  return Math.max(0, Math.min(100, s));
}

// 標籤: 給 UI 與報告用的定性等級
function label(bucket) {
  const s = score(bucket);
  if (bucket && bucket.deny.size >= 3 && bucket.confirm.size <= bucket.deny.size) return { v: "疑似誤報", tone: "bad" };
  if (s >= 75) return { v: "高信心", tone: "ok" };
  if (s >= 45) return { v: "待驗證", tone: "warn" };
  return { v: "未證實", tone: "miss" };
}

function publicView(bucket) {
  if (!bucket) return { score: W.base, confirm: 0, deny: 0, label: label(null) };
  return {
    score: score(bucket),
    confirm: bucket.confirm.size,
    deny: bucket.deny.size,
    label: label(bucket),
    lastVoteAt: bucket.updatedAt,
  };
}

module.exports = { Consensus: { W, newBucket, vote, score, label, publicView } };
