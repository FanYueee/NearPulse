// NearPulse — 啟動入口: 組裝 http server + API 路由 + WS hub
"use strict";

const http = require("http");
const config = require("./config");
const { Api } = require("./lib/api");
const { Hub } = require("./lib/ws-hub");
const { Static } = require("./lib/static");

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const u = new URL(req.url, "http://x");
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  try {
    let body = {};
    if (req.method === "POST" || req.method === "PATCH") {
      body = await new Promise((resolve) => {
        let b = "";
        let size = 0;
        req.on("data", (c) => {
          size += c.length;
          if (size > 256 * 1024) { req.destroy(); resolve({}); return; } // 上限 256KB
          b += c;
        });
        req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({ __badJson: true }); } });
      });
      if (body.__badJson) return send(400, { error: "invalid JSON body" });
    }

    const result = await Api.dispatch(req, res, u.pathname, u.searchParams, body);
    if (result) return send(result[0], result[1]);
    if (Static.serve(req, res, u.pathname)) return;
    return send(404, { error: "not found" });
  } catch (e) {
    return send(500, { error: String((e && e.message) || e) });
  }
});

// 注入群播函式 (單向依賴: api -> hub, 避免循環)
Api.bindSystem(Hub.pushSystem);

Hub.setup(server);

server.listen(config.port, () => {
  console.log(`[NearPulse] http + ws on :${config.port} | llm-agent: ${require("./llm-agent").Agent.llmReady() ? "enabled" : "rules-only"}`);
});
