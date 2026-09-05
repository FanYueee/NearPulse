/**
 * ============================================================================
 * eventReport —— 產出可交給站務人員／警消的事件報告
 * ============================================================================
 * 【要解決的問題】
 * 現場的人攔下站務人員時，只能用嘴巴講「那邊好像有煙」。而系統手上其實有
 * 完整的結構：幾個人回報、什麼時候、在哪個錨點、有沒有在移動、照片。
 * 那些資訊留在手機畫面上，交接的那一刻就消失了。
 *
 * 這份報告把它變成可以直接遞出去的東西——用 LINE 傳、用簡訊傳、
 * 或截圖給對方。
 *
 * 【最重要的一節在最後】
 * 「這份報告的性質」不是免責聲明的客套話，而是**這份文件能不能被信任地使用**
 * 的前提。收到的人必須知道：
 *   - 這是群眾通報，不是官方查證結果
 *   - 「3 個獨立訊號」指 3 個瀏覽器 session，**不等於 3 個人**
 *   - 座標來自圖資而非現場實測
 * 少了這一節，一份看起來很正式的 Markdown 會讓人誤以為它經過查證——
 * 那比沒有這份報告更糟。
 */

import { config } from '../config.js';
import { findVenue, exitSide } from './venueService.js';
import { evacuationPlan } from './evacuationService.js';
import { countIndependentPositives, countOnSiteNegatives } from '../pipeline/cluster.js';

const ts = (v) =>
  v ? new Date(v).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) : '—';
const hm = (v) =>
  v ? new Date(v).toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) : '—';

const STATUS_TEXT = {
  candidate: '徵詢中（尚未達到確認門檻）',
  active: '已確認（達到獨立訊號門檻）',
  frozen: '已凍結（超過時限無新訊號）',
  cancelled: '已取消（現場否證或逾時）',
};

/**
 * 產生 Markdown 事件報告。
 * @param {object} event  完整事件（store 內的物件，不是 summary）
 * @param {{ origin?: string }} [opts] origin 用來把照片連結寫成絕對網址
 */
export function eventReportMarkdown(event, { origin = '' } = {}) {
  const type = config.eventTypes[event.type] ?? {};
  const venue = event.stationId ? findVenue(event.stationId) : null;
  const positives = countIndependentPositives(event);
  const negatives = countOnSiteNegatives(event);
  const witnessYes = event.confirmations.filter(
    (c) => c.step === 'witness' && c.atStation && c.witnessed === 'yes'
  ).length;

  const anchorExit = venue?.exits?.find((e) => e.code === event.nearExitCode) ?? null;
  const side = venue && anchorExit ? exitSide(venue, anchorExit) : null;

  const L = [];
  L.push(`# 事件報告：${type.label ?? event.type}　${event.stationName}`);
  L.push('');
  L.push(`> 由 NearPulse 產生於 ${ts(Date.now())}　·　事件編號 \`${event.id}\``);
  L.push('');

  // ---- 一眼看懂 ----
  L.push('## 摘要');
  L.push('');
  L.push('| 項目 | 內容 |');
  L.push('|---|---|');
  L.push(`| 事件類型 | **${type.label ?? event.type}**（嚴重度 ${type.severity ?? '—'}） |`);
  L.push(`| 目前狀態 | ${STATUS_TEXT[event.status] ?? event.status} |`);
  L.push(`| 場域 | ${event.stationName}${venue ? `（${event.stationId}）` : '（不在圖資內，為通報者描述）'} |`);
  L.push(`| 站內位置 | ${event.nearExitCode ? `近 ${event.nearExitCode} 出口${side ? `（站體${side}側）` : ''}` : '未確認'} |`);
  L.push(`| 首次通報 | ${ts(event.createdAt)} |`);
  L.push(`| 最後更新 | ${ts(event.updatedAt)} |`);
  L.push(`| 獨立訊號 | ${positives}（門檻 ${type.threshold ?? '—'}） |`);
  L.push(`| 回報筆數 | ${event.reports.length} |`);
  L.push(`| 現場確認 | 有看到 ${witnessYes} 人　沒看到 ${negatives} 人 |`);
  if (event.assistanceReports > 0) {
    L.push(`| ⚠️ 需要協助 | **${event.assistanceReports} 筆回報表示有人無法自行疏散** |`);
  }
  if (event.onTrain) L.push('| 事件位置 | **在行駛中的列車上** |');
  L.push('');

  // ---- 通報者提供的東西 ----
  const notes = event.reports.map((r) => r.note).filter(Boolean);
  if (notes.length > 0 || event.displayPhotoRef) {
    L.push('## 通報者提供');
    L.push('');
    for (const n of notes) L.push(`- 「${n}」`);
    if (event.displayPhotoRef) {
      L.push(`- 現場照片：${origin}/api/photos/${event.displayPhotoRef}`);
      L.push('  （暫存 10 分鐘後失效——需要保存請立即另存）');
    }
    L.push('');
  }

  // ---- 座標與軌跡 ----
  const point = event.incidentPoint ?? (anchorExit ? { lat: anchorExit.lat, lon: anchorExit.lon } : null);
  if (point || event.track?.length) {
    L.push('## 位置與軌跡');
    L.push('');
    if (point) {
      L.push(`- 座標：\`${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}\``);
      L.push(`- 地圖：https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lon}#map=18/${point.lat}/${point.lon}`);
    }
    if (event.track?.length > 1) {
      L.push('- 觀測序列（不同裝置在不同時間的指認）：');
      for (const t of event.track.slice(-6)) {
        L.push(`  - ${hm(t.at)}　${t.exitCode ? `${t.exitCode} 出口附近` : `${t.lat.toFixed(5)}, ${t.lon.toFixed(5)}`}`);
      }
    }
    if (event.motion?.moving) {
      L.push(`- **判定移動中**：往${event.motion.compass ?? '—'}方，`
        + `約 ${event.motion.speedMps?.toFixed(1) ?? '—'} m/s（判定信心：${event.motion.confidence ?? '—'}）`);
    }
    L.push('');
  }

  // ---- 系統建議 ----
  const plan = evacuationPlan({
    venueId: event.stationId, nearExitCode: event.nearExitCode,
    point: event.incidentPoint, motion: event.motion,
    incidentType: event.type, onTrain: event.onTrain,
  });
  if (plan) {
    L.push('## 系統當時給出的疏散建議');
    L.push('');
    if (plan.kind === 'exits') {
      L.push(`- 建議前往：${plan.go.map((g) => `**${g.code}**${g.landmark ? `（往${g.landmark}）` : ''}`).join('、')}`);
      if (plan.avoid.length) L.push(`- 建議避開：${plan.avoid.map((g) => `${g.code}`).join('、')}`);
      if (plan.anchored === false) L.push('- ⚠️ 事件在站內的確切位置未確認，以上僅為該場域的出口清單');
    } else {
      L.push(`- ${plan.reason ?? ''}`);
      L.push(`- ${plan.action ?? ''}`);
    }
    L.push('');
  }

  // ---- 這份報告能不能被信任地使用 ----
  L.push('---');
  L.push('');
  L.push('## 這份報告的性質');
  L.push('');
  L.push('- 這是**群眾通報彙整**，不是官方查證結果。請以現場人員判斷為準。');
  L.push(`- 「獨立訊號」指來自不同瀏覽器 session 的回報或現場確認，`
    + `**不等於不同的人**——同一人換裝置會被算成兩個。`);
  L.push('- 站內位置來自照片文字辨識或使用者點選，經出口圖資查表得出；'
    + '座標為出口的地面位置，**非現場實測**。');
  L.push('- 出口圖資來源：OpenStreetMap（ODbL）與交通部 TDX。');
  L.push('- 未顯示步行距離：地下通道的實際路徑與地面直線距離差異可達數倍。');
  L.push('');

  return L.join('\n');
}

/** 檔名：可讀、可排序、不含會出問題的字元 */
export function eventReportFilename(event) {
  const t = new Date(event.createdAt ?? Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`
    + `-${pad(t.getHours())}${pad(t.getMinutes())}`;
  const name = String(event.stationName ?? '').replace(/[^\p{L}\p{N}]+/gu, '') || 'event';
  return `NearPulse-${stamp}-${name}-${event.id}.md`;
}
