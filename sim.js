"use strict";
// だるまのシミュレーター（2026-10-18）。ゲーム（index.html）と同じ rules.js で、同じ順番に進める：
//   言っている間は 0.1 秒ずつ進む → 言い終わり → 振り向くなら見逃しの間（GRACE）だけ進めてから見る
//   → 見送りなら止まらず「だ」から続く（強気度は予約したもの）／振り向いたらひと休み（時間は止まる）
// old/daruma-sim.js は前の決まりのまま残してある。
//
//   node sim.js                     いつもの表（だるまの作戦ごと）。何も指定しなければゲームの今の値
//   node sim.js sweep               猶予 × 時計 の表（GRACES=0.1,0.2 などで猶予を並べる）
//   node sim.js kid                 子ども役：人っぽい子 1人＋CPU の子 3人 対 ゲームの CPU のだるま
//   node sim.js check               シミュレーターの確かめ（下の check を見る）
// 数字は環境変数で変えられる：N（局数）、KIDS（子どもの人数、ふだん 4）、CLOCK（秒）、KNOCK（下がる量。start ならスタートへ）、GRACE（秒）、
//   OLD=1（前の決まり：見送りで「だ」をつながない・止まり方は元のまま・見逃しなし）

const R = require("./rules.js");
const Core = R.Core, P = R.P;
const env = (k, d) => (process.env[k] != null ? process.env[k] : d);
const N = +env("N", 500);
const OLD = env("OLD", "0") === "1";

// ---------- だるまの作戦 ----------
// 見ているのは描かれた位置だけ（old/daruma-sim.js の smart_human と同じ見方）
function reader(opt) {
  opt = opt || {};
  const CREEP = opt.creep || 65, WIN = 8, EPS = 0.4;
  // 見てから「振り向く／見送る」を押すまでの遅れ（人は 0.3 秒くらい）。REACT=0 で前の作りと同じ
  const REACT = +env("REACT", 3);
  let log = [], ramped = false, wants = [];
  const lead = now => { let k = 0; for (let i = 1; i < now.length; i++) if (now[i] > now[k]) k = i; return k; };
  const prep = st => {
    const healthy = st.stamina > st.staminaMax * 0.5;
    st.reward = healthy ? "high" : "low";
    Core.applyTempoChange(P, st, healthy ? 55 : 25);
    ramped = false;
  };
  return {
    onPrep(st) { log = []; wants = []; prep(st); },
    // 見送ったとき：次の強気度は予約していたもの（ここで選ぶ）。テンポは変えると気力を使うので、そのまま
    // テンポは、速めていたら元に戻す（下げるのはただ）
    onCarry(st) { const healthy = st.stamina > st.staminaMax * 0.5; st.reward = healthy ? "high" : "low";
      if (ramped || st.tempoValue > (healthy ? 55 : 25)) Core.applyTempoChange(P, st, healthy ? 55 : 25); ramped = false; },
    onTick(st) {
      log.push(st.children.map(c => c.pos)); if (log.length > WIN + 1) log.shift();
      // 見るのは、先頭の子の位置と、走っている子がいるか（足が動いているかで見える）だけ。
      // 「ブレーキを踏み始めたか」は人には見分けられないので使わない（2026-10-18）
      const now = log[log.length - 1], i = lead(now);
      const running = st.children.some(c => c.vel > P.CATCH_VEL_THRESHOLD);
      const want = now[i] >= CREEP && running;
      wants.push(want);
      st.turnArmed = wants.length > REACT ? wants[wants.length - 1 - REACT] : st.turnArmed;
      const left = (100 - st.chantProgress) / Core.tempoFill(P, 100);
      if (opt.ambush && want && !ramped && left <= 6) { Core.applyTempoChange(P, st, 100); ramped = true; }
      if (opt.feint && !want && !ramped && left <= 6) { Core.applyTempoChange(P, st, 100); ramped = true; }
    }
  };
}
const POLICIES = {
  "人間の読み": () => reader(),
  "読み＋振り向く回に加速": () => reader({ ambush: true }),
  "読み＋見送る回に加速": () => reader({ feint: true }),
  "ゲームの CPU のだるま": () => R.cpuDaruma(),
  "毎回振り向く": () => ({ onPrep(st) { st.reward = "low"; Core.applyTempoChange(P, st, 50); }, onCarry() {}, onTick(st) { st.turnArmed = true; } }),
  "絶対振り向かない": () => ({ onPrep(st) { st.reward = "max"; Core.applyTempoChange(P, st, 50); }, onCarry() {}, onTick(st) { st.turnArmed = false; } }),
  "でたらめ": () => ({
    onPrep(st) { st.reward = R.TIERS[Math.floor(Math.random() * 4)]; Core.applyTempoChange(P, st, Math.random() * 100); },
    onCarry(st) { st.reward = R.TIERS[Math.floor(Math.random() * 4)]; },
    onTick(st) { if (Math.random() < 0.05) Core.applyTempoChange(P, st, Math.random() * 100); if (Math.random() < 0.03) st.turnArmed = !st.turnArmed; }
  })
};

// ---------- 人っぽい子ども ----------
// 耳でテンポを感じて「あと何秒で言い終わるか」を見積もり、止まるのにかかる時間（0.5 秒）＋反応（0.2 秒）＋
// 気持ちの余裕 だけ前に指を離す。テンポの感じ取りは少し遅れる（終わりぎわに速められると遅れる）。
// 余裕は毎回ばらつく。光（強気度）が強いと欲ばる。気力が足りないだるまなら最後まで走る。見送られたら走り続ける
// dash（2026-10-23）：'brake' は体力が足りれば上半分で離して急ブレーキ（そのぶんぎりぎりまで走る）、
//   'both' は走り出しもダッシュ。体力が DASH_MIN より少ないときは、ふつうに走って止まる
const DASH_MIN = +env("DASH_MIN", 40);
function humanKid(style, dash) {
  const base = { careful: 4, normal: 2, bold: 0.5 }[style || "normal"];
  // 人は「あと何秒」を正確には読めない。毎回のずれ（ふつう分布・0.25 秒）
  const gauss = () => { let u = 0; for (let k = 0; k < 6; k++) u += Math.random(); return (u - 3) / Math.sqrt(0.5); };
  let last = 999, margin = 2, pf = null;
  return st => {
    const fill = Core.tempoFill(P, st.tempoValue);
    pf = pf == null ? fill : pf + (fill - pf) / 6;
    if (st.chantProgress < last) { // 言い始め（見送りの「だ」からも）
      const li = R.TIERS.indexOf(st.reward);
      margin = base - (li - 1.5) * 1 + gauss() * 2.5;
    }
    last = st.chantProgress;
    if (st.stamina < Core.turnCostOf(P, st)) return true;
    const ticksLeft = (100 - st.chantProgress) / pf;
    // 止まるのにかかる時間は、いまの速さから（体で覚えている）
    const me = st.children.find(c => c.human);
    const useDash = !!dash && me.energy >= DASH_MIN;
    const stopTicks = Math.max(0, (me.vel - P.CATCH_VEL_THRESHOLD) / (me.brake * (useDash ? P.BOOST_BRAKE_MULT : 1)));
    const run = ticksLeft > stopTicks + 2 + margin;
    me.boost = useDash && (!run || dash === "both");
    return run;
  };
}

// ---------- 1局 ----------
function play(policy, opt) {
  opt = opt || {};
  P.GOAL_TICKS = Math.round((opt.clock || 40) * 10);
  P.CATCH_KNOCK = opt.knock == null ? null : opt.knock;
  if (opt.grace != null) R.LOOK.grace = Math.round(opt.grace * 10);
  const kids = opt.kids || +env("KIDS", 4);
  const st = R.newGame({ withMe: !!opt.kid, kids, lane: kids - 1, cpuStop: OLD ? [0, 0] : undefined });
  if (OLD) { // 止まり方を元の値に戻す
    const defs = Object.fromEntries(Core.ROSTER.map(d => [d.id, d]));
    st.children.forEach(c => { if (defs[c.id]) c.brake = defs[c.id].brake; });
  }
  const me = st.children.find(c => c.human);
  policy.onPrep(st);
  let res = null;
  for (let t = 0; t < 20000; t++) {
    if (me) me.input = opt.kid(st);
    res = Core.tick(P, st);
    if (res.reached) return { win: "kid", by: res.reached, st };
    if (res.timeUp) return { win: "daruma", st };
    if (res.chantDone) {
      let out;
      if (OLD) { out = Core.resolveCycle(P, st); out.carry = false; }
      else if (R.wantsTurn(st)) {
        // 振り向いて見る。人っぽい子は、振り向いたのを見て 0.2 秒で指を離す
        R.startLook(st);
        let react = 2;
        for (;;) {
          if (me) me.input = me.input && react-- > 0;
          const r2 = R.lookTick(st);
          if (r2.reached) return { win: "kid", by: r2.reached, st };
          if (r2.done) break;
        }
        out = R.endLook(st);
      } else out = R.resolve(st);
      if (out.carry) policy.onCarry(st);
      else { R.applyReserved(st); policy.onPrep(st); }
    } else policy.onTick(st);
  }
  return { win: "none", st };
}

function batch(name, mk, opt, n) {
  n = n || N;
  let dw = 0, cyc = 0, catches = 0, turned = 0, resolved = 0, whiff = 0, meWin = 0, meCaught = 0, endLeft = 0;
  for (let i = 0; i < n; i++) {
    const kidFn = opt.kid ? opt.kid() : null;
    const r = play(mk(), Object.assign({}, opt, { kid: kidFn }));
    if (r.win === "daruma") dw++;
    if (r.by && r.by.human) meWin++;
    cyc += r.st.cycle - 1; catches += r.st.catches; turned += r.st.turnedCycles; resolved += r.st.resolvedCycles; whiff += r.st.whiffedTurns;
    if (r.win === "kid") endLeft += (P.GOAL_TICKS - r.st.elapsedTicks) / 10;
  }
  return { name, n, daruma: dw / n, cyc: cyc / n, catches: catches / n, turnRate: turned / Math.max(1, resolved), whiffRate: whiff / Math.max(1, turned), meWin: meWin / n, endLeft: endLeft / Math.max(1, n - dw) };
}
const pct = x => (100 * x).toFixed(0).padStart(3) + "%";
// 勝率の誤差（95%）。N=500 なら ±4% くらい
const ci = (p, n) => 1.96 * Math.sqrt(p * (1 - p) / n);

function table(opt) {
  console.log(`時計 ${opt.clock || 40}秒・捕まったら ${opt.knock == null ? "スタートへ" : opt.knock + " 下がる"}・猶予 ${OLD ? 0 : (opt.grace != null ? opt.grace : R.LOOK.grace / 10)}秒${OLD ? "（前の決まり）" : ""}  各${N}局`);
  for (const [name, mk] of Object.entries(POLICIES)) {
    const b = batch(name, mk, opt);
    console.log(`  ${name.padEnd(14, "　")} だるまの勝ち ${pct(b.daruma)}（±${(100 * ci(b.daruma, b.n)).toFixed(0)}）  言った回数 ${b.cyc.toFixed(1)}  捕まえた ${b.catches.toFixed(1)}  振り向いた ${pct(b.turnRate)}  空振り ${pct(b.whiffRate)}`);
  }
}

const mode = process.argv[2] || "table";
const knockArg = v => (v === "start" ? null : +v);
// 何も指定しないときは、ゲーム（index.html）の今の値：時計 46 秒・猶予 0.3 秒・だるまの前で見つかったら 24 下がる（遠いほど少なく、スタートで約10）
const GAME = { clock: 46, grace: 0.3, knock: "24" };
const MAIN = require.main === module;   // ほかのファイルから読みこんだときは、表を出さない
if (MAIN && mode === "table") table({ clock: +env("CLOCK", GAME.clock), knock: knockArg(env("KNOCK", GAME.knock)), grace: +env("GRACE", GAME.grace) });
if (MAIN && mode === "sweep") {
  // 猶予（振り向き始めてから見つかるまで）× 時計
  const clocks = env("CLOCKS", "42,44,46,48,50").split(",").map(Number);
  const graces = env("GRACES", String(GAME.grace)).split(",").map(Number);
  const knock = knockArg(env("KNOCK", GAME.knock));
  const pols = env("POLS", "人間の読み,ゲームの CPU のだるま,でたらめ,毎回振り向く,絶対振り向かない").split(",");
  for (const g of graces) {
    R.LOOK.grace = Math.round(g * 10);
    console.log(`
猶予 ${g}秒・捕まったら ${knock == null ? "スタートへ" : knock + " 下がる"}（だるまの勝ち・各${N}局）`);
    console.log("  " + "作戦".padEnd(14, "　") + clocks.map(c => (c + "秒").padStart(6)).join(""));
    for (const p of pols) {
      const row = clocks.map(c => pct(batch(p, POLICIES[p], { clock: c, knock }).daruma).padStart(6)).join("");
      console.log("  " + p.padEnd(14, "　") + row);
    }
    if (env("KIDROW", "1") === "1") {
      const row = clocks.map(c => pct(1 - batch("k", POLICIES["ゲームの CPU のだるま"], { clock: c, knock, kid: () => humanKid("normal") }).daruma).padStart(6)).join("");
      console.log("  " + "（子ども役）ふつうの子の勝ち".padEnd(14, "　") + row);
    }
  }
}
if (MAIN && mode === "kid") {
  const clock = +env("CLOCK", GAME.clock), knock = knockArg(env("KNOCK", GAME.knock));
  R.LOOK.grace = Math.round(+env("GRACE", GAME.grace) * 10);
  console.log(`子ども役：人っぽい子 1人＋CPU の子 3人 対 ゲームの CPU のだるま。時計 ${clock}秒・捕まったら ${knock == null ? "スタートへ" : knock + " 下がる"}  各${N}局`);
  const dashes = env("DASH", "none,brake,both").split(","), styles = env("STYLES", "careful,normal,bold").split(",");
  const pols = env("POLS", "ゲームの CPU のだるま").split(",");
  for (const pol of pols) for (const d of dashes) for (const style of styles) {
    const b = batch(style, POLICIES[pol], { clock, knock, kid: () => humanKid(style, d === "none" ? null : d) });
    console.log(`  ${pol}／ダッシュ ${{ none: "なし", brake: "止まるだけ", both: "走り出しも" }[d]}／人っぽい子（${{ careful: "慎重", normal: "ふつう", bold: "強気" }[style]}） 子どもの勝ち ${pct(1 - b.daruma)}  うち人っぽい子がタッチ ${pct(b.meWin)}  捕まえた ${b.catches.toFixed(1)}`);
  }
}
if (MAIN && mode === "check") {
  // ① 前の決まりに戻すと、前のシミュレーター（old/daruma-sim.js）と同じ数字が出るか
  //    前の結果（4人をくじ・各400局）：人間の読み 83%・毎回振り向く 37%・絶対振り向かない 5%
  process.env.OLD = "1";
}
module.exports = { play, batch, POLICIES, humanKid };
