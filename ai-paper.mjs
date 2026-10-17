// Isolated educational account. No game storage and no broker API.
export const PAPER_FEE=.001;
export function freshPaper(){return {version:1,wallets:{TWD:100000,USD:10000},positions:[],log:[],used:[]};}
export function freshQuote(m,now=Date.now()){return m&&Number.isFinite(m.quote?.price)&&m.quote.price>0&&Number.isFinite(m.quote.timestamp)&&m.quote.timestamp<=now+60000&&now-m.quote.timestamp<=(m.assetClass==='crypto'?2:120)*3600000;}
export function applyDecision(s,analysis,market,now=Date.now()){
 if(!analysis||!['long','short','hold'].includes(analysis.decision?.action))throw Error('尚無有效 AI 決策');
 if(analysis.market.symbol!==market?.symbol||analysis.market.quote.timestamp!==market.quote.timestamp||analysis.market.quote.price!==market.quote.price||!freshQuote(market,now))throw Error('報價已變動或過舊，請重新取得 AI 分析');
 const key=analysis.market.symbol+':'+analysis.market.quote.timestamp+':'+analysis.decidedAt;
 if(s.used.includes(key))throw Error('這次分析已執行，不會重複開倉');
 const action=analysis.decision.action;if(action==='hold'){s.used.push(key);s.used=s.used.slice(-300);s.log.push({time:now,symbol:market.symbol,action:'hold',note:'AI 觀望，不開倉'});s.log=s.log.slice(-100);return;}
 if(s.positions.some(p=>p.symbol===market.symbol))throw Error('此商品已有模擬持倉，請先平倉');
 const c=market.currency;if(!['TWD','USD'].includes(c))throw Error('不支援的計價幣別');const cash=s.wallets[c],margin=Math.floor(cash*.1*100)/100,fee=margin*PAPER_FEE;if(margin<1||margin+fee>cash)throw Error('模擬現金不足');
 s.wallets[c]-=margin+fee;s.positions.push({id:key,symbol:market.symbol,name:market.name,currency:c,side:action==='long'?1:-1,entry:market.quote.price,margin,units:margin/market.quote.price,fee,openedAt:now,quoteTime:market.quote.timestamp});s.used.push(key);s.used=s.used.slice(-300);s.log.push({time:now,symbol:market.symbol,action,fee,currency:c});s.log=s.log.slice(-100);
}
export function closePaper(s,id,market,now=Date.now()){
 const p=s.positions.find(p=>p.id===id);if(!p||p.symbol!==market?.symbol||!freshQuote(market,now))throw Error('沒有此商品的有效報價，無法平倉');const gross=p.side*(market.quote.price-p.entry)*p.units,fee=p.units*market.quote.price*PAPER_FEE;s.wallets[p.currency]+=p.margin+gross-fee;s.positions=s.positions.filter(x=>x!==p);s.log.push({time:now,symbol:p.symbol,action:'close',net:gross-p.fee-fee,currency:p.currency});s.log=s.log.slice(-100);
}
