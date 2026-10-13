# 公開多團隊版：使用與部署

這是目前 [免費公開服務](https://demo.terry878.org/roomly/)使用的模式。每個人可用自己的 Google 帳號建立空間、邀請別人，共用符合會議室地點的會議。公開版只提供手動同步；原本單團隊／公司版的白名單、自動推播與定時補查是[另一種部署模式](DEPLOYMENT.md#單團隊公司自架模式)。

## 直接使用公開服務

1. 登入後按「建立空間」，填入名稱與會議室地點，確認同意分享符合地點的會議。
2. 開啟「空間設定」→「我的日曆」，由本人完成 Google 授權。
3. 管理員在「邀請其他人」填入對方的 **Google 登入 Email**，產生專用邀請連結並自行分享。系統不自動寄信。
4. 對方以指定 Email 登入，同意加入與分享，並自行授權日曆。單有邀請連結不能使用其他帳號加入。
5. 任何有效成員都能按「同步會議」，更新這個空間所有成員已授權日曆中的相符活動。

若自己尚未授權或需重新授權，按同步會先帶到「我的日曆」設定，不會建立空的成功工作，也不會自動開啟 Google 授權視窗。完成本人授權後再回時間表按同步；其他未授權來源仍會在同步結果分別標示。

每個帳號最多建立 3 個空間；每個空間最多 10 位成員，包含尚未接受的邀請。邀請有效 7 天，可在管理員設定頁撤銷。遺失的邀請連結不會從後端取回原始秘密，可撤銷後重新產生。

不同空間的成員、地點、會議與同步工作分開。管理員移除成員時，其來源資料會從此空間移除；成員也能離開空間。個人移除日曆授權，會刪除自己的後端日曆憑證與所有空間中的分享會議。登出只結束網站登入，不撤銷日曆授權。

## 授權與同步怎麼運作？

Google 基本登入使用 `openid`、`email`、`profile`；連接日曆另需本人同意：

| 權限 | 用途 |
| --- | --- |
| `https://www.googleapis.com/auth/calendar.events.readonly` | 讀取活動時間、地點、標題、主辦人、受邀者與 Meet 連結 |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | 找出本人可讀取的主要、共用或已訂閱日曆 |

Roomly 不要求 Gmail 或日曆寫入權限，也不會增加帳號原本沒有的日曆讀取權限。每人都要自己授權，管理員不能代替他人操作。[Google Calendar 授權範圍](https://developers.google.com/workspace/calendar/api/auth)

同步會列出授權帳號可讀取的日曆，完整讀取所選期間的活動與分頁，篩選符合空間地點的活動，再保存必要資料。只有 Meet 連結而沒有相符地點的活動，不會當作這間會議室的預約。相同邀請會合併，週期會議依每次發生時間區分。

**只有明確按「同步會議」發出的 POST 才啟動 Google 讀取。** 已建立工作的 Queue consumer 可繼續完成這次要求，暫時運輸失敗也只重試既有工作。開啟看板、登入、切換日期、查看來源與工作狀態，皆只讀既有快取，不會建立自動同步、cron、Google watch 或另一個背景補查。

日曆範圍尚未取得、來源未授權或同步失敗時，畫面會標示未知或失敗，不能把空白解讀為沒有人預約。成功時間只在完整取得並保存來源資料後前進。失敗可保留上次成功資料與時間；請查看來源狀態，再由使用者重新按同步。

目前同步期間最多 31 天，限目前日期前後 63 天內；相同空間正在同步時會共用現有工作，每位使用者另有 30 秒的手動觸發間隔。看板主要顯示五天，勾選略過週末或國定假日時會往後選出五個符合日期。

## Google 專案的目前限制

2026 年 10 月 14 日設定檢查時，公用 Google 專案已為 **Production**，但敏感日曆權限仍未完成驗證，Console 顯示 **7／100** 授權名額已使用。請以 Google Console 當前值為準。

基本登入可與日曆授權分開；新的日曆授權可能遇到未驗證警示、專案的 100 人上限，或 Workspace 組織政策限制。這不是付費造成，打賞不能解除。公司與公開版各自隔離資料，不代表同一 Google Cloud 專案的授權上限也分開。Google 的上限以專案生命週期計算；正式發布不等於日曆權限驗證通過。[Google Audience 說明](https://support.google.com/cloud/answer/15549945?hl=en)、[未驗證應用程式](https://support.google.com/cloud/answer/7454865?hl=en)

## 支持頁

[支持 Roomly](https://demo.terry878.org/roomly/support.html)說明即時通知、背景同步與雲端資源需要維護費用。免費公開版目前以手動同步降低用量。尚未準備收款方式，頁面沒有付款按鈕、收款或捐款後自動解鎖功能；未來若獲得支持，會另行公告評估開放的功能。

## 本機開發多團隊版

需要 Node.js 24 或更新版本。先在專案根目錄執行 `npm ci`。本機與雲端都需使用**自己的** Google OAuth 專案，不能把公開服務的 Client Secret 複製來使用。

### 1. 建立自己的 Google OAuth

在 Google Cloud Console 啟用 Calendar API，建立 Web application OAuth client。混合 Gmail／Workspace 帳號選 External，Data Access 宣告上方兩項日曆唯讀權限及基本登入範圍。開發期間若使用 Testing，將測試帳號加入 Test users；日曆 refresh token 在 Testing 可能於 7 天後到期。長期公開使用需處理 Production 與 Google 驗證。[Google Audience](https://support.google.com/cloud/answer/15549945?hl=en)

| Google 設定 | 本機 | 雲端範例 |
| --- | --- | --- |
| Authorized JavaScript origins | `http://localhost:3000` | `https://roomly.example.com` |
| 登入 redirect URI | `http://localhost:3000/roomly/api/login/redirect` | `https://roomly.example.com/roomly/api/login/redirect` |
| 日曆 redirect URI | `http://localhost:3000/roomly/api/calendar/callback` | `https://roomly.example.com/roomly/api/calendar/callback` |

Origin 不含 `/roomly` 路徑。兩個 redirect URI 必須完整相符；不要混用 `localhost` 與 `127.0.0.1`，或多加結尾 `/`。自己的雲端網址也要加入 Google 授權網域，並填入自己部署的 `about.html` 與 `privacy.html`。[Google Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)

### 2. 本機變數

PowerShell：

```powershell
Copy-Item .dev.vars.community.example .dev.vars
```

macOS／Linux：

```sh
cp .dev.vars.community.example .dev.vars
```

編輯 `.dev.vars`，填入：

| 設定 | 值 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | 自己的 Web application Client ID |
| `GOOGLE_CLIENT_SECRET` | 同一個 client 的 Secret，只供後端使用 |
| `PUBLIC_CALENDAR_TOKEN_KEY` | 自己產生的 32-byte、64 字元十六進位金鑰 |

可在自己的終端機產生金鑰：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`wrangler.community.local.jsonc` 已設定 `PUBLIC_APP_ORIGIN=http://localhost:3000`、`PUBLIC_DB`、`PUBLIC_SYNC_QUEUE` 與 `migrations-community/`。其中全零樣式 database ID 只供本機模擬，不能用於雲端。`.dev.vars` 被 Git 忽略，不要將真實值放入前端、設定範例或 Git。

若同一份 checkout 也開發單團隊模式，兩者使用不同的 `.dev.vars` 內容，切換時要備份自己的設定；勿把單團隊的 `CALENDAR_TOKEN_KEY` 當作公開版 `PUBLIC_CALENDAR_TOKEN_KEY`。

### 3. 啟動本機服務

```sh
npm run dev:community
```

此指令先建置 `community-dist/`，套用多團隊本機 D1 migrations，再於 [http://localhost:3000/roomly/](http://localhost:3000/roomly/)啟動 Worker。首次登入建立自己的空間，授權日曆，再按同步。每次修改前端後重啟此指令可重建 assets。

只初始化本機資料表：

```sh
npm run db:community:local
```

等同 `wrangler d1 migrations apply roomly-community --local --config wrangler.community.local.jsonc`，套用的是 `migrations-community/`，而非舊單團隊 `migrations/`。本機 D1 與 Queue 由 Wrangler 模擬，不需先建立遠端資源；本機仍會在手動同步時連接真實 Google API。不要使用 `wrangler dev --remote` 測試 Queue。[Cloudflare Queues 本機開發](https://developers.cloudflare.com/queues/configuration/local-development/)

## 部署多團隊版到 Cloudflare

### 1. 複製雲端範例

PowerShell：

```powershell
Copy-Item wrangler.community.example.jsonc wrangler.community.jsonc
```

macOS／Linux：

```sh
cp wrangler.community.example.jsonc wrangler.community.jsonc
```

`wrangler.community.jsonc` 是自己使用的部署設定，已列入 `.gitignore`。不要填入公司的舊 D1、舊 Queue 或私人帳號 ID。這個模式使用新的 `PUBLIC_DB`、新的 `PUBLIC_SYNC_QUEUE` 與新的 `PUBLIC_CALENDAR_TOKEN_KEY`。

### 2. 建立自己的資源

```sh
npx wrangler login
npx wrangler d1 create roomly-community --config wrangler.community.jsonc
npx wrangler queues create roomly-community-sync --config wrangler.community.jsonc
```

將 D1 建立結果中的 `database_id` 填入雲端設定，保留 binding `PUBLIC_DB` 與 `migrations_dir: "migrations-community"`。若改資料庫名稱，也要修改 `db:community:*` 指令的名稱。producer 與 consumer 的 Queue 名稱必須一致，binding 保留 `PUBLIC_SYNC_QUEUE`。

同時修改自己的 `wrangler.community.jsonc`：

- `name`：自己的 Worker 名稱。
- `vars.PUBLIC_APP_ORIGIN`：實際 HTTPS origin，不含路徑或結尾 `/`。
- `vars.GOOGLE_CLIENT_ID`：自己的雲端 OAuth Client ID。
- `d1_databases[0].database_id`：剛建立的資料庫 ID。
- `queues.producers`／`queues.consumers`：剛建立的同一個 Queue。

入口固定 `/roomly/`。可以使用自己的 `workers.dev` 子網域，或合併自有網域設定：

```json
{"routes": [{"pattern": "roomly.example.com", "custom_domain": true}]}
```

該 zone 必須在自己的 Cloudflare 帳號。Google origin／兩個回呼、`PUBLIC_APP_ORIGIN` 與實際網址需一同更新。請先修改 `community/about.html` 與 `community/privacy.html`，反映自己的聯絡方式與真實處理政策。[Cloudflare Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

### 3. 初始化、檢查並發布

```sh
npm run db:community:remote
npm test
npm run typecheck
npm run check:community
npm run deploy:community
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.community.jsonc
npx wrangler secret put PUBLIC_CALENDAR_TOKEN_KEY --config wrangler.community.jsonc
```

首次 deploy 建立 Worker，再用 `secret put` 分別保存同一個 OAuth client 的 Secret 與自己的新 64 字元加密金鑰；兩個 secrets 完成前，登入與授權功能不會完整可用。勿將密鑰寫入 `vars` 或 Git。`check:community` 使用本機範例設定做 dry run，不需要雲端 ID；如果要額外檢查自己填好的雲端設定，可執行 `npx wrangler deploy --dry-run --config wrangler.community.jsonc`。[Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

`db:community:remote` 明確使用自己的雲端設定，依序套用 `migrations-community/`；後續更新也要先套用尚未執行的 migrations，再 deploy。不要用舊的 `npm run db:remote` 或 `npm run deploy` 指令發布多團隊版。[Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)

本模式沒有 cron 或 Google watch。Queue 每次僅延續已建立的手動工作，producer／consumer 都需部署，工作才能完成。Cloudflare 免費額度不等於無限資源，自己的部署請依實際使用量查看 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)與 [Queues 價格](https://developers.cloudflare.com/queues/platform/pricing/)。

加密金鑰需妥善備份；直接替換 `PUBLIC_CALENDAR_TOKEN_KEY` 會使既有日曆 refresh token 無法解密，需另行遷移或請使用者重新授權。本機 `.dev.vars` 不會自動上傳成雲端 secrets。

### 4. 部署後確認

使用自己的 Google 帳號登入，建立空間，授權日曆，按同步。確認來源真正完成後才出現成功時間，再用另一個指定帳號接受邀請，確認兩個獨立空間的成員與會議不會互相顯示。OAuth、邀請與 API 回應不進入 PWA 快取，只有公開靜態 assets 可離線快取。

## GitHub Pages 與虛構展示

`npm run build:pages` 產生 `pages-dist/` 的產品介紹與入口頁，GitHub Actions 發布這個資料夾。若自架公開服務，將 `community/pages.html` 中**所有**以 `https://demo.terry878.org/roomly/` 開頭的服務連結改成自己的 HTTPS 網域，保留 `/roomly/` 及各說明頁路徑。帶 `data-service-entry` 的主入口須保持相同網址，說明與支持連結也須使用相同 origin；建置會檢查一致性。再按 [Pages 發布教學](DEPLOYMENT.md#github-pages發布入口頁)操作。

`npm run demo` 與 `npm run build:demo` 仍單獨提供不需登入的虛構介面示範，輸出 `demo-dist/`。它不連接 Google、不寄信，也不是目前 GitHub Pages 的首頁；[舊展示截圖](SCREENSHOTS.md)只用來示意甘特圖操作。
