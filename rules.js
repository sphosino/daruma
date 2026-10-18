// だるまさんがころんだの決まり（だるま役・子ども役・シミュレーターで同じものを使う）
//   元は old/daruma-core.js（前のだるまで作りこんだ決まりと子どもの AI）。ここではその上に
//   2026-10-18 に決めたことを足す：
//   - 子どもの止まり方は人に合わせる（全速から止まるまで 0.4〜0.7 秒）
//   - 人の子どもも、元の子どもの1人として同じコースを走る（押している間だけ加速）
//   - 見送ったら止まらず、最後の「だ」が次の「だ」を兼ねる
//   - 強気度は言っている間に予約でき、見送りの「だ」かひと休みで変わる
//   - 子ども役のときの CPU のだるま（シミュレーターの「人間の読み」と同じ見方）
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./old/daruma-core.js"));
  else root.DarumaRules = factory(root.DarumaCore);
})(typeof self !== "undefined" ? self : this, function (Core) {
  "use strict";

  var P = Core.makeConfig({});
  var TIERS = ["low", "mid", "high", "max"];

  // 止まり方：元の止まりやすさの順番（maxSpeed/brake が大きいほど止まりにくい）はそのままに、
  // 全速から止まるまでを 4〜7 tick（0.4〜0.7 秒）に広げる。人は 5 tick（0.5 秒）
  var STOP_TICKS_MIN = 4, STOP_TICKS_MAX = 7;
  function humanStop(d, lo, hi) {
    lo = lo != null ? lo : STOP_TICKS_MIN; hi = hi != null ? hi : STOP_TICKS_MAX;
    var o = d.maxSpeed / d.brake;
    var t = Math.max(0.5, lo + (o - 0.83) / (3.1 - 0.83) * (hi - lo));
    return Object.assign({}, d, { brake: d.maxSpeed / t });
  }

  // 人の子ども。速さは元の子どもの真ん中くらい。全速まで 0.33 秒、止まるまで 0.5 秒
  var ME_SPEED = 0.30;
  var ME = {
    id: "me", name: "あなた", color: "var(--ink)",
    maxSpeed: ME_SPEED, accel: ME_SPEED / 3.3, brake: ME_SPEED / 5, endurance: 0.5,
    boldness: 0.5, selfControl: 0.5, judgmentResilience: 0.5, motorControl: 0.5,
    bodyAwareness: 0.5, skepticism: 0.5, conformity: 0, reaction: 0.5
  };

  // 人の子どもの加速・減速（全速になるまで accT 秒、全速から止まるまで stopT 秒）
  function setMe(c, accT, stopT) {
    c.accel = c.maxSpeed / Math.max(0.5, accT * 10);
    c.brake = c.maxSpeed / Math.max(0.5, stopT * 10);
  }

  // 子どもを n 人。withMe なら1人は人（列は lane 番目）。cpuStop=[最短,最長] 秒で CPU の止まり方を変えられる
  function newGame(opt) {
    opt = opt || {};
    var n = opt.kids || P.ACTIVE_CHILDREN;
    var cs = opt.cpuStop || [STOP_TICKS_MIN / 10, STOP_TICKS_MAX / 10];
    var defs = Core.pickActiveChildren(P, opt.withMe ? n - 1 : n).map(function (d) { return humanStop(d, cs[0] * 10, cs[1] * 10); });
    var lane = opt.lane != null ? opt.lane : Math.floor(n / 2);
    if (opt.withMe) defs.splice(lane, 0, ME);
    var st = Core.newRunState(P, defs, opt.type);
    st.children.forEach(function (c) {
      if (c.id === "me") { c.human = true; c.input = false; setMe(c, opt.accT != null ? opt.accT : 0.33, opt.stopT != null ? opt.stopT : 0.5); }
    });
    st.turnArmed = true;
    st.reward = "mid";
    st.nextReward = null;
    return st;
  }

  // 言い終わった。振り向いたかどうかを返す。見送りなら止まらずに続ける形にしておく
  function resolve(st) {
    var out = Core.resolveCycle(P, st);
    out.carry = !out.turned && !out.underpowered;
    if (out.carry) {
      st.chantProgress = 10;      // 最後の「だ」が次の「だ」を兼ねる
      applyReserved(st);
    }
    return out;
  }
  function applyReserved(st) { if (st.nextReward) { st.reward = st.nextReward; st.nextReward = null; } }

  // 言っているところ：何音目まで言ったか（0〜10）
  function said(st) { return Math.min(10, Math.floor(st.chantProgress / 10)); }

  // ---------- CPU のだるま ----------
  // 見るのは描かれた位置だけ（速さの数字は見ない）。先頭が CREEP より奥に来ていて、
  // まだ動いていて、ゆるめていなければ振り向く。気力が多いときは強気度を高めにして見送りで稼ぐ
  function cpuDaruma(rand) {
    rand = rand || Math.random;
    var CREEP = 65, WIN = 8, EPS = 0.4;
    var log = [];
    var ramp = false, willRamp = false;
    function lead(now) { var k = 0; for (var i = 1; i < now.length; i++) if (now[i] > now[k]) k = i; return k; }
    function pickReward(st) {
      var q = st.stamina / st.staminaMax;
      var w = q < 0.3 ? [1, 2, 4, 3] : q > 0.7 ? [3, 3, 3, 1] : [2, 3, 3, 2];
      var r = rand() * 10, i = 0;
      while ((r -= w[i]) > 0 && i < 3) i++;
      return TIERS[i];
    }
    function newPhrase(st) {
      // テンポは毎回少し変える。気力が少ないときはゆっくり
      var healthy = st.stamina > st.staminaMax * 0.5;
      st.tempoValue = healthy ? 40 + rand() * 30 : 20 + rand() * 20;
      ramp = false; willRamp = rand() < 0.25;   // たまに、終わりぎわに速める
    }
    return {
      // ひと休みのあと、言い始める前
      onPrep: function (st) { st.reward = pickReward(st); log = []; newPhrase(st); },
      // 見送りの「だ」で強気度を変える（予約していたもの）
      onCarry: function (st) { st.reward = pickReward(st); newPhrase(st); },
      // 言っている間、毎 tick
      onTick: function (st) {
        log.push(st.children.map(function (c) { return c.pos; }));
        if (log.length > WIN + 1) log.shift();
        var now = log[log.length - 1], then = log[0], i = lead(now);
        var moving = log.length < 2 || now[i] - then[i] > EPS;
        var slowing = false;
        if (log.length >= 5) {
          var mid = Math.floor(log.length / 2);
          slowing = (now[i] - log[mid][i]) < (log[mid][i] - then[i]) * 0.6;
        }
        var want = now[i] >= CREEP && moving && !slowing;
        st.turnArmed = want;
        var left = (100 - st.chantProgress) / Core.tempoFill(P, 100);
        if (want && willRamp && !ramp && left <= 6) { Core.applyTempoChange(P, st, 100); ramp = true; }
      }
    };
  }

  return {
    Core: Core, P: P, TIERS: TIERS, ME: ME,
    humanStop: humanStop, setMe: setMe, newGame: newGame, resolve: resolve, applyReserved: applyReserved,
    said: said, cpuDaruma: cpuDaruma
  };
});
