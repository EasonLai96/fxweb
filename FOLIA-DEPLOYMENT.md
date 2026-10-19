# Club music / Folia deployment

## Components

- `folia-player.mjs` / `.css`: independent vanilla browser widget, imported from `index.html`. Does not read game tokens/accounts or call game APIs.
- Default radio: browser `<audio preload="none">` connects directly to SomaFM HTTPS streams on user click. No audio proxy, polling, automatic retry, autoplay, or music database. Saves only station and volume under `fxweb.music.v1`.
- SomaFM attribution and original site link remain visible. Streams are third-party radio, not a redistributed catalogue or guarantee of perpetual availability. At 128kbps a listener uses roughly 58MB/hour of their own data.
- Optional full Folia: `https://fxweb-folia.1090340.workers.dev/`, loaded in a separate-origin sandboxed iframe only after an explicit click. Collapse retains the instance; Stop unloads it. Folder import requires the top-level link (File System Access restrictions).

## Reproduce Folia

Source: https://github.com/chthollyphile/folia-major at `235db10a0d0383c86d5fd575223ecbf36e8b6d72`, AGPL-3.0. This deployment uses the original application unmodified; source and its license are available there. It is not the Android APK branch. Node >=24 required.

```powershell
git clone https://github.com/chthollyphile/folia-major.git
git checkout 235db10a0d0383c86d5fd575223ecbf36e8b6d72
npm ci --ignore-scripts
$env:VITE_QQ_API_BASE='/api/qq'
$env:VITE_NETEASE_API_BASE=''
npm run build
```

Use the upstream `wrangler.jsonc` with name `fxweb-folia`, retaining its Worker entry, process defines and Assets configuration (`run_worker_first: ['/api/*']`). Set runtime `QQ_SESSION_SECRET` with Wrangler secret put; generate cryptographically, never commit it. No AI secrets are configured. QQ anonymous search works; playback requires the listener's login, rights and region. NetEase/KuGou are not configured (do not promise them as working). Local playback works; missing NetEase lyric auto-match can log warnings/errors without preventing local audio.

After each build, create `dist/_headers` (or keep this in a deployment-only public asset):

```text
/*
  Content-Security-Policy: frame-ancestors 'self' https://easonlai96.github.io http://127.0.0.1:8799
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

Deploy with `npx wrangler@4 deploy --config <config-path>`. Configuration and headers contain no secrets. Do not deploy Folia into `fxweb-api` or reuse the game's market secret. The two Workers still share account-level Free request quota.

## Capacity / known limits

Cloudflare docs: https://developers.cloudflare.com/workers/platform/limits/ and https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ . Free Worker invocations are limited to 100,000/day/account and 10ms CPU/request. Static Assets requests are free/unlimited; `/api/*` invokes Worker. Plan, current usage, CPU distributions and third-party quotas were not directly measured, so no maximum concurrent-user guarantee is made.

Folia built assets ~19.6MiB raw, PWA precache ~14.8MiB raw (202 entries). These are not measured transfer bytes; optional Folia can be heavy on client memory/CPU and first download. Default radio does not load it or invoke Folia APIs. It adds zero steady-state Worker requests; audio bytes go to the radio source. QQ use and the existing trading/online APIs still consume account quotas. One active trader polling every 1.5s can request ~2,400 state reads/hour before other APIs/cron; player isolation does not solve the game's existing scale limits.

Bounded live check: 30 static requests at max concurrency 5, all HTTP200 and cache HIT; warm repeats n20 p50 200ms/p95 330ms from one client/location. One channels request 200 in 223ms. Not a saturation benchmark; does not establish max users, CPU headroom or global capacity. Live public search separately returned 3 songs with HTTP200.

## Verification

Browser: both radio stations actually played (audio readyState4, paused=false and increasing currentTime); collapsed playback continues; Stop removes src and pauses; station/volume saved; no iframe before explicit load; optional Folia loads and unloads; radio stops before Folia opens. Local Folia playback verified using a generated 20s WAV imported via a test-provided OPFS directory handle, with currentTime increasing; real OS picker and QQ account login playback not tested. Never use real user accounts for tests.
