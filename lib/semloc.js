// NearPulse 語意座標 — 「座標不必是經緯度，空間的本質是相對地標」
// 兩階快選: 空間類型 → 該場域必有的實體大字 (零權限/零硬體/零資料庫)
// 異國容錯: 每一步都可跳過 — 全部跳過仍可通報 (大類可從文字/照片推斷)
"use strict";

// 第一階: 空間類型 (圖示可辨識, 跨語言)
const SPACES = {
  platform:  { label: "月台 / 軌道邊", icon: "M2 17h20M6 17V9h12v8M12 9V5", anchors: ["1", "2", "3", "4", "5", "6", "7", "8"], anchorHint: "看頭頂月台門 / 車廂的大數字", anchorPrefix: "月台門", free: true },
  concourse: { label: "大廳 / 出口",   icon: "M4 21V8l8-5 8 5v13M9 21v-6h6v6", anchors: ["1 號出口", "2 號出口", "3 號出口", "4 號出口", "服務台"], anchorHint: "看最近的出口號或服務台", anchorPrefix: "近", free: true },
  parking:   { label: "停車場",       icon: "M5 3v18M19 3v18M9 7h6M9 11h6M9 15h6", anchors: ["A 區", "B 區", "C 區", "D 區", "E 區", "F 區"], anchorHint: "看柱子上的分區字母", anchorPrefix: "", free: true },
  corridor:  { label: "走道 / 地下街", icon: "M4 12h16M4 6h16M4 18h16", anchors: ["綠色緊急出口燈箱", "紅色消防栓箱", "滅火器", "樓梯口"], anchorHint: "找最近的消防安全設施 (綠色/紅色)", anchorPrefix: "近", free: true },
  vehicle:   { label: "車廂內",       icon: "M3 6h18v10H3zM3 16l-1 4h20l-1-4M7 10h.01M11 10h.01", anchors: ["1", "2", "3", "4", "5", "6"], anchorHint: "看車門上方的車門號", anchorPrefix: "車門", free: true },
  gate:      { label: "登機門 / 機場", icon: "M2 20h20M12 4v10M12 4l-4 5M12 4l4 5M8 20v-4M12 20v-6M16 20v-4", anchors: [], anchorHint: "看登機門號 (如 B12、D3) — 輸入你看到的字", anchorPrefix: "登機門", free: true, freeHint: "例: B12、D3、A1" },
  mall:      { label: "百貨 / 商場",   icon: "M4 8h16l1 12H3zM9 8V5a3 3 0 016 0v3", anchors: [], anchorHint: "看專櫃招牌或樓層指標 — 輸入店名或樓層", anchorPrefix: "", free: true, freeHint: "例: ZARA、UNIQLO、3F" },
  store:     { label: "商店內",       icon: "M4 4h16v16H4zM4 10h16M8 4v6", anchors: [], anchorHint: "拍下店名招牌讓 AI 辨識", anchorPrefix: "", free: true, freeHint: "例: 便利商店名" },
};

// 樓層標籤 (垂直維度) — 含機場/百貨高樓層; 不確定可跳過
const LEVELS = ["B3", "B2", "B1", "地面層", "2F", "3F", "4F", "5F"];

// 組成語意座標字串: 例 "月台 · 月台門 3 (B2)" / "登機門 / 機場 · 登機門 B12"
function semanticLocation(spaceKey, anchor, level) {
  const sp = SPACES[spaceKey];
  if (!sp) return null;
  const parts = [];
  if (anchor) parts.push(sp.anchorPrefix ? `${sp.anchorPrefix} ${anchor}` : anchor);
  if (level) parts.push(`(${level})`);
  if (!parts.length) return sp.label;
  return `${sp.label} · ${parts.join(" ")}`;
}

// 從自由文字粗抽語意位置 (fallback: 使用者打字時) — 含多國語言地標
function extractSemantic(text) {
  const t = String(text || "");
  const m =
    t.match(/月台[門]?\s*([1-8])/) ||
    t.match(/車[厢廂]門?\s*([1-6])/) ||
    t.match(/[gG]ate\s*([A-Z]?\d{1,2}[a-z]?)/) ||            // Gate B12 / gate 3
    t.match(/(?:[0-9])\s*號?出口|exit\s*([0-9])|sortie\s*([0-9])/i) || // 出口/Exit/SORTIE
    t.match(/(消防栓箱?|緊急出口|滅火器|樓梯口)/) ||
    t.match(/([A-F])\s*區/) ||
    t.match(/B(\d)\s*[- ]?([A-F])?\d*/);
  if (!m) return null;
  if (/月台/.test(t)) return semanticLocation("platform", m[1]);
  if (/車[厢廂]/.test(t)) return semanticLocation("vehicle", m[1]);
  if (/gate/i.test(t)) return semanticLocation("gate", m[1]);
  const exitNum = m[1] || m[2];
  if (/出口|exit|sortie/i.test(t)) return semanticLocation("concourse", `${exitNum} 號出口`);
  if (/消防|緊急|滅火|樓梯|地下街|走道/.test(t)) {
    if (/地下街|走道/.test(t) && !/消防|緊急|滅火|樓梯/.test(t)) return semanticLocation("corridor");
    return semanticLocation("corridor", m[1]);
  }
  if (m[0].match(/[A-F]\s*區/)) return semanticLocation("parking", `${m[1]} 區`);
  return null;
}

// ---------------------------------------------------------------- 地標式引導 (無經緯度下的方向指引)
// 原則: 使用者的眼睛找得到 → 引導才有意義
function generateGuidance(spaceKey, level, threat) {
  const guide = [];
  switch (spaceKey) {
    case "platform":
      guide.push("沿月台邊黃線內側移動，往樓梯/電扶梯方向的出口走");
      break;
    case "concourse":
      guide.push("尋找綠色「EXIT」燈箱，沿箭頭方向前往地面層");
      break;
    case "parking":
      guide.push("沿柱面黃色車道指引線，往最近的上坡「出口」移動");
      break;
    case "corridor":
      guide.push("找綠色緊急出口燈箱（黑暗中發光），沿其箭頭方向疏散");
      break;
    case "vehicle":
      guide.push("聽從車長廣播；若需疏散，往車廂兩端車門方向移動");
      break;
    case "gate":
      guide.push("沿登機門編號遞減/遞增方向走，尋找「EXIT」或海關指示；跟隨地勤人員");
      break;
    case "mall":
      guide.push("尋找每層樓電梯旁的樓層導覽圖，前往最近的安全梯（綠色門）");
      break;
    default:
      guide.push("跟隨現場廣播與人群有序移動，不逆行");
  }
  if (level && /^B/.test(level)) guide.push("你在地下層 — 優先找往上 (UP/出口) 的動線");
  if (threat) guide.push("遠離危險源，協助傷患時先確保自身安全");
  return guide;
}

// 從回報文字猜空間類型 (自動判斷, 不丟選項給使用者)
function guessSpace(text) {
  const t = String(text || "");
  if (/月台|軌道|platform/i.test(t)) return "platform";
  if (/登機|閘口|gate|航廈|terminal/i.test(t)) return "gate";
  if (/停車場|車位|parking/i.test(t)) return "parking";
  if (/百貨|專櫃|商場|mall|zara|uniqlo/i.test(t)) return "mall";
  if (/車[厢廂]/.test(t)) return "vehicle";
  if (/地下街|走道|走廊|通道|corridor/i.test(t)) return "corridor";
  if (/大廳|出口|閘門|服務台|concourse/i.test(t)) return "concourse";
  if (/商店|店內|櫃台/i.test(t)) return "store";
  return null;
}

module.exports = { Geo2: { SPACES, LEVELS, semanticLocation, extractSemantic, generateGuidance, guessSpace } };
