// NearPulse 演習模式 — 腳本機器人 + AI 評分
"use strict";

const now = () => Date.now();

const DRILL_STEPS = [
  { id: "assign",     label: "回應 AI 微任務指派 (被 @ 指名後回報)",   done: (ev) => (ev.assignLog || []).length > 0 },
  { id: "facts",      label: "補齊 3 項關鍵事實 (位置/傷患/威脅)",     done: (ev) => ["location", "injured", "threat"].every((k) => ev.facts[k]) },
  { id: "multimodal", label: "使用照片或語音回報",                     done: (ev) => ev.timeline.some((m) => m.kind === "photo" || m.kind === "voice") },
  { id: "zone",       label: "執行分區導流",                           done: (ev) => !!ev.zone },
  { id: "close",      label: "落幕 (停止演習)",                         done: (ev) => ev.status === "resolved" },
];

// 模擬民眾注入計畫 (有些正確、有些矛盾 — 供闢謠/事實補齊練習)
const NOISE_PLAN = [
  { at: 6000,  who: "民眾A", text: "好像是 B 區那邊傳來的味道，我離很遠看不太清楚" },
  { at: 14000, who: "民眾B", text: "我聽到有人說 3 樓，但我在 2 樓沒看到東西" },
  { at: 26000, who: "民眾C", text: "現場疑似有人受傷了，倒在地上！" },
  { at: 40000, who: "民眾D", text: "別擠！往 1 號出口走，B 區已經封閉了" },
];

class DrillBot {
  constructor(emit) {
    this.emit = emit; // ({kind, text, meta}) => void — 由 api.js 注入 pushSystem
    this.startedAt = now();
    this.plan = [...NOISE_PLAN];
  }

  start() {
    this.emit({ kind: "drill", text: "演習機器人上線 — 將以群眾身分注入模擬訊息，請依 AI 指揮官引導完成演習目標。" });
  }

  tick() {
    const el = now() - this.startedAt;
    while (this.plan.length && this.plan[0].at <= el) {
      const p = this.plan.shift();
      this.emit({ kind: "chat", text: `[演習模擬 ${p.who}] ${p.text}` });
    }
  }

  score(ev) {
    const pct = Math.round((DRILL_STEPS.filter((s) => s.done(ev)).length / DRILL_STEPS.length) * 100);
    const grade = pct >= 100 ? "優" : pct >= 60 ? "甲" : pct >= 40 ? "乙" : "丙";
    return {
      steps: DRILL_STEPS.map((s) => ({ id: s.id, label: s.label, done: s.done(ev) })),
      totalPercent: pct,
      grade,
      durationMin: Math.max(1, Math.round((now() - this.startedAt) / 60000)),
      members: [...ev.drill.scores.entries()].map(([name, s]) => ({ name, ...s })),
      comment: pct >= 100
        ? "全流程完成: 指派回應、事實補齊、多模態回報、導流、落幕皆到位 — 團隊協作成熟。"
        : "未完成項目: " + DRILL_STEPS.filter((s) => !s.done(ev)).map((s) => s.label).join("、") + "。建議再演練一次。",
    };
  }

  stop(ev) {
    return this.score(ev);
  }
}

module.exports = { DrillBot };
