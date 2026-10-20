// みんなで遊ぶときの通信（おかしならべの room.js と同じしくみ。ブラウザでは window.DarumaRoom）
//   create(name)        だるまの部屋を作って id を返す（作った人は、まずだるまの席）
//   connect(id, onMsg)  つなぐ。切れたらつなぎ直す。onMsg にサーバーからの {t:'room', room, ev} などを渡す
//   send(msg)           {t:'join'|'seat'|'start'|'again'|'want'|'go'|'arm'|'aura'|'tempo'|'leave'} を送る
//   me()                このブラウザの番号（pid）。また遊ぼのほかのゲームと同じものを使う
// サーバーの場所：mataasobo.com なら api.mataasobo.com、手元で開いたときは http://127.0.0.1:8787（wrangler dev）
(function(root){
'use strict';
const API=location.hostname==='mataasobo.com'?'https://api.mataasobo.com':'http://127.0.0.1:8787';
const ABC='abcdefghjkmnpqrstuvwxyz23456789';
function me(){
  let p=null;try{p=localStorage.getItem('mataasobo-pid')}catch(e){}
  if(!/^[a-z0-9]{16,40}$/.test(p||'')){p=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>ABC[b%ABC.length]).join('');try{localStorage.setItem('mataasobo-pid',p)}catch(e){}}
  return p;
}
async function create(name){
  const r=await fetch(API+'/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pid:me(),name,kind:'daruma'})});
  const j=await r.json();if(!r.ok)throw new Error(j.error||'部屋を作れませんでした');return j.id;
}
let ws=null,queue=[],wait=1000,timer=null;
function connect(id,onMsg){
  const open=()=>{
    clearTimeout(timer);
    const s=ws=new WebSocket(API.replace(/^http/,'ws')+'/rooms/'+id+'/ws?pid='+me());
    s.onopen=()=>{wait=1000;queue.splice(0).forEach(m=>s.send(m));onMsg({t:'open'})};
    s.onmessage=e=>{if(e.data==='pong')return;try{onMsg(JSON.parse(e.data))}catch(err){console.error(err)}};
    s.onclose=()=>{if(s!==ws)return;onMsg({t:'close'});timer=setTimeout(open,wait);wait=Math.min(wait*2,10000)};
  };
  open();
  setInterval(()=>{if(ws&&ws.readyState===1)ws.send('ping')},20000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&ws&&ws.readyState>1){wait=1000;open()}});
}
function send(msg){const s=JSON.stringify(msg);if(ws&&ws.readyState===1)ws.send(s);else queue.push(s)}
root.DarumaRoom={create,connect,send,me,API};
})(this);
