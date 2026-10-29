// 音（2026-10-29）：BGM（sound/bgm.mp3）を流す。三人将棋・だるま・四字熟語あつめと同じもの（ゲームごとに置く）
//   最初は鳴らさない。🔇/🔊ボタンでオンにした人だけ鳴る。オン／オフはまた遊ぼのゲームで共通の mataasobo-sound に覚える
//   ボタンは言葉の切りかえ（#langBtn）の左に、同じ見た目で置く。なければ header の最後に .pill で置く
//   ブラウザは人が一度どこかを押すまで音を鳴らせないので、オンのまま開いたときは、最初に押されたときに鳴らし始める
//   Sound.want(false) で止め、Sound.want(true) で続きから鳴らす。タブを隠したら止める
(function () {
  const KEY = 'mataasobo-sound';
  const t = (ja, en) => (typeof L === 'function' ? L(ja, en) : ja);
  let on = false, want = true, unlocked = false;
  try { on = localStorage.getItem(KEY) === 'on'; } catch (e) {}
  const bgm = new Audio('sound/bgm.mp3');
  bgm.loop = true; bgm.volume = 0.35; bgm.preload = 'none';
  const sync = () => {
    if (on && want && unlocked && !document.hidden) { if (bgm.paused) bgm.play().catch(() => {}); }
    else if (!bgm.paused) bgm.pause();
  };
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'soundBtn';
  const show = () => { b.textContent = on ? '🔊' : '🔇'; b.title = on ? t('音を消す', 'Sound off') : t('音を出す', 'Sound on'); b.setAttribute('aria-label', b.title); };
  b.onclick = () => {
    on = !on; unlocked = true;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {}
    show(); sync();
  };
  show();
  const lb = document.getElementById('langBtn');
  if (lb) {
    b.className = lb.className;
    if (lb.style.marginLeft === 'auto') {   // 右寄せのボタン（おかしならべ）：2つをまとめて右に寄せる（折り返しで離れないように）
      const w = document.createElement('span');
      w.style.cssText = 'margin-left:auto;display:flex;gap:6px';
      lb.style.marginLeft = ''; lb.before(w); w.append(b, lb);
    } else lb.before(b);
  } else {
    b.className = 'pill';
    const h = document.querySelector('header');
    (h || document.body).appendChild(b);
  }
  const unlock = () => { unlocked = true; sync(); document.removeEventListener('pointerdown', unlock, true); document.removeEventListener('keydown', unlock, true); };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
  document.addEventListener('visibilitychange', sync);
  globalThis.Sound = { want(v) { v = !!v; if (v !== want) { want = v; sync(); } }, get playing() { return !bgm.paused; } };
})();
