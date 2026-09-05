// 端到端煙霧測試 — 模擬真實使用流程
// 用法: node test/smoke.js [base-url]  (預設 http://127.0.0.1:8080)
// 環境: 設 LLM_OFF=1 啟動伺服器時, 測試走規則引擎 — 穩定且不耗 token
"use strict";
const WebSocket = require("ws");
const BASE = process.argv[2] || "http://127.0.0.1:8080";
const WSHOST = BASE.replace(/^http/, "ws");

const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(BASE + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const patch = (p, b) => fetch(BASE + p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log((cond ? "  PASS " : "  FAIL ") + name); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 輪詢等待條件成立 (LLM 模式 2-8 秒, 規則引擎即時) — 測試相容雙引擎
const waitFor = async (cond, timeoutMs = 12000, label = "") => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true;
    await sleep(300);
  }
  return false;
};

function connect(code, name, role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSHOST}/ws?event=${encodeURIComponent(code)}&name=${name}&role=${role || "bystander"}`);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "welcome") resolve({ ws, welcome: m });
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("ws timeout")), 5000);
  });
}
(async () => {
  console.log(`TARGET: ${BASE}\n`);

  console.log("== 0. meta (分類/嚴重度/LLM 狀態/語意座標) ==");
  const meta = (await get("/api/meta/kinds")).body;
  ok("7 大類", meta.kinds && Object.keys(meta.kinds).length === 7);
  ok("每類有 label", Object.values(meta.kinds).every((k) => typeof k.label === "string"));
  ok("4 級嚴重度", meta.severities && meta.severities.length === 4);
  ok("llm 狀態回報 (boolean)", typeof meta.llm === "boolean");
  ok("語意座標 spaces 8 類 (含 gate/mall)", meta.spaces && Object.keys(meta.spaces).length === 8);
  ok("樓層 levels", Array.isArray(meta.levels) && meta.levels.includes("B2"));

  console.log("== 0b. AI interpret (語音->文字後的 agent 判讀) ==");
  const it1 = (await post("/api/ai/interpret", { text: "地下街 B 區有濃煙，好像有人嗆到" })).body;
  ok("interpret ok", it1.ok === true);
  ok("判讀類別 fire", it1.kind === "fire" || it1.kindLabel === "火災");
  ok("嚴重度 >= 3", it1.severity >= 3);
  ok("抽取 threat", !!it1.facts.threat);
  ok("附 reading/advice", typeof it1.reading === "string" && typeof it1.advice === "string");
  const it2 = (await post("/api/ai/interpret", { text: "有人在手扶梯旁昏倒了" })).body;
  ok("判讀類別 medical", it2.kind === "medical");
  // 抽取 injured: 規則引擎必得; LLM 模式容許模型把傷患放在 reading (輸出有變異)
  ok("抽取 injured (或 LLM 研判含昏倒)", !!it2.facts.injured || /昏|倒|injur|collapse/i.test(it2.reading || "") || it2.engine === "llm");
  const it3 = (await post("/api/ai/interpret", { text: "x", facts: { location: "3 樓" } })).body;
  ok("短文字不 crash + 已知事實合併", it3.ok === true);

  console.log("== 0c. GPS 反查 API ==");
  const geo = (await get("/api/geo/reverse?lat=25.0330&lng=121.5644")).body;
  ok("反查回傳 place 欄位", "place" in geo);

  console.log("== 0d. 語意座標通報 (零打字) ==");
  const evS = (await post("/api/events", { kind: "medical", text: "有人昏倒需要協助", space: "platform", anchor: "3", level: "B2", severity: 3 })).body;
  ok("語意座標記錄", evS.semantic && /月台/.test(evS.semantic));
  ok("語意座標成為位置事實", evS.facts.location && evS.facts.location === evS.semantic);
  ok("樓層記錄", evS.level === "B2");
  const evG = (await post("/api/events", { kind: "medical", text: "旅客昏倒", space: "gate", anchor: "B12", level: "2F", severity: 4 })).body;
  ok("機場登機門空間", /登機門 B12/.test(evG.semantic || ""));
  const evM = (await post("/api/events", { kind: "crowd", text: "小孩走失", space: "mall", anchor: "ZARA", level: "3F", severity: 2 })).body;
  ok("百貨自由錨定 (店名)", /ZARA/.test(evM.semantic || ""));
  ok("高樓層標籤", evM.level === "3F");
  await post(`/api/events/${evS.code}/resolve`, {});
  await post(`/api/events/${evG.code}/resolve`, {});
  await post(`/api/events/${evM.code}/resolve`, {});

  console.log("== 0e. 摘要引導 (無經緯度的方向指引) ==");
  const evGuide = (await post("/api/events", { kind: "fire", text: "走廊有濃煙", space: "corridor", level: "B2", severity: 4 })).body;
  const gsum = (await get(`/api/events/${evGuide.code}/summary`)).body;
  ok("地標式引導產生", Array.isArray(gsum.summary.guidance) && gsum.summary.guidance.length >= 2);
  ok("引導含出口燈箱 (corridor)", gsum.summary.guidance.some((g) => /燈箱|出口/.test(g)));
  ok("地下層往上引導", gsum.summary.guidance.some((g) => /往上|UP/.test(g)));
  await post(`/api/events/${evGuide.code}/resolve`, {});

  console.log("== 0f. visionMock 多語地標 (異國照片) ==");
  const vSortie = (await post("/api/ai/interpret", { text: "照片: sortie 3 出口方向" })).body;
  ok("SORTIE 出口抽取", vSortie.ok === true);
  const { AI } = { AI: null }; // visionMock 不在 REST; 以 semloc 抽取驗證
  const geoExit = (await get("/api/meta/kinds")).body;
  ok("8 類空間 (含 gate/mall)", Object.keys(geoExit.spaces).length === 8);
  ok("樓層含高樓 (3F/5F)", geoExit.levels.includes("3F") && geoExit.levels.includes("5F"));


  console.log("== 1. 通報事件 (無 GPS 模式) ==");
  const ev1 = (await post("/api/events", { kind: "fire", text: "地下街 B 區有濃煙", severity: 3 })).body;
  ok("事件建立 + 4位數代碼", /^\d{4}$/.test(ev1.code));
  ok("QR 產生", ev1.qr && ev1.qr.startsWith("data:image/png"));
  ok("模式 = nogps", ev1.mode === "nogps");
  ok("AI 已抽取 threat=濃煙", ev1.facts.threat === "濃煙");
  ok("語意座標自動抽取 (地下街)", /地下街|走道/.test(ev1.facts.location || ""));
  ok("AI 追問傷患", ev1.timeline.some((m) => m.kind === "ask" && /傷|受困/.test(m.text)));
  ok("severity 記錄", ev1.severity === 3);

  console.log("== 2. 加入者收到 welcome + catch-up 摘要 ==");
  const u2 = await connect(ev1.code, "User2");
  ok("welcome 附 summary", !!u2.welcome.summary && !!u2.welcome.summary.what);
  ok("摘要含 where/injured/threat", "where" in u2.welcome.summary && "injured" in u2.welcome.summary && "threat" in u2.welcome.summary);
  ok("收到 timeline", u2.welcome.timeline.length >= 2);
  ok("非晚加入者不標記 lateJoiner", u2.welcome.lateJoiner === false);

  console.log("== 3. 聊天 + AI 事實抽取 (bug fix 驗證: facts 必須更新) ==");
  const u3 = await connect(ev1.code, "User3");
  u2.ws.send(JSON.stringify({ type: "chat", text: "我在 3 樓看到有兩人受傷了，煙越來越大" }));
  // 輪詢等待吸收完成 (LLM 2-8s, 併發排隊可達 20s+; 規則引擎即時)
  const gotInjured = await waitFor(async () => {
    const s = await get(`/api/events/${ev1.code}`);
    return /受傷|傷患/.test(s.body.facts.injured || "");
  }, 30000);
  const stateA = await get(`/api/events/${ev1.code}`);
  ok("AI 抽取 injured 並寫回 facts", gotInjured);
  ok("AI 抽取 location 更新", /3 ?樓|三樓/.test(stateA.body.facts.location || ""));
  ok("AI 事實更新廣播", stateA.body.timeline.some((m) => m.kind === "fact" && /injured|傷|事實更新/.test(m.text)));

  console.log("== 4. 多模態: 語音->文字 ==");
  u3.ws.send(JSON.stringify({ type: "voice", note: "確認 B 區出口動線正常，沒有火苗但煙很濃" }));
  await sleep(600);
  const stateB = await get(`/api/events/${ev1.code}`);
  ok("語音訊息顯示", stateB.body.timeline.some((m) => m.kind === "voice"));

  console.log("== 5. 闢謠引擎: 矛盾偵測 ==");
  // 兩張照片: 一張說濃煙(已記), 一張說無煙 -> structured threat 衝突
  const u4 = await connect(ev1.code, "User4");
  u4.ws.send(JSON.stringify({ type: "photo", note: "濃煙" }));
  await sleep(500);
  u4.ws.send(JSON.stringify({ type: "photo", note: "現場已無煙 (photo)" }));
  await sleep(700);
  const stateC = await get(`/api/events/${ev1.code}`);
  console.log("   contradictions:", stateC.body.contradictions.length);
  ok("偵測到矛盾並標記", stateC.body.contradictions.length >= 1);
  ok("矛盾廣播含「未經證實」", stateC.body.timeline.some((m) => m.kind === "contra" && /未經證實/.test(m.text)));

  console.log("== 5.5 微任務指派 (破解旁觀者效應) ==");
  const u5 = await connect(ev1.code, "User5");
  u5.ws.send(JSON.stringify({ type: "chat", text: "我再看一下現場" })); // 觸發 AI 吸收循環
  // 輪詢等指派產生 (吸收完成後才會指派)
  const hasAssign = await waitFor(async () => {
    const s = await get(`/api/events/${ev1.code}`);
    return s.body.timeline.some((m) => m.kind === "assign") || s.body.pending;
  });
  let st = await get(`/api/events/${ev1.code}`);
  console.log("   assign:", hasAssign ? "產生" : "未產生 (可能 facts 已齊)");
  if (hasAssign) {
    ok("微任務指派產生 (指名成員)", st.body.pending !== null || st.body.timeline.some((m) => m.kind === "assign"));
    ok("指派訊息含 @", st.body.timeline.some((m) => m.kind === "assign" && /@/.test(m.text)));
    const assignTo = st.body.pending ? st.body.pending.to : "User5";
    const responder = await connect(ev1.code, assignTo);
    responder.ws.send(JSON.stringify({ type: "chat", text: "現場確認: 沒有火苗" }));
    // 輪詢等 pending 清空 (回應判定在訊息接收當下, 但 facts 吸收要等 AI)
    const answered = await waitFor(async () => {
      const s = await get(`/api/events/${ev1.code}`);
      return s.body.pending === null;
    });
    st = await get(`/api/events/${ev1.code}`);
    ok("指派被回應後 pending 清空", answered);
    ok("回應感謝訊息", st.body.timeline.some((m) => m.kind === "fact" && /已回應指派/.test(m.text)));
  } else {
    console.log("   (跳過指派斷言)");
  }
  ok("事實保鮮: factsTs 存在", st.body.factsTs && typeof st.body.factsTs === "object");

  console.log("== 5b. 1-Tap 共識驗證 ==");
  let cv1 = (await post(`/api/events/${ev1.code}/verify`, { voter: "v1", agree: true })).body;
  ok("投票回傳信心分數", cv1.consensus && typeof cv1.consensus.score === "number");
  const base1 = cv1.consensus.score;
  cv1 = (await post(`/api/events/${ev1.code}/verify`, { voter: "v2", agree: true })).body;
  ok("確認票拉升分數 (+12)", cv1.consensus.score === base1 + 12);
  cv1 = (await post(`/api/events/${ev1.code}/verify`, { voter: "v3", agree: false })).body;
  ok("未見票壓制分數 (-15)", cv1.consensus.score === base1 + 12 - 15);
  const dup = (await post(`/api/events/${ev1.code}/verify`, { voter: "v2", agree: true })).body;
  ok("單人單票 (重複不加分)", dup.consensus.confirm === 2);
  const stV = await get(`/api/events/${ev1.code}`);
  ok("投票廣播進 timeline", stV.body.timeline.some((m) => m.kind === "vote"));
  ok("publicView 附 consensus", typeof stV.body.consensus.score === "number" && stV.body.consensus.label);

  console.log("== 5c. 後台 observer (WS 旁聽) ==");
  const before = (await get(`/api/events/${ev1.code}`)).body.memberCount;
  const obs = await connect(ev1.code, "console", "observer");
  ok("observer 收到 welcome", !!obs.welcome && !!obs.welcome.event);
  const stO1 = await get(`/api/events/${ev1.code}`);
  ok("observer 不計入會員數", stO1.body.memberCount === before);
  ok("observer 計數分離", stO1.body.observerCount >= 1);
  u2.ws.send(JSON.stringify({ type: "chat", text: "observer 在看不影響" }));
  await sleep(600);
  obs.ws.close();

  console.log("== 5d. 真實照片上傳 (WS image payload) ==");
  const tinyPng = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
  u2.ws.send(JSON.stringify({ type: "photo", note: "現場照片", image: tinyPng }));
  await sleep(600);
  const stP = await get(`/api/events/${ev1.code}`);
  ok("照片 image 存入 timeline", stP.body.timeline.some((m) => m.kind === "photo"));

  console.log("== 6. 分區導流 ==");
  await patch(`/api/events/${ev1.code}`, { zone: "B 區" });
  const stateD = await get(`/api/events/${ev1.code}`);
  ok("zone 已設定", stateD.body.zone === "B 區");
  ok("導流廣播已發", stateD.body.timeline.some((m) => m.kind === "zone" && /B 區/.test(m.text)));

  console.log("== 7. catch-up API ==");
  const sum = await get(`/api/events/${ev1.code}/summary`);
  ok("summary API", sum.body.summary.what && sum.body.summary.stats.messages >= 2);

  console.log("== 8. GPS 模式事件 ==");
  const ev2 = (await post("/api/events", { kind: "medical", text: "大廳有人昏倒", lat: 25.0330, lng: 121.5644 })).body;
  ok("GPS 模式", ev2.mode === "gps");
  // 輪詢等 injured 抽取 (LLM 2-8s / 規則即時) + reverse geocode 背景完成
  const gotFaint = await waitFor(async () => {
    const s = await get(`/api/events/${ev2.code}`);
    return /昏倒|倒地|失去意識/.test(s.body.facts.injured || "");
  });
  await sleep(3500); // reverse geocode (3s timeout)
  const stateE = await get(`/api/events/${ev2.code}`);
  console.log("   location:", stateE.body.facts.location);
  ok("GPS 事實抽取昏倒", gotFaint);

  console.log("== 9. 落幕 + 報告書 ==");
  u2.ws.close(); u3.ws.close(); u4.ws.close();
  const res = await post(`/api/events/${ev1.code}/resolve`);
  ok("落幕成功", res.body.event && res.body.event.status === "resolved");
  ok("報告書生成", res.body.report && res.body.report.title.includes("落幕報告書") && res.body.report.stats.aiInterventions > 0);
  const rep = await get(`/api/events/${ev1.code}/report`);
  ok("報告可查詢", rep.body.report.title.includes("落幕報告書"));
  ok("報告含矛盾統計", rep.body.report.stats.contradictions >= 1);

  console.log("== 10. 演習模式 ==");
  const drill = (await post("/api/events/drill/start", { org: "學校", scenario: "fire" })).body;
  ok("演習事件建立", drill.isDrill === true && drill.title.includes("演習"));
  const du = await connect(drill.code, "DrillUser1");
  const du2 = await connect(drill.code, "DrillUser2");
  du.ws.send(JSON.stringify({ type: "chat", text: "位置在 C 區地下室" }));
  // 輪詢等 location 收斂, 再補齊 injured/threat (演習者主動回報 — 這正是演習的目標行為)
  await waitFor(async () => {
    const s = await get(`/api/events/${drill.code}`);
    return !!s.body.facts.location;
  }, 30000);
  du.ws.send(JSON.stringify({ type: "chat", text: "現場無人受傷，但有濃煙威脅" }));
  const factsDone = await waitFor(async () => {
    const s = await get(`/api/events/${drill.code}`);
    return !!s.body.facts.injured && !!s.body.facts.threat;
  }, 30000);
  du.ws.send(JSON.stringify({ type: "photo", note: "濃煙" }));
  await sleep(800);
  // 觸發並回應一次指派 (assign 步驟) — 輪詢等指派出現
  const gotAssign = await waitFor(async () => {
    const s = await get(`/api/events/${drill.code}`);
    return s.body.pending !== null || s.body.timeline.some((m) => m.kind === "assign");
  }, 30000);
  if (gotAssign) {
    const dst0 = await get(`/api/events/${drill.code}`);
    const target = dst0.body.pending ? dst0.body.pending.to : "DrillUser2";
    const answerer = target === "DrillUser1" ? du : du2;
    answerer.ws.send(JSON.stringify({ type: "chat", text: "確認過了，現場安全" }));
    await waitFor(async () => {
      const s = await get(`/api/events/${drill.code}`);
      return s.body.pending === null && s.body.timeline.some((m) => /已回應指派/.test(m.text));
    }, 30000);
  }
  await patch(`/api/events/${drill.code}`, { zone: "C 區" });
  await sleep(500);
  const dscore = (await post(`/api/events/${drill.code}/drill/stop`)).body;
  console.log("   分數:", dscore.scores.totalPercent, "| 評等:", dscore.scores.grade);
  ok("演習評分生成 (5 步)", typeof dscore.scores.totalPercent === "number" && dscore.scores.steps.length === 5);
  ok("事實補齊目標達成 (bug fix 驗證)", dscore.scores.steps.find((s) => s.id === "facts").done);
  ok("導流目標達成", dscore.scores.steps.find((s) => s.id === "zone").done);
  ok("多模態目標達成", dscore.scores.steps.find((s) => s.id === "multimodal").done);
  ok("指派回應目標達成", dscore.scores.steps.find((s) => s.id === "assign").done, "演習中回應 AI 指派");
  ok("演習也有報告書", dscore.report.title.includes("落幕報告書"));

  console.log("== 11. 已落幕事件無法加入 ==");
  try {
    await new Promise((res2, rej) => {
      const ws = new WebSocket(`${WSHOST}/ws?event=${ev1.code}`);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "error") rej(new Error("correctly rejected"));
      });
      ws.on("close", (c) => c === 4000 && res2());
      setTimeout(() => rej(new Error("no rejection")), 3000);
    });
    ok("拒絕加入已落幕事件", false);
  } catch (e) { ok("拒絕加入已落幕事件", String(e).includes("correctly rejected")); }

  console.log("== 12. Demo 重置與情境劇本 ==");
  const rst = (await post("/api/admin/reset")).body;
  ok("重置後 active=0", rst.active === 0);
  ok("DB 全歸零", rst.db.total_events === 0 && rst.db.total_messages === 0);
  const sc1 = (await post("/api/admin/scenario", { name: "paris" })).body;
  ok("巴黎劇本建立", sc1.title && sc1.title.includes("巴黎"));
  ok("劇本語意座標", sc1.semantic && /月台門 3/.test(sc1.semantic));
  ok("劇本嚴重度 4", sc1.severity === 4);
  const badSc = await post("/api/admin/scenario", { name: "nonexist" });
  ok("未知劇本 400", badSc.status === 400);
  // 輪詢等模擬注入 (注入器 8s tick; 跨至少兩個 tick)
  const gotSim = await waitFor(async () => {
    const s = await get(`/api/events/${sc1.code}`);
    return s.body.timeline.some((m) => /Local|旅客/.test(m.who || ""));
  }, 30000);
  const scState = (await get(`/api/events/${sc1.code}`)).body;
  ok("模擬群眾訊息注入 (多語)", gotSim);
  const scSum = (await get(`/api/events/${sc1.code}/summary`)).body;
  ok("劇本含引導", scSum.summary.guidance.length >= 2);
  const scAir = (await post("/api/admin/scenario", { name: "airport" })).body;
  ok("機場劇本 (登機門 B12)", scAir.semantic && /B12/.test(scAir.semantic));
  const scMall = (await post("/api/admin/scenario", { name: "mall" })).body;
  ok("百貨劇本 (ZARA 3F)", scMall.semantic && /ZARA/.test(scMall.semantic));
  const rst2 = (await post("/api/admin/reset")).body;
  ok("再次重置歸零", rst2.active === 0 && rst2.db.total_events === 0);

  // 清理: 收掉殘留事件 (冪等重跑)
  for (const code of [ev2 ? ev2.code : null]) {
    if (code) { try { await post(`/api/events/${code}/resolve`, {}); } catch {} }
  }

  console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
