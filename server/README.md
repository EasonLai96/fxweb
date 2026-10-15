# fxweb-api

Cloudflare Workers + D1：帳號、救援碼重設密碼、伺服器端交易。

## API

Authorization: Bearer token；session有效30天。

| 方法 | 路徑 | 用途 |
|---|---|---|
| POST | /api/register | username,password → token,user,recoveryCode |
| POST | /api/login | username,password → token,user |
| POST | /api/logout | 作廢目前session |
| GET | /api/me | user、hasRecoveryCode |
| POST | /api/reset-password | username,recoveryCode,newPassword → 新session及新救援碼 |
| POST | /api/recovery-code | password → 新救援碼，舊碼作廢 |
| GET | /api/game?since=N | 帳戶、公開行情、增量K線、離線補算狀態 |
| POST | /api/game/open | pair,side,leverage,margin,since,requestId |
| POST | /api/game/close | id,since,requestId |
| POST | /api/game/reset | since,requestId |
| GET | /api/leaderboard | 匿名可看自願參賽玩家暱稱與目前已儲存分數快照 |
| GET | /api/leaderboard/me | 登入後查看自己本季參賽狀態 |
| POST | /api/leaderboard/join | 登入後從全新 $10,000 回合以 {nickname} 加入一次 |
| POST | /api/leaderboard/leave | 登入後退出；本季不可重新加入 |
| DELETE | /api/account | password，刪帳與所有相關資料 |

舊 /api/save 已移除。交易值以伺服器為準。requestId為1–64個英數/底線/連字號，同一請求重送須用同ID；只保留最近128筆去重紀錄，不是永久回執。

## 安全與時間

- 密碼PBKDF2-SHA256 100000次，隨機salt；token只存SHA256。
- 救援碼驗證後CAS原子消耗；session版本精確比對，重設撤銷其他登入。
- 登入與救援操作節流；game讀取120次/分鐘、動作60次/分鐘、重置5次/分鐘。
- 所有登入玩家共用伺服器絕對 tick（UTC epoch/1500ms）及版本化 HMAC-SHA256 虛構行情；全球密鑰僅以 Worker secret `SHARED_MARKET_SECRET` 提供，絕不提交或存 D1。既有私有行情持倉用原市場結算至清倉，禁止再開舊市場新倉，清倉後保留餘額/成就轉共享市場。
- 共享持倉到期限制 7 天。每請求最多補600根；仍有曝險時完整保留待結算 ticks，追平前新交易回409 catching_up。閒置數月可能需大量請求；無人發請求時不保證資料庫即時結算/更新榜單，不能將離線視作暫停。
- 排行按本季帳戶權益/$10,000−1（含浮動損益）排序，每季 UTC 1/4/7/10 月1日換季，需全新回合並自願公開暱稱。重置/退出同季禁止重入；無真人驗證仍可能多帳號操作。公開查詢不會為所有玩家重新結算，僅顯示玩家最近持久化分數及確認時間。
- CORS不是防止非瀏覽器呼叫的安全機制。

## 部署

在server目錄安裝wrangler（npm install --save-dev wrangler@3），用wrangler login授權後：

```sh
npx wrangler d1 migrations list fxweb --remote
npx wrangler d1 migrations apply fxweb --remote
# 先以安全亂數產生32位元組hex，透過 wrangler secret put SHARED_MARKET_SECRET 儲存，切勿列印到終端或提交。
npx wrangler secret put SHARED_MARKET_SECRET
npx wrangler deploy
```

0002保留舊saves；0003只新增自願參賽的 JSON 索引。正式變更前檢查 migration 紀錄並備份。重要：共同行情密鑰一旦有人持倉不能直接更換，否則歷史價格與強平結果會改變；輪換需先設計版本化雙密鑰與完整過渡。
前端config.mjs填Worker網址；不得把token或備份資料提交Git。

## 測試

```sh
node --test --no-warnings test/api.test.mjs
```

使用SQLite D1 shim測帳號競態、交易冪等與API安全；game-security測試涵蓋密碼學向量與離線時間重播。
