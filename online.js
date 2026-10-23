// みんなで遊ぶ（?room=〇〇 で開いたとき）。ゲームはサーバーが進める（rules.js と同じ決まり）。
//   この画面は、サーバーから 0.1 秒ごとに届く様子を描いて、押したことをサーバーに送るだけ
//   index.html の描く部品（draw・renderCtl・renderChant・renderClock など）と変数（st・me・phase・prev…）をそのまま使う
(function(){
'use strict';
const ROOM=new URLSearchParams(location.search).get('room');
const DR=window.DarumaRoom;
const myName=()=>{try{return localStorage.getItem('mataasobo-name')||''}catch(e){return ''}};
const saveName=v=>{try{localStorage.setItem('mataasobo-name',v)}catch(e){}};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ---------- 部屋を作る（ふつうに開いたとき） ----------
if(!ROOM){
  const b=$('roomBtn');if(b)b.onclick=async()=>{
    let name=myName();if(!name){name=(prompt('みんなに見せる名前（8文字まで）','')||'').trim().slice(0,8)||'ゲスト';saveName(name)}
    b.disabled=true;b.textContent='部屋を作っています…';
    try{const id=await DR.create(name);location.href=location.pathname+'?room='+id}
    catch(e){alert('部屋を作れませんでした。少し待ってから、もう一度どうぞ');b.disabled=false;b.textContent='みんなで遊ぶ（部屋を作る）'}
  };
  return;
}

// ---------- 部屋の中 ----------
window.DARUMA_ONLINE=true;
window.DarumaOnline={get RV(){return RV}};   // 確かめ用（部屋の様子を外から読む）
let RV=null,game=-1,myId=null,lastWant=-1;
const HUMAN_COL=['#e8743b','#ff6f9f','#43b2f5','#6cc94e'];
$('roomBtn').hidden=true;$('pauseBtn').remove();$('helpBtn').hidden=true;
document.title='だるまさんがころんだ（みんなで）';

DR.connect(ROOM,m=>{
  if(m.t==='open'){DR.send({t:'join',name:myName()||'ゲスト'});return}
  if(m.t==='close'){note('つなぎ直しています…');return}
  if(m.t==='err'){showMsg(m.msg,1800);if(m.room)apply(m.room,[]);return}
  if(m.t==='room')apply(m.room,m.ev||[]);
});

function apply(v,ev){
  RV=v;const playing=!['lobby','over'].includes(v.phase);
  role=v.you===0?'daruma':'kid';
  if(v.st)syncState(v);
  for(const e of ev)onEvent(e);
  if(v.phase!=='push'&&push&&gt-push.t0>(push.dur||0))push=null;   // 押し戻しの見せ方は、終わったら消す
  phase=v.phase==='lobby'?'setup':v.phase;
  $('ctlDaruma').hidden=!(playing&&v.you===0);$('pad').hidden=!(playing&&v.you>0);$('pad').classList.add('noDash');   // ダッシュは、まだサーバーの決まりに入れていない（ひとりで遊ぶ版で試している）
  $('endBtn').hidden=false;
  if(playing){$('over').hidden=true;note(v.phase==='prep'?(v.you===0?'ひと休み。準備ができたら「唱える」':'ひと休み。動けない'):'')}
  else renderRoomCard();
  renderCtl();renderChant();
}
// サーバーの様子を、描く部品が使う形（st）にする
function syncState(v){
  const s=v.st;
  if(!st||game!==v.game){
    game=v.game;myId=v.you>0?'h'+(v.you-1):null;
    let ci=0,hi=1;
    st={children:s.kids.map(k=>({...k,col:k.id===myId?null:(/^h/.test(k.id)?HUMAN_COL[hi++%4]:KID_COL[ci++%4])}))};
    prev=null;Object.keys(caughtAt).forEach(k=>delete caughtAt[k]);
  }
  prev=st.children.map(c=>c.pos);prevVel=st.children.map(c=>c.vel);prevAt=gt;
  s.kids.forEach((k,i)=>Object.assign(st.children[i],k,{human:k.id===myId,caughtNow:k.caught}));
  me=st.children.find(c=>c.id===myId)||null;
  Object.assign(st,{chantProgress:s.cp,elapsedTicks:s.el,stamina:s.stamina,staminaMax:s.staminaMax,reward:s.reward,tempoValue:s.tempo,cycle:s.cycle,catches:s.catches,
    type:P.DARUMA_TYPES[s.type]||P.DARUMA_TYPES.normal,turnArmed:s.turnArmed,nextReward:s.nextReward||null,looking:!!s.look,look:s.look||st.look});
  P.GOAL_TICKS=s.goal;
}
function onEvent(e){
  const n=e.syl;if(n){if(n<10)beep(520+n*18,0.06);else beep(330,0.18)}
  if(e.cue)beep(260,0.5,'sine');
  if(e.look){faceAt=gt}
  if(e.caught){caughtAt[e.caught]=gt;beep(150,0.25,'sawtooth');
    if(e.caught===myId)showMsg('見つかった！',2200,e.pressing?'まだ押していた':`あと${Math.max(0.1,e.late).toFixed(1)}秒早く離せば止まれた`)}
  if(e.pushed){const names=e.pushed.map(id=>(st.children.find(c=>c.id===id)||{}).name).filter(Boolean);
    if(!e.pushed.length)showMsg('セーフ…みんな止まってた',1000);else if(!e.pushed.includes(myId))showMsg((role==='kid'?'セーフ！ ':'見つけた！ ')+names.join('・'),1200);
    push={from:e.from,to:st.children.map(c=>c.pos),t0:gt,dur:e.pushed.length?700:0};}
  if(e.carry)showMsg(role==='daruma'?(e.auto?'気力が足りない…見送り':'見送り！'):'だるまが\n見送り！',e.auto?1100:800);
  if(e.outOfGas&&role==='daruma')showMsg('気力切れ！',1400,'テンポが半分に落ちた');
  if(e.over&&RV&&RV.winner){const w=RV.winner;beep(880,0.15);}
}
// 集まっているとき・終わったときのカード
function renderRoomCard(){
  const v=RV,url=location.origin+location.pathname+'?room='+v.id,w=v.winner;
  $('over').hidden=false;$('roles').hidden=true;$('types').hidden=true;$('fb').hidden=true;
  let head='みんなで遊ぶ',sub='リンクを送って、友だちを呼ぼう。空いた席には CPU が入ります。';
  if(v.phase==='over'&&w){const mine=w.side==='kids'?v.you>0:v.you===0;
    head=w.side==='kids'?(w.id===myId?'タッチ！あなたの勝ち':`${esc(w.name)}がタッチ！子どもの勝ち`):'時間切れ…だるまの勝ち';
    sub=(mine?'やった！ ':'')+`これまで だるま ${v.wins[0]}勝・子ども ${v.wins[1]}勝`;}
  $('overH').textContent=head;$('overP').textContent=sub;
  const seat=(s,i)=>{const label=i===0?'だるま':'子ども'+i,mine=v.you===i;
    return `<div class="rseat${mine?' mine':''}"><b>${label}</b><span>${s.empty?'CPU':esc(s.name)+(s.online?'':'（るす）')}</span>${s.empty&&v.you>=0?`<button class="pill" data-seat="${i}" type="button">ここに座る</button>`:''}</div>`};
  $('roomCard').hidden=false;
  $('roomCard').innerHTML=`<div class="rseats">${v.seats.map(seat).join('')}</div>
    <div class="rinv"><input id="rUrl" readonly value="${esc(url)}"><button class="pill" id="rCopy" type="button">コピー</button>
    <a class="pill" href="https://line.me/R/share?text=${encodeURIComponent('だるまさんがころんだで遊ぼ！ '+url)}" target="_blank" rel="noopener">LINE</a>${navigator.share?'<button class="pill" id="rShare" type="button">送る</button>':''}</div>
    <label class="rname">あなたの名前 <input id="rName" maxlength="8" value="${esc(myName())}"></label>`;
  $('roomCard').querySelectorAll('[data-seat]').forEach(b=>b.onclick=()=>DR.send({t:'seat',i:+b.dataset.seat}));
  $('rCopy').onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText(url).then(()=>showMsg('コピーしました',900))};
  const sh=$('rShare');if(sh)sh.onclick=()=>navigator.share({title:'だるまさんがころんだ',text:'だるまさんがころんだで遊ぼ！',url}).catch(()=>{});
  $('rName').onchange=()=>{const n=$('rName').value.trim().slice(0,8)||'ゲスト';saveName(n);DR.send({t:'join',name:n})};
  const sb=$('startBtn');sb.hidden=!v.host;sb.textContent=v.phase==='over'?'もう一回':'はじめる';
  sb.onclick=()=>DR.send({t:v.phase==='over'?'again':'start'});
  $('waitHost').hidden=v.host;
}

// ---------- 押したことをサーバーに送る ----------
$('go').onclick=()=>{if(phase==='prep'&&role==='daruma'){ac();DR.send({t:'go'})}};
$('arm').onclick=()=>{if(st&&role==='daruma')DR.send({t:'arm',on:!st.turnArmed})};
$('tempo').oninput=()=>{if(st&&role==='daruma')DR.send({t:'tempo',v:+$('tempo').value})};
window.sendAura=r=>DR.send({t:'aura',r});
$('endBtn').onclick=()=>{if(confirm('部屋を出ますか？（遊んでいる途中なら、あなたの席は CPU になります）')){DR.send({t:'leave'});setTimeout(()=>{location.href=location.pathname},200)}};
// 子ども：押している場所の速さを、変わったときだけ送る
(function loop(){
  if(RV&&RV.you>0&&!['lobby','over'].includes(RV.phase)){const v=pressed?want:0;if(Math.abs(v-lastWant)>0.01){lastWant=v;DR.send({t:'want',v:+v.toFixed(2)})}}
  requestAnimationFrame(loop);
})();
})();
