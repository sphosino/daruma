"use strict";
// だるまの作戦を進化させる（2026-10-25）：作戦を数字の組（遺伝子）にして、たくさん戦わせ、勝った組を残して少しずつ変える
//   相手は sim.js の人っぽい子ども（慎重・ふつう・強気、ダッシュあり・なし）1人と CPU の子ども 3人。決まりはゲームと同じ rules.js
//   テンポは 9 段階（0・12.5・25 … 100。両端と真ん中が入る）。テンポを変えるのは、1文字唱えるごと（字の切れ目）とひと休みだけ
//
//   node tools/evolve.js [世代数] [1つの遺伝子の試合数]     例：node tools/evolve.js 20 150
//   TYPE=attack などで、だるまの種類を変えられる（ふだん normal）
const path = require("path");
const sim = require(path.join(__dirname, "..", "sim.js"));
const R = require(path.join(__dirname, "..", "rules.js"));
const Core = R.Core, P = R.P;
const GENS = +(process.argv[2] || 20), GAMES = +(process.argv[3] || 150), POP = 24, KEEP = 8;
const GAME = { clock: 45, grace: 0.4, knock: 18, type: process.env.TYPE || "normal" };
const LV = (k) => Math.max(0, Math.min(8, Math.round(k))) * 12.5;   // 9 段階のテンポ
const AURA = R.TIERS;   // ['low','mid','high','max']

// ---------- 遺伝子 ----------
// d1,d2：いちばん前の子の位置（0〜1）で、遠い・中くらい・近い の3つに分ける境目
// tFar,tMid,tNear：それぞれのテンポの段（0〜8）
// lowS：気力がこれ（0〜1）を下回ったら、回復のテンポ tLow に落とす
// turnAt：いちばん前の子がここ（0〜1）を越えたら振り向く。needRun：走っている子がいるときだけ（0/1）
// aHi,aLo：気力があるとき・少ないときのオーラ（0〜3）。auraS：その境目の気力（0〜1）
// amb：だまし討ち（1 なら、振り向く回は唱え終わりの ambT tick 前からテンポを tAmb に上げる）
const GENES = { d1: [0, 1], d2: [0, 1], tFar: [0, 8], tMid: [0, 8], tNear: [0, 8], lowS: [0, 1], tLow: [0, 8],
  turnAt: [0, 1], needRun: [0, 1], aHi: [0, 3], aLo: [0, 3], auraS: [0, 1], amb: [0, 1], ambT: [1, 12], tAmb: [0, 8] };
const INT = new Set(["tFar", "tMid", "tNear", "tLow", "needRun", "aHi", "aLo", "amb", "ambT", "tAmb"]);
const rnd = (a, b) => a + Math.random() * (b - a);
function randomGene() { const g = {}; for (const [k, [a, b]] of Object.entries(GENES)) g[k] = INT.has(k) ? Math.round(rnd(a, b)) : rnd(a, b); return fix(g); }
function fix(g) {
  for (const [k, [a, b]] of Object.entries(GENES)) { g[k] = Math.max(a, Math.min(b, g[k])); if (INT.has(k)) g[k] = Math.round(g[k]); }
  if (g.d2 < g.d1) [g.d1, g.d2] = [g.d2, g.d1];
  return g;
}
function mutate(g, rate) {
  const c = { ...g };
  for (const [k, [a, b]] of Object.entries(GENES)) if (Math.random() < 0.35) {
    const span = b - a, gauss = (Math.random() + Math.random() + Math.random() - 1.5) * 2;
    c[k] = INT.has(k) && span <= 1 ? (Math.random() < 0.3 ? 1 - c[k] : c[k]) : c[k] + gauss * span * rate;
  }
  return fix(c);
}
function cross(a, b) { const c = {}; for (const k of Object.keys(GENES)) c[k] = Math.random() < 0.5 ? a[k] : b[k]; return fix(c); }

// ---------- 遺伝子からだるまを作る ----------
function daruma(g) {
  let lastSaid = -1, ambOn = false;
  const lead = (st) => Math.max(...st.children.map((c) => c.pos)) / P.GOAL_POS;
  const running = (st) => st.children.some((c) => c.vel > P.CATCH_VEL_THRESHOLD);
  const tempoFor = (st) => {
    const s = st.stamina / st.staminaMax, l = lead(st);
    if (s < g.lowS) return LV(g.tLow);
    return LV(l < g.d1 ? g.tFar : l < g.d2 ? g.tMid : g.tNear);
  };
  const aura = (st) => AURA[st.stamina / st.staminaMax >= g.auraS ? g.aHi : g.aLo];
  const setTempo = (st, v) => { if (Math.abs(v - st.tempoValue) > 0.5) Core.applyTempoChange(P, st, v); };
  return {
    onPrep(st) { st.reward = aura(st); st.tempoValue = tempoFor(st); lastSaid = -1; ambOn = false; },   // ひと休みの間は、テンポを変えてもただ
    onCarry(st) { st.reward = aura(st); lastSaid = -1; ambOn = false; },
    onTick(st) {
      const l = lead(st);
      st.turnArmed = l >= g.turnAt && (!g.needRun || running(st));
      const said = R.said(st);
      const left = (100 - st.chantProgress) / Core.tempoFill(P, st.tempoValue);
      if (g.amb && st.turnArmed && !ambOn && left <= g.ambT) { setTempo(st, LV(g.tAmb)); ambOn = true; return; }
      if (said !== lastSaid && !ambOn) { lastSaid = said; setTempo(st, tempoFor(st)); }
    },
  };
}

// ---------- 強さを測る：だるまの勝ちの割合（人っぽい子どもの遊び方をまぜる） ----------
const KIDS = [["careful", null], ["normal", null], ["bold", null], ["careful", "brake"], ["normal", "brake"], ["bold", "both"]];
function fitness(g, n) {
  let w = 0;
  for (let i = 0; i < n; i++) {
    const [style, dash] = KIDS[i % KIDS.length];
    const r = sim.play(daruma(g), { ...GAME, kid: sim.humanKid(style, dash) });
    if (r.win === "daruma") w++;
  }
  return w / n;
}
function baseline(n) {   // 今のゲームの CPU のだるま（同じ相手）
  let w = 0; const style = { normal: "normal", attack: "tempo", oni: "oni", red: "gold" }[GAME.type];
  for (let i = 0; i < n; i++) { const [s, d] = KIDS[i % KIDS.length]; if (sim.play(R.cpuDaruma(null, style), { ...GAME, kid: sim.humanKid(s, d) }).win === "daruma") w++; }
  return w / n;
}
function describe(g) {
  const pct = (x) => Math.round(x * 100) + "%";
  return [`テンポ：先頭が ${pct(g.d1)} までは ${LV(g.tFar)}、${pct(g.d2)} までは ${LV(g.tMid)}、その先は ${LV(g.tNear)}`,
    `気力が ${pct(g.lowS)} を切ったら テンポ ${LV(g.tLow)}（回復）`,
    `振り向く：先頭が ${pct(g.turnAt)} を越えたら${g.needRun ? '（走っている子がいるときだけ）' : '（いつでも）'}`,
    `オーラ：気力 ${pct(g.auraS)} 以上なら ${g.aHi}、それより下なら ${g.aLo}（0 弱〜3 全開）`,
    g.amb ? `だまし討ち：振り向く回は、唱え終わりの ${g.ambT / 10} 秒前からテンポ ${LV(g.tAmb)}` : "だまし討ち：しない"].join("\n  ");
}

module.exports = { GENES, INT, randomGene, mutate, cross, fix, daruma, describe, LV, GAME, KIDS };
if (require.main !== module) return;
// ---------- 進化 ----------
console.log(`だるまの種類 ${GAME.type}・${POP}組 × ${GENS}世代・1組 ${GAMES}試合`);
const base = baseline(GAMES * 4);
console.log(`今のゲームの CPU のだるま：だるまの勝ち ${(base * 100).toFixed(0)}%`);
let pop = Array.from({ length: POP }, randomGene).map((g) => ({ g, f: 0 }));
const t0 = Date.now();
for (let gen = 1; gen <= GENS; gen++) {
  for (const p of pop) p.f = fitness(p.g, GAMES);
  pop.sort((a, b) => b.f - a.f);
  console.log(`${gen}世代：いちばん ${(pop[0].f * 100).toFixed(0)}%・上位平均 ${(pop.slice(0, KEEP).reduce((a, p) => a + p.f, 0) / KEEP * 100).toFixed(0)}%（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  const elite = pop.slice(0, KEEP), rate = 0.25 * (1 - gen / (GENS + 1)) + 0.05, next = elite.map((p) => ({ g: p.g, f: 0 }));
  while (next.length < POP) { const a = elite[Math.floor(Math.random() * KEEP)].g, b = elite[Math.floor(Math.random() * KEEP)].g; next.push({ g: mutate(Math.random() < 0.5 ? cross(a, b) : a, rate), f: 0 }); }
  pop = next;
}
// 最後に上位を、たくさんの試合で測り直す（運のよかった組をふるい落とす）
for (const p of pop.slice(0, KEEP)) p.f = fitness(p.g, GAMES * 4);
pop.sort((a, b) => b.f - a.f);
console.log(`\nいちばん強い作戦（${GAMES * 4}試合で測り直し）：だるまの勝ち ${(pop[0].f * 100).toFixed(0)}%（今の CPU は ${(base * 100).toFixed(0)}%）\n  ${describe(pop[0].g)}`);
console.log(`\n2番目：${(pop[1].f * 100).toFixed(0)}%\n  ${describe(pop[1].g)}`);
console.log("\n遺伝子：" + JSON.stringify(pop[0].g));
