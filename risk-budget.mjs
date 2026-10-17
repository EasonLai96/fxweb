// Pure sizing math. Estimates are scenarios, never guaranteed loss caps.
import {feeFor,unrealizedPnl,LIQ_LOSS,isUsdBase} from './engine.mjs?v=20261017lab1';
const profiles={fx:[.00003,5e7,.00014,.06],etf:[.00008,8e6,.00028,.065],crypto:[.00025,1e6,.00065,.10]};
export function estimatedFriction(kind,notional,stress=true){const [spread,depth,impact]=profiles[kind]||profiles.fx;return Math.min(.0012,(spread+impact*Math.sqrt(notional/depth))*(stress?1.7:1));}
export function closeMidThreshold(pos,friction=0){const units=pos.units??(isUsdBase(pos.pair)?pos.notional:pos.notional/pos.entry);const fill=isUsdBase(pos.pair)?pos.entry/(1+pos.side*LIQ_LOSS*pos.margin/units):pos.entry-pos.side*LIQ_LOSS*pos.margin/units;return fill/(1-pos.side*friction);}
export function sizeRisk({pair,kind='fx',side,price,stop,leverage,netWorth,free,riskPct=1,hours=24,frictionEnabled=false}){
 if(![side,price,stop,leverage,netWorth,free,riskPct,hours].every(Number.isFinite)||![1,-1].includes(side)||price<=0||stop<=0||netWorth<=0||free<=0||riskPct<=0||riskPct>100||hours<0||leverage<=0)return {ok:false,error:'請輸入有效的風險比例、價格與持有時數'};
 if(side*(stop-price)>=0)return {ok:false,error:'做多止損須低於現價，做空止損須高於現價'};
 const budget=netWorth*riskPct/100;
 const calc=margin=>{const notional=margin*leverage;const friction=frictionEnabled?estimatedFriction(kind,notional):0;const entry=price*(1+side*friction);const pos={pair,side,notional,margin,entry,leverage};const fill=stop*(1-side*friction);const fee=feeFor(notional,leverage);const carry=frictionEnabled?Math.max(0,notional-margin)*(profiles[kind]||profiles.fx)[3]*hours/(365*24):0;const pnl=unrealizedPnl(pos,fill);const loss=Math.max(0,-pnl)+fee+carry;const gapPrice=stop*(1-side*.01);const gapLoss=Math.max(0,-unrealizedPnl(pos,gapPrice*(1-side*friction)))+fee+carry;return {margin,notional,fee,carry,loss,gapLoss,friction,threshold:closeMidThreshold(pos,friction),liquidatedBeforeStop:-pnl>=margin*LIQ_LOSS};};
 let lo=0,hi=free;for(let i=0;i<70;i++){const m=(lo+hi)/2,c=calc(m);if(c.loss<=budget&&m+c.fee<=free)lo=m;else hi=m;}const result=calc(Math.floor(lo*100)/100);return result.margin>=10?{ok:true,budget,...result}:{ok:false,error:'預算或可用餘額不足以投入最低 $10 保證金'};
}
