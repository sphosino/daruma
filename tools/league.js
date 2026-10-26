"use strict";
// ゲームの相手にする AI を育てる（2026-10-26）。tools/coevolve.js は決まりの数字を合わせるための「作戦どうしの比べ」で、
//   人の子 1 人＋CPU の子 3 人の形で、一緒に育った相手だけを相手にしていた。そのまま 4 人ともゲームに入れると、
//   4 人がそろって動き、相手を決め打ちした専門家になった（別の回のだるまには 0% か 100%）。ここでは、ゲームの形で育てる：
//   ・子どもは 4 人とも別々：たくさんの子どもから、毎試合くじで 4 人を選んでチームにする（rules.js の learnedKid）
//   ・相手はいろいろ：育っている途中の相手の上位、昔の強者、外から渡した相手（ほかの回で育っただるま・子ども）、その種類の CPU のだるま、元の CPU の子ども
//   ・回ごとの気まぐれ：子どもは離す余裕が ±0.3 秒、だるまは振り向く線が ±0.08 ずれる。だるまは 0.3 秒遅れで見る（ゲームに入れる形のまま）
//
//   node tools/league.js [世代数] [出力 JSON]     TYPE=oni などで種類。SEED_FILES=a.txt,b.txt で coevolve.js の出力から相手の遺伝子を足す
const fs = require("fs"), path = require("path");
const R = require(path.join(__dirname, "..", "rules.js"));
const E = require("./evolve.js"), C = require("./coevolve.js");
const Core = R.Core, P = R.P;
const TYPE = process.env.TYPE || "normal", GENS = +(process.argv[2] || 60), OUT = process.argv[3];
const POP = 24, KEEP = 8, HOF = 8, N_TEAM = 4;
const CPU_STYLE = { normal: "normal", attack: "tempo", oni: "oni", red: "gold" }[TYPE];
P.GOAL_TICKS = 450; P.CATCH_KNOCK = 18; R.LOOK.grace = 4;   // ゲームと同じ（index.html の TUNE_DEF）
if (process.env.SLOWCOST) P.TEMPO_SLOW_COST_PER_UNIT = +process.env.SLOWCOST;

// 外から渡す相手：coevolve.js の出力の最後の 2 行
const seedD = [], seedK = [];
for (const f of (process.env.SEED_FILES || "").split(",").filter(Boolean)) {
  const t = fs.readFileSync(f, "utf8"), d = t.match(/だるまの遺伝子：(.*)/), k = t.match(/子どもの遺伝子：(.*)/);
  if (d) seedD.push(JSON.parse(d[1])); if (k) seedK.push(JSON.parse(k[1]));
}

// 1 試合。dg：だるまの遺伝子（null なら CPU のだるま）。team：子どもの遺伝子 4 つ（null なら元の CPU の子 4 人）
//   返すのは { d: だるまの勝ち, by: タッチした子の番号（-1 はなし） }
function play(dg, team) {
  const st = team ? R.newGameSeats({ kids: team.map((_, i) => ({ name: "k" + i })), type: TYPE }) : R.newGame({ kids: N_TEAM, type: TYPE });
  const ks = team ? st.children.map((c, i) => ({ c, k: R.learnedKid(team[i]) })) : [];
  const d = dg ? R.learnedDaruma(TYPE, dg) : R.cpuDaruma(null, CPU_STYLE);
  const who = (c) => ks.findIndex((x) => x.c === c);
  d.onPrep(st);
  for (let t = 0; t < 20000; t++) {
    for (const x of ks) x.k.tick(st, x.c);
    const res = Core.tick(P, st);
    if (res.reached) return { d: 0, by: who(res.reached) };
    if (res.timeUp) return { d: 1, by: -1 };
    if (res.chantDone) {
      let out;
      if (R.wantsTurn(st)) {
        R.startLook(st);
        for (;;) { for (const x of ks) x.k.look(x.c); const r2 = R.lookTick(st); if (r2.reached) return { d: 0, by: who(r2.reached) }; if (r2.done) break; }
        out = R.endLook(st);
      } else out = R.resolve(st);
      if (out.carry) d.onCarry(st); else { R.applyReserved(st); d.onPrep(st); }
    } else d.onTick(st);
  }
  return { d: 1, by: -1 };
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const teamOf = (pool, n) => Array.from({ length: n }, () => pick(pool));

function main() {
  console.log(`だるまの種類 ${TYPE}・だるま ${POP} × 子ども ${POP}（4 人ずつくじでチーム）× ${GENS} 世代・外から だるま ${seedD.length}・子ども ${seedK.length}`);
  let dpop = Array.from({ length: POP }, (_, i) => ({ g: i < seedD.length ? seedD[i] : E.randomGene(), f: 0 }));
  let kpop = Array.from({ length: POP }, (_, i) => ({ g: i < seedK.length ? seedK[i] : C.krandom(), f: 0 }));
  const dhof = [], khof = [], t0 = Date.now();
  for (let gen = 1; gen <= GENS; gen++) {
    // 子ども：いろいろなだるまを相手に、くじで組んだチームで戦う。点はチームの勝ち＋自分のタッチ×0.5
    const dOpp = [...dpop.slice(0, 4).map((p) => p.g), ...dhof.slice(-3), ...seedD, null, null];
    const ks = kpop.map(() => ({ s: 0, n: 0 }));
    for (const dg of dOpp) for (let i = 0; i < 40; i++) {
      const idx = Array.from({ length: N_TEAM }, () => Math.floor(Math.random() * POP));
      const r = play(dg, idx.map((j) => kpop[j].g));
      idx.forEach((j, m) => { ks[j].s += (1 - r.d) + (r.by === m ? 0.5 : 0); ks[j].n++; });
    }
    kpop.forEach((p, j) => { p.f = ks[j].n ? ks[j].s / ks[j].n : 0; });
    // だるま：子どもの上位・昔の強者・外の子どもをくじで組んだチームと、元の CPU の子ども
    const kPool = [...kpop.slice(0, 8).map((p) => p.g), ...khof.slice(-4), ...seedK];
    for (const p of dpop) {
      let w = 0, n = 0;
      for (let i = 0; i < 30; i++) { w += play(p.g, teamOf(kPool, N_TEAM)).d; n++; }
      for (let i = 0; i < 10; i++) { w += play(p.g, null).d; n++; }
      p.f = w / n;
    }
    dpop.sort((a, b) => b.f - a.f); kpop.sort((a, b) => b.f - a.f);
    if (gen % 3 === 0) { dhof.push(dpop[0].g); khof.push(kpop[0].g); }
    if (gen % 5 === 0 || gen === 1) console.log(`${gen}世代：だるまの上位 ${(dpop[0].f * 100).toFixed(0)}%・子どもの上位 ${(kpop[0].f * 100).toFixed(0)}点（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
    const rate = 0.25 * (1 - gen / (GENS + 1)) + 0.05;
    const breed = (pop, mut, cr) => { const el = pop.slice(0, KEEP), nx = el.map((p) => ({ g: p.g, f: 0 }));
      while (nx.length < POP) { const a = pick(el).g, b = pick(el).g; nx.push({ g: mut(Math.random() < 0.5 ? cr(a, b) : a, rate), f: 0 }); } return nx; };
    if (gen < GENS) { dpop = breed(dpop, E.mutate, E.cross); kpop = breed(kpop, C.kmutate, C.kcross); }
  }
  // ゲームに入れる候補：だるまは上位 1、子どもは上位 8（4 人をここからくじで選ぶ）
  const best = { type: TYPE, daruma: dpop[0].g, kids: kpop.slice(0, 8).map((p) => p.g) };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(best));
  console.log(`\n学習しただるま\n  ${E.describe(best.daruma)}`);
  console.log(`\n学習した子ども（上位）\n  ${C.kdescribe(best.kids[0])}`);
}
module.exports = { play };
if (require.main === module) main();
