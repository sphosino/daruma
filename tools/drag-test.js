"use strict";
// 引きのばし（振り向く回だけ、唱え終わり近くでテンポを落とす）がどれくらい効くかを、そこだけ変えて測る（2026-10-26）
//   だるまは、学習しただるま（遺伝子 BASE）のまま。落とすテンポ tAmb と、落とし始める tick ambT だけを変える
//   相手：人っぽい子ども（慎重・強気）と、学習した子ども（KID）。NOREGEN=1 で気力の自動回復なし
//   node tools/drag-test.js [試合数]
const path = require("path");
const R = require(path.join(__dirname, "..", "rules.js"));
const P = R.P;
if (process.env.NOREGEN === "1") P.TEMPO_REGEN_SLOWEST = 0;
if (process.env.SLOWCOST) P.TEMPO_SLOW_COST_PER_UNIT = +process.env.SLOWCOST;   // 遅くするコスト（1 につき）
const sim = require(path.join(__dirname, "..", "sim.js"));
const E = require("./evolve.js");
const N = +(process.argv[2] || 400);
// 自動回復なしで学習しただるまと子ども（2026-10-25 の 4回目）
const BASE = process.env.BASE ? JSON.parse(process.env.BASE) : {"d1":0.04568609957101878,"d2":0.8445408594640827,"tFar":6,"tMid":2,"tNear":8,"lowS":1,"tLow":5,"turnAt":0.8480694821575223,"needRun":1,"aHi":1,"aLo":2,"auraS":0.8268204813912055,"amb":1,"ambT":10,"tAmb":4};
const KID = process.env.KID ? JSON.parse(process.env.KID) : null;
const kidOf = () => require("./coevolve.js").kid;
const opp = [["慎重な人っぽい子", () => sim.humanKid("careful", null)], ["強気な人っぽい子", () => sim.humanKid("bold", null)]];
if (KID) opp.push(["学習した子ども", () => kidOf()(KID)]);
const cases = [["落とさない", { amb: 0 }], ["半分（50）", { tAmb: 4 }], ["25", { tAmb: 2 }], ["いちばん遅く（0）", { tAmb: 0 }]];
console.log(`自動回復 ${P.TEMPO_REGEN_SLOWEST ? "あり" : "なし"}・遅くするコスト ${P.TEMPO_SLOW_COST_PER_UNIT || 0}・${N}試合ずつ（だるまの勝ち）`);
console.log("振り向く回の最後の1秒".padEnd(14) + opp.map((o) => o[0]).join(" ｜ "));
for (const [name, ch] of cases) {
  const g = { ...BASE, ...ch };
  const cells = opp.map(([, mk]) => { let w = 0; for (let i = 0; i < N; i++) if (sim.play(E.daruma(g), { ...E.GAME, kid: mk() }).win === "daruma") w++; return `${Math.round(w / N * 100)}%`; });
  console.log(name.padEnd(12) + "：" + cells.join(" ｜ "));
}
