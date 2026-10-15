# fxweb-api

槓桿交易練習場的後端：Cloudflare Workers + D1。帳號密碼登入、雲端存檔。

## API

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | /api/register | `{username, password}` → `{token, user}` |
| POST | /api/login | `{username, password}` → `{token, user}` |
| POST | /api/logout | 需登入，作廢目前 token |
| GET | /api/me | 需登入 |
| GET | /api/save | 需登入，回傳 `{save: {data, version, updatedAt} 或 null}` |
| PUT | /api/save | 需登入，`{baseVersion, data}`；版本不符回 409 並附上雲端存檔；`{force:true, data}` 強制覆蓋 |
| DELETE | /api/account | 需登入，`{password}`，刪除帳號與存檔 |

登入後以 `Authorization: Bearer <token>` 呼叫。token 有效 30 天，資料庫只存 SHA-256。

## 安全設計

- 密碼：PBKDF2-SHA256、100000 次迭代、每人 16 bytes 隨機 salt。
- 帳號不存在與密碼錯誤回同一訊息，且都會跑一次 PBKDF2（時間相近）。
- 同一帳號 + IP 15 分鐘內失敗 10 次即鎖定；同一 IP 15 分鐘內最多註冊 10 個帳號。
- CORS 只允許 `ALLOWED_ORIGINS` 內的網站。
- 存檔上限 64 KB；內容由玩家瀏覽器產生，不可當作可信成績。

## 部署

```sh
npm install
export CLOUDFLARE_API_TOKEN=...      # 權限：Workers Scripts Edit、D1 Edit
npx wrangler d1 create fxweb         # 把印出的 database_id 填進 wrangler.toml
npx wrangler d1 migrations apply fxweb --remote
npx wrangler deploy
```

部署後把 Worker 網址填進前端 `config.mjs` 的 `API_BASE`。

## 測試

```sh
node --test --no-warnings test/api.test.mjs
```

用 `node:sqlite` 模擬 D1（`test/d1shim.mjs`），不需要 Cloudflare 帳號。
