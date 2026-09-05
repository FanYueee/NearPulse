// NearPulse 靜態與分流 — 桌面 UA → /console (後台); 手機 → /mobile (通報端)
// 明確路徑 (/mobile /console /intro) 不受 UA 影響
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// 手機 UA 判定: M (mobile-first 設計, 無手機 UA 的桌面裝置一律進後台)
const MOBILE_RE = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|Opera Mini|IEMobile/i;

function isMobileUA(req) {
  return MOBILE_RE.test(req.headers["user-agent"] || "");
}

function sendFile(req, res, fp) {
  const stat = fs.statSync(fp);
  const type = TYPES[path.extname(fp).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(fp).pipe(res);
  return true;
}

function serve(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  try {
    // 首頁分流: / → 手機通報端或電腦後台 (視 UA); /index.html 一律導手機版
    if (pathname === "/" || pathname === "/index.html") {
      const target = isMobileUA(req) ? "/mobile/" : "/console/";
      res.writeHead(302, { Location: target });
      return res.end();
    }

    // 目錄 → index.html
    let rel = pathname;
    if (rel.endsWith("/")) rel += "index.html";

    // 防路徑逃逸
    const fp = path.normalize(path.join(ROOT, rel));
    if (!fp.startsWith(ROOT + path.sep)) return false;

    let target = fp;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      // /mobile /console /intro 無副檔名 → 對應 .html
      const alt = fp + ".html";
      if (fs.existsSync(alt) && fs.statSync(alt).isFile()) target = alt;
      else return false;
    }
    return sendFile(req, res, target);
  } catch {
    return false;
  }
}

module.exports = { Static: { serve, isMobileUA } };
