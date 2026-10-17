export const DEMO_MODEL='@cf/meta/llama-3.2-3b-instruct';
export const DEMO_SYMBOLS=Object.freeze(['2330.TW','0050.TW','AAPL','SPY','NVDA','BTC-USD','ETH-USD']);
const info={'2330.TW':['台積電','stock','TWD'],'0050.TW':['元大台灣50','etf','TWD'],AAPL:['Apple','stock','USD'],SPY:['SPDR S&P 500 ETF','etf','USD'],NVDA:['NVIDIA','stock','USD'],'BTC-USD':['Bitcoin','crypto','USD'],'ETH-USD':['Ethereum','crypto','USD']};
const riskNotice='僅供教育模擬，非投資建議；AI 可能錯誤；做空有重大損失風險。無實際交易或帳戶功能。';
const prompt='You are an educational paper-trading analyst, not a broker. Read only supplied numerical daily-close observations. Decide long, short, or hold. If uncertain choose hold. Return ONLY one JSON object with EXACTLY three keys: action, reason, risk. Never include symbol or any extra keys. reason and risk MUST be nonempty Traditional Chinese sentences (10 to 60 characters each). No markdown or guarantees. Example format: {"action":"hold","reason":"近期價格波動較大，暫時觀望等待方向。","risk":"價格可能突然反轉，模擬結果不代表未來表現。"}. Your actual decision and explanation must reflect the supplied observations. Never output empty strings.';
export class DemoError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
export function createDemoCache(){return {market:new Map(),decisions:new Map()};}
const cache=createDemoCache();
function check(s){if(typeof s!=='string'||!DEMO_SYMBOLS.includes(s))throw new DemoError(400,'unsupported_symbol','僅支援固定商品清單');}
function ctx(d){return {fetch:d.fetch||globalThis.fetch.bind(globalThis),now:d.now||Date.now,cache:d.cache||cache,marketTimeoutMs:Math.min(4000,Math.max(1,d.marketTimeoutMs??4000)),aiTimeoutMs:d.aiTimeoutMs??15000};}
function put(m,k,v){if(!m.has(k)&&m.size>=64){const victim=[...m].find(([,v])=>!v.pending);if(!victim)throw new DemoError(503,'demo_busy','服務忙碌');m.delete(victim[0]);}m.set(k,v);}
async function deadline(work,ms,error,abort){let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>{abort?.();reject(error);},ms);})]);}finally{clearTimeout(timer);}}
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const time=(x,t)=>Number.isInteger(x)&&x>0&&x*1000<=t+60000;
const millitime=(x,t)=>Number.isInteger(x)&&x>0&&x<=t+60000;
function parse(d,s,url,fetchedAt){
 const row=d?.chart?.result?.[0],m=row?.meta;
 if(d?.chart?.error||!m||m.symbol!==s||m.currency!==info[s][2]||!positive(m.regularMarketPrice)||!time(m.regularMarketTime,fetchedAt))throw Error('quote');
 const ts=row.timestamp,cs=row.indicators?.quote?.[0]?.close;
 if(!Array.isArray(ts)||!Array.isArray(cs)||ts.length!==cs.length||ts.length>1000)throw Error('history');
 const history=[];for(let i=0;i<ts.length;i++){if(cs[i]===null)continue;if(!positive(cs[i])||!time(ts[i],fetchedAt)||(history.length&&ts[i]*1000<=history.at(-1).timestamp))throw Error('bar');history.push({timestamp:ts[i]*1000,close:cs[i]});}
 if(history.length<2)throw Error('history');const [name,assetClass,currency]=info[s];
 return {symbol:s,name,assetClass,currency,quote:{price:m.regularMarketPrice,timestamp:m.regularMarketTime*1000},history:history.slice(-60),historyInterval:'1d',source:{provider:'Yahoo Finance chart',url,fetchedAt,authorizedRealtime:false,delayNotice:'Yahoo Finance 公開 chart 資料可能延遲、休市或中斷；非授權即時行情，無即時性或可用性保證。請檢查 quote.timestamp。'},riskNotice};
}
// All URLs are constructed here from the fixed symbol allowlist; no proxy or arbitrary URL input.
async function upstream(url,c,json=true){const ac=new AbortController();return deadline(async()=>{const r=await c.fetch(url,{signal:ac.signal,redirect:'manual',headers:{Accept:json?'application/json':'text/csv'}});if(!r.ok||Number(r.headers.get('content-length'))>1000000)throw Error('upstream');const text=await r.text();if(text.length>1000000)throw Error('size');return json?JSON.parse(text):text;},c.marketTimeoutMs,Error('timeout'),()=>ac.abort());}
function market(s,history,quote,provider,url,c,notice){
 history.sort((a,b)=>a.timestamp-b.timestamp);history=history.filter((v,i)=>!i||v.timestamp!==history[i-1].timestamp);
 if(history.length<2||history.some(v=>!positive(v.close)||!millitime(v.timestamp,c.now()))||!positive(quote.price)||!millitime(quote.timestamp,c.now()))throw Error('observations');
 const [name,assetClass,currency]=info[s];return {symbol:s,name,assetClass,currency,quote,history:history.slice(-60),historyInterval:'1d',source:{provider,url:Array.isArray(url)?url[0]:url,...(Array.isArray(url)?{urls:url}:{}),fetchedAt:c.now(),authorizedRealtime:false,delayNotice:notice},riskNotice};
}
function dateStamp(y,m,d,hour){const t=Date.UTC(y,m-1,d,hour);const v=new Date(t);if(v.getUTCFullYear()!==y||v.getUTCMonth()!==m-1||v.getUTCDate()!==d)throw Error('date');return t;}
async function twse(s,c){
 const now=new Date(c.now()+8*3600000),months=[0,-1].map(offset=>new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+offset,1)));
 const urls=months.map(d=>`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}01&stockNo=${s.slice(0,4)}`);
 const results=await Promise.allSettled(urls.map(url=>upstream(url,c)));const history=[],used=[];
 for(let i=0;i<results.length;i++){const result=results[i];if(result.status!=='fulfilled')continue;const d=result.value;if(d?.stat!=='OK'||!Array.isArray(d.data)||d.data.length>100)continue;
  const fields=d.fields;if(!Array.isArray(fields))continue;const di=fields.indexOf('日期'),ci=fields.indexOf('收盤價');if(di<0||ci<0)continue;used.push(urls[i]);
  for(const row of d.data){const match=/^(\d{3,4})\/(\d{2})\/(\d{2})$/.exec(row[di]);if(!match)throw Error('date');const timestamp=dateStamp(Number(match[1])+1911,Number(match[2]),Number(match[3]),5)+30*60000;const close=Number(String(row[ci]).replaceAll(',',''));if(!positive(close))throw Error('close');history.push({timestamp,close});}
 }
 history.sort((a,b)=>a.timestamp-b.timestamp);const last=history.at(-1);if(!last)throw Error('history');return market(s,history,{price:last.close,timestamp:last.timestamp},'TWSE official STOCK_DAY',used,c,'TWSE 官方日收盤資料；非即時行情，可能延遲。quote.timestamp 為來源交易日台北時間 13:30 收盤，不是抓取時間。');
}
async function nasdaq(s,c){
 const day=t=>new Date(t).toISOString().slice(0,10),url=`https://api.nasdaq.com/api/quote/${s}/historical?assetclass=${s==='SPY'?'etf':'stocks'}&fromdate=${day(c.now()-60*86400000)}&todate=${day(c.now())}&limit=60`;
 const data=await upstream(url,c);if(data?.data?.symbol!==s||!Array.isArray(data.data.tradesTable?.rows)||data.data.tradesTable.rows.length>100)throw Error('history');const history=[];
 for(const row of data.data.tradesTable.rows){const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row.date);if(!match||!/^\$?[\d,]+(?:\.\d+)?$/.test(row.close))throw Error('bar');const y=Number(match[3]),m=Number(match[1]),d=Number(match[2]);let timestamp=dateStamp(y,m,d,20);const nyHour=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(timestamp));if(nyHour==='15')timestamp+=3600000;const close=Number(row.close.replace(/[$,]/g,''));if(!positive(close))throw Error('close');if(timestamp<=c.now())history.push({timestamp,close});}
 history.sort((a,b)=>a.timestamp-b.timestamp);const last=history.at(-1);if(!last)throw Error('history');return market(s,history,{price:last.close,timestamp:last.timestamp},'Nasdaq official historical',url,c,'Nasdaq 公開日線；quote 是最後交易日日收盤價、非即時行情，可能延遲。timestamp 為來源交易日紐約時間 16:00 標準收盤時間（非逐筆成交時間；提早收市日亦不代表精確成交時刻）。');
}
async function coinbase(s,c){
 const base=`https://api.exchange.coinbase.com/products/${s}`,url=base+'/candles?granularity=86400',tickerUrl=base+'/ticker';
 const [candles,ticker]=await Promise.allSettled([upstream(url,c),upstream(tickerUrl,c)]);if(candles.status!=='fulfilled'||!Array.isArray(candles.value)||candles.value.length>500)throw Error('candles');const history=[];
 for(const row of candles.value){if(!Array.isArray(row)||row.length<6||!time(row[0],c.now())||!positive(row[4]))throw Error('bar');if((row[0]+86400)*1000<=c.now())history.push({timestamp:row[0]*1000,close:row[4]});}
 history.sort((a,b)=>a.timestamp-b.timestamp);const last=history.at(-1);if(!last)throw Error('history');let quote={price:last.close,timestamp:last.timestamp+86400000},spot=false;
 if(ticker.status==='fulfilled'){const d=ticker.value,price=Number(d?.price),timestamp=Date.parse(d?.time);if(positive(price)&&millitime(timestamp,c.now())){quote={price,timestamp};spot=true;}}
 return market(s,history,quote,'Coinbase Exchange',spot?[url,tickerUrl]:url,c,spot?'Coinbase Exchange 公開 ticker 與 UTC 日線，非授權即時行情，可能延遲；quote.timestamp 是 ticker 實際成交時間，history.timestamp 是 UTC 日線起始時間。':'Coinbase Exchange 已完成 UTC 日線；ticker 不可用，quote 明示為最後完整日收盤、非即時行情；quote.timestamp 為該日線結束時間，history.timestamp 為日線起始時間。');
}
async function fetchMarket(s,c){try{return await (s.endsWith('.TW')?twse(s,c):s.endsWith('-USD')?coinbase(s,c):nasdaq(s,c));}catch(e){console.warn('demo-primary',s,String(e.message).slice(0,180));}
 const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=1mo`;try{return parse(await upstream(url,c),s,url,c.now());}catch{}
 throw new DemoError(503,'market_unavailable','真實行情不可用；未產生替代行情');}
export async function getDemoMarket(s,env={},deps={}){check(s);const c=ctx(deps),old=c.cache.market.get(s);if(old&&(old.pending||old.expiresAt>c.now()))return structuredClone(await old.promise);const e={pending:true,expiresAt:c.now()+60000};put(c.cache.market,s,e);e.promise=fetchMarket(s,c).finally(()=>{e.pending=false;e.expiresAt=c.now()+60000;});return structuredClone(await e.promise);}
function validate(result){let v=result?.response??result?.choices?.[0]?.message?.content;if(typeof v==='string'){if(v.length>4096)throw Error('size');v=JSON.parse(v);}if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='action,reason,risk'||!['long','short','hold'].includes(v.action))throw Error('schema');for(const k of ['reason','risk'])if(typeof v[k]!=='string'||!v[k].trim()||v[k].length>800||/[\u0000-\u001f\u007f<>]/u.test(v[k]))throw Error('text');return {action:v.action,reason:v.reason.trim(),risk:v.risk.trim()};}
// Only explicit decision requests run AI. Deduplication is per isolate, not global.
// Do not use unsupported JSON mode or silently substitute a different model.
export async function getDemoDecision(s,env={},deps={}){check(s);if(typeof env?.AI?.run!=='function')throw new DemoError(503,'ai_unavailable','Workers AI 尚未啟用；未產生決策');const c=ctx(deps),market=await getDemoMarket(s,env,deps),age=c.now()-market.quote.timestamp; if(age>(market.assetClass==='crypto'?2:120)*3600000)throw new DemoError(503,'stale_market','行情時間過舊，未呼叫 AI；請等待來源更新');const key=`${DEMO_MODEL}:${s}:${market.quote.timestamp}:${market.quote.price}`,old=c.cache.decisions.get(key);if(old){const v=structuredClone(await old.promise);return {...v,cache:{hit:true,scope:'worker-isolate',key}};}const e={pending:true};put(c.cache.decisions,key,e);e.promise=(async()=>{let result;try{result=await deadline(()=>env.AI.run(DEMO_MODEL,{messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify({symbol:market.symbol,currency:market.currency,quote:market.quote,historyInterval:market.historyInterval,history:market.history.slice(-20).map(p=>p.close),source:market.source.provider+'; '+market.source.delayNotice})}],max_tokens:350,temperature:0}),c.aiTimeoutMs,new DemoError(503,'ai_timeout','AI 逾時；未產生決策'));}catch(err){throw err instanceof DemoError?err:new DemoError(503,'ai_unavailable','真實 AI 模型不可用；未產生決策');}let decision;try{decision=validate(result);}catch{throw new DemoError(502,'invalid_ai_response','AI 回應驗證失敗；未產生可用決策');}return {market,decision,model:DEMO_MODEL,decidedAt:c.now(),riskNotice};})().finally(()=>{e.pending=false;});
// Retain failures for this timestamp: timed-out binding calls may still cost money.
 const v=structuredClone(await e.promise);return {...v,cache:{hit:false,scope:'worker-isolate',key}};}
