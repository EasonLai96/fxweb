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
| DELETE | /api/account | password，刪帳與所有相關資料 |

舊 /api/save 已移除。交易值以伺服器為準。requestId為1–64個英數/底線/連字號，同一請求重送須用同ID；只保留最近128筆去重紀錄，不是永久回執。

## 安全與時間

- 密碼PBKDF2-SHA256 100000次，隨機salt；token只存SHA256。
- 救援碼驗證後CAS原子消耗；session版本精確比對，重設撤銷其他登入。
- 登入與救援操作節流；game讀取120次/分鐘、動作60次/分鐘、重置5次/分鐘。
- 遊戲使用256bit私密HMAC-SHA256亂數，重算確定性，不回傳秘密或未結束新聞的實際方向。
- 每請求最多補600根；剩餘時間不丟棄，追平前新交易回409 catching_up。不要把離線視作暫停。
- CORS不是防止非瀏覽器呼叫的安全機制。

## 部署

在server目錄安裝wrangler（npm install --save-dev wrangler@3），用wrangler login授權後：

```sh
npx wrangler d1 migrations list fxweb --remote
npx wrangler d1 migrations apply fxweb --remote
npx wrangler deploy
```

0002保留舊saves表，不把舊資料匯入games；只適用尚未套用0002的DB。正式變更前檢查migration紀錄並備份。
前端config.mjs填Worker網址；不得把token或備份資料提交Git。

## 測試

```sh
node --test --no-warnings test/api.test.mjs
```

使用SQLite D1 shim測帳號競態、交易冪等與API安全；game-security測試涵蓋密碼學向量與離線時間重播。
