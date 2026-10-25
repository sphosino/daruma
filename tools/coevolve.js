"use strict";
// だるまと子どもを一緒に進化させる（2026-10-25）。だるまだけ鍛えると、決まった子どものくせをつく作戦ばかり覚えるので、
//   子どもも鍛えて、お互いに強くする。昔の強者も対戦相手に混ぜて、作戦がぐるぐる回るのを防ぐ
//   子どもの AI には人の体の制約をかける（いじれない）：
//     ・「あと何秒で唱え終わるか」は耳で聞いたテンポで見積もり、テンポが変わっても気づくのは遅れる
//     ・押す・離すは、決めてから 0.25 秒たって指に伝わる。押し方を変えたら 0.3 秒は次の変更ができない
//     ・だるまが振り向くつもりかどうかは見えない（見えるのは唱えた字・テンポ・オーラ・気力のゲージ）
//   だるまの作戦の形は tools/evolve.js と同じ（テンポ 9 段階、変えるのは 1 文字ごと）
//
//   node tools/coevolve.js [世代数] [1組あたりの試合数]     例：node tools/coevolve.js 30 40
const path = require("path");
const sim = require(path.join(__dirname, "..", "sim.js"));
const R = require(path.join(__dirname, "..", "rules.js"));
const E = require("./evolve.js");
const Core = R.Core, P = R.P;
if (process.env.NOREGEN === "1") P.TEMPO_REGEN_SLOWEST = 0;   // 気力の自動回復なしで比べる
if (process.env.SLOWCOST) P.TEMPO_SLOW_COST_PER_UNIT = +process.env.SLOWCOST;   // 唱えている途中で遅くするコスト（1 につき）
if (process.env.UPCOST) P.TEMPO_CHANGE_COST_PER_UNIT = +process.env.UPCOST;   // 唱えている途中で速くするコスト（1 につき。ふだん 0.23）
const GENS = +(process.argv[2] || 30), GAMES = +(process.argv[3] || 40), POP = 24, KEEP = 8, HOF = 6;
const GAME = { ...E.GAME, type: process.env.TYPE || "normal" };
const SPD = (k) => Math.max(0, Math.min(8, Math.round(k))) / 8;   // 走る速さ 9 段階（0〜1）

// ---------- 子どもの遺伝子 ----------
// m0..m3：オーラ（弱・中・強・全開）ごとの余裕。唱え終わりの何 tick 前（0.1 秒）に離すか（止まるのにかかる分は別に足す）
// spFar,spNear：ゴールが遠いとき・近いときの速さの段（0〜8）。near：その境目（0〜1）
// dStart：走り出しの dStart tick はダッシュ。dBrake：止まるときダッシュ（急ブレーキ）を使う（0/1）。dMin：使うのは体力がこれ（0〜1）以上のとき
// eLow,spLow：体力がこれを切ったら、この速さに落とす
// gray：だるまの気力が足りない（灰色）ときは走り抜ける（0/1）
// 早口への返し技（2026-10-25）：aTh 聞こえるテンポが、慣れていたテンポの何倍になったら「早口だ」と思うか（気づくのは REACT tick 遅れ）
//   aNear 唱え終わりまであと何 tick 以内なら反応するか。aBrake 気づいたら急ブレーキ（ダッシュ）で止まるか（0/1）。その回は、もう走らない
const KGENES = { m0: [0, 25], m1: [0, 25], m2: [0, 25], m3: [0, 25], spFar: [0, 8], spNear: [0, 8], near: [0, 1],
  dStart: [0, 8], dBrake: [0, 1], dMin: [0, 1], eLow: [0, 1], spLow: [0, 8], gray: [0, 1],
  aTh: [1.05, 3], aNear: [0, 40], aBrake: [0, 1], hold: [0, 40] };
// hold：ためる手（唱え終わり近くで急に遅くされる）への返し技（2026-10-25）。唱え終わりまで hold tick 以内のつもりで一度止まったら、その回は走り直さない
const KINT = new Set(["spFar", "spNear", "dStart", "dBrake", "spLow", "gray", "aBrake"]);
const rnd = (a, b) => a + Math.random() * (b - a);
function kfix(g) { for (const [k, [a, b]] of Object.entries(KGENES)) { g[k] = Math.max(a, Math.min(b, g[k])); if (KINT.has(k)) g[k] = Math.round(g[k]); } return g; }
function krandom() { const g = {}; for (const [k, [a, b]] of Object.entries(KGENES)) g[k] = rnd(a, b); return kfix(g); }
function kmutate(g, rate) {
  const c = { ...g };
  for (const [k, [a, b]] of Object.entries(KGENES)) if (Math.random() < 0.35) {
    const span = b - a, gauss = (Math.random() + Math.random() + Math.random() - 1.5) * 2;
    c[k] = KINT.has(k) && span <= 1 ? (Math.random() < 0.3 ? 1 - c[k] : c[k]) : c[k] + gauss * span * rate;
  }
  return kfix(c);
}
function kcross(a, b) { const c = {}; for (const k of Object.keys(KGENES)) c[k] = Math.random() < 0.5 ? a[k] : b[k]; return kfix(c); }

// 遺伝子から子どもを作る（sim.play の kid：毎 tick 呼ばれて、目標の速さ 0〜1 を返す。ダッシュは me.boost）
const REACT = 2, HOLD = 3;   // 0.25 秒（2〜3 tick）遅れて指に伝わる・変えたら 0.3 秒はそのまま
function kid(g) {
  let pf = null, queue = [], cur = { v: 0, b: false }, lastChange = -99, t = 0, runT = 0, lastCP = 999, heard = [], alarm = false, held = false, wasRun = false;
  return (st) => {
    t++;
    const me = st.children.find((c) => c.human);
    const fill = Core.tempoFill(P, st.tempoValue);
    heard.push(fill); if (heard.length > REACT + 1) heard.shift();
    const fillHeard = heard[0];   // 早口に気づくのは REACT tick 遅れ
    if (st.chantProgress < lastCP) { runT = 0; alarm = false; held = false; } lastCP = st.chantProgress;
    // 慣れていたテンポ（pf）より急に速くなったと気づいた：唱え終わりが近ければ、その回はもう走らない
    if (pf != null && !alarm && fillHeard >= pf * g.aTh && (100 - st.chantProgress) / fillHeard <= g.aNear) alarm = true;
    pf = pf == null ? fill : pf + (fill - pf) / 6;   // 耳で聞いたテンポ（遅れて追いつく）
    // 決める（見えるものだけで）
    const aura = R.TIERS.indexOf(st.reward), grayNow = st.stamina < Core.turnCostOf(P, st);
    const left = (100 - st.chantProgress) / pf;
    const stopNeed = Math.max(0, (me.vel - P.CATCH_VEL_THRESHOLD) / (me.brake * (g.dBrake ? P.BOOST_BRAKE_MULT : 1)));
    let run = !alarm && !held && ((g.gray && grayNow) || left > stopNeed + g["m" + aura]);
    if (wasRun && !run && left <= g.hold) held = true;   // 唱え終わり近くで止まった：この回はもう走らない
    wasRun = run;
    const e = me.energy / me.energyMax, prog = me.pos / P.GOAL_POS;
    let v = 0, b = false;
    if (run) { v = SPD(e < g.eLow ? g.spLow : prog >= g.near ? g.spNear : g.spFar); runT++; b = runT <= g.dStart && e >= g.dMin; }
    else { runT = 0; b = (!!g.dBrake || (alarm && !!g.aBrake)) && e >= g.dMin && me.vel > P.CATCH_VEL_THRESHOLD; }
    // 指に伝わるのは REACT tick あと。変えたら HOLD tick は次の変更なし
    queue.push({ v, b, at: t + REACT });
    while (queue.length && queue[0].at <= t) {
      const w = queue.shift();
      if ((w.v > 0) !== (cur.v > 0) || w.b !== cur.b) { if (t - lastChange < HOLD) continue; lastChange = t; }
      cur = { v: w.v, b: w.b };
    }
    me.boost = cur.b && cur.v > 0 ? true : cur.b;
    return cur.v;
  };
}
function kdescribe(g) {
  const lv = (k) => k + "/8";
  return [`離す余裕（唱え終わりの何秒前・止まる分は別）：弱 ${(g.m0 / 10).toFixed(1)}・中 ${(g.m1 / 10).toFixed(1)}・強 ${(g.m2 / 10).toFixed(1)}・全開 ${(g.m3 / 10).toFixed(1)}`,
    `速さ：ゴールまで ${Math.round(g.near * 100)}% までは ${lv(g.spFar)}、その先は ${lv(g.spNear)}・体力 ${Math.round(g.eLow * 100)}% を切ったら ${lv(g.spLow)}`,
    `ダッシュ：走り出し ${g.dStart / 10} 秒・急ブレーキ ${g.dBrake ? "使う" : "使わない"}（体力 ${Math.round(g.dMin * 100)}% 以上のとき）`,
    `だるまの気力が灰色なら ${g.gray ? "走り抜ける" : "いつもどおり"}`,
    `ためる手：唱え終わりまで ${(g.hold / 10).toFixed(1)} 秒以内で止まったら、その回は走り直さない`,
    `早口：テンポが ${g.aTh.toFixed(2)} 倍になり、唱え終わりまで ${(g.aNear / 10).toFixed(1)} 秒以内なら、${g.aBrake ? "急ブレーキで" : "ふつうに"}止まる`].join("\n  ");
}

// ---------- 対戦 ----------
// 1試合：だるま遺伝子 dg（null なら今のゲームの CPU）× 子ども（遺伝子 kg か、人っぽい子 hk=[style,dash]）
const CPU_STYLE = { normal: "normal", attack: "tempo", oni: "oni", red: "gold" }[GAME.type];
function game(dg, kg, hk) {
  const d = dg ? E.daruma(dg) : R.cpuDaruma(null, CPU_STYLE);
  const k = kg ? kid(kg) : sim.humanKid(hk[0], hk[1]);
  const r = sim.play(d, { ...GAME, kid: k });
  return { d: r.win === "daruma", me: !!(r.by && r.by.human) };
}
function match(dg, kg, hk, n) { let dw = 0, me = 0; for (let i = 0; i < n; i++) { const r = game(dg, kg, hk); dw += r.d; me += r.me; } return { dw: dw / n, me: me / n }; }
const HUMANS = [["careful", null], ["bold", null], ["normal", "brake"]];

module.exports = { kid, kdescribe, KGENES };
if (require.main !== module) return;
// ---------- 進化 ----------
console.log(`だるまの種類 ${GAME.type}・だるま ${POP}組 × 子ども ${POP}組 × ${GENS}世代・1組あたり ${GAMES}試合`);
let dpop = Array.from({ length: POP }, () => ({ g: E.randomGene(), f: 0 })), kpop = Array.from({ length: POP }, () => ({ g: krandom(), f: 0 }));
let dhof = [], khof = [];   // 昔の強者
const t0 = Date.now();
for (let gen = 1; gen <= GENS; gen++) {
  // 対戦相手：相手側の今の上位 + 昔の強者（少し）
  const kOpp = [...kpop.slice(0, 4).map((p) => p.g), ...khof.slice(-2)], dOpp = [...dpop.slice(0, 4).map((p) => p.g), ...dhof.slice(-2)];
  const n = Math.max(6, Math.round(GAMES / 2));
  for (const p of dpop) {   // だるまの強さ：子どもの上位・昔の強者・人っぽい子に勝つ割合
    let s = 0, c = 0;
    for (const kg of kOpp) { s += match(p.g, kg, null, n).dw; c++; }
    for (const hk of HUMANS) { s += match(p.g, null, hk, n).dw; c++; }
    p.f = s / c;
  }
  for (const p of kpop) {   // 子どもの強さ：子どもチームの勝ち＋自分のタッチ×0.5（だるまの上位・昔の強者・今の CPU 相手）
    let s = 0, c = 0;
    for (const dg of [...dOpp, null]) { const r = match(dg, p.g, null, n); s += (1 - r.dw) + 0.5 * r.me; c++; }
    p.f = s / c;
  }
  dpop.sort((a, b) => b.f - a.f); kpop.sort((a, b) => b.f - a.f);
  if (gen % 3 === 0) { dhof.push(dpop[0].g); khof.push(kpop[0].g); }
  console.log(`${gen}世代：だるまの上位 ${(dpop[0].f * 100).toFixed(0)}%・子どもの上位 ${(kpop[0].f * 100).toFixed(0)}点（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  const rate = 0.25 * (1 - gen / (GENS + 1)) + 0.05;
  const breed = (pop, mut, cr) => { const el = pop.slice(0, KEEP), nx = el.map((p) => ({ g: p.g, f: 0 }));
    while (nx.length < POP) { const a = el[Math.floor(Math.random() * KEEP)].g, b = el[Math.floor(Math.random() * KEEP)].g; nx.push({ g: mut(Math.random() < 0.5 ? cr(a, b) : a, rate), f: 0 }); } return nx; };
  if (gen < GENS) { dpop = breed(dpop, E.mutate, E.cross); kpop = breed(kpop, kmutate, kcross); }
}
// 最後に、たくさんの試合で比べる
const N = GAMES * 10, bestD = dpop[0].g, bestK = kpop[0].g, pct = (x) => (x * 100).toFixed(0) + "%";
console.log(`\n—— ${N}試合ずつで比べる（だるまの勝ちの割合） ——`);
const rows = [["今の CPU のだるま", null], ["学習したいちばん強いだるま", bestD]];
const cols = [["慎重な人っぽい子", null, ["careful", null]], ["強気な人っぽい子", null, ["bold", null]], ["学習したいちばん強い子", bestK, null]];
console.log("".padEnd(16) + cols.map((c) => c[0]).join(" ｜ "));
for (const [name, dg] of rows) console.log(name.padEnd(14) + "：" + cols.map(([, kg, hk]) => { const r = match(dg, kg, hk, N); return `だるま ${pct(r.dw)}（自分のタッチ ${pct(r.me)}）`; }).join(" ｜ "));
console.log(`\n学習したいちばん強いだるま\n  ${E.describe(bestD)}`);
console.log(`\n学習したいちばん強い子ども\n  ${kdescribe(bestK)}`);
console.log("\nだるまの遺伝子：" + JSON.stringify(bestD) + "\n子どもの遺伝子：" + JSON.stringify(bestK));
