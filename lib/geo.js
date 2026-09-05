// NearPulse 地理工具 — Nominatim 反查 (GPS -> 地址); 逾時/失敗回 null
"use strict";

const config = require("../config");

function reverseGeocode(lat, lng, cb) {
  const url = `${config.geo.nominatimBase}/reverse?format=json&accept-language=zh-TW&lat=${lat}&lon=${lng}`;
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };

  const req = require("https").get(url, { headers: { "User-Agent": "NearPulse-Demo/1.0" } }, (r) => {
    let b = "";
    r.on("data", (c) => (b += c));
    r.on("end", () => {
      try {
        const j = JSON.parse(b);
        finish(j.display_name ? j.display_name.split(",").slice(0, 3).join(" ") : null);
      } catch { finish(null); }
    });
  });
  req.on("error", () => finish(null));
  req.setTimeout(config.geo.timeoutMs, () => { req.destroy(); finish(null); });
}

module.exports = { Geo: { reverseGeocode } };
