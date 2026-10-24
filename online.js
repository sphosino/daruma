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
    let name=myName();if(!name){name=(prompt(L('みんなに見せる名前（8文字まで）','Your name for other players (up to 8 characters)'),'')||'').trim().slice(0,8)||L('ゲスト','Guest');saveName(name)}
    b.disabled=true;b.textContent=L('部屋を作っています…','Making a room…');
    try{const id=await DR.create(name);location.href=location.pathname+'?room='+id}
    catch(e){alert(L('部屋を作れませんでした。少し待ってから、もう一度どうぞ',"Couldn't make a room. Please wait a moment and try again"));b.disabled=false;b.textContent=L('みんなで遊ぶ（部屋を作る）','Play with friends (make a room)')}
  };
  return;
}

// ---------- 部屋の中 ----------
window.DARUMA_ONLINE=true;
window.DarumaOnline={get RV(){return RV}};   // 確かめ用（部屋の様子を外から読む）
let RV=null,game=-1,myId=null,lastWant=-1,lastBoost=false,prepEnd=null,prepS=-1;
const HUMAN_COL=['#e8743b','#ff6f9f','#43b2f5','#6cc94e'];
$('roomBtn').hidden=true;$('pauseBtn').remove();$('helpBtn').hidden=true;
document.title=L('だるまさんがころんだ（みんなで）','Red Light, Green Light (with friends)');
// サーバーからのお知らせは日本語で届くので、英語のときはここで置きかえる
const ERR_EN={'もう始まっています。終わるまで待ってね':'The game has already started. Please wait until it ends','満員です':'The room is full','まだ部屋に入っていません':"You haven't joined the room yet",'いまは席を移れません':"You can't change seats right now",'その席はありません':"That seat doesn't exist",'その席にはもう人がいます':'Someone is already in that seat','部屋に入っていません':"You're not in the room",'部屋を作った人だけが始められます':'Only the host can start','もう始まっています':'Already started','いまは唱えられません':"You can't chant right now"};

DR.connect(ROOM,m=>{
  if(m.t==='open'){DR.send({t:'join',name:myName()||L('ゲスト','Guest')});return}
  if(m.t==='close'){note(L('つなぎ直しています…','Reconnecting…'));return}
  if(m.t==='err'){showMsg(EN&&ERR_EN[m.msg]||m.msg,1800);if(m.room)apply(m.room,[]);return}
  if(m.t==='room')apply(m.room,m.ev||[]);
});

function apply(v,ev){
  RV=v;const playing=!['lobby','over'].includes(v.phase);
  role=v.you===0?'daruma':'kid';
  if(v.st)syncState(v);
  for(const e of ev)onEvent(e);
  if(v.phase!=='push'&&push&&gt-push.t0>(push.dur||0))push=null;   // 押し戻しの見せ方は、終わったら消す
  phase=v.phase==='lobby'?'setup':v.phase;
  $('ctlDaruma').hidden=!(playing&&v.you===0);$('pad').hidden=!(playing&&v.you>0);
  $('endBtn').hidden=false;
  // だるまの準備は30秒まで（過ぎたらサーバーが自動で唱え始める）。残りの秒は下の loop で数える
  prepEnd=v.phase==='prep'&&v.prepLeft!=null?performance.now()+v.prepLeft:null;prepS=-1;
  if(playing){$('over').hidden=true;note(v.phase==='prep'?prepNote(v.prepLeft):'')}
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
    if(e.caught===myId)showMsg(L('見つかった！','Caught!'),2200)}
  if(e.pushed){const names=e.pushed.map(id=>st.children.find(c=>c.id===id)).filter(Boolean).map(nm);
    if(!e.pushed.length)showMsg(L('セーフ…みんな止まってた','Safe… everyone stopped'),1000);else if(!e.pushed.includes(myId))showMsg((role==='kid'?L('セーフ！ ','Safe! '):L('見つけた！ ','Got you! '))+names.join(L('・',', ')),1200);
    push={from:e.from,to:st.children.map(c=>c.pos),t0:gt,dur:e.pushed.length?700:0};}
  if(e.carry&&role==='daruma')showMsg(e.auto?L('気力が足りない…見送り','Not enough spirit… passed'):L('見送り！','Passed!'),e.auto?1100:800);
  if(e.outOfGas&&role==='daruma')showMsg(L('気力切れ！','Out of spirit!'),1400,L('テンポが半分に落ちた','Tempo dropped by half'));
  if(e.over&&RV&&RV.winner){const w=RV.winner;beep(880,0.15);}
}
// 集まっているとき・終わったときのカード
function renderRoomCard(){
  const v=RV,url=location.origin+location.pathname+'?room='+v.id,w=v.winner;
  $('over').hidden=false;$('roles').hidden=true;$('types').hidden=true;$('fb').hidden=true;$('shareBtn').hidden=true;
  let head=L('みんなで遊ぶ','Play with friends'),sub=L('リンクを送って、友だちを呼ぼう。空いた席には CPU が入ります。','Send the link to invite friends. Empty seats are filled by the CPU.');
  if(v.phase==='over'&&w){const mine=w.side==='kids'?v.you>0:v.you===0,wn=EN&&KID_EN[w.id]||w.name;
    head=w.side==='kids'?(w.id===myId?L('タッチ！あなたの勝ち','Touch! You win'):L(`${wn}がタッチ！子どもの勝ち`,`${wn} touched it! The runners win`)):L('時間切れ…だるまの勝ち',"Time's up… the Daruma wins");
    sub=(mine?L('やった！ ','Nice! '):'')+L(`これまで だるま ${v.wins[0]}勝・子ども ${v.wins[1]}勝`,`So far: Daruma ${v.wins[0]} · Runners ${v.wins[1]}`);}
  $('overH').textContent=head;$('overP').textContent=sub;
  const seat=(s,i)=>{const label=i===0?L('だるま','Daruma'):L('子ども','Runner ')+i,mine=v.you===i;
    return `<div class="rseat${mine?' mine':''}"><b>${label}</b><span>${s.empty?'CPU':esc(s.name)+(s.online?'':L('（るす）',' (away)'))}</span>${s.empty&&v.you>=0?`<button class="pill" data-seat="${i}" type="button">${L('ここに座る','Sit here')}</button>`:''}</div>`};
  $('roomCard').hidden=false;
  $('roomCard').innerHTML=`<div class="rseats">${v.seats.map(seat).join('')}</div>
    <div class="rinv"><input id="rUrl" readonly value="${esc(url)}"><button class="pill" id="rCopy" type="button">${L('コピー','Copy')}</button>
    ${EN?'':`<a class="pill" href="https://line.me/R/share?text=${encodeURIComponent('だるまさんがころんだで遊ぼ！ '+url)}" target="_blank" rel="noopener">LINE</a>`}${navigator.share?`<button class="pill" id="rShare" type="button">${L('送る','Share')}</button>`:''}</div>
    <label class="rname">${L('あなたの名前','Your name')} <input id="rName" maxlength="8" value="${esc(myName())}"></label>`;
  $('roomCard').querySelectorAll('[data-seat]').forEach(b=>b.onclick=()=>DR.send({t:'seat',i:+b.dataset.seat}));
  $('rCopy').onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText(url).then(()=>showMsg(L('コピーしました','Copied'),900))};
  const sh=$('rShare');if(sh)sh.onclick=()=>navigator.share({title:L('だるまさんがころんだ','Red Light, Green Light'),text:L('だるまさんがころんだで遊ぼ！',"Let's play Red Light, Green Light!"),url}).catch(()=>{});
  $('rName').onchange=()=>{const n=$('rName').value.trim().slice(0,8)||L('ゲスト','Guest');saveName(n);DR.send({t:'join',name:n})};
  const sb=$('startBtn');sb.hidden=!v.host;sb.textContent=v.phase==='over'?L('もう一回','Play again'):L('はじめる','Start');
  sb.onclick=()=>DR.send({t:v.phase==='over'?'again':'start'});
  $('waitHost').hidden=v.host;
}

// ---------- 押したことをサーバーに送る ----------
$('go').onclick=()=>{if(phase==='prep'&&role==='daruma'){ac();DR.send({t:'go'})}};
$('arm').onclick=()=>{if(st&&role==='daruma')DR.send({t:'arm',on:!st.turnArmed})};
$('tempo').oninput=()=>{if(st&&role==='daruma')DR.send({t:'tempo',v:+$('tempo').value})};
window.sendAura=r=>DR.send({t:'aura',r});
$('endBtn').onclick=()=>{if(confirm(L('部屋を出ますか？（遊んでいる途中なら、あなたの席は CPU になります）','Leave the room? (If a game is in progress, the CPU takes your seat)'))){DR.send({t:'leave'});setTimeout(()=>{location.href=location.pathname},200)}};
function prepNote(ms){const n=ms!=null?Math.max(0,Math.ceil(ms/1000)):null;const s=n!=null?L(`　あと${n}秒`,` · ${n}s left`):'';return role==='daruma'?L('「唱える」を押そう','Press "Chant"')+s:L('だるまの準備中','The Daruma is getting ready')+s}
// 子ども：押している場所の速さとダッシュ（パッドの上半分）を、変わったときだけ送る
(function loop(){
  if(prepEnd&&phase==='prep'){const left=prepEnd-performance.now(),sec=Math.max(0,Math.ceil(left/1000));if(sec!==prepS){prepS=sec;note(prepNote(left))}}
  if(RV&&RV.you>0&&!['lobby','over'].includes(RV.phase)){const v=pressed?want:0;if(Math.abs(v-lastWant)>0.01||boost!==lastBoost){lastWant=v;lastBoost=boost;DR.send({t:'want',v:+v.toFixed(2),b:boost})}}
  requestAnimationFrame(loop);
})();
})();
