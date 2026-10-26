// だるまさんがころんだの決まり（だるま役・子ども役・シミュレーターで同じものを使う）
//   元は old/daruma-core.js（前のだるまで作りこんだ決まりと子どもの AI）。ここではその上に
//   2026-10-18 に決めたことを足す：
//   - 子どもの止まり方は人に合わせる（全速から止まるまで 0.4〜0.7 秒）
//   - 人の子どもも、元の子どもの1人として同じコースを走る（押している間だけ加速）
//   - 見送ったら止まらず、最後の「だ」が次の「だ」を兼ねる
//   - オーラ（前の名前は強気度）は言っている間に予約でき、見送りの「だ」かひと休みで変わる
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

  // 人の子どもの体をポイントで振り分ける（2026-10-26、けんじさん案）：速さ・止まりやすさ・走り出し・持久力をそれぞれ 1〜5、合わせて BODY_POINTS。
  //   全部 3 がふつうの「あなた」（速さ 0.30・止まるまで 1 秒・全速まで 2 秒・持久力 0.5）。どれかを上げたら、どれかを下げる
  //   1 段で同じくらい効くように、軸ごとに幅を変えた（シミュレーターで、1 つだけ変えたときの自分のタッチが 段1 約12%・3 約33%・5 約47%）。
  //   上の段ほど伸びを小さくして、1 つに全部振るより散らすほうが得になる形にしている
  var BODY = {
    speed: [0.28, 0.29, 0.30, 0.308, 0.313],   // 全速（1 tick に進む量）。少しの差がとても効く
    stop: [2.0, 1.4, 1.0, 0.75, 0.6],          // 全速から止まるまで（秒）。0.7 秒より短くしても、ほとんど効かない
    acc: [2.9, 2.45, 2.0, 1.7, 1.55],          // 全速になるまで（秒）
    end: [0.15, 0.3, 0.5, 0.7, 0.95]           // 持久力（体力の器・減りにくさ・戻りやすさ）
  };
  var BODY_POINTS = 12, BODY_KEYS = ["speed", "stop", "acc", "end"];
  function bodyOk(b) {
    if (!b) return false;
    var sum = 0;
    for (var i = 0; i < BODY_KEYS.length; i++) { var v = b[BODY_KEYS[i]]; if (!(v >= 1 && v <= 5) || v !== Math.round(v)) return false; sum += v; }
    return sum === BODY_POINTS;
  }

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
    // opt.learned（遺伝子の配列）：CPU の子を学習した子にする（2026-10-26、だるま役の「つよい」）。名前は元の子のまま、体は人の子と同じ
    if (opt.learned) defs = defs.map(function (d) { return Object.assign({}, ME, { id: d.id, name: d.name }); });
    var lane = opt.lane != null ? opt.lane : Math.floor(n / 2);
    //   opt.meBody = { speed, stop, acc, end }（値そのもの）は、調べる道具用
    var body = opt.meBody || (bodyOk(opt.body) ? { speed: BODY.speed[opt.body.speed - 1], stop: BODY.stop[opt.body.stop - 1], acc: BODY.acc[opt.body.acc - 1], end: BODY.end[opt.body.end - 1] } : null);
    if (opt.withMe) defs.splice(lane, 0, body ? Object.assign({}, ME, { maxSpeed: body.speed, accel: body.speed / 3.3, endurance: body.end }) : ME);
    var st = Core.newRunState(P, defs, opt.type);
    st.children.forEach(function (c, i) {
      if (c.id === "me") { c.human = true; c.input = false; setMe(c, body ? body.acc : opt.accT != null ? opt.accT : ACC_T, body ? body.stop : opt.stopT != null ? opt.stopT : 1.0); }
      else if (opt.learned) { c.driven = true; c.input = 0; setMe(c, ACC_T, 1.0); c.brain = learnedKid(opt.learned[i % opt.learned.length]); }
    });
    st.turnArmed = true;
    st.reward = "mid";
    st.nextReward = null;
    return st;
  }

  // みんなで遊ぶとき：子どもの席ごとに、人（{name}）か CPU（null）かを決めて始める（2026-10-20）
  //   人の子は id が h0〜h3（席の順）。CPU の子は、元の子どもの中からくじで選ぶ
  function newGameSeats(opt) {
    var kids = opt.kids, cs = opt.cpuStop || [STOP_TICKS_MIN / 10, STOP_TICKS_MAX / 10];
    var ai = Core.pickActiveChildren(P, kids.filter(function (k) { return !k; }).length)
      .map(function (d) { return humanStop(d, cs[0] * 10, cs[1] * 10, opt.cpuAccT); });
    var defs = kids.map(function (k, i) { return k ? Object.assign({}, ME, { id: 'h' + i, name: k.name }) : ai.shift(); });
    var st = Core.newRunState(P, defs, opt.type);
    st.children.forEach(function (c) {
      if (/^h\d$/.test(c.id)) { c.human = true; c.input = 0; setMe(c, opt.accT != null ? opt.accT : ACC_T, opt.stopT != null ? opt.stopT : 1.0); }
    });
    st.turnArmed = true; st.reward = "mid"; st.nextReward = null;
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
  var LOOK = { grace: 3, ticks: 12 };   // 猶予 0.3 秒・見る 1.2 秒（tick は 0.1 秒）。振り向いてから 0.3 秒たった時点で、まだ動いている子が見つかる
  //   （2026-10-19：前は「0.2 秒」と書いていたが、数え方が 1 つずれていて実際は 0.3 秒だった。遊んだ感じとシミュレーターの結果はこの 0.3 秒なので、書き方をそろえた）
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
    if (st.look.t >= LOOK.grace) {
      st.children.forEach(function (c) {
        if (c.caughtNow || c.vel <= P.CATCH_VEL_THRESHOLD) return;
        c.caughtNow = true;
        c.caughtLate = (c.vel - P.CATCH_VEL_THRESHOLD) / c.brake;   // 止まりきるのに足りなかった tick
        c.caughtPressing = !!((c.human || c.driven) && c.input);
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
  // style（2026-10-25）：'normal' はいつもの唱え方。'tempo' はテンポを武器にする（攻めだるま：テンポを上げるのが安い）。
  //   決まった手順ではなく、子どもの様子を見て回ごとに変える：
  //   ・唱え始めの速さは毎回ばらばら
  //   ・みんな止まって待っている → ゆっくり唱える（時計は唱えている間だけ進むので、待っている子は時間だけ取られる）
  //   ・走っている子がいて、唱え終わりが近い → いきなり最高速（止まりきれない子を捕まえる）
  //   ・ときどき、速めたのに振り向かない（「速くなったら振り向く」と読ませない）
  // 数字はシミュレーター（node sim.js kid、POLS=攻めだるま TYPE=attack）で、子どもの勝ちが ふつうのだるまとそろうように決めた（2026-10-25）。
  //   時計45秒・猶予0.4秒・気力1000 で、ノーマル 73.5%・攻め 73.7%（子ども6通り、各400局）。人は急な早口にあわてるので、実際は少し手ごわいはず
  //   line：振り向く気になる線にかける数。振り向くのが高いだるまなので、大きめ（ここぞのときだけ振り向く）。小さくすると気力が切れて弱くなる
  var TEMPO = { start: [40, 90], slow: 15, rushAt: [55, 85], bluff: 0.2, line: 1.25 };
  // 'oni'（鬼だるま：振り向くのが安い・テンポを上げるのが高い）：テンポは上げず、一定のリズムで唱える。振り向くのが安いので、
  //   気力切れしにくい。line を下げて振り向きすぎると、安くても気力が切れて弱くなる（0.8 で子ども 84%）。0.95 でノーマルとそろう
  var ONI = { line: 0.95, tempo: [45, 60] };
  // 'gold'（金だるま：気力が多い・見送ってもたまりにくい）：オーラは両はし（全開か弱）に寄せる（aura の重み：全開・強・中・弱）。
  //   全開に寄せすぎると強すぎる（[6,2,1,1] で子ども 53%）。気力が多いうちは惜しまず振り向き（rich）、少なくなったら、ここぞのときだけ（poor）
  //   数字はシミュレーター（子ども6通り、各400局）で、ノーマル 73.5%・鬼 72.4%・金 71.0% にそろえた（2026-10-25、時計45秒・猶予0.4秒・気力1000）
  var GOLD = { aura: [3, 2, 2, 3], rich: 0.8, poor: 1.2 };
  function cpuDaruma(rand, style) {
    rand = rand || Math.random;
    var tempoStyle = style === 'tempo', oni = style === 'oni', gold = style === 'gold';
    var SEE_LAG = 3;
    var seen = [], ramp = false, willRamp = false, line = 0.5, rushAt = Infinity, bluff = false;
    function pickReward(st) {
      var q = st.stamina / st.staminaMax;
      var w = gold ? GOLD.aura : q < 0.3 ? [1, 2, 4, 3] : q > 0.7 ? [3, 3, 3, 1] : [2, 3, 3, 2];
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
      if (tempoStyle) {
        st.tempoValue = TEMPO.start[0] + rand() * (TEMPO.start[1] - TEMPO.start[0]) * (healthy ? 1 : 0.5);
        willRamp = false;
        rushAt = TEMPO.rushAt[0] + rand() * (TEMPO.rushAt[1] - TEMPO.rushAt[0]);
        bluff = rand() < TEMPO.bluff;
        line *= TEMPO.line;
      }
      if (oni) { st.tempoValue = ONI.tempo[0] + rand() * (ONI.tempo[1] - ONI.tempo[0]); willRamp = false; line *= ONI.line; }
      if (gold) line *= st.stamina > st.staminaMax * 0.5 ? GOLD.rich : GOLD.poor;
    }
    return {
      // ひと休みのあと、言い始める前
      onPrep: function (st) { st.reward = pickReward(st); seen = []; newPhrase(st); },
      // 見送りの「だ」でオーラを変える（予約していたもの）
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
        if (tempoStyle && !ramp) {
          if (v.run < 0.2 && st.chantProgress > 20 && st.tempoValue > TEMPO.slow) { st.tempoValue = TEMPO.slow; st.cpuThought += "（止まってるな…ゆっくり）"; }   // 遅くするのはただ
          else if (st.chantProgress >= rushAt && v.run >= 0.25 && (st.turnArmed || bluff)) { Core.applyTempoChange(P, st, 100); ramp = true; }
        }
      }
    };
  }

  // 学習しただるま（2026-10-26）：tools/coevolve.js で、だるまと子どもを一緒に進化させて覚えた作戦。子ども役で「つよい」を選んだときの相手
  //   作戦は数字の組（遺伝子。意味は tools/evolve.js）。見えるものは今の CPU と同じく 0.3 秒遅れ（学習のときは遅れなしだった）
  //   d1,d2：先頭の子の位置で3つに分ける境目／tFar,tMid,tNear：それぞれのテンポの段（0〜8 → 0〜100）／lowS,tLow：気力が減ったときのテンポ
  //   turnAt：先頭がここを越えたら振り向く。needRun：走っている子がいるときだけ／aHi,aLo,auraS：オーラ／amb,ambT,tAmb：振り向く回だけ、唱え終わりの ambT tick 前からテンポを変える
  //   種類ごとの遺伝子（2026-10-26、tools/league.js を 150 世代ずつ 2 本。強いほう）
  var LEARNED = {"normal":{"d1":0,"d2":0.009,"tFar":2,"tMid":8,"tNear":5,"lowS":0.729,"tLow":3,"turnAt":0.789,"needRun":1,"aHi":2,"aLo":0,"auraS":0.336,"amb":1,"ambT":12,"tAmb":7},"attack":{"d1":0.126,"d2":0.692,"tFar":3,"tMid":5,"tNear":3,"lowS":0.344,"tLow":1,"turnAt":0.781,"needRun":0,"aHi":1,"aLo":0,"auraS":0.053,"amb":1,"ambT":11,"tAmb":8},"oni":{"d1":0.621,"d2":0.924,"tFar":3,"tMid":2,"tNear":8,"lowS":0.026,"tLow":6,"turnAt":0.799,"needRun":0,"aHi":2,"aLo":0,"auraS":0.102,"amb":1,"ambT":11,"tAmb":8},"red":{"d1":0.161,"d2":0.586,"tFar":4,"tMid":4,"tNear":3,"lowS":0.117,"tLow":6,"turnAt":0.732,"needRun":1,"aHi":0,"aLo":2,"auraS":0.139,"amb":1,"ambT":12,"tAmb":8}};
  //   wob：回ごとの気まぐれ。振り向く線が ±wob ずれる（読まれにくくする。ふだん 0.08）
  function learnedDaruma(type, genes, rand, wob) {
    var g = genes || LEARNED[type] || LEARNED.normal;
    rand = rand || Math.random; wob = wob != null ? wob : 0.08;
    var SEE_LAG = 3, seen = [], lastSaid = -1, ambOn = false, line = g.turnAt;
    function newLine() { line = g.turnAt + (rand() * 2 - 1) * wob; }
    var LV = function (k) { return Math.max(0, Math.min(8, Math.round(k))) * 12.5; };
    function tempoFor(st, lead) {
      if (st.stamina / st.staminaMax < g.lowS) return LV(g.tLow);
      return LV(lead < g.d1 ? g.tFar : lead < g.d2 ? g.tMid : g.tNear);
    }
    function aura(st) { return TIERS[st.stamina / st.staminaMax >= g.auraS ? g.aHi : g.aLo]; }
    function setTempo(st, v) { if (Math.abs(v - st.tempoValue) > 0.5) Core.applyTempoChange(P, st, v); }
    function look(st) {
      return { lead: Math.max.apply(null, st.children.map(function (c) { return c.pos; })) / P.GOAL_POS,
        run: st.children.some(function (c) { return c.vel > P.CATCH_VEL_THRESHOLD; }) };
    }
    return {
      // ひと休みの間は、テンポを変えてもただ
      onPrep: function (st) { st.reward = aura(st); seen = []; st.tempoValue = tempoFor(st, look(st).lead); lastSaid = -1; ambOn = false; newLine(); },
      onCarry: function (st) { st.reward = aura(st); lastSaid = -1; ambOn = false; newLine(); },
      onTick: function (st) {
        seen.push(look(st));
        if (seen.length > SEE_LAG + 1) seen.shift();
        var v = seen[0];   // 0.3 秒前に見えたもの
        var afford = st.stamina >= Core.turnCostOf(P, st);
        st.turnArmed = afford && v.lead >= line && (!g.needRun || v.run);
        st.cpuThought = !afford ? "気力が足りない…" : st.turnArmed ? (g.needRun ? "走ってるな…振り向く" : "近い！振り向く") : v.lead < line ? "まだ遠い…見送る" : "みんな止まってる…見送る";
        var s = said(st), left = (100 - st.chantProgress) / Core.tempoFill(P, st.tempoValue);
        if (g.amb && st.turnArmed && !ambOn && left <= g.ambT) { setTempo(st, LV(g.tAmb)); ambOn = true; st.cpuThought += "（ここで変える！）"; return; }
        if (s !== lastSaid && !ambOn) { lastSaid = s; setTempo(st, tempoFor(st, v.lead)); }
      }
    };
  }

  // 学習した子ども（2026-10-26）：tools/coevolve.js で覚えた子どもの作戦。だるま役で「つよい」を選んだときの相手。体は人の子と同じ（ME）
  //   人の体の制約：テンポは耳で聞いて遅れて追いつく、押す・離すは 0.2 秒遅れて指に伝わる、変えたら 0.3 秒は次の変更なし、
  //   だるまが振り向くつもりかは見えない（見えるのは唱えた字・テンポ・オーラ・気力のゲージ）。遺伝子の意味は tools/coevolve.js
  //   使い方：k = learnedKid(遺伝子)。唱えている間は毎 tick k.tick(st, c)、振り向いて見ている間は k.look(c)
  //   種類ごとに 16 人（tools/league.js の 2 本の上位 8 人ずつ）。ゲームでは毎試合ここから 4 人ちがう子をくじで選ぶ
  var LEARNED_KIDS = {"normal":[{"m0":6.013,"m1":6.583,"m2":3.399,"m3":1.833,"spFar":3,"spNear":6,"near":0.489,"dStart":2,"dBrake":0,"dMin":0.049,"eLow":1,"spLow":8,"gray":1,"aTh":2.616,"aNear":30.449,"aBrake":1,"hold":37.723},{"m0":3.259,"m1":5.295,"m2":2.295,"m3":2.513,"spFar":3,"spNear":6,"near":0.489,"dStart":2,"dBrake":0,"dMin":0.049,"eLow":1,"spLow":8,"gray":1,"aTh":2.616,"aNear":35.413,"aBrake":0,"hold":37.723},{"m0":6.013,"m1":5.295,"m2":5.62,"m3":2.27,"spFar":2,"spNear":6,"near":0.489,"dStart":2,"dBrake":0,"dMin":0.049,"eLow":1,"spLow":8,"gray":1,"aTh":2.716,"aNear":35.486,"aBrake":1,"hold":37.308},{"m0":6.013,"m1":4.678,"m2":2.98,"m3":1.451,"spFar":3,"spNear":6,"near":0.449,"dStart":3,"dBrake":0,"dMin":0.08,"eLow":1,"spLow":8,"gray":1,"aTh":2.883,"aNear":35.413,"aBrake":0,"hold":37.371},{"m0":5.842,"m1":3.259,"m2":2.98,"m3":1.451,"spFar":3,"spNear":6,"near":0.489,"dStart":3,"dBrake":0,"dMin":0.073,"eLow":1,"spLow":8,"gray":1,"aTh":2.753,"aNear":35.413,"aBrake":0,"hold":35.213},{"m0":4.553,"m1":3.155,"m2":2.9,"m3":1.511,"spFar":4,"spNear":7,"near":0.478,"dStart":2,"dBrake":0,"dMin":0.049,"eLow":1,"spLow":8,"gray":1,"aTh":2.771,"aNear":35.039,"aBrake":1,"hold":36.298},{"m0":5.255,"m1":3.155,"m2":0,"m3":1.511,"spFar":4,"spNear":6,"near":0.773,"dStart":2,"dBrake":0,"dMin":0.049,"eLow":1,"spLow":8,"gray":1,"aTh":2.753,"aNear":35.083,"aBrake":1,"hold":39.343},{"m0":6.013,"m1":4.675,"m2":2.98,"m3":1.451,"spFar":3,"spNear":6,"near":0.489,"dStart":3,"dBrake":0,"dMin":0.08,"eLow":1,"spLow":8,"gray":1,"aTh":2.753,"aNear":35.413,"aBrake":0,"hold":37.723},{"m0":3.645,"m1":1.987,"m2":3.684,"m3":2.591,"spFar":8,"spNear":6,"near":1,"dStart":7,"dBrake":0,"dMin":0.903,"eLow":0.4,"spLow":8,"gray":1,"aTh":2.673,"aNear":22.988,"aBrake":1,"hold":6.977},{"m0":4.378,"m1":1.54,"m2":4.565,"m3":0,"spFar":8,"spNear":5,"near":1,"dStart":7,"dBrake":0,"dMin":0.914,"eLow":0.283,"spLow":8,"gray":1,"aTh":2.395,"aNear":32.245,"aBrake":0,"hold":4.534},{"m0":4.271,"m1":1.54,"m2":4.256,"m3":1.349,"spFar":8,"spNear":5,"near":1,"dStart":6,"dBrake":0,"dMin":0.903,"eLow":0.283,"spLow":8,"gray":1,"aTh":2.471,"aNear":30.71,"aBrake":0,"hold":6.977},{"m0":4.271,"m1":1.592,"m2":4.198,"m3":1.349,"spFar":8,"spNear":4,"near":1,"dStart":6,"dBrake":0,"dMin":0.849,"eLow":0.283,"spLow":8,"gray":1,"aTh":2.471,"aNear":29.698,"aBrake":0,"hold":8.932},{"m0":4.271,"m1":1.54,"m2":4.198,"m3":1.349,"spFar":8,"spNear":5,"near":1,"dStart":7,"dBrake":0,"dMin":0.903,"eLow":0.283,"spLow":8,"gray":1,"aTh":2.673,"aNear":29.326,"aBrake":0,"hold":6.977},{"m0":2.346,"m1":2.525,"m2":4.198,"m3":0,"spFar":8,"spNear":6,"near":1,"dStart":6,"dBrake":0,"dMin":0.849,"eLow":0.4,"spLow":8,"gray":1,"aTh":2.673,"aNear":22.988,"aBrake":0,"hold":6.977},{"m0":2.346,"m1":3.858,"m2":4.198,"m3":1.596,"spFar":8,"spNear":4,"near":1,"dStart":6,"dBrake":1,"dMin":0.849,"eLow":0.4,"spLow":8,"gray":1,"aTh":2.78,"aNear":20.044,"aBrake":0,"hold":7.788},{"m0":4.624,"m1":1.54,"m2":4.565,"m3":1.092,"spFar":8,"spNear":5,"near":1,"dStart":7,"dBrake":0,"dMin":0.914,"eLow":0.283,"spLow":8,"gray":1,"aTh":2.471,"aNear":29.698,"aBrake":1,"hold":6.655}],"attack":[{"m0":3.212,"m1":2.893,"m2":6.701,"m3":1.628,"spFar":8,"spNear":8,"near":0.081,"dStart":1,"dBrake":0,"dMin":0.994,"eLow":0.682,"spLow":8,"gray":1,"aTh":1.665,"aNear":0.283,"aBrake":0,"hold":8.712},{"m0":3.212,"m1":3.254,"m2":6.701,"m3":1.628,"spFar":7,"spNear":8,"near":0.081,"dStart":1,"dBrake":0,"dMin":0.994,"eLow":0.682,"spLow":8,"gray":1,"aTh":1.741,"aNear":0.283,"aBrake":0,"hold":8.712},{"m0":1.978,"m1":2.052,"m2":6.969,"m3":0,"spFar":6,"spNear":8,"near":0,"dStart":1,"dBrake":0,"dMin":1,"eLow":0.736,"spLow":8,"gray":1,"aTh":1.75,"aNear":0.283,"aBrake":0,"hold":10.651},{"m0":1.978,"m1":2.85,"m2":6.969,"m3":0,"spFar":6,"spNear":8,"near":0,"dStart":1,"dBrake":0,"dMin":0.97,"eLow":0.736,"spLow":8,"gray":1,"aTh":1.75,"aNear":1.336,"aBrake":1,"hold":10.651},{"m0":2.802,"m1":3.254,"m2":6.969,"m3":0,"spFar":7,"spNear":8,"near":0,"dStart":1,"dBrake":0,"dMin":0.994,"eLow":0.736,"spLow":8,"gray":1,"aTh":1.741,"aNear":0.283,"aBrake":0,"hold":8.712},{"m0":2.31,"m1":5.616,"m2":8.661,"m3":2.213,"spFar":7,"spNear":8,"near":0,"dStart":1,"dBrake":0,"dMin":0.994,"eLow":0.682,"spLow":8,"gray":1,"aTh":1.696,"aNear":0.283,"aBrake":0,"hold":10.017},{"m0":1.259,"m1":2.85,"m2":4.709,"m3":7.085,"spFar":6,"spNear":8,"near":0,"dStart":2,"dBrake":1,"dMin":0.994,"eLow":0.691,"spLow":8,"gray":1,"aTh":1.05,"aNear":0.288,"aBrake":0,"hold":13.614},{"m0":1.963,"m1":4.854,"m2":6.701,"m3":2.087,"spFar":7,"spNear":8,"near":0,"dStart":1,"dBrake":0,"dMin":0.994,"eLow":0.736,"spLow":8,"gray":1,"aTh":1.488,"aNear":0.922,"aBrake":0,"hold":10.277},{"m0":12.584,"m1":3.964,"m2":0.856,"m3":8.176,"spFar":8,"spNear":8,"near":0,"dStart":5,"dBrake":1,"dMin":0.957,"eLow":0.427,"spLow":2,"gray":1,"aTh":1.906,"aNear":28.768,"aBrake":1,"hold":0.177},{"m0":8.829,"m1":2.757,"m2":0,"m3":8.658,"spFar":8,"spNear":8,"near":0.077,"dStart":5,"dBrake":1,"dMin":0.957,"eLow":0.217,"spLow":2,"gray":1,"aTh":2.498,"aNear":23.42,"aBrake":1,"hold":0},{"m0":10.893,"m1":2.044,"m2":0,"m3":8.075,"spFar":8,"spNear":8,"near":0,"dStart":5,"dBrake":0,"dMin":0.957,"eLow":0.321,"spLow":1,"gray":1,"aTh":1.971,"aNear":23.42,"aBrake":1,"hold":3.777},{"m0":7.07,"m1":4.128,"m2":1.291,"m3":8.607,"spFar":8,"spNear":8,"near":0,"dStart":4,"dBrake":0,"dMin":0.916,"eLow":0.27,"spLow":2,"gray":1,"aTh":1.962,"aNear":21.446,"aBrake":0,"hold":0.145},{"m0":6.901,"m1":4.216,"m2":0,"m3":7.916,"spFar":8,"spNear":8,"near":0.031,"dStart":5,"dBrake":1,"dMin":0.957,"eLow":0.318,"spLow":2,"gray":1,"aTh":2.593,"aNear":23.42,"aBrake":1,"hold":0.152},{"m0":9.233,"m1":2.757,"m2":1.239,"m3":9.605,"spFar":8,"spNear":8,"near":0.061,"dStart":4,"dBrake":0,"dMin":0.957,"eLow":0.217,"spLow":2,"gray":1,"aTh":2.405,"aNear":23.506,"aBrake":1,"hold":0.719},{"m0":8.157,"m1":4.338,"m2":0,"m3":11.549,"spFar":7,"spNear":8,"near":0.086,"dStart":5,"dBrake":1,"dMin":0.834,"eLow":0.361,"spLow":1,"gray":1,"aTh":1.971,"aNear":23.94,"aBrake":1,"hold":3.777},{"m0":4.916,"m1":4.128,"m2":0.804,"m3":8.075,"spFar":8,"spNear":8,"near":0,"dStart":4,"dBrake":0,"dMin":0.916,"eLow":0.27,"spLow":2,"gray":1,"aTh":1.962,"aNear":23.104,"aBrake":1,"hold":0}],"oni":[{"m0":10.422,"m1":14.571,"m2":3.948,"m3":5.384,"spFar":7,"spNear":8,"near":0,"dStart":6,"dBrake":1,"dMin":1,"eLow":0.005,"spLow":1,"gray":1,"aTh":1.111,"aNear":13.007,"aBrake":0,"hold":0},{"m0":9.349,"m1":8.124,"m2":3.948,"m3":3.723,"spFar":7,"spNear":8,"near":0.044,"dStart":6,"dBrake":1,"dMin":1,"eLow":0,"spLow":2,"gray":1,"aTh":1.276,"aNear":15.675,"aBrake":0,"hold":12.884},{"m0":7.945,"m1":10.5,"m2":9.645,"m3":5.731,"spFar":7,"spNear":8,"near":0.073,"dStart":6,"dBrake":1,"dMin":1,"eLow":0.033,"spLow":1,"gray":1,"aTh":1.316,"aNear":11.61,"aBrake":0,"hold":2.224},{"m0":7.554,"m1":7.416,"m2":12.029,"m3":3.723,"spFar":7,"spNear":8,"near":0.03,"dStart":6,"dBrake":1,"dMin":1,"eLow":0.033,"spLow":1,"gray":1,"aTh":1.05,"aNear":11.61,"aBrake":1,"hold":4.337},{"m0":7.945,"m1":10.448,"m2":12.123,"m3":3.723,"spFar":7,"spNear":8,"near":0.106,"dStart":6,"dBrake":1,"dMin":0.971,"eLow":0.033,"spLow":1,"gray":1,"aTh":1.191,"aNear":11.61,"aBrake":0,"hold":5.656},{"m0":7.554,"m1":7.416,"m2":8.758,"m3":4.6,"spFar":7,"spNear":8,"near":0.03,"dStart":6,"dBrake":1,"dMin":1,"eLow":0.046,"spLow":1,"gray":1,"aTh":1.05,"aNear":12.911,"aBrake":0,"hold":4.337},{"m0":7.945,"m1":11.402,"m2":11.959,"m3":4.562,"spFar":7,"spNear":8,"near":0.1,"dStart":6,"dBrake":1,"dMin":0.971,"eLow":0.033,"spLow":1,"gray":1,"aTh":1.191,"aNear":11.61,"aBrake":0,"hold":8.036},{"m0":7.945,"m1":10.612,"m2":11.959,"m3":5.731,"spFar":7,"spNear":8,"near":0.106,"dStart":6,"dBrake":1,"dMin":0.971,"eLow":0.033,"spLow":1,"gray":1,"aTh":1.191,"aNear":11.61,"aBrake":0,"hold":8.036},{"m0":3.699,"m1":1.417,"m2":8.066,"m3":2.113,"spFar":8,"spNear":8,"near":0.877,"dStart":0,"dBrake":0,"dMin":0.431,"eLow":0.077,"spLow":4,"gray":1,"aTh":1.052,"aNear":2.06,"aBrake":0,"hold":0},{"m0":3.699,"m1":1.417,"m2":8.066,"m3":0,"spFar":8,"spNear":8,"near":0.877,"dStart":1,"dBrake":0,"dMin":0.319,"eLow":0.104,"spLow":4,"gray":1,"aTh":1.052,"aNear":4.39,"aBrake":0,"hold":7.967},{"m0":1.242,"m1":1.417,"m2":2.564,"m3":0,"spFar":8,"spNear":8,"near":0.877,"dStart":0,"dBrake":0,"dMin":0.249,"eLow":0.093,"spLow":4,"gray":1,"aTh":1.052,"aNear":13.667,"aBrake":0,"hold":0},{"m0":0,"m1":0,"m2":0.018,"m3":0,"spFar":8,"spNear":8,"near":0.758,"dStart":0,"dBrake":0,"dMin":0.28,"eLow":0.104,"spLow":3,"gray":1,"aTh":1.734,"aNear":13.667,"aBrake":0,"hold":0.615},{"m0":0,"m1":1.417,"m2":8.066,"m3":0,"spFar":8,"spNear":8,"near":0.769,"dStart":1,"dBrake":0,"dMin":0.28,"eLow":0.057,"spLow":4,"gray":1,"aTh":1.137,"aNear":4.39,"aBrake":0,"hold":7.967},{"m0":0,"m1":1.417,"m2":7.865,"m3":0,"spFar":8,"spNear":8,"near":0.877,"dStart":0,"dBrake":0,"dMin":0.322,"eLow":0.121,"spLow":4,"gray":1,"aTh":1.137,"aNear":4.39,"aBrake":0,"hold":0},{"m0":1.874,"m1":1.417,"m2":9.856,"m3":0,"spFar":8,"spNear":8,"near":0.877,"dStart":0,"dBrake":0,"dMin":0.322,"eLow":0.121,"spLow":4,"gray":1,"aTh":1.154,"aNear":4.39,"aBrake":0,"hold":0},{"m0":3.699,"m1":1.417,"m2":8.066,"m3":0,"spFar":8,"spNear":8,"near":0.877,"dStart":0,"dBrake":0,"dMin":0.322,"eLow":0.121,"spLow":4,"gray":1,"aTh":1.052,"aNear":4.39,"aBrake":0,"hold":0}],"red":[{"m0":4.311,"m1":10.966,"m2":3.1,"m3":4.456,"spFar":7,"spNear":0,"near":0.997,"dStart":1,"dBrake":0,"dMin":0.068,"eLow":0.986,"spLow":8,"gray":1,"aTh":2.947,"aNear":27.708,"aBrake":1,"hold":20.101},{"m0":4.311,"m1":10.966,"m2":2.517,"m3":4.669,"spFar":7,"spNear":0,"near":1,"dStart":2,"dBrake":0,"dMin":0.131,"eLow":0.967,"spLow":8,"gray":1,"aTh":2.947,"aNear":27.708,"aBrake":1,"hold":20.101},{"m0":3.648,"m1":7.84,"m2":4.148,"m3":0,"spFar":6,"spNear":0,"near":0.964,"dStart":1,"dBrake":0,"dMin":0.398,"eLow":0.967,"spLow":8,"gray":1,"aTh":3,"aNear":29.151,"aBrake":0,"hold":26.407},{"m0":2.946,"m1":7.84,"m2":5.905,"m3":0,"spFar":6,"spNear":0,"near":0.915,"dStart":2,"dBrake":0,"dMin":0.404,"eLow":0.981,"spLow":8,"gray":1,"aTh":2.845,"aNear":29.151,"aBrake":1,"hold":15.13},{"m0":4.311,"m1":10.966,"m2":2.517,"m3":4.456,"spFar":7,"spNear":1,"near":0.997,"dStart":1,"dBrake":0,"dMin":0.131,"eLow":0.977,"spLow":8,"gray":1,"aTh":2.741,"aNear":30.285,"aBrake":1,"hold":20.101},{"m0":5.001,"m1":8.378,"m2":5.008,"m3":0,"spFar":6,"spNear":0,"near":0.973,"dStart":1,"dBrake":0,"dMin":0.351,"eLow":0.967,"spLow":8,"gray":1,"aTh":3,"aNear":30.968,"aBrake":0,"hold":24.807},{"m0":4.311,"m1":10.966,"m2":2.517,"m3":4.456,"spFar":7,"spNear":0,"near":0.997,"dStart":1,"dBrake":0,"dMin":0.131,"eLow":0.967,"spLow":8,"gray":1,"aTh":2.947,"aNear":27.708,"aBrake":1,"hold":20.101},{"m0":6.573,"m1":10.281,"m2":5.883,"m3":0,"spFar":6,"spNear":1,"near":0.954,"dStart":2,"dBrake":0,"dMin":0.413,"eLow":0.967,"spLow":8,"gray":1,"aTh":3,"aNear":30.549,"aBrake":1,"hold":24.528},{"m0":5.14,"m1":5.166,"m2":1.768,"m3":0,"spFar":8,"spNear":8,"near":0.691,"dStart":6,"dBrake":0,"dMin":0.19,"eLow":0.192,"spLow":8,"gray":0,"aTh":1.141,"aNear":13.261,"aBrake":1,"hold":16.969},{"m0":4.313,"m1":3.472,"m2":3.639,"m3":0,"spFar":8,"spNear":8,"near":0.755,"dStart":6,"dBrake":0,"dMin":0.19,"eLow":0.08,"spLow":8,"gray":1,"aTh":1.141,"aNear":13.261,"aBrake":1,"hold":21.231},{"m0":4.313,"m1":5.166,"m2":1.712,"m3":0,"spFar":8,"spNear":8,"near":0.755,"dStart":4,"dBrake":0,"dMin":0.138,"eLow":0.24,"spLow":8,"gray":1,"aTh":1.141,"aNear":16.646,"aBrake":1,"hold":24.135},{"m0":3.076,"m1":5.166,"m2":2.805,"m3":0,"spFar":8,"spNear":8,"near":0.755,"dStart":6,"dBrake":0,"dMin":0.169,"eLow":0.233,"spLow":8,"gray":1,"aTh":1.08,"aNear":22.138,"aBrake":1,"hold":24.135},{"m0":3.076,"m1":5.166,"m2":0.315,"m3":0.241,"spFar":8,"spNear":8,"near":0.696,"dStart":6,"dBrake":0,"dMin":0.176,"eLow":0.233,"spLow":8,"gray":0,"aTh":1.08,"aNear":18.854,"aBrake":1,"hold":24.313},{"m0":2.204,"m1":5.166,"m2":0.315,"m3":0.241,"spFar":8,"spNear":8,"near":0.696,"dStart":6,"dBrake":0,"dMin":0.176,"eLow":0.279,"spLow":8,"gray":0,"aTh":1.08,"aNear":18.854,"aBrake":1,"hold":28.98},{"m0":3.86,"m1":5.502,"m2":1.768,"m3":0,"spFar":8,"spNear":7,"near":0.679,"dStart":6,"dBrake":0,"dMin":0.176,"eLow":0.18,"spLow":8,"gray":0,"aTh":1.198,"aNear":15.408,"aBrake":1,"hold":24.916},{"m0":4.313,"m1":5.166,"m2":1.768,"m3":0,"spFar":8,"spNear":8,"near":0.755,"dStart":6,"dBrake":0,"dMin":0.19,"eLow":0.08,"spLow":8,"gray":1,"aTh":1.141,"aNear":13.261,"aBrake":1,"hold":23.856}]};
  var KID_REACT = 2, KID_HOLD = 3;
  //   wob：回ごとの気まぐれ。離す余裕が ±wob 秒ずれる（4人がそろって動かないように。ふだん 0.3）
  function learnedKid(g, rand, wob) {
    rand = rand || Math.random; wob = wob != null ? wob : 0.3;
    var off = 0, pf = null, queue = [], cur = { v: 0, b: false }, lastChange = -99, t = 0, runT = 0, lastCP = 999, heard = [], alarm = false, held = false, wasRun = false, react = 0;
    var spd = function (k) { return Math.max(0, Math.min(8, Math.round(k))) / 8; };
    return {
      tick: function (st, me) {
        t++; react = KID_REACT;
        var fill = Core.tempoFill(P, st.tempoValue);
        heard.push(fill); if (heard.length > KID_REACT + 1) heard.shift();
        var fillHeard = heard[0];   // 早口に気づくのは KID_REACT tick 遅れ
        if (st.chantProgress < lastCP) { runT = 0; alarm = false; held = false; off = (rand() * 2 - 1) * wob * 10; } lastCP = st.chantProgress;
        if (pf != null && !alarm && fillHeard >= pf * g.aTh && (100 - st.chantProgress) / fillHeard <= g.aNear) alarm = true;
        pf = pf == null ? fill : pf + (fill - pf) / 6;   // 耳で聞いたテンポ（遅れて追いつく）
        var aura = TIERS.indexOf(st.reward), grayNow = st.stamina < Core.turnCostOf(P, st);
        var left = (100 - st.chantProgress) / pf;
        var stopNeed = Math.max(0, (me.vel - P.CATCH_VEL_THRESHOLD) / (me.brake * (g.dBrake ? P.BOOST_BRAKE_MULT : 1)));
        var run = !alarm && !held && ((g.gray && grayNow) || left > stopNeed + Math.max(0, g["m" + aura] + off));
        if (wasRun && !run && left <= g.hold) held = true;   // 唱え終わり近くで止まった：この回はもう走らない
        wasRun = run;
        var e = me.energy / me.energyMax, prog = me.pos / P.GOAL_POS, v = 0, b = false;
        if (run) { v = spd(e < g.eLow ? g.spLow : prog >= g.near ? g.spNear : g.spFar); runT++; b = runT <= g.dStart && e >= g.dMin; }
        else { runT = 0; b = (!!g.dBrake || (alarm && !!g.aBrake)) && e >= g.dMin && me.vel > P.CATCH_VEL_THRESHOLD; }
        queue.push({ v: v, b: b, at: t + KID_REACT });   // 指に伝わるのは KID_REACT tick あと。変えたら KID_HOLD tick は次の変更なし
        while (queue.length && queue[0].at <= t) {
          var w = queue.shift();
          if ((w.v > 0) !== (cur.v > 0) || w.b !== cur.b) { if (t - lastChange < KID_HOLD) continue; lastChange = t; }
          cur = { v: w.v, b: w.b };
        }
        me.boost = cur.b && cur.v > 0 ? true : cur.b;
        me.input = cur.v;
      },
      // 振り向いたのを見て、0.2 秒で指を離す
      look: function (me) { if (react-- <= 0) { me.input = 0; me.boost = false; cur = { v: 0, b: false }; queue = []; } }
    };
  }

  return {
    Core: Core, P: P, TIERS: TIERS, ME: ME, BODY: BODY, BODY_POINTS: BODY_POINTS, BODY_KEYS: BODY_KEYS, bodyOk: bodyOk, LEARNED: LEARNED, learnedDaruma: learnedDaruma, LEARNED_KIDS: LEARNED_KIDS, learnedKid: learnedKid,
    humanStop: humanStop, setMe: setMe, newGame: newGame, newGameSeats: newGameSeats,
    LOOK: LOOK, wantsTurn: wantsTurn, startLook: startLook, lookTick: lookTick, endLook: endLook, resolve: resolve, applyReserved: applyReserved,
    said: said, cpuDaruma: cpuDaruma, TEMPO: TEMPO, ONI: ONI, GOLD: GOLD
  };
});
