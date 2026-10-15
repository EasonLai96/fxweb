// Fictional shared tape. The 256-bit secret must come ONLY from Worker env.
// No secret, HMAC digest or future news result belongs in D1, API or logs.
import { hmacSha256, PAIRS, NEWS_SETTLE } from '../../market.mjs';
export const TICK_MS = 1500;
export const SHARED_MARKET_ALGORITHM = 'fxweb/shared/hmac-sha256-causal-v1';
const SPAN = 64, KEEP_NEWS = 50, PAIR_KEYS = Object.keys(PAIRS), enc = new TextEncoder();
const HEADLINES = {
  'EUR/USD': [['歐洲央行官員暗示將再升息',1],['歐元區製造業 PMI 意外疲軟',-1],['德國通膨數據高於預期',1],['美國非農就業強勁，美元走高',-1]],
  'GBP/USD': [['英國央行維持鷹派立場',1],['英國零售銷售大幅下滑',-1],['英國薪資成長超出預期',1],['英國政局不確定性升溫',-1]],
  'AUD/USD': [['中國刺激政策提振澳元',1],['鐵礦砂價格重挫',-1],['澳洲央行意外升息',1],['全球避險情緒升溫',-1]],
  'USD/JPY': [['日本央行維持超寬鬆政策',1],['日本財務省暗示進場干預',-1],['美債殖利率攀升',1],['避險資金湧入日圓',-1]],
  'USD/CHF': [['聯準會官員發言偏鷹',1],['地緣政治緊張，資金湧入瑞郎',-1],['美國零售銷售超出預期',1],['瑞士央行意外升息',-1]],
  'USD/CAD': [['國際油價大跌，加元承壓',1],['加拿大就業數據亮眼',-1],['美國 CPI 高於預期',1],['加拿大央行釋出鷹派訊號',-1]],
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
  const key = keyBytes(secret), digests = new Map(), quotes = new Map(), bars = new Map(), reports = new Map();
  function digest(domain,t,p='') {
    const id = `${domain}|${t}|${p}`;
    if (!digests.has(id)) digests.set(id,hmacSha256(key,enc.encode(`${SHARED_MARKET_ALGORITHM}|${id}`)));
    return digests.get(id);
  }
  function u(bytes,at=0) { return new DataView(bytes.buffer,bytes.byteOffset+at,4).getUint32(0)/4294967296; }
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
    const result=PAIRS[p]*Math.exp(trend+jitter*0.0014);
    quotes.set(id,result); return result;
  }
  function candle(t,p) {
    checkTick(t); checkPair(p);
    const id=`${t}|${p}`;
    if (bars.has(id)) return bars.get(id);
    const o=t ? price(t-1,p):PAIRS[p], c=price(t,p), bytes=digest('wick',t,p);
    const h=Math.max(o,c)*(1+u(bytes)*0.00045), l=Math.min(o,c)*(1-u(bytes,4)*0.00045);
    const r=v=>Number(v.toPrecision(7));
    const bar={t,o:r(o),h:r(h),l:r(l),c:r(c)};
    bars.set(id,bar); return bar;
  }
  function news(t,head=t) {
    checkTick(t); checkTick(head);
    if(head<t) throw new RangeError('Cannot publish future news');
    if (!reports.has(t)) {
      const bytes=digest('news',t);
      let item=null;
      if (u(bytes)<0.035) {
        const pair=PAIR_KEYS[Math.floor(u(bytes,4)*PAIR_KEYS.length)];
        const list=HEADLINES[pair], [text,claimed]=list[Math.floor(u(bytes,8)*list.length)];
        item={step:t,pair,text,claimed};
      }
      reports.set(t,item);
    }
    const item=reports.get(t);
    if (!item) return null;
    const settled=head-t>=NEWS_SETTLE;
    return {...item,settled,reversed:settled ? u(digest('news-result',t))<0.24 : null};
  }
  return {price,candle,news};
}
export function sharedPrice(secret,tick,pair) { return context(secret).price(tick,pair); }
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
  const news=[];
  // Previously published releases can acquire a settled result after `since`.
  // Full snapshots preserve the existing bounded 50-item / 2000-tick policy.
  const earliest=delta ? Math.max(0,since-NEWS_SETTLE)
    : Math.max(0,headTick-Math.max(history+NEWS_SETTLE,2000)+1);
  for(let t=headTick;t>=earliest && (delta||news.length<KEEP_NEWS);t--) {
    const item=req.news(t,headTick); if(item) news.push(item);
  }
  news.reverse();
  return {prices,candles,news,step:headTick,history,algorithm:SHARED_MARKET_ALGORITHM};
}
