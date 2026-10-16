/* Standalone UI; parent owns API, consent, authorization, public filtering and score computation.
 * request('list') -> {leaderboard:{season,endsAt,updatedAt,entries:[{rank,nickname,returnPct,equity,closedTrades,resetCount,scoreUpdatedAt}],myEntry?,note?}}
 * request('me') -> {optIn:boolean,nickname:string|null,myEntry:Entry|null}; request('join',{nickname}) / request('leave') return same.
 * returnPct is fractional (+0.12 = +12%); times ISO 8601. Failed calls reject Error.
 * list must work anonymously; public rows MUST exclude username, token, account identifiers and credentials.
 * leave must remove the entry server-side before the next public list response. Server must enforce
 * nickname length (1–16 Unicode characters), eligibility, tie breaks and opt-in. No fraud-proof claim.
 * getContext() -> {mode:'guest'|'server',username?:string|null}; onToast(message,bad?).
 */
const el=(tag,cls='',text)=>{const n=document.createElement(tag);n.className=cls;if(text!=null)n.textContent=String(text);return n};
const btn=(text,fn,cls='')=>{const n=el('button',`fx-leader-button ${cls}`,text);n.type='button';n.addEventListener('click',fn);return n};
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const date=x=>{const n=x?new Date(x).getTime():NaN;return Number.isFinite(n)?new Date(n).toLocaleString('zh-TW',{hour12:false}):'未提供'};
const pct=x=>finite(x)?`${x>=0?'+':''}${(x*100).toFixed(2)}%`:'—';
const money=x=>{if(!finite(x))return'—';const a=Math.abs(x),s=x<0?'-':'';if(a>=1e20)return`${s}$${a.toExponential(2).replace('e+','e')}`;for(const[n,u]of[[1e16,'京'],[1e12,'兆'],[1e8,'億']])if(a>=n)return`${s}$${(a/n).toLocaleString('en-US',{maximumFractionDigits:2})} ${u}`;return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(x)};
const count=x=>Number.isInteger(x)&&x>=0?x.toLocaleString('zh-TW'):'—';
export function initLeaderboard({request,onToast=()=>{},getContext}={}){
  if(typeof request!=='function'||typeof getContext!=='function')throw new TypeError('排行榜需要 request 與 getContext');
  if(document.getElementById('fx-leader-dialog'))return {update(){}};
  if(!document.querySelector('link[data-fx-leaderboard]')){const link=el('link');link.rel='stylesheet';link.href=new URL('./leaderboard-ui.css',import.meta.url).href;link.dataset.fxLeaderboard='1';document.head.append(link)}
  const ctx=()=>getContext()||{}, identity=()=>`${ctx().mode}\u0000${ctx().username||''}`, signed=()=>ctx().mode==='server'&&!!ctx().username;
  const toolbar=document.querySelector('#fx-extras .fx-extra-toolbar');
  const launch=btn('排行',open,'fx-leader-launcher');launch.setAttribute('aria-haspopup','dialog');
  if(toolbar)toolbar.append(launch);
  else{const nav=el('nav','fx-leader-strip');nav.setAttribute('aria-label','排行榜');nav.append(launch);const main=document.querySelector('main');if(main)main.before(nav);else document.body.append(nav)}
  const dialog=el('dialog','fx-leader-dialog');dialog.id='fx-leader-dialog';dialog.setAttribute('aria-labelledby','fx-leader-title');
  const head=el('div','fx-leader-heading'),title=el('h2','','虛構行情排行榜');title.id='fx-leader-title';title.tabIndex=-1;
  head.append(title,btn('關閉',()=>close()));const body=el('div','fx-leader-body');dialog.append(head,body);document.body.append(dialog);
  let opener=null,epoch=0,who=identity(),board=null,me=null,loading=false,saving=false,error='',past=null,prevId=null;
  const otherOverlay=()=>[...document.querySelectorAll('[role="dialog"],dialog')].some(n=>n!==dialog&&!dialog.contains(n)&&!n.closest('[hidden],.hidden')&&(n.tagName!=='DIALOG'||n.open)&&n.getClientRects().length>0);
  function close(restore=true){if(!dialog.open)return;epoch++;dialog.close();if(restore&&!otherOverlay())(opener?.isConnected?opener:launch).focus({preventScroll:true})}
  dialog.addEventListener('cancel',e=>{e.preventDefault();close()});
  dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()});
  dialog.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const a=[...dialog.querySelectorAll('button,input')].filter(n=>!n.disabled&&n.getClientRects().length);if(e.shiftKey&&(document.activeElement===a[0]||document.activeElement===title)){e.preventDefault();a.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===a.at(-1)){e.preventDefault();a[0]?.focus()}});
  const valid=(ticket,id)=>dialog.open&&epoch===ticket&&identity()===id;
  function open(){if(otherOverlay()){onToast('請先完成或關閉目前的視窗。');return}opener=document.activeElement;dialog.showModal();who=identity();board=null;me=null;error='';past=null;render();reload();title.focus({preventScroll:true})}
  async function reload(){const ticket=++epoch,id=identity();loading=true;error='';render();
    try{const settled=await Promise.allSettled([request('list',past?{season:past}:undefined),signed()&&!past?request('me'):Promise.resolve(me)]);
      if(!valid(ticket,id))return;if(settled[0].status==='rejected')throw settled[0].reason;
      const value=settled[0].value?.leaderboard;if(!value||!Array.isArray(value.entries))throw new Error('排行榜資料格式不正確');
      board=value;if(!past&&typeof value.previousSeason==='string')prevId=value.previousSeason;const personal=settled[1].status==='fulfilled'?settled[1].value:null;me=personal&&typeof personal.optIn==='boolean'?personal:null;
    }catch(ex){if(valid(ticket,id))error=ex instanceof Error?ex.message:'暫時無法載入排行榜'}finally{if(valid(ticket,id)){loading=false;render()}}}
  async function mutate(action,nickname){if(!signed()||saving)return;const ticket=++epoch,id=identity();saving=true;error='';render();
    try{const result=await request(action,action==='join'?{nickname}:undefined);if(!valid(ticket,id))return;
      if(!result||typeof result.optIn!=='boolean'||result.optIn!==(action==='join'))throw new Error('參賽設定回應格式不正確');
      me=result;board=null;loading=true;render();const fresh=(await request('list'))?.leaderboard;
      if(!valid(ticket,id))return;if(!fresh||!Array.isArray(fresh.entries))throw new Error('排行榜資料格式不正確');
      board=fresh;onToast(action==='leave'?'已退出本季排行榜，公開列表已更新。':'已自願加入排行榜。');
    }catch(ex){if(valid(ticket,id)){board=null;error=ex instanceof Error?ex.message:'設定失敗，請稍後重試';onToast(error,true)}}finally{if(valid(ticket,id)){saving=false;loading=false;render()}}}
  function personal(){if(!signed())return el('p','fx-leader-callout','訪客可匿名查看公開排行；登入後可自願加入，不會自動公開帳號名稱。');
    if(!me)return el('p','fx-leader-callout',loading?'正在讀取你的參賽設定…':'尚未確認參賽設定，請重新整理。');
    const section=el('section','fx-leader-participant');section.append(el('h3','','我的參賽設定'));
    if(me.optIn){section.append(el('p','',`已加入：${me.nickname||'未提供暱稱'}（不顯示登入帳號）`));const leave=btn('退出排行',()=>mutate('leave'),'fx-leader-danger');leave.disabled=saving||loading;section.append(leave)}
    else if(me.status==='withdrawn'){section.append(el('p','','本季已退出或已重置，不能再次加入；下一季可重新報名。'));}
    else{section.append(el('p','','預設不參賽。加入前須自願重置為全新 $10,000 回合，清除現有持倉與交易紀錄。公開列表只顯示自選暱稱與統計數字。'));
      const form=el('form','fx-leader-join'),label=el('label','','公開暱稱（1–16 字）'),input=el('input'),submit=btn('自願加入',()=>{},'fx-leader-primary');
      input.id='fx-leader-nickname';input.name='nickname';input.autocomplete='off';input.maxLength=32;input.placeholder='請輸入自選暱稱';label.htmlFor=input.id;submit.type='submit';submit.disabled=saving||loading;
      input.addEventListener('input',()=>input.setCustomValidity(''));
      form.addEventListener('submit',e=>{e.preventDefault();const nickname=input.value.trim();if(!nickname||Array.from(nickname).length>16){input.setCustomValidity('暱稱需為 1–16 字');input.reportValidity();return}input.setCustomValidity('');mutate('join',nickname)});
      form.append(label,input,submit);section.append(form)}return section}
  function render(){if(!dialog.open)return;body.replaceChildren();body.append(el('p','fx-leader-intro','僅為虛構行情練習競賽，不是真實交易或投資成績。排行受伺服器賽季、資格與排序規則限制；不保證能杜絕所有不公平行為。'));
    const controls=el('div','fx-leader-controls'),refresh=btn('重新整理',reload);refresh.disabled=loading||saving;controls.append(refresh);
    if(past||prevId){const sw=btn(past?'回到本季':`上季排行（${prevId}）`,()=>{past=past?null:prevId;board=null;reload()});sw.disabled=loading||saving;controls.append(sw)}body.append(controls);
    if(loading){const p=el('p','fx-leader-state','正在載入公開排行榜…');p.setAttribute('role','status');body.append(p)}
    if(error){const p=el('p','fx-leader-state fx-leader-error',`載入或設定失敗：${error}。請重新整理再試。`);p.setAttribute('role','alert');body.append(p)}
    if(board){body.append(el('h3','fx-leader-season',`賽季：${typeof board.season==='string'?board.season:'未提供'}`));body.append(el('p','fx-leader-time',board.archived?`已封存的最終排名 · 封存時間：${date(board.updatedAt)}`:`開始：${date(board.startsAt)} · 結束：${date(board.endsAt)} · 列表更新：${date(board.updatedAt)}`));
      const stamp=board.updatedAt?new Date(board.updatedAt).getTime():NaN;
      if(!board.archived&&(!Number.isFinite(stamp)||Date.now()-stamp>120000||navigator.onLine===false))body.append(el('p','fx-leader-lag','資料可能滯後：排行不是即時行情或即時帳戶權益，請以列表更新時間為準。'));
      if(typeof board.note==='string'&&board.note.trim())body.append(el('p','fx-leader-note',board.note));
      if(!board.entries.length)body.append(el('p','fx-leader-state',board.archived?'這個賽季沒有封存的排名。':'這個賽季還沒有參賽者，歡迎稍後再來看看。'));
      else{const list=el('ol','fx-leader-list');for(const entry of board.entries){const row=el('li','fx-leader-row'),person=el('div','fx-leader-person'),metric=el('div','fx-leader-metric');
        // Field allowlist and textContent only: never output username, token or arbitrary fields.
        person.append(el('strong','fx-leader-rank',Number.isInteger(entry.rank)&&entry.rank>0?`#${entry.rank}`:'—'),el('span','fx-leader-name',typeof entry.nickname==='string'?entry.nickname:'匿名參賽者'));
        metric.append(el('strong',finite(entry.returnPct)?entry.returnPct>0?'fx-leader-up':entry.returnPct<0?'fx-leader-down':'':'',pct(entry.returnPct)),el('small','',`權益 ${money(entry.equity)}`));
        row.append(person,metric,el('small','fx-leader-detail',`平倉 ${count(entry.closedTrades)} · 重置 ${count(entry.resetCount)} · 成績 ${date(entry.scoreUpdatedAt)}`));list.append(row)}body.append(list)}}
    if(!past)body.append(personal());body.append(el('p','fx-leader-foot','只公開暱稱、排名與練習統計；退出後伺服器必須立即從公開列表移除。請勿在暱稱填入個資。'))}
  function update(){const id=identity();if(id!==who){who=id;epoch++;board=null;me=null;loading=false;saving=false;error='';if(dialog.open)reload()}if(dialog.open&&otherOverlay())close(false)}
  const observer=new MutationObserver(()=>{if(dialog.open&&otherOverlay())close(false)});observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','hidden','open']});
  return {update}
}
