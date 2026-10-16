// Fictional shared tape. The 256-bit secret must come ONLY from Worker env.
// No secret, HMAC digest or future news result belongs in D1, API or logs.
import { hmacKey, PAIRS, NEWS_SETTLE, FX_KEYS, ETF_KEYS, CRYPTO_KEYS, volOf, pickEvent, eventShape, EVENT_SPAN } from '../../market.mjs';
export const TICK_MS = 1500;
export const SHARED_MARKET_ALGORITHM = 'fxweb/shared/hmac-sha256-causal-v1';
// PAIR_KEYS 包含 ETF（價格、K 線都會算）。新聞則分兩條獨立的 HMAC 串流：
// 外匯沿用原本的 'news' 網域與 6 個外匯清單，所以既有外匯新聞與價格逐位元不變；
// ETF 用新的 'news-etf' 網域，只會「多出」ETF 新聞，不會改動任何外匯的歷史。
const SPAN = 64, KEEP_NEWS = 50, PAIR_KEYS = Object.keys(PAIRS), enc = new TextEncoder();
// ===== 重大事件（崩盤／暴漲）=====
// 時間切成每 EVENT_BUCKET 根一格；每格用一個 HMAC 決定「這格有沒有事件、在第幾根、是什麼事件」。
// 事件當根價格瞬間跳空（約 6 成在第一根、剩下兩根內補完），維持 EVENT_HOLD 根後，
// 在 EVENT_DECAY 根內平滑回到原本走勢。EVENT_START 之前完全沒有事件，所以既有歷史價格逐位元不變。
export const EVENT_START = Date.UTC(2026, 9, 16, 2, 0, 0) / 1500;   // 2026-10-16 10:00（台灣時間）起
export const EVENT_BUCKET = 200;      // 200 根 ≈ 5 分鐘
export const EVENT_CHANCE = 0.45;     // 每 5 分鐘 45% 機率 → 平均約 11 分鐘一次

const HEADLINES = {
  'EUR/USD': [['歐洲央行官員暗示將再升息',1],['歐元區製造業 PMI 意外疲軟',-1],['德國通膨數據高於預期',1],['美國非農就業強勁，美元走高',-1]],
  'GBP/USD': [['英國央行維持鷹派立場',1],['英國零售銷售大幅下滑',-1],['英國薪資成長超出預期',1],['英國政局不確定性升溫',-1]],
  'AUD/USD': [['中國刺激政策提振澳元',1],['鐵礦砂價格重挫',-1],['澳洲央行意外升息',1],['全球避險情緒升溫',-1]],
  'USD/JPY': [['日本央行維持超寬鬆政策',1],['日本財務省暗示進場干預',-1],['美債殖利率攀升',1],['避險資金湧入日圓',-1]],
  'USD/CHF': [['聯準會官員發言偏鷹',1],['地緣政治緊張，資金湧入瑞郎',-1],['美國零售銷售超出預期',1],['瑞士央行意外升息',-1]],
  'USD/CAD': [['國際油價大跌，加元承壓',1],['加拿大就業數據亮眼',-1],['美國 CPI 高於預期',1],['加拿大央行釋出鷹派訊號',-1]],
  '0050':  [['台積電法說會釋出樂觀展望',1],['外資連續賣超台股',-1],['AI 伺服器出貨創新高',1],['台幣急升壓抑電子股',-1]],
  '00878': [['高股息成分股宣布加碼配息',1],['殖利率走升，高股息族群承壓',-1],['央行降息預期升溫',1],['成分股季度調整引發賣壓',-1]],
  'BTC':   [['比特幣減半行情發酵',1],['美國監管機構起訴大型交易所',-1],['上市公司宣布買進比特幣',1],['巨鯨錢包大量轉入交易所',-1]],
  'ETH':   [['以太坊升級順利完成',1],['DeFi 協議遭駭，以太幣承壓',-1],['以太幣現貨 ETF 獲批',1],['質押解鎖潮湧現賣壓',-1]],
  'SOL':   [['Solana 迷因幣交易量創新高',1],['Solana 網路再度當機',-1],['大型支付商宣布支援 SOL',1],['創投基金大舉拋售 SOL',-1]],
  'DOGE':  [['馬斯克推文提到狗狗幣',1],['狗狗幣巨鯨疑似出貨',-1],['電商平台宣布接受狗狗幣付款',1],['迷因幣熱潮退燒',-1]],
  'SPY':   [['美國企業財報優於預期',1],['聯準會暗示延後降息',-1],['美國消費數據強勁',1],['美國經濟衰退疑慮升溫',-1]],
  'QQQ':   [['科技巨頭財報亮眼',1],['晶片出口管制升級',-1],['AI 需求帶動科技股反彈',1],['美債殖利率大漲，科技股重挫',-1]],
};
function keyBytes(secret) {
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) throw new Error('Shared market requires a 256-bit hexadecimal secret');
  return Uint8Array.from(secret.match(/../g), h => parseInt(h, 16));
}
function checkTick(t) { if (!Number.isSafeInteger(t) || t < 0) throw new RangeError('Invalid absolute market tick'); }
function checkPair(p) { if (!Object.hasOwn(PAIRS,p)) throw new RangeError('Unsupported market pair'); }
export function absoluteTick(now = Date.now()) {
  if (!Number.isFinite(now) || now < 0) throw new RangeError('Invalid UTC epoch time');
  const t = Math.floor(now / TICK_MS); checkTick(t); return t;
}
export const tickAt = absoluteTick;
// Request-scoped memo; prices at t consume ONLY HMAC domains timestamped <= t.
function context(secret) {
  const mac = hmacKey(keyBytes(secret)), digests = new Map(), quotes = new Map(), bars = new Map(), reports = new Map();
  function digest(domain,t,p='') {
    const id = `${domain}|${t}|${p}`;
    let d = digests.get(id);
    if (d === undefined) { d = mac(enc.encode(`${SHARED_MARKET_ALGORITHM}|${id}`)); digests.set(id,d); }
    return d;
  }
  // 讀 4 個位元組為大端序 uint32（與原本的 DataView.getUint32 相同），再換成 [0,1)。
  function u(b,at=0) { return (b[at]*16777216 + b[at+1]*65536 + b[at+2]*256 + b[at+3])/4294967296; }
  function anchor(t,p) { return t<0 ? 0 : (u(digest('anchor',t,p))*2-1)*0.012; }
  function price(t,p) {
    checkTick(t); checkPair(p);
    const id=`${t}|${p}`;
    if (quotes.has(id)) return quotes.get(id);
    const start=Math.floor(t/SPAN)*SPAN, x=(t-start)/SPAN, smooth=x*x*(3-2*x);
    // The current anchor first becomes available at 'start'; never read the NEXT anchor.
    const trend=anchor(start-SPAN,p)*(1-smooth)+anchor(start,p)*smooth;
    let jitter=0;
    for(let lag=0;lag<3;lag++) if(t>=lag) jitter += [0.5,0.32,0.18][lag]*(u(digest('noise',t-lag,p))*2-1);
    // vol：外匯 = 1（與原算式逐位元相同），ETF 依標的放大波動。
    let result=PAIRS[p]*Math.exp(volOf(p)*(trend+jitter*0.0014));
    // 重大事件的跳空；沒有事件影響時完全不乘，外匯價格逐位元不變。
    const shock=t>=EVENT_START ? shockLog(t,p) : 0;
    if (shock) result*=Math.exp(shock);
    quotes.set(id,result); return result;
  }
  // 第 b 格的事件（或 null）。HMAC 網域時間戳＝格子起點 ≤ 事件時間，只有事件時間到了才會被使用。
  const eventsByBucket=new Map();
  function bucketEvent(b) {
    if (eventsByBucket.has(b)) return eventsByBucket.get(b);
    const start=b*EVENT_BUCKET; let ev=null;
    if (start+EVENT_BUCKET>EVENT_START) {
      const d=digest('event',start);
      const step=start+Math.floor(u(d,4)*EVENT_BUCKET);
      if (u(d,0)<EVENT_CHANCE && step>=EVENT_START) {
        // 依序取亂數：先用這個摘要剩下的 6 個字，不夠再取 'event-r' 摘要。
        let block=d, at=8, j=0;
        const r=()=>{ if(at>=32){ block=digest('event-r',start,String(j++)); at=0; } const v=u(block,at); at+=4; return v; };
        const picked=pickEvent(r,PAIR_KEYS);
        if (picked) ev={...picked,step,logs:Object.fromEntries(Object.entries(picked.moves).map(([p,m])=>[p,Math.log(1+m)]))};
      }
    }
    eventsByBucket.set(b,ev); return ev;
  }
  function shockLog(t,p) {
    let s=0;
    const last=Math.floor(t/EVENT_BUCKET), first=Math.max(0,Math.floor((t-EVENT_SPAN)/EVENT_BUCKET));
    for(let b=first;b<=last;b++) {
      const ev=bucketEvent(b);
      if (ev && ev.logs[p]!==undefined && t>=ev.step) s+=ev.logs[p]*eventShape(t-ev.step);
    }
    return s;
  }
  // [from, to] 之間發生的事件（對外版本：不含內部 log 值）
  function eventsBetween(from,to) {
    const out=[];
    if (to<EVENT_START) return out;
    for(let b=Math.max(0,Math.floor(Math.max(from,EVENT_START)/EVENT_BUCKET));b<=Math.floor(to/EVENT_BUCKET);b++) {
      const ev=bucketEvent(b);
      if (ev && ev.step>=from && ev.step<=to) out.push({step:ev.step,pair:ev.pair,text:ev.text,claimed:ev.claimed,event:ev.id,moves:ev.moves,settled:true,reversed:false});
    }
    return out;
  }
  function candle(t,p) {
    checkTick(t); checkPair(p);
    const id=`${t}|${p}`;
    if (bars.has(id)) return bars.get(id);
    const o=t ? price(t-1,p):PAIRS[p], c=price(t,p), bytes=digest('wick',t,p);
    const w=0.00045*volOf(p);
    const h=Math.max(o,c)*(1+u(bytes)*w), l=Math.min(o,c)*(1-u(bytes,4)*w);
    const r=v=>Number(v.toPrecision(7));
    const bar={t,o:r(o),h:r(h),l:r(l),c:r(c)};
    bars.set(id,bar); return bar;
  }
  // 一條新聞串流：domain 決定 HMAC 網域，keys 是這條串流可能報導的商品。
  // 外匯串流＝原本的 ('news', 6 個外匯, 'news-result')，結果與加入 ETF 前逐位元相同。
  const STREAMS=[['news',FX_KEYS,'news-result'],['news-etf',ETF_KEYS,'news-etf-result'],['news-crypto',CRYPTO_KEYS,'news-crypto-result']];
  function streamNews(si,t,head) {
    const [domain,keys,resultDomain]=STREAMS[si], id=`${si}|${t}`;
    if (!reports.has(id)) {
      const bytes=digest(domain,t);
      let item=null;
      if (keys.length && u(bytes)<0.035) {
        const pair=keys[Math.floor(u(bytes,4)*keys.length)];
        const list=HEADLINES[pair], [text,claimed]=list[Math.floor(u(bytes,8)*list.length)];
        item={step:t,pair,text,claimed};
      }
      reports.set(id,item);
    }
    const item=reports.get(id);
    if (!item) return null;
    const settled=head-t>=NEWS_SETTLE;
    return {...item,settled,reversed:settled ? u(digest(resultDomain,t))<0.24 : null};
  }
  function check(t,head) {
    checkTick(t); checkTick(head);
    if(head<t) throw new RangeError('Cannot publish future news');
  }
  // 外匯新聞（單一則或 null）；維持原本的介面。
  function news(t,head=t) { check(t,head); return streamNews(0,t,head); }
  // 這一根 K 線的所有新聞（外匯在前、ETF 在後）。
  function allNews(t,head=t) {
    check(t,head);
    return STREAMS.map((_,i)=>streamNews(i,t,head)).filter(Boolean);
  }
  return {price,candle,news,allNews,streamNews,eventsBetween};
}
export function sharedPrice(secret,tick,pair) { return context(secret).price(tick,pair); }
// 一個請求內重複查價用：共用同一份 HMAC 快取。補算 600 根時，每根的 3 個 noise
// 有 2 個是上一根已算過的、anchor 每 64 根才換一次，重複利用後 HMAC 次數降到約 1/3。
export function sharedPricer(secret) { const c=context(secret); return (tick,pair)=>c.price(tick,pair); }
export function sharedCandle(secret,tick,pair) { return context(secret).candle(tick,pair); }
export function sharedNews(secret,tick) { return context(secret).news(tick); }
export function makeSharedMarket(secret,headTick,{history=160,since}={}) {
  checkTick(headTick);
  if (!Number.isSafeInteger(history)||history<1||history>10000) throw new RangeError('Invalid shared market history');
  // A valid cursor needs only the new bars. In particular, an unchanged head
  // must not recompute the whole tape just to return the current prices.
  const delta=Number.isSafeInteger(since)&&since>=0&&since<=headTick&&headTick-since<history;
  const req=context(secret), prices={}, candles={};
  const first=delta ? since+1 : Math.max(0,headTick-history+1);
  for(const pair of PAIR_KEYS) {
    const series=[];
    for(let t=first;t<=headTick;t++) series.push(req.candle(t,pair));
    prices[pair]=req.price(headTick,pair); candles[pair]=series;
  }
  // Previously published releases can acquire a settled result after `since`.
  // Full snapshots preserve the existing bounded 50-item / 2000-tick policy（外匯）。
  const scan=(si,earliest,limit)=>{
    const out=[];
    for(let t=headTick;t>=earliest && out.length<limit;t--) { const it=req.streamNews(si,t,headTick); if(it) out.push(it); }
    return out.reverse();
  };
  const fxNews=delta ? scan(0,Math.max(0,since-NEWS_SETTLE),Infinity)
    : scan(0,Math.max(0,headTick-Math.max(history+NEWS_SETTLE,2000)+1),KEEP_NEWS);
  // ETF 新聞：只回顧畫面上看得到的 K 線範圍（history + 結算期），完整快照不用多掃 2000 根，
  // Worker 的 CPU 時間因此只比加入 ETF 前多一點點。
  const recent=si=>delta ? scan(si,Math.max(0,since-NEWS_SETTLE),Infinity)
    : scan(si,Math.max(0,headTick-(history+NEWS_SETTLE)+1),KEEP_NEWS);
  const etfNews=recent(1), cryptoNews=recent(2);
  // 重大事件：完整快照列出最近 2000 根內的事件；增量只送新發生的。
  const events=req.eventsBetween(delta ? since+1 : Math.max(0,headTick-1999),headTick);
  // 依時間合併；同一根外匯在前。外匯部分與加入 ETF 前逐位元相同。
  const rank=n=>n.event ? 3 : FX_KEYS.includes(n.pair) ? 0 : ETF_KEYS.includes(n.pair) ? 1 : 2;
  const news=[...fxNews,...etfNews,...cryptoNews,...events].sort((a,b)=>a.step-b.step||rank(a)-rank(b));
  return {prices,candles,news,step:headTick,history,algorithm:SHARED_MARKET_ALGORITHM};
}
