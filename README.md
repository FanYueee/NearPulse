# NearPulse 近場脈動

**語意座標取代經緯度的臨時情報迴路 — 3 秒零打字回報 · 1-Tap 群眾驗證 · AI 微任務指派 · 事實保鮮期**

通勤與公共場域突發事件的即時資訊系統。地下空間 GPS 全死、恐慌下沒人能打字、晚到者爬不完訊息、假消息跑得比查核快——NearPulse 針對這四個結構性問題，做出可以在惡劣環境真正動起來的系統。

BUILDMODE GEN-AI HACKATHON 2026 — Track 02 AI for Everyday Life

## 快速開始

```bash
npm install        # 依賴: ws / qrcode / better-sqlite3 (編譯失敗自動降級 JSON 儲存)
npm start          # 啟動於 :8080
npm test           # 端到端測試 (83 項, 含 WebSocket 流程)
```

### 三個入口（同一後端）

| 路徑 | 裝置 | 用途 |
|---|---|---|
| `/` | 手機 UA | 自動導向 **`/mobile/`** — 通報端（按住說話 → AI 判讀 → 逃脫引導） |
| `/` | 桌面 UA | 自動導向 **`/console/`** — 後台指揮中心（事件總覽 / 即時監控 / 信心儀表 / 導流 / 落幕 / 手機即時預覽） |
| `/intro` | 任何 | 功能介紹 + 創新亮點 + 3 分鐘演示腳本 |

### 接上真實 LLM（可選）

複製 `.env.example` 為 `.env`，填入任何 OpenAI 相容 API。未設定時自動降級內建規則引擎，所有功能不受影響。語音通報流程：瀏覽器 SpeechRecognition (zh-TW) → `/api/ai/interpret` → LLM 判讀類別/嚴重度/事實 → 自動代填表單。

### 部署（本 repo 現行環境）

`systemctl start nearpulse`（systemd 常駐、掛掉自動重啟）+ nginx 反代 80 → 8080（含 WebSocket upgrade）。

## 核心創新（與既有方案結構性不同）

### 1. 語意座標定位（獨家）
地下空間不猜位置——用兩階快選讓人把環境既有的大字告訴系統：月台門號九宮格、消防栓箱、停車場柱號、出口燈箱、**登機門（B12）、百貨專櫃招牌（ZARA 3F）**。看不懂選項時可**自由錨定**：直接輸入眼睛看到的字（`SORTIE 3`、`GATE D3`），人眼就是 OCR。每一步（空間/錨點/樓層）都可跳過，全跳過仍可通報。**「座標不必是經緯度，空間的本質是相對地標」**——救護人員在地下室使用的正是這套語言。介面支援中/英切換，異國旅客可用。（`lib/semloc.js`）

### 1b. 地標式引導（創新）
沒有經緯度，方向引導靠「眼睛找得到的東西」：`generateGuidance()` 依空間類型與樓層生成——「找綠色緊急出口燈箱（黑暗中發光），沿箭頭疏散」「你在地下層——優先找往上動線」，寫進 Catch-up 摘要卡。從「你在哪」到「你該往哪走」的閉環，不依賴任何定位技術。

### 1c. 一鍵情境劇本 + Demo 重置（電腦＋手機共演）
後台 Demo 面板：**重置**（`POST /api/admin/reset`，事件與統計歸零）與三個預置情境（`POST /api/admin/scenario`）——**巴黎地鐵**（GPS 失效、法/中多語群眾注入）、**機場登機門**（B12 昏倒、地勤/旅客接力回報）、**百貨 3F**（走失溫柔版）。注入後自動開始監控，模擬群眾定時發言並走完整 AI 吸收管線，手機掃碼即可加入共演。後台另含 **OSM（OpenStreetMap）即時地圖**：Leaflet + OSM 圖磚標記 GPS 事件（零 API key），語意座標事件依設計留在地圖之外。

### 2. 1-Tap 群眾驗證（獨家）
第一人回報後，周遭群眾不進群不打字，一顆按鈕完成「我看到了 / 沒看到」。信心分數公式完全透明：基礎 20 分 + 每確認 12 分（上限 60）− 每未見 15 分 − 時間衰減。單人單票可改票；惡作劇會被反向票壓制。Waze 的行車置信度衰減，移植到步行逃生。（`lib/consensus.js`）

### 3. AI 微任務指派（破解旁觀者效應）
旁觀者效應：人越多越沒人回報。AI 指揮官不對空氣喊話——**隨機指名一位在場成員**「@你：請回報傷患狀況」，30 秒未回應才升級全員，回應即記錄進落幕報告與演習評分。把「有人會處理吧」變成「就是我來處理」。（`lib/ws-hub.js`）

### 4. 事實保鮮期
2 分鐘前的「無人受傷」可能已過期。每項事實帶確認時間戳，面板即時顯示「37 秒前確認」，逾 2 分鐘 AI 主動要求覆核。資訊從「曾經正確」變成「持續正確」。（`lib/ws-hub.js`）

### 5. SOS 工具組（吸收自 Beacon 守護臺灣的概念，Web 原生實作）
- **聲光警報**：WebAudio 雙頻交替警笛（620↔950Hz）＋螢幕閃光＋震動——危急時引起周圍注意
- **快速撥號**：110／119 一鍵直撥（`tel:` 連結，不需任何權限）
- **報平安**：脫離後一鍵把「我安全了＋位置」用 Web Share 分享給家人（降級為簡訊）——補上「家人最想知道你在哪、安全嗎」的最後一哩

### 6. 逃脫地圖（OSM + Leaflet）
事件有 GPS 座標且使用者在 2km 內時，協助頁畫出「紅=事故／藍=你／綠=建議安全方向」，一鍵開啟 Google Maps 步行導航；地下/室內（語意座標事件）或距離過遠時自動降級為地標式文字引導——**不顯示假精確的數字**。

## 與既有方案的差異（含上架競品）

| 維度 | Beacon 守護臺灣（2026/7 上架 App） | Ushahidi / 官方災防 App | NearPulse |
|---|---|---|---|
| 本質 | 通知平台（轉發回報） | 災情地圖（人工審核） | **情報系統**（AI 判讀/收斂/引導） |
| 取用 | 下載 101.9MB App | 下載 App / 等專員 | **掃碼即用 PWA，零安裝** |
| AI | 無 | 無/人工 | MiniMax M3 判讀＋規則雙引擎 |
| 定位 | GPS 依賴 | GPS/口述 | 語意座標（月台門/消防栓/店名）＋GPS |
| 隱私 | 精確位置＋跨 App 追蹤＋廣告 | — | 匿名、無帳號、用完即散 |
| 生命週期 | 永久動態牆 | 永久 | 落幕自動解散＋歸檔報告 |

## 功能總覽

| 功能 | 狀態 | 位置 |
|---|---|---|
| 事件臨時群組（QR/4位碼免裝加入，落幕解散） | 完整 | `lib/api.js` `lib/store.js` |
| 電腦後台指揮中心（observer 旁聽不干擾現場） | 完整 | `public/console/` |
| 零打字通報（7 類 × 細項 × 4 級嚴重度全點選） | 完整 | `public/mobile/` `ai-engine.js` |
| 語意座標兩階快選 | 完整 | `lib/semloc.js` |
| 1-Tap 共識驗證 | 完整 | `lib/consensus.js` |
| AI 指揮官（追問 + 45 秒週期 + 完整度儀表） | 完整 | `ai-engine.js` `lib/ws-hub.js` |
| 微任務指派（旁觀者效應破解） | 完整 | `lib/ws-hub.js` |
| 事實保鮮期 | 完整 | `lib/ws-hub.js` |
| Catch-up 摘要卡 | 完整 | `ai-engine.js` |
| 闢謠引擎（矛盾標記 + 共識投票雙層防線） | 完整 | `lib/ws-hub.js` |
| 語音通報 + AI 判讀（主輸入路徑） | 完整 | 前端 SpeechRecognition + `llm-agent.js` |
| SOS 工具（聲光警報/110・119 快撥/報平安） | 完整 | `public/mobile/app.js` |
| 分區導流 | 完整 | `lib/api.js`（zone 白名單驗證） |
| 落幕報告書 + SQLite 歸檔 | 完整 | `ai-engine.js` `lib/db.js` |
| 演習模式 + AI 評分（5 目標含指派回應） | 完整 | `drill-bot.js` |
| GPS 定位 + Nominatim 地址反查 | 完整 | `lib/geo.js` |
| PWA（manifest + service worker 離線殼） | 完整 | `public/sw.js` |

## 系統架構

```
[手機 PWA — 通報端]                    [電腦 — 後台指揮中心]
 3 秒零打字回報/語音/照片(邊緣運算)       事件監控/信心儀表/導流/落幕/預覽
      │ QR ?join=CODE / GPS / 語意座標            │ observer WS (旁聽不干擾)
      ▼                                            ▼
 ══════════ nginx :80 — REST /api/* — WebSocket /ws (upgrade) ══════════
      │
      ├─ lib/api.js      路由表化 REST
      ├─ lib/ws-hub.js   頻道 + agentAbsorb 統一吸收 + 微任務 + 保鮮
      ├─ lib/store.js    記憶體權威 store（代碼防碰撞）
      ├─ lib/consensus.js 1-Tap 共識分數（透明公式）
      ├─ lib/semloc.js   語意座標字典（月台門/消防地標/停車柱/店名）
      ├─ lib/db.js       SQLite 持久化（events/messages/votes；JSON 降級）
      ├─ lib/geo.js      Nominatim 反查（逾時 fallback null）
      ├─ lib/static.js   UA 分流 + 路徑逃逸防護
      ├─ ai-engine.js    規則引擎（事實抽取/分類/嚴重度/摘要/報告）
      ├─ llm-agent.js    OpenAI 相容 LLM（無金鑰降級規則引擎）
      └─ drill-bot.js    演習機器人 + 評分
```

設計原則：**記憶體為權威、SQLite 為歸檔**（重啟不回載，服務即時性優先）；同步（WS 廣播）與非同步（AI 吸收）分離；每項 AI 功能在 LLM 不可用時都有規則引擎降級路徑。

## API 一覽

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/events` | 通報 `{kind, text, severity?, space?, anchor?, level?, lat?, lng?}` → QR + code |
| GET | `/api/events` | 進行中事件列表 |
| GET | `/api/events/:code` | 詳情（timeline/facts/consensus） |
| POST | `/api/events/:code/verify` | 1-Tap 投票 `{voter, agree}` |
| PATCH | `/api/events/:code` | 分區導流 `{zone}`（白名單） |
| GET | `/api/events/:code/summary` | Catch-up 摘要卡 |
| GET | `/api/events/:code/qr` | 加入 QR |
| POST | `/api/events/:code/resolve` | 落幕 → 報告書 |
| GET | `/api/events/:code/report` | 查詢報告 |
| POST | `/api/events/drill/start` | 啟動演習 `{org, scenario}` |
| POST | `/api/events/:code/drill/stop` | 結束演習 → AI 評分 |
| POST | `/api/ai/interpret` | LLM 判讀 `{text, kind?, facts?}` |
| GET | `/api/geo/reverse?lat=&lng=` | GPS 地址反查 |
| GET | `/api/meta/kinds` | 分類/嚴重度/語意座標字典 |
| GET | `/api/admin/stats` | 後台統計（DB 彙總） |
| POST | `/api/admin/reset` | Demo 重置（事件+統計歸零） |
| POST | `/api/admin/scenario` | 一鍵情境劇本 `{name: paris\|airport\|mall}` |
| WS | `/ws?event=CODE&name=&role=` | chat / voice / photo / locate / verify（role=observer 後台旁聽） |

## 3 分鐘演示腳本

完整腳本在 `/intro`。摘要：電腦開後台（同屏手機預覽）→ 手機 A 零打字通報（月台門 3 + B2 + 緊急，全程不輸入文字）→ 後台看 AI 追問與完整度爬升 → 手機 B 掃碼加入收摘要卡 → 1-Tap 投票看信心分數即時變化 → AI 指派 @某人 → 闢謠示範（已無煙照片）→ 真實照片（顯示邊緣篩檢 KB 數）→ 導流廣播 → 後台一鍵落幕出報告 → 演習模式拿評分。

## 誠實揭露（真實 vs 模擬）

**真實運作**：WebSocket 群聊、QR 產生與加入、UA 分流後台、零打字表單、語意座標、1-Tap 投票與信心分數、微任務指派與計時、事實保鮮、Catch-up 摘要、矛盾標記、GPS 定位與 Nominatim 反查、照片 Canvas 壓縮與 Laplacian 篩檢、語音辨識（瀏覽器端）、多語播報、SQLite 歸檔與統計、演習機器人與評分。

**可切換介面（填 API Key 即真實）**：LLM 情境判讀（`llm-agent.js`，未設金鑰走規則引擎 `rulesInterpret`）；照片內容解析（`visionMock`，介面已抽象可直接換 Vision API）。

**Roadmap（純 Web 環境會現場翻車，故不實作）**：氣壓計樓層推算（iOS 全不支援、Android 預設封印）、Wi-Fi BSSID 指紋（無比對庫）、聲波浮水印（需站方配合）。我們不做會翻車的功能。

## 開發

```
config.js          環境設定（零依賴 .env loader）
server.js          啟動入口（組裝 http + API + WS，約 60 行）
lib/               後端模組（每檔單一職責）
public/mobile/     手機通報端
public/console/    電腦後台
public/intro.html  介紹頁
test/smoke.js      63 項端到端測試（node test/smoke.js [base-url]）
data/              SQLite / JSON 降級檔（執行時生成）
```

測試：`npm test`（或指定 `node test/smoke.js http://127.0.0.1` 走 nginx）。

## 授權

MIT
