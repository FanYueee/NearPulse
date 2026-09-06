/**
 * ============================================================================
 * train.js —— 到站倒數（client 端計算）
 * ============================================================================
 * server 的態勢卡只給**絕對到站時刻** `arriveAt`，不給剩餘秒數。
 * 原因見 server 的 trainService：剩餘秒數每秒都不同，寫進卡片會讓每次
 * 輪詢的 ETag 都不一樣，弱網下最寶貴的 304 就全沒了。
 *
 * 代價是倒數要在這裡算——但這反而更好：畫面能每秒更新，而不是跟著
 * 12 秒的輪詢週期一跳一跳。
 *
 * 【刻意的粗略】
 * 秒數來自 TDX 的官方站間行車時間，但那是**平均值**：誤點、月台擁擠、
 * 緊急停車都不在資料裡。所以顯示一律取整到 10 秒或半分鐘——
 * 講「還有 47 秒」會給出資料支撐不了的精確感。
 */

const clock = () => Date.now();

/**
 * @param {number} arriveAt - 預計到站時刻（ms epoch）
 * @returns {{etaSec: number, arrived: boolean, text: string, action: string}}
 */
/**
 * 月台上的人現在該做什麼——**依事件類型**。
 *
 * 原本一律寫「退離車門、不要上車」，但那只對了一半：
 * 無差別攻擊的加害者會從車上下來，叫月台上的人站在原地等，
 * 等於把他們留在加害者的必經路線上。而急救事件剛好相反——
 * 那時候需要的是讓出動線給救護人員，不是叫大家跑。
 */
function platformAction(typeLabel, arrived) {
  switch (typeLabel) {
    case '攻擊':
      return arrived
        ? '加害者可能已下車。立刻離開月台往出口方向移動，不要圍觀或拍攝。'
        : '不要上車，立刻往出口方向離開月台——加害者可能隨車抵達。';
    case '火警':
      return arrived
        ? '不要上車。讓車上的人先出來，接著一起往出口疏散。'
        : '不要上車，退離月台門前並準備往出口疏散。';
    case '急救':
      return arrived
        ? '讓出車門與通道，讓救護人員先進出，不要圍觀。'
        : '空出車門動線與通往出口的通道，讓救護人員能夠通過。';
    case '推擠':
      return arrived
        ? '退離車門，讓車上的人先出來，不要往前擠。'
        : '往月台兩端散開，不要聚集在車門前。';
    default:
      return arrived
        ? '退離車門，讓車上的人先出來，不要上車。'
        : '退離月台門前，空出車門動線，不要上車。';
  }
}

export function etaOf(arriveAt, now = clock(), typeLabel = null) {
  const etaSec = Math.round((arriveAt - now) / 1000);
  const arrived = etaSec <= 0;

  return {
    etaSec: Math.max(0, etaSec),
    arrived,
    text: arrived
      ? '應已進站'
      : etaSec <= 15
        ? '即將進站'
        : etaSec < 60
          ? `約 ${Math.round(etaSec / 10) * 10} 秒後進站`
          : `約 ${Math.round(etaSec / 30) * 0.5} 分鐘後進站`,
    /**
     * 月台上的人現在該做的事。一句話，動詞在最前面——
     * 恐慌中的人只接收到前幾個字。
     */
    action: platformAction(typeLabel, arrived),
  };
}
