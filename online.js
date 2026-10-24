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
  // 2026-10-25：「みんなで遊ぶ」を押すと、まず部屋の一覧（人がいる部屋）。入るか、新しく作るかを選ぶ（前は押したとたんに部屋ができていた）
  const b=$('roomBtn');if(!b)return;
  const box=document.createElement('div');box.className='rlist';box.hidden=true;b.after(box);
  const make=async(btn)=>{
    let name=myName();if(!name){name=(prompt(L('みんなに見せる名前（8文字まで）','Your name for other players (up to 8 characters)'),'')||'').trim().slice(0,8)||L('ゲスト','Guest');saveName(name)}
    btn.disabled=true;btn.textContent=L('部屋を作っています…','Making a room…');
    // 作ったら、そのままゲーム画面へ（2026-10-25）：選んでいた役とだるまの種類で、CPU とすぐ遊び始める。遊びながら人を待つ
    try{const id=await DR.create(name);try{sessionStorage.setItem('dk-go',JSON.stringify({id,role,type:pickedType}))}catch(e){}location.href=location.pathname+'?room='+id}
    catch(e){alert(L('部屋を作れませんでした。少し待ってから、もう一度どうぞ',"Couldn't make a room. Please wait a moment and try again"));btn.disabled=false;btn.textContent=L('新しく部屋を作る','Make a new room')}
  };
  let rooms=null;
  const draw=()=>{
    const list=rooms==null?`<p class="rnone">${L('部屋を探しています…','Looking for rooms…')}</p>`:rooms.length?rooms.map(r=>{
      const people=r.seats.filter(x=>x&&x.online),host=(people[0]||{}).name||'';
      const st=r.phase==='lobby'?L('人を待っています','Waiting for players'):r.phase==='over'?L('ひと休み中','Between rounds'):L('遊んでいます（終わったら入れます）','Playing (join after this round)');
      return `<a class="rrow" href="?room=${encodeURIComponent(r.id)}"><b>${esc(host)}${L('の部屋',"'s room")}</b><span>${EN?people.length+(people.length===1?' player':' players'):people.length+'人'} ・ ${st}</span></a>`}).join('')
      :`<p class="rnone">${L('いま開いている部屋はありません。作って待ってみよう','No open rooms right now. Make one and wait for others')}</p>`;
    box.innerHTML=`<p class="rlistH">${L('入れる部屋','Rooms you can join')}</p>${list}<button class="pill rmake" type="button">${L('新しく部屋を作る','Make a new room')}</button>`;
    box.querySelector('.rmake').onclick=e=>make(e.currentTarget);
  };
  const fill=async()=>{if(box.hidden||phase!=='setup')return;try{const r=await fetch(DR.API+'/rooms?kind=daruma');rooms=(await r.json()).rooms||[]}catch(e){rooms=rooms||[]}if(!box.hidden)draw()};
  b.onclick=()=>{box.hidden=!box.hidden;b.classList.toggle('on',!box.hidden);if(!box.hidden){draw();fill()}};
  setInterval(fill,10000);
  return;
}

// ---------- 部屋の中 ----------
window.DARUMA_ONLINE=true;
window.DarumaOnline={get RV(){return RV}};   // 確かめ用（部屋の様子を外から読む）
let RV=null,game=-1,myId=null,lastWant=-1,lastBoost=false,prepEnd=null,prepS=-1;
const HUMAN_COL=['#e8743b','#ff6f9f','#43b2f5','#6cc94e'];
$('roomBtn').hidden=true;$('pauseBtn').remove();$('helpBtn').hidden=true;
const badge=document.createElement('span');badge.id='roomBadge';badge.className='rbadge';document.querySelector('header').prepend(badge);
// 定型文（2026-10-25）：💬 で言葉を選んで送る。届いた言葉は上に吹き出しで数秒出る。自由に書けるチャットはなし（荒らし対策）
const SAY={hi:['よろしく！','Hi!'],ready:['準備OK押して！','Press Ready!'],wait:['ちょっと待って','One sec'],go:['はじめよう！',"Let's go!"],nice:['ナイス！','Nice!'],
  close:['おしい！','So close!'],again:['もう一回！','Again!'],lol:['ｗｗｗ','LOL'],thx:['ありがとう！','Thanks!'],bye:['またね','Bye!']};
const sayBtn=document.createElement('button');sayBtn.type='button';sayBtn.className='pill';sayBtn.id='sayBtn';sayBtn.textContent='💬';sayBtn.setAttribute('aria-label',L('ひとこと送る','Send a message'));
$('endBtn').before(sayBtn);
const sayBox=document.createElement('div');sayBox.className='sayBox';sayBox.hidden=true;
sayBox.innerHTML=Object.entries(SAY).map(([k,t])=>`<button class="pill" type="button" data-say="${k}">${L(t[0],t[1])}</button>`).join('');document.body.append(sayBox);
const feed=document.createElement('div');feed.className='sayFeed';feed.setAttribute('aria-live','polite');document.body.append(feed);
sayBtn.onclick=e=>{e.stopPropagation();sayBox.hidden=!sayBox.hidden};
sayBox.onclick=e=>{const b=e.target.closest('[data-say]');if(!b)return;DR.send({t:'say',k:b.dataset.say});sayBox.hidden=true};
document.addEventListener('pointerdown',e=>{if(!sayBox.hidden&&!sayBox.contains(e.target)&&e.target!==sayBtn)sayBox.hidden=true});
function showSay(m){const t=SAY[m.k];if(!t)return;const d=document.createElement('div');d.className='say'+(m.s===(RV&&RV.you)&&m.s>=0?' me':'');
  d.innerHTML=`<b>${esc(m.n)}</b>${esc(L(t[0],t[1]))}`;feed.append(d);while(feed.children.length>3)feed.firstChild.remove();
  setTimeout(()=>{d.classList.add('out');setTimeout(()=>d.remove(),400)},4000)}
document.title=L('だるまさんがころんだ（みんなで）','Red Light, Green Light (with friends)');
// サーバーからのお知らせは日本語で届くので、英語のときはここで置きかえる
const ERR_EN={'もう始まっています。終わるまで待ってね':'The game has already started. Please wait until it ends','満員です':'The room is full','まだ部屋に入っていません':"You haven't joined the room yet",'いまは席を移れません':"You can't change seats right now",'その席はありません':"That seat doesn't exist",'その席にはもう人がいます':'Someone is already in that seat','部屋に入っていません':"You're not in the room",'部屋を作った人だけが始められます':'Only the host can start','もう始まっています':'Already started','いまは唱えられません':"You can't chant right now",
  'いまは変えられません':"You can't change it right now",'そのだるまはありません':"That Daruma doesn't exist",'だるまの人だけが選べます':'Only the Daruma player can choose','部屋を作った人だけが選べます':'Only the host can choose','みんなの準備OKを待っています':'Waiting for everyone to be ready'};

DR.connect(ROOM,m=>{
  if(m.t==='open'){DR.send({t:'join',name:myName()||L('ゲスト','Guest')});return}
  if(m.t==='close'){note(L('つなぎ直しています…','Reconnecting…'));return}
  if(m.t==='err'){showMsg(EN&&ERR_EN[m.msg]||m.msg,1800);if(m.room)apply(m.room,[]);return}
  if(m.t==='room'){apply(m.room,m.ev||[]);autoGo(m.room)}
});
// 部屋を作ったばかりなら、選んでいた役の席に移って、種類を決めて、すぐ始める（ひとりのときだけ・一度だけ）
function autoGo(v){
  let g=null;try{g=JSON.parse(sessionStorage.getItem('dk-go')||'null')}catch(e){}
  if(!g||g.id!==v.id)return;try{sessionStorage.removeItem('dk-go')}catch(e){}
  if(!v.host||v.phase!=='lobby'||present(v).length>1)return;
  if(g.role==='kid'&&v.you===0)DR.send({t:'seat',i:1});
  if(g.type)DR.send({t:'dtype',k:g.type});
  DR.send({t:'start'});
}

function apply(v,ev){
  const was=RV;RV=v;const playing=!['lobby','over'].includes(v.phase);
  renderBadge(v,was);
  role=v.you===0?'daruma':'kid';
  if(v.st)syncState(v);
  for(const e of ev)onEvent(e);
  if(v.phase!=='push'&&push&&gt-push.t0>(push.dur||0))push=null;   // 押し戻しの見せ方は、終わったら消す
  phase=v.phase==='lobby'?'setup':v.phase;
  $('ctlDaruma').hidden=!(playing&&v.you===0);$('pad').hidden=!(playing&&v.you>0);
  $('endBtn').hidden=false;
  // だるまの準備は30秒まで（過ぎたらサーバーが自動で唱え始める）。残りの秒は下の loop で数える
  prepEnd=v.phase==='prep'&&v.prepLeft!=null?performance.now()+v.prepLeft:null;prepS=-1;
  if(playing){$('over').hidden=true;note(v.phase==='prep'||v.you<0?prepNote(v.prepLeft):'')}
  else renderRoomCard();
  renderCtl();renderChant();
}
// サーバーの様子を、描く部品が使う形（st）にする
function syncState(v){
  const s=v.st;
  if(!st||game!==v.game){
    game=v.game;myId=v.you>0?'h'+(v.you-1):null;
    // 子どもには、今回のだるまの種類を知らせる（色でも分かるが、名前とクセも）
    if(v.you>0){const k=CPU_STYLES[CPU_OF[s.type]||'normal'];if(k)showMsg(k.n,2400,k.sub)}
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
  if(e.say){showSay(e.say);return}
  const n=e.syl;if(n){if(n<10)beep(520+n*18,0.06);else beep(330,0.18)}
  if(e.cue)beep(260,0.5,'sine');
  if(e.look){faceAt=gt}
  if(e.caught){caughtAt[e.caught]=gt;beep(150,0.25,'sawtooth');
    if(e.caught===myId)showMsg(L('見つかった！','Caught!'),2200)}
  if(e.pushed){const names=e.pushed.map(id=>st.children.find(c=>c.id===id)).filter(Boolean).map(nm);
    if(!e.pushed.length)showMsg(L('セーフ…みんな止まってた','Safe… everyone stopped'),1000);else if(!e.pushed.includes(myId))showMsg(role==='kid'?names.join(L('・',', '))+L('が見つかった',' got caught'):L('見つけた！ ','Got you! ')+names.join(L('・',', ')),1200);   // ほかの子だけのときに「セーフ！」は付けない
    push={from:e.from,to:st.children.map(c=>c.pos),t0:gt,dur:e.pushed.length?700:0};}
  if(e.carry&&role==='daruma')showMsg(e.auto?L('気力が足りない…見送り','Not enough spirit… passed'):L('見送り！','Passed!'),e.auto?1100:800);
  if(e.outOfGas&&role==='daruma')showMsg(L('気力切れ！','Out of spirit!'),1400,L('テンポが半分に落ちた','Tempo dropped by half'));
  if(e.over&&RV&&RV.winner){const w=RV.winner;beep(880,0.15);}
}
// 部屋にいる人（つながっている人と、途中に来て待っている人）。左上にいつも出し、来た人は知らせる
const present=v=>v.seats.filter(s=>!s.empty&&s.online).map(s=>s.name).concat(v.waiting||[]);
function renderBadge(v,was){
  const n=present(v).length,w=(v.waiting||[]).length;
  badge.innerHTML=`<i></i>${L('部屋','Room')} ${EN?n+(n===1?' player':' players'):n+'人'}${w?L(`・${w}人待ち`,` · ${w} waiting`):n<=1?L('・待っています',' · waiting'):''}`;
  badge.title=L('みんなで遊ぶ部屋の中にいます','You are in a room with friends');
  if(!was)return;
  const before=present(was);
  for(const nmx of present(v)){const k=before.indexOf(nmx);if(k>=0){before.splice(k,1);continue}
    const playing=!['lobby','over'].includes(v.phase);
    showMsg(L(`${nmx}が来た！`,`${nmx} joined!`),2200,playing?L('この回が終わったら入ります','Joins after this round'):'')}
}
// 集まっているとき・終わったときのカード
function renderRoomCard(){
  const v=RV,url=location.origin+location.pathname+'?room='+v.id,w=v.winner;
  $('over').hidden=false;$('roles').hidden=true;$('types').hidden=true;$('fb').hidden=true;$('shareBtn').hidden=true;$('exitRow').hidden=true;$('otherBtn').hidden=true;
  let head=L('みんなで遊ぶ','Play with friends'),sub=L('リンクを送って、友だちを呼ぼう。空いた席には CPU が入ります。','Send the link to invite friends. Empty seats are filled by the CPU.');
  if(v.phase==='over'&&w){const mine=w.side==='kids'?v.you>0:v.you===0,wn=EN&&KID_EN[w.id]||w.name;
    head=w.side==='kids'?(w.id===myId?L('タッチ！あなたの勝ち','Touch! You win'):L(`${wn}がタッチ！子どもの勝ち`,`${wn} touched it! The runners win`)):L('時間切れ…だるまの勝ち',"Time's up… the Daruma wins");
    sub=(mine?L('やった！ ','Nice! '):'')+L(`これまで だるま ${v.wins[0]}勝・子ども ${v.wins[1]}勝`,`So far: Daruma ${v.wins[0]} · Runners ${v.wins[1]}`);}
  $('overH').textContent=head;$('overP').textContent=sub;
  const seat=(s,i)=>{const label=i===0?L('だるま','Daruma'):L('子ども','Runner ')+i,mine=v.you===i;
    return `<div class="rseat${mine?' mine':''}"><b>${label}</b><span>${s.empty?'CPU':esc(s.name)+(s.online?'':L('（るす）',' (away)'))}</span>${!s.empty&&s.online?`<em class="rready${s.ready?' on':''}">${s.host?L('作った人','Host'):s.ready?L('準備OK','Ready'):L('準備中…','Not ready')}</em>`:''}${s.empty&&v.you>=0?`<button class="pill" data-seat="${i}" type="button">${L('ここに座る','Sit here')}</button>`:''}</div>`};
  $('roomCard').hidden=false;
  // だるまの種類（2026-10-25）：だるまの席に人がいればその人、CPU のだるまなら部屋を作った人が選ぶ。ほかの人には見えるだけ
  const canPick=v.dtypeBy===0?v.you===0:v.host,dt=v.dtype||'random';
  const dHTML=`<div class="choices rtypes"><span class="typeQ">${L('だるまの種類','Daruma type')}${canPick?'':v.dtypeBy===0?L('（だるまの人が選びます）',' (the Daruma player picks)'):L('（部屋を作った人が選びます）',' (the host picks)')}</span>`+
    typeChoices().map(k=>`<button class="pill dCard${k===dt?' on':''}${k!=='random'&&k!=='normal'?' t_'+k:''}" data-dt="${k}" type="button"${canPick?'':' disabled'}><canvas data-k="${k}"></canvas><span>${typeName(k)}</span></button>`).join('')+
    `<p class="typeNote">${typeNote(dt)}</p></div>`;
  // ほかに人がいるか。ひとりのときは、待っていることと、待たずに始めてもいいことを書く
  const n=present(v).length;
  const wHTML=`<p class="rwait">${n<=1?L('ほかの人を待っています… 待たずに始めても、あとから来た人は次の回から入れます','Waiting for others… You can start now; anyone who joins later plays from the next round'):L(`いま、この部屋に${n}人`,`${n} players in this room`)}</p>`;
  $('roomCard').innerHTML=wHTML+`<div class="rseats">${v.seats.map(seat).join('')}</div>${dHTML}
    <div class="rinv"><input id="rUrl" readonly value="${esc(url)}"><button class="pill" id="rCopy" type="button">${L('コピー','Copy')}</button>
    ${EN?'':`<a class="pill" href="https://line.me/R/share?text=${encodeURIComponent('だるまさんがころんだで遊ぼ！ '+url)}" target="_blank" rel="noopener">LINE</a>`}${navigator.share?`<button class="pill" id="rShare" type="button">${L('送る','Share')}</button>`:''}</div>
    <label class="rname">${L('あなたの名前','Your name')} <input id="rName" maxlength="8" value="${esc(myName())}"></label>`;
  $('roomCard').querySelectorAll('[data-seat]').forEach(b=>b.onclick=()=>DR.send({t:'seat',i:+b.dataset.seat}));
  $('roomCard').querySelectorAll('canvas[data-k]').forEach(c=>{c.style.width=c.style.height='48px';drawDarumaThumb(c,c.dataset.k)});
  $('roomCard').querySelectorAll('[data-dt]').forEach(b=>b.onclick=()=>DR.send({t:'dtype',k:b.dataset.dt}));
  $('rCopy').onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText(url).then(()=>showMsg(L('コピーしました','Copied'),900))};
  const sh=$('rShare');if(sh)sh.onclick=()=>navigator.share({title:L('だるまさんがころんだ','Red Light, Green Light'),text:L('だるまさんがころんだで遊ぼ！',"Let's play Red Light, Green Light!"),url}).catch(()=>{});
  $('rName').onchange=()=>{const n=$('rName').value.trim().slice(0,8)||L('ゲスト','Guest');saveName(n);DR.send({t:'join',name:n})};
  // 始める：作った人は、つながっているほかの人が全員「準備OK」を押してから（2026-10-25。入ったとたんに始められてしまっていた）
  //   ほかの人は、同じ場所のボタンで「準備OK」を押す（もう一度押すと取り消し）。満員で入れなかった人は見ているだけ
  const sb=$('startBtn'),mine=v.you>=0?v.seats[v.you]:null,wait=v.seats.filter(s=>!s.empty&&s.online&&!s.ready).length,wh=$('waitHost');
  if(v.host){sb.hidden=false;sb.disabled=wait>0;sb.classList.remove('sub');sb.textContent=v.phase==='over'?L('もう一回','Play again'):L('はじめる','Start');
    sb.onclick=()=>DR.send({t:v.phase==='over'?'again':'start'});
    wh.hidden=!wait;wh.textContent=L(`みんなの「準備OK」を待っています（あと${wait}人）`,`Waiting for everyone to be ready (${wait} left)`)}
  else if(mine){sb.hidden=false;sb.disabled=false;sb.classList.toggle('sub',mine.ready);sb.textContent=mine.ready?L('準備OK ✓（取り消す）','Ready ✓ (undo)'):L('準備OK！','Ready!');
    sb.onclick=()=>DR.send({t:'ready',on:!mine.ready});
    wh.hidden=!mine.ready;wh.textContent=L('部屋を作った人が始めるのを待っています',"Waiting for the room's host to start")}
  else{sb.hidden=true;wh.hidden=false;wh.textContent=L('満員なので、見ているだけです','The room is full, so you are watching')}
}

// ---------- 押したことをサーバーに送る ----------
$('go').onclick=()=>{if(phase==='prep'&&role==='daruma'){ac();DR.send({t:'go'})}};
$('arm').onclick=()=>{if(st&&role==='daruma')DR.send({t:'arm',on:!st.turnArmed})};
$('tempo').oninput=()=>{if(st&&role==='daruma')DR.send({t:'tempo',v:+$('tempo').value})};
window.sendAura=r=>DR.send({t:'aura',r});
$('endBtn').onclick=()=>{if(confirm(L('部屋を出ますか？（遊んでいる途中なら、あなたの席は CPU になります）','Leave the room? (If a game is in progress, the CPU takes your seat)'))){DR.send({t:'leave'});setTimeout(()=>{location.href=location.pathname},200)}};
function prepNote(ms){if(RV&&RV.you<0&&!RV.queued)return L('見ているだけです','You are watching');if(RV&&RV.queued)return L('この回が終わったら、席に入ります。見て待っててね',"You'll get a seat after this round. Watch for now");const n=ms!=null?Math.max(0,Math.ceil(ms/1000)):null;const s=n!=null?L(`　あと${n}秒`,` · ${n}s left`):'';return role==='daruma'?L('「唱える」を押そう','Press "Chant"')+s:L('だるまの準備中','The Daruma is getting ready')+s}
// 子ども：押している場所の速さとダッシュ（パッドの上半分）を、変わったときだけ送る
(function loop(){
  if(prepEnd&&phase==='prep'){const left=prepEnd-performance.now(),sec=Math.max(0,Math.ceil(left/1000));if(sec!==prepS){prepS=sec;note(prepNote(left))}}
  if(RV&&RV.you>0&&!['lobby','over'].includes(RV.phase)){const v=pressed?want:0;if(Math.abs(v-lastWant)>0.01||boost!==lastBoost){lastWant=v;lastBoost=boost;DR.send({t:'want',v:+v.toFixed(2),b:boost})}}
  requestAnimationFrame(loop);
})();
})();
