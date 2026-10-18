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
  var STOP_TICKS_MIN = 8, STOP_TICKS_MAX = 14;   // 0.8〜1.4 秒（子どもは全力で走るので、全力疾走から止まるくらい。前は 0.4〜0.7 秒）
  function humanStop(d, lo, hi, accT) {
    lo = lo != null ? lo : STOP_TICKS_MIN; hi = hi != null ? hi : STOP_TICKS_MAX;
    var o = d.maxSpeed / d.brake;
    var t = Math.max(0.5, lo + (o - 0.83) / (3.1 - 0.83) * (hi - lo));
    // 走り出しも人に合わせる：全速まで accT 秒くらい。元の乗りやすさの順番で ±15% ばらつく
    var a0 = d.maxSpeed / d.accel;                      // 元の、全速までの tick（3.5〜4.0）
    var at = (accT != null ? accT : ACC_T) * (1 + (a0 - 3.75) / 0.5 * 0.15);
    return Object.assign({}, d, { brake: d.maxSpeed / t, accT: Math.max(1, at * 10) });
  }
  var ACC_T = 2.0;   // 全速まで 2 秒（2026-10-18。けんじさん「止まるより全速が短いなんてありえん」。0.33 秒 → 1.5 秒 → 2 秒）

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
    c.accT = Math.max(1, accT * 10);
    c.brake = c.maxSpeed / Math.max(0.5, stopT * 10);
  }

  // 子どもを n 人。withMe なら1人は人（列は lane 番目）。cpuStop=[最短,最長] 秒で CPU の止まり方を変えられる
  function newGame(opt) {
    opt = opt || {};
    var n = opt.kids || P.ACTIVE_CHILDREN;
    var cs = opt.cpuStop || [STOP_TICKS_MIN / 10, STOP_TICKS_MAX / 10];
    var defs = Core.pickActiveChildren(P, opt.withMe ? n - 1 : n).map(function (d) { return humanStop(d, cs[0] * 10, cs[1] * 10, opt.cpuAccT); });
    var lane = opt.lane != null ? opt.lane : Math.floor(n / 2);
    if (opt.withMe) defs.splice(lane, 0, ME);
    var st = Core.newRunState(P, defs, opt.type);
    st.children.forEach(function (c) {
      if (c.id === "me") { c.human = true; c.input = false; setMe(c, opt.accT != null ? opt.accT : ACC_T, opt.stopT != null ? opt.stopT : 1.0); }
    });
    st.turnArmed = true;
    st.reward = "mid";
    st.nextReward = null;
    return st;
  }

  // 言い終わった。振り向いたかどうかを返す。見送りなら止まらずに続ける形にしておく
  function resolve(st) {
    // 振り向くつもりでも気力が足りなければ、自動で見送る（「力が足りない…」で全部失う落とし穴はなくした）
    if (st.turnArmed && st.stamina < Core.turnCostOf(P, st)) { st.turnArmed = false; st.autoSkip = true; } else st.autoSkip = false;
    var out = Core.resolveCycle(P, st);
    out.autoSkip = st.autoSkip;
    out.carry = !out.turned && !out.underpowered;
    if (out.carry) {
      st.chantProgress = 10;      // 最後の「だ」が次の「だ」を兼ねる
      applyReserved(st);
    }
    return out;
  }
  // ---------- 振り向いて見る（2026-10-18） ----------
  // 言い終わって振り向くと、LOOK の間だるまが見ている。この間も子どもの体は動く（時計と言葉は止まる）。
  // 振り向き始めてから GRACE（振り向く動き＋すべって止まりきる猶予）がたっても動いている子が見つかる。
  // 見つかった子はその場で固まり、見終わってから押し戻される。何が起きたか見て分かるようにするため
  var LOOK = { grace: 2, ticks: 12 };   // 0.2 秒（振り向く動きのぶん）・1.2 秒（tick は 0.1 秒）。猶予 0.3 秒だと子どもがほとんど捕まらず、時間切れだけのゲームになった
  function wantsTurn(st) { return st.turnArmed && st.stamina >= Core.turnCostOf(P, st); }
  function startLook(st) {
    st.looking = true;
    st.look = { t: 0, from: st.children.map(function (c) { return c.pos; }), caught: [] };
  }
  // 見ている間を 0.1 秒進める。新しく見つかった子を返す。late は「あと何 tick 早く止まりはじめれば間に合ったか」
  function lookTick(st) {
    var cp = st.chantProgress, el = st.elapsedTicks, sta = st.stamina;
    var res = Core.tick(P, st);
    st.chantProgress = cp; st.elapsedTicks = el; st.stamina = sta;
    st.look.t += 1;
    var newly = [];
    if (st.look.t > LOOK.grace) {
      st.children.forEach(function (c) {
        if (c.caughtNow || c.vel <= P.CATCH_VEL_THRESHOLD) return;
        c.caughtNow = true;
        c.caughtLate = (c.vel - P.CATCH_VEL_THRESHOLD) / c.brake;   // 止まりきるのに足りなかった tick
        c.caughtPressing = !!(c.human && c.input);
        st.look.caught.push(c); newly.push(c);
      });
    }
    return { newly: newly, reached: res.reached, done: st.look.t >= LOOK.ticks };
  }
  // 見終わった。見つかった子を押し戻して（resolveCycle は「動いている子」を捕まえるので、そう見せかける）、結果を返す
  function endLook(st) {
    var caught = st.look.caught;
    st.children.forEach(function (c) { c.vel = c.caughtNow ? 1 : 0; });
    var before = st.children.map(function (c) { return c.pos; });
    var out = resolve(st);
    st.children.forEach(function (c) { c.vel = 0; c.caughtNow = false; });
    st.looking = false;
    out.before = before;
    out.from = st.look.from;
    out.caughtList = caught;
    return out;
  }

  function applyReserved(st) { if (st.nextReward) { st.reward = st.nextReward; st.nextReward = null; } }

  // 言っているところ：何音目まで言ったか（0〜10）
  function said(st) { return Math.min(10, Math.floor(st.chantProgress / 10)); }

  // ---------- CPU のだるま ----------
  // 人のだるまにも見えることだけで決める（2026-10-18）：いちばん近い子がどこまで来ているか、走っている子がいるか
  // （足が動いているかで見える。見てから 0.3 秒遅れて気づく）、自分の気力。「ブレーキを踏み始めたか」は 4 人を
  // 相手に人には見分けられないので使わない（前はそれで見送って「なんでそんな動きに？」になった）。
  // 毎回の気まぐれ（その回の「振り向く気になる線」）を入れる。st.cpuThought に考えを書く（画面で見られる）
  function cpuDaruma(rand) {
    rand = rand || Math.random;
    var SEE_LAG = 3;
    var seen = [], ramp = false, willRamp = false, line = 0.5;
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
      ramp = false; willRamp = rand() < 0.25;   // たまに、振り向く回の終わりぎわに速める
      line = 0.35 + rand() * 0.4;               // その回の気まぐれ：この線を超えたら振り向く
    }
    return {
      // ひと休みのあと、言い始める前
      onPrep: function (st) { st.reward = pickReward(st); seen = []; newPhrase(st); },
      // 見送りの「だ」で強気度を変える（予約していたもの）
      onCarry: function (st) { st.reward = pickReward(st); newPhrase(st); },
      // 言っている間、毎 tick
      onTick: function (st) {
        seen.push({
          lead: Math.max.apply(null, st.children.map(function (c) { return c.pos; })),
          run: st.children.filter(function (c) { return c.vel > P.CATCH_VEL_THRESHOLD; }).length / st.children.length
        });
        if (seen.length > SEE_LAG + 1) seen.shift();
        var v = seen[0];                                         // 0.3 秒前に見えたもの
        var near = Math.max(0, Math.min(1, (v.lead - 30) / 60)); // 30 で 0、90 で 1
        var qi = st.stamina / st.staminaMax;
        var want = 0.55 * near + 0.25 * qi + 0.3 * v.run;
        var afford = st.stamina >= Core.turnCostOf(P, st);
        st.turnArmed = afford && want > line;
        st.cpuThought = !afford ? "気力が足りない…" :
          st.turnArmed ? (near > 0.6 ? "近い！振り向く" : v.run > 0.5 ? "走ってるな…振り向く" : "振り向く") :
          (near < 0.3 ? "まだ遠い…見送る" : v.run < 0.25 ? "みんな止まってる…見送る" : "見送る");
        var left = (100 - st.chantProgress) / Core.tempoFill(P, 100);
        if (st.turnArmed && willRamp && !ramp && left <= 6) { Core.applyTempoChange(P, st, 100); ramp = true; }
      }
    };
  }

  return {
    Core: Core, P: P, TIERS: TIERS, ME: ME,
    humanStop: humanStop, setMe: setMe, newGame: newGame,
    LOOK: LOOK, wantsTurn: wantsTurn, startLook: startLook, lookTick: lookTick, endLook: endLook, resolve: resolve, applyReserved: applyReserved,
    said: said, cpuDaruma: cpuDaruma
  };
});
