"use strict";
// The one and only implementation of the だるまさんがころんだ game loop.
//
// Loaded by all three front ends:
//   daruma-game.html       — the playable prototype
//   daruma-balance-lab.html— the parameter-tweaking lab
//   daruma-sim.js          — the headless batch simulator
//
// Each of those used to carry its own copy of this logic, which meant a
// balance change had to be hand-mirrored three times and the lab could
// silently drift from the game it was supposed to be tuning. Everything that
// decides the outcome of a cycle lives here; the front ends only do input,
// rendering and (for the sim) policy.
//
// Loaded as a classic script so the HTML pages still work over file:// —
// module scripts are blocked there. Sets window.DarumaCore in a browser and
// module.exports under Node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DarumaCore = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // --- tuning ------------------------------------------------------------
  // Every knob lives in one object so the lab can override any of them and
  // the sim can sweep them, without either one redefining the logic.
  var DEFAULTS = {
    TICK_MS: 100,
    // The daruma wins by lasting this long, not by surviving a fixed number of
    // phrases. With a phrase count, chanting fast shortened each phrase AND
    // brought the finish line closer — two wins for one cost. Past tempo ~85
    // that made the goal literally unreachable: ten fast phrases gave the kids
    // 295 ticks of running for a 94-unit track they cover at ~0.27/tick, so a
    // daruma could win 100% of games without ever turning around. On a clock,
    // chanting fast still suppresses movement but no longer ends the game any
    // sooner. 400 ticks at 100ms = 40 seconds, about what ten phrases at a
    // normal pace used to take.
    GOAL_TICKS: 400,
    // How many of the roster are on the track at once. Still undecided, and it
    // is the steepest lever in the whole game: on the shipped roster a good
    // reader wins 90.8% against 2 runners, 76.4% against 4 and 37.8% against
    // 10, because turning only resets who is moving while the leader is the
    // maximum of N. Treat any balance number as being about a specific count.
    ACTIVE_CHILDREN: 4,
    CATCH_VEL_THRESHOLD: 0.05,
    GOAL_POS: 96,
    CATCH_KNOCK: null,
    TEMPO_CHANGE_COST_PER_UNIT: 0.025,
    STAMINA_MAX: 110,

    // "necery dash": a random, cycle-count-independent burst of reckless
    // speed. Disabled for now (was 0.0006) — energy is the real gate.
    BURST_CHANCE_BASE: 0,
    BURST_DURATION: 6,
    BURST_SPEED_MULT: 1.9,
    BURST_COOLDOWN: 15,

    // kids run on their own energy pool, mirroring daruma's stamina.
    CHILD_ENERGY_MAX: 100,
    RUN_DRAIN_RATE: 2,
    REST_REGEN_RATE: 1.5,
    REGEN_VEL_RATIO: 0.5,
    CHANGE_DRAIN_RATE: 0.5,
    BURST_ENERGY_COST: 35,
    WINDED_RECOVER_AT: 20,
    WINDED_SPEED_MULT: 0.35,
    PACING_SCALE: 0.4,
    MOTOR_DEGRADE_SCALE: 0.5,
    // --- required pace ------------------------------------------------------
    // Anyone actually playing this counts: "the goal is that far away, there
    // are that many phrases left, so I need this much ground per phrase". A kid
    // badly behind schedule has to gamble; one that only needs a step can be
    // maddeningly careful.
    //
    // This replaces two separate nudges that were never combined — "it's late
    // in the game so I'm bolder" and "I'm near the goal so I can relax". Kept
    // apart, a kid at pos 30 with two phrases left (hopeless without recklessness)
    // and one at pos 90 with two phrases left (one step from winning) felt the
    // same urgency, which is not how anybody plays.
    //
    // Fraction of the remaining time a kid can actually spend running: the
    // rest goes on stopping for each phrase.
    PACE_FEASIBLE_FRACTION: 0.85,
    // Below this much of their feasible pace they're comfortably ahead.
    PACE_COMFORT: 0.8,
    PACE_WEIGHT: 0.5,
    // The arithmetic is not the hard part; judging distance and your own speed
    // is. Rolled per phrase, scaled by judgmentResilience.
    PACE_MISREAD_SPREAD: 0.35,

    // ① Does this kid even intend to stop this phrase? Decided once, at the
    // start of the phrase, gated by boldness — plus the daruma's 強気度 tell,
    // how late in the game it is, what this daruma has actually been DOING
    // (see DARUMA_MEMORY_SPAN) and what the kid is playing for (see MOTIVES).
    // This is what punishes a daruma who never really turns.
    GAMBLE_BASE: 0.5,
    // ↑ when the record says this daruma rarely turns: not worth stopping for.
    GAMBLE_THREAT_WEIGHT: 0.60,
    // 得点欲: the closer to the goal, the harder a kid who wants it pushes.
    GAMBLE_GREED_WEIGHT: 0.30,
    // やる気の低い子は賭けにも出ない。
    GAMBLE_EFFORT_WEIGHT: 0.35,

    // herd sense: conformity>0 follows the crowd, <0 is contrarian.
    HERD_SCALE: 0.25,

    // --- how a kid decides to stop ------------------------------------------
    // Kids hear the phrase ending, so there is no guesswork about WHEN it
    // lands. A kid gets caught for exactly two reasons: ① they never meant to
    // stop this phrase, or they meant to and didn't make it — because ② they
    // misjudged their own stopping distance or ③ they were slow to react.
    // There is deliberately no random "flinched and braked" roll; every catch
    // has a reason you could narrate.

    // ⑤ how fine they cut it: ticks of margin they want on top of their
    // stopping distance. Bold kids squeeze out extra ground, cautious kids
    // stop early and give up distance.
    FREEZE_LEAD_MIN: 0, // a max-boldness kid
    FREEZE_LEAD_MAX: 5, // a fully cautious kid

    // ⑦b 責任感: with the rest of the field out of contention, it is on you.
    // Extra ⑤ margin and less willingness to gamble, at full weight — i.e. when
    // exactly one kid can still get there and that kid is you.
    //
    // Note which way this points: feeling responsible makes a kid CAREFUL, and
    // careful costs ground. Everything else that fires late in a game (pace
    // pressure, shame decaying) pushes towards recklessness, so this is the one
    // force running the other way.
    //
    // It does NOT hand the daruma a way back into a slipping game, which was
    // the guess going in. Measured, thinning the field costs the daruma: the
    // survivor gives up a little ground, but it also stops reliably, so turns
    // whiff and the stamina goes with them. That is why the gamble term is the
    // small one — most of the caution belongs in the margin, where it shows as
    // lost ground rather than as a daruma wasting its turns on nobody.
    RESPONSIBILITY_LEAD: 3.0,
    RESPONSIBILITY_GAMBLE: 0.12,

    // ⑤b A scare carries one phrase. Deliberately one-directional: a kid who
    // only just made it keeps more margin next time, but a kid who stopped with
    // room to spare does NOT get bolder. Both halves would be a feedback loop
    // chasing pure noise — the stopping misread is rerolled every phrase, so
    // "that was close" says nothing about the next one — and a loop with an
    // opposing force oscillates. One direction cannot. It is also how it
    // actually goes: the fright registers, the wasted caution doesn't.
    //
    // Ticks of margin at or under which the stop counts as a fright. 0 = off.
    NEAR_MISS_TICKS: 3,
    // Not every scare lands. Keeps the effect a spice rather than a rule.
    NEAR_MISS_CHANCE: 0.5,
    // Extra ⑤ margin the following phrase, in ticks.
    NEAR_MISS_LEAD: 1.2,

    // ② Misreading your own stopping distance, as a multiplier on it, rolled
    // fresh each phrase. Below 1 = "I can stop shorter than I really can" =
    // brakes too late = catchable. Above 1 = brakes early and loses ground.
    // Scaled by judgmentResilience, so a sharp kid misjudges by less. This is
    // now the main way a kid who meant to stop still gets caught, so it is
    // load-bearing: at 0 nobody is ever catchable.
    STOPPING_MISREAD_SPREAD: 0.45,

    // ③ Noticing the moment to brake is a reaction, not instant. Ticks of
    // delay between "I need to be stopping" and actually braking, per kid,
    // from their reaction trait. At 100ms/tick these are tenths of a second.
    //
    // Kids ANTICIPATE their own delay — a kid who knows they're slow starts
    // watching earlier, so a fixed handicap doesn't just doom them. (It did
    // when this was first written: a systematically slow kid missed every
    // single phrase, so somebody was always left moving and turning could
    // never whiff.) What actually catches people is the delay coming out
    // WORSE than they planned for, which REACTION_JITTER controls. Slower
    // kids are also less consistent, so the jitter scales with the delay.
    REACTION_TICKS_MIN: 0, // sharpest kid
    REACTION_TICKS_MAX: 5, // slowest kid
    REACTION_JITTER: 0.6,  // fraction of their own delay, plus or minus

    // Two independent prices for going fast: TEMPO_CHANGE_COST_PER_UNIT is the
    // one-off charge for the speed-up itself, TEMPO_MAX.drainPerTick is the
    // per-tick cost of holding the pace. Measured: loosening the one-off is
    // safe (chant-fast-never-turn stays at 0%) but only worth ~8pt to an
    // ambush, because an ambush's bill is mostly holding the pace, not
    // reaching it. Loosening the drain does move it — and revives
    // chant-fast-never-turn from 0% to 100% at the same time.
    TEMPO_MIN: { fillPerTick: 1.1, drainPerTick: 0.04 },
    TEMPO_MAX: { fillPerTick: 3.8, drainPerTick: 1.10 },
    // >1 keeps the slow half of the slider cheap; cost only spikes near the top
    TEMPO_DRAIN_CURVE: 2.8,
    // Same shape for how fast the phrase actually advances. This exists so the
    // TOP of the slider can be raised without dragging the middle up with it:
    // raising TEMPO_MAX.fillPerTick alone shortens every phrase at every tempo,
    // which hands the daruma the whole game (measured: 3.8 -> 4.6 took every
    // policy, degenerate ones included, to ~100%). With a curve, the ordinary
    // chanting speeds stay where they were and only a deliberate sprint to the
    // top gets faster — which is what makes a late ramp worth anything.
    TEMPO_FILL_CURVE: 1.0,

    REWARD: {
      low:  { reward: 0,  turnCost: 11, label: "低" },
      mid:  { reward: 6,  turnCost: 17, label: "中" },
      high: { reward: 12, turnCost: 32, label: "高" },
      max:  { reward: 20, turnCost: 60, label: "激" }
    },

    // --- だるまのタイプ -------------------------------------------------------
    // Picked by the player, not drawn — this is the one seat where playability
    // beats fidelity, so an explicit choice is fine here in a way it would not
    // be on the kids' side.
    //
    // expectTurn is what the kids assume about a daruma of this shape before
    // it has done anything — the idea being that an advantage everyone can see
    // is an advantage that gets read, so 鬼's cheap turns would be expected and
    // whiff more often.
    //
    // Measured, that part is weak: it moves whiff rates by about a point.
    // What actually separates the types is the cost structure, and it separates
    // them a long way — see the numbers on each line below. Treat expectTurn as
    // flavour that is wired up and ready to be turned up, not as the balancing
    // force. GAMBLE_THREAT_WEIGHT is the knob that would give it teeth.
    DARUMA_TYPES: {
      normal: { label: "ふつう",     staminaScale: 1.00, turnCostScale: 1.00, tempoScale: 1.00, skipRewardScale: 1.00, expectTurn: 0.50 },
      // 器は大きいが実入りが細い。貯めるのではなく最初から持っている。
      red:    { label: "赤だるま",   staminaScale: 1.45, turnCostScale: 1.00, tempoScale: 1.00, skipRewardScale: 0.55, expectTurn: 0.50 },
      // 振り向きは安いが詠唱で押せない。そして安いことは見抜かれている。
      oni:    { label: "鬼だるま",   staminaScale: 1.00, turnCostScale: 0.62, tempoScale: 1.45, skipRewardScale: 1.00, expectTurn: 0.88 },
      // テンポは安いが振り向きが高い。舐められる分、たまの一発が刺さる。
      attack: { label: "攻めだるま", staminaScale: 1.00, turnCostScale: 1.45, tempoScale: 0.55, skipRewardScale: 1.00, expectTurn: 0.15 }
    },
    DARUMA_TYPE: "normal",
    // How many phrases of "what this type usually does" the assumption is
    // worth. As a plain starting value it decided phrase one and was then
    // overwritten by the first thing that actually happened, which measured as
    // nothing at all. Carried as weight against the record instead, it stays a
    // pull all game without ever beating real evidence.
    TYPE_PRIOR_PHRASES: 2,

    // 強気度 tell: low reads as "playing defense" (kids get cautious), max as
    // "going for the bank" (kids get bold). A fixed low=turn/max=skip rhythm
    // telegraphs itself and gets read right back.
    AURA_BOLDNESS: { low: -0.15, mid: -0.05, high: 0.05, max: 0.15 },

    // Who is available to be drawn. Defaults to the authored roster below, but
    // the lab can hand over a generated population so a random cast is playable
    // in the real game and not only measurable in a table.
    ROSTER: null, // filled in below with the authored roster

    // --- ⑥ どの速さで走るか --------------------------------------------------
    // Drain used to be linear in velocity, and that had a consequence nobody
    // intended: drain scales with speed and time scales inversely, so a given
    // DISTANCE cost the same energy at any pace. Running slow bought literally
    // nothing, so every kid ran flat out from the first tick to the last and
    // the only variety left was who ran out first. Above 1, speed costs extra
    // per unit of ground and pacing becomes a decision. Normalised at each
    // kid's own top speed, so 1 restores the old behaviour exactly.
    RUN_DRAIN_EXPONENT: 2.2,
    // Slowest economical cruise, as a fraction of the kid's own top speed.
    CRUISE_MIN: 0.5,
    // How far above the pace they strictly need a greedy kid chooses to run.
    // Load-bearing: pacing purely to the required pace is a negative feedback
    // loop — anyone ahead of schedule eases off, anyone behind pushes — which
    // drags the whole field onto one shared schedule. Measured at 0 it cut the
    // spread of ground gained between characters by ~60%, i.e. it made the
    // uniformity problem worse, not better. This is what pulls them apart again.
    GREED_PACE_BONUS: 0.40,

    // --- ⑦ 前に出るか、隠れるか -----------------------------------------------
    // The daruma watches whoever is furthest along, so the lead is a cost in
    // itself. A kid who would rather not be the one being watched eases off on
    // finding itself out front; a kid trying to draw the turn does the reverse.
    LEAD_SHYNESS: 0.35,
    // How far clear of the next kid counts as "out front".
    LEAD_MARGIN: 4,

    // --- C 動機: この試合で何を狙っているか -----------------------------------
    // Drawn per MATCH, not baked into the character, and never labelled on
    // screen. Not labelled is not the same as not readable, and it shouldn't
    // be: a motive that never shows in how a kid runs is just noise. These
    // show — a slacker's ceiling is lower, a decoy moves on the phrases
    // somebody else is out front, a scorer pushes harder the closer it gets.
    // Learning to spot that is a fair thing to learn. What stays out of reach
    // is doing it for four runners at once, which is what keeps the daruma
    // playing mostly on feel.
    //   greed    自分でタッチしたい
    //   effort   そもそもの本気度
    //   shame    捕まるのがどれだけ嫌か(終盤ほど薄れる)
    //
    // careless — 捕まるのを気にしない子 — is where the "削り役" ended up. It
    // used to be an explicit decoy with a `devotion` trait that made it run
    // HARDER the more likely it thought a turn was, i.e. deliberately walk into
    // the catch, on the theory that it was spending itself to drain 気力. No
    // kid does attrition maths on a bar it cannot see. What a kid does do is
    // not mind very much, and shame already carries that: a kid with none of it
    // keeps no margin (⑤) and doesn't mind being the one out front (⑦), so it
    // sits in view, cuts it fine and gets caught. The daruma then can't afford
    // to skip. Same effect, no intent required — and one trait fewer.
    MOTIVES: {
      scorer:   { greed: 0.90, effort: 0.95, shame: 0.35 },
      careless: { greed: 0.25, effort: 0.85, shame: 0.05 },
      slacker:  { greed: 0.30, effort: 0.35, shame: 0.55 },
      steady:   { greed: 0.55, effort: 0.75, shame: 0.65 }
    },
    // Relative weights, not counts — the draw is independent per kid, so a
    // field with nobody who cares is unlikely but not impossible.
    MOTIVE_MIX: { scorer: 0.30, careless: 0.25, slacker: 0.20, steady: 0.25 },
    // ⑤ 恥: how many extra ticks of margin an early-game kid keeps because
    // being the FIRST one sent back is its own punishment. Scaled by how much
    // of the clock is left, so it fades into recklessness by the end.
    SHAME_LEAD: 1.5,
    // How far a slacker's ceiling sits below everyone else's top speed.
    EFFORT_SPEED_FLOOR: 0.55,

    // --- D だるまの読み -------------------------------------------------------
    // ① was a fresh gamble every phrase with no memory whatsoever. Kids now
    // carry what this particular daruma has actually been doing.
    DARUMA_MEMORY_SPAN: 5,
    // How far the record can pull a kid off the even odds, before their own
    // suspicion scales it. A kid that reads hard is a kid that can be fooled,
    // which is the counterweight PERCEIVED_TEMPO_LAG hands back to the daruma.
    MEMORY_WEIGHT: 0.45,
    // Ticks of smoothing on a kid's sense of how fast the chant is going. At 0
    // a mid-phrase speed-up is registered instantly, tempo can only ever work
    // by shortening the phrase, and a late ramp strands nobody. Above 0 the
    // ramp is a feint that can actually catch someone out.
    PERCEIVED_TEMPO_LAG: 8,

    // --- B 疲労の自覚 ---------------------------------------------------------
    // Kids misread their own stopping distance but used to know their remaining
    // energy to the decimal. They don't. The bias is deliberately one-way — the
    // tired feel fresher than they are — because that is how a kid commits to a
    // run its legs cannot finish, which is a catch you can narrate.
    FATIGUE_MISREAD: 0.45,

    // Injectable so tests/sweeps can use a seeded generator.
    rand: Math.random
  };

  var CHANT_CHARS = ["だ", "る", "ま", "さ", "ん", "が", "こ", "ろ", "ん", "だ"];

  // Full roster of 10 — a game randomly picks 4 to actually play.
  //
  // Everything here is a property of the CHARACTER and stays put game to game.
  // What a kid is playing for is NOT here: that is drawn per match (see
  // MOTIVES) precisely so the same face can be the one going for it in one game
  // and the decoy in the next.
  //
  // A 身体 — visible just by watching them run
  //   maxSpeed / accel: どれだけ速く、どれだけ早く乗るか
  //   brake: 1tickでどれだけ減速できるか。誰も瞬間停止はできない。
  //   endurance: 短距離型(0)〜長距離型(1)。タンク容量・燃費・回復力をまとめて決める。
  //     速い子ほど低く置いてある(容量と最高速のトレードで、大きいタンクが
  //     ただの上位互換にならないように)
  // B 気質 — 見えない。名前がうっすら匂わせる程度
  //   boldness: 危険を感じても押すリスク許容度。①止まる気になるかと⑤粘り幅を決める
  //   selfControl: 自分の体力にどれだけ気を配れるか(独立した軸)
  //   reaction: ③「そろそろ止まらないと」に気づいてから足が動くまでの速さ。高いほど速い
  //   judgmentResilience: ②自分の制動距離をどれだけ正確に読めるか。高いほど読み違えない
  //   motorControl: ④疲れてもブレーキ性能が落ちにくいか
  //   bodyAwareness: 自分の疲れ具合をどれだけ正確に感じ取れるか。低い子は
  //     「まだいける」と思って出て、足が思ったより動かずに捕まる
  //   skepticism: だるまの直近の行動をどれだけ重く見るか。高いほど読むが、
  //     高いほど読みを裏切られる(テンポの知覚ラグに引っかかる)
  //   conformity: 周りに合わせるか(⑧用。まだ全員0で未使用)
  var ROSTER = [
    { id: "c1",  name: "強気なボウル",     color: "var(--pink)",
      maxSpeed: 0.3432, accel: 0.0924, brake: 0.1408, endurance: 0.20,
      boldness: 0.85, selfControl: 0.15, judgmentResilience: 0.35, motorControl: 0.30,
      bodyAwareness: 0.20, skepticism: 0.30, conformity: 0, reaction: 0.15 },
    { id: "c2",  name: "慎重なケイン",     color: "var(--blue)",
      maxSpeed: 0.2640, accel: 0.0660, brake: 0.2640, endurance: 0.70,
      boldness: 0.25, selfControl: 0.85, judgmentResilience: 0.70, motorControl: 0.70,
      bodyAwareness: 0.75, skepticism: 0.65, conformity: 0, reaction: 0.45 },
    // The one who actually reads the daruma: high skepticism leans on the
    // record instead of the tell, which is a strength right up until the
    // daruma feints.
    { id: "c3",  name: "読み屋のミル",     color: "var(--green)",
      maxSpeed: 0.2904, accel: 0.0792, brake: 0.1672, endurance: 0.55,
      boldness: 0.55, selfControl: 0.60, judgmentResilience: 0.90, motorControl: 0.60,
      bodyAwareness: 0.60, skepticism: 0.90, conformity: 0, reaction: 1.00 },
    // brake much lower than maxSpeed on purpose: once at speed this one skids
    // for several ticks. She's quite self-aware (high selfControl) — she just
    // can't physically act on it fast.
    { id: "c4",  name: "滑り屋のレン",     color: "var(--purple)",
      maxSpeed: 0.2992, accel: 0.0748, brake: 0.0968, endurance: 0.45,
      boldness: 0.45, selfControl: 0.70, judgmentResilience: 0.40, motorControl: 0.85,
      bodyAwareness: 0.50, skepticism: 0.45, conformity: 0, reaction: 0.25 },
    { id: "c5",  name: "のんびり屋のユキ", color: "var(--teal)",
      maxSpeed: 0.2464, accel: 0.0660, brake: 0.2200, endurance: 0.85,
      boldness: 0.15, selfControl: 0.50, judgmentResilience: 0.50, motorControl: 0.40,
      bodyAwareness: 0.45, skepticism: 0.25, conformity: 0, reaction: 0.10 },
    // 早とちり means jumping to conclusions: quick to react (0.80) but reads
    // both his own braking and the daruma badly.
    { id: "c6",  name: "早とちりのハヤテ", color: "var(--orange)",
      maxSpeed: 0.3256, accel: 0.0880, brake: 0.1760, endurance: 0.25,
      boldness: 0.75, selfControl: 0.30, judgmentResilience: 0.15, motorControl: 0.25,
      bodyAwareness: 0.25, skepticism: 0.20, conformity: 0, reaction: 0.80 },
    { id: "c7",  name: "省エネのコハル",   color: "var(--mustard)",
      maxSpeed: 0.2728, accel: 0.0704, brake: 0.2464, endurance: 0.90,
      boldness: 0.40, selfControl: 0.95, judgmentResilience: 0.65, motorControl: 0.75,
      bodyAwareness: 0.90, skepticism: 0.70, conformity: 0, reaction: 0.35 },
    // Fastest on the roster and the shortest tank on it: 一直線 in both senses.
    { id: "c8",  name: "一直線のダイ",     color: "var(--brown)",
      maxSpeed: 0.3520, accel: 0.0968, brake: 0.1232, endurance: 0.15,
      boldness: 0.65, selfControl: 0.20, judgmentResilience: 0.30, motorControl: 0.20,
      bodyAwareness: 0.15, skepticism: 0.10, conformity: 0, reaction: 0.30 },
    { id: "c9",  name: "石橋のシズカ",     color: "var(--slate)",
      maxSpeed: 0.2552, accel: 0.0616, brake: 0.3080, endurance: 0.75,
      boldness: 0.10, selfControl: 0.80, judgmentResilience: 0.85, motorControl: 0.65,
      bodyAwareness: 0.80, skepticism: 0.80, conformity: 0, reaction: 0.55 },
    { id: "c10", name: "気まぐれのソラ",   color: "var(--coral)",
      maxSpeed: 0.3080, accel: 0.0836, brake: 0.1936, endurance: 0.40,
      boldness: 0.60, selfControl: 0.45, judgmentResilience: 0.55, motorControl: 0.45,
      bodyAwareness: 0.40, skepticism: 0.50, conformity: 0, reaction: 0.65 }
  ];

  DEFAULTS.ROSTER = ROSTER; // the authored cast is the default pool

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // --- adopted balance -----------------------------------------------------
  // The lab can hand a tuned parameter set straight to the playable game. A
  // page opened from file:// can't rewrite this file, so the adopted set lives
  // in localStorage and gets layered over the defaults at load. Node (the sim)
  // has no localStorage and always runs the shipped defaults — so if a balance
  // is worth keeping, bake it into DEFAULTS here rather than leaving it
  // adopted, or the sim and the game will be measuring different games.
  var ADOPTED_KEY = "daruma.adoptedBalance";

  function hasStorage() {
    try { return typeof localStorage !== "undefined" && localStorage !== null; }
    catch (e) { return false; } // some browsers throw on access with cookies off
  }
  function adoptedOverrides() {
    if (!hasStorage()) return null;
    try { return JSON.parse(localStorage.getItem(ADOPTED_KEY)) || null; }
    catch (e) { return null; }
  }
  function adoptBalance(overrides) {
    if (!hasStorage()) return false;
    try { localStorage.setItem(ADOPTED_KEY, JSON.stringify(overrides)); return true; }
    catch (e) { return false; }
  }
  function clearAdoptedBalance() {
    if (!hasStorage()) return false;
    try { localStorage.removeItem(ADOPTED_KEY); return true; }
    catch (e) { return false; }
  }

  // Shallow merge, one level deep for the nested TEMPO_* / REWARD objects so a
  // caller can override just TEMPO_MAX.drainPerTick without restating the rest.
  function makeConfig(overrides) {
    var P = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var d = DEFAULTS[k];
      P[k] = (d && typeof d === "object" && !Array.isArray(d) && typeof d !== "function")
        ? JSON.parse(JSON.stringify(d)) : d;
    });
    if (!overrides) return P;
    Object.keys(overrides).forEach(function (k) {
      var o = overrides[k];
      if (o && typeof o === "object" && !Array.isArray(o) && P[k] && typeof P[k] === "object") {
        Object.keys(o).forEach(function (k2) { P[k][k2] = o[k2]; });
      } else {
        P[k] = o;
      }
    });
    return P;
  }

  function tempoFill(P, v) {
    var ratio = Math.pow(clamp(v, 0, 100) / 100, P.TEMPO_FILL_CURVE);
    return P.TEMPO_MIN.fillPerTick + (P.TEMPO_MAX.fillPerTick - P.TEMPO_MIN.fillPerTick) * ratio;
  }
  function tempoDrain(P, v) {
    var ratio = Math.pow(v / 100, P.TEMPO_DRAIN_CURVE);
    return P.TEMPO_MIN.drainPerTick + (P.TEMPO_MAX.drainPerTick - P.TEMPO_MIN.drainPerTick) * ratio;
  }
  function tempoLabel(v) {
    if (v < 20) return "かなり遅い";
    if (v < 40) return "遅め";
    if (v < 60) return "ふつう";
    if (v < 80) return "速め";
    return "かなり速い";
  }

  // Rolled fresh at the start of every phrase.
  //
  // ① is NOT decided here: the daruma picks its 強気度 during prep, after this
  // runs, and that tell is part of what the kids are reading. So the intention
  // is rolled lazily on the phrase's first tick instead (see tick()).
  function rollPhraseTraits(P, children) {
    children.forEach(function (c) {
      c.intentionRolled = false;
      c.intendsToStop = true;
      // ② how wrong they are about their own stopping distance this phrase
      c.stoppingMisread = 1 + (P.rand() * 2 - 1) * P.STOPPING_MISREAD_SPREAD * (1 - c.judgmentResilience) * 2;
      // and how wrong they are about how far behind schedule they are
      c.paceMisread = 1 + (P.rand() * 2 - 1) * P.PACE_MISREAD_SPREAD * (1 - c.judgmentResilience) * 2;
      // ③ the delay they plan around, and what it actually turns out to be
      c.reactionDelay = P.REACTION_TICKS_MAX - c.reaction * (P.REACTION_TICKS_MAX - P.REACTION_TICKS_MIN);
      c.reactionActual = Math.max(0,
        c.reactionDelay * (1 + (P.rand() * 2 - 1) * P.REACTION_JITTER));
      c.reactionCountdown = null;
      c.reacted = false;
      // how long they have been slow enough not to register, this phrase
      c.safeTicks = 0;
    });
  }

  function pickActiveChildren(P, count) {
    var want = count == null ? P.ACTIVE_CHILDREN : count;
    var pool = (P && P.ROSTER && P.ROSTER.length ? P.ROSTER : ROSTER).slice();
    // A pool smaller than the number of runners asked for silently produces a
    // short field — which is exactly what happened to balances adopted by an
    // older lab that published only its four test subjects as the whole cast:
    // asking for ten runners quietly gave four. Top up from the authored
    // roster instead of shrinking the game.
    if (pool.length < want) {
      var have = {};
      pool.forEach(function (c) { have[c.id] = true; });
      for (var k = 0; k < ROSTER.length && pool.length < want; k++) {
        if (!have[ROSTER[k].id]) pool.push(ROSTER[k]);
      }
    }
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(P.rand() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    return pool.slice(0, want);
  }

  // Evenly spread lanes for however many are running, so the count can change
  // without the track needing a hand-written lane list.
  function laneFor(index, count) {
    if (count <= 1) return 50;
    return 15 + (70 * index) / (count - 1);
  }

  // Turn a roster entry (or a lab-authored def) into a runtime child.
  function makeChild(P, def) {
    // Defaults matter here: the lab publishes child defs with only the fields
    // its sliders expose, so anything added since has to survive being absent.
    var endurance = def.endurance != null ? def.endurance : 0.5;
    // One trait, three consequences. The marathoner carries more, spends it
    // more slowly and gets more back from standing still; the sprinter is the
    // reverse and pays for the top speed it was given in the table above.
    var tank = P.CHILD_ENERGY_MAX * (0.60 + 0.80 * endurance);
    return {
      id: def.id, name: def.name, color: def.color,
      maxSpeed: def.maxSpeed, accel: def.accel, brake: def.brake, accT: def.accT || 0,
      boldness: def.boldness, selfControl: def.selfControl,
      judgmentResilience: def.judgmentResilience != null ? def.judgmentResilience : 0.5,
      motorControl: def.motorControl != null ? def.motorControl : 0.5,
      conformity: def.conformity != null ? def.conformity : 0,
      reaction: def.reaction,
      endurance: endurance,
      bodyAwareness: def.bodyAwareness != null ? def.bodyAwareness : 0.5,
      skepticism: def.skepticism != null ? def.skepticism : 0.5,
      energyMax: tank,
      drainScale: 1.30 - 0.60 * endurance,
      regenScale: 0.70 + 0.60 * endurance,
      // C is filled in per match by assignMotives(), not here.
      motiveName: "steady", motive: P.MOTIVES.steady,
      // D: what this kid currently believes the chant is doing, which is not
      // necessarily what it is doing.
      perceivedFill: null,
      pos: 2, vel: 0, burstTicks: 0, burstCooldown: 0,
      safeTicks: 0, spooked: false,
      energy: tank, feltEnergy: tank, winded: false, freezing: false
    };
  }

  // C: what each kid is playing for THIS match. Drawn independently per kid, so
  // a field of four decoys is unlikely rather than impossible. The same face
  // turns up in a different role every game, so knowing the cast tells you
  // nothing about the motives — you have to read this game.
  function pickMotive(P) {
    var keys = Object.keys(P.MOTIVE_MIX);
    var total = 0, i;
    for (i = 0; i < keys.length; i++) total += P.MOTIVE_MIX[keys[i]];
    var r = P.rand() * total;
    for (i = 0; i < keys.length; i++) {
      r -= P.MOTIVE_MIX[keys[i]];
      if (r <= 0) return keys[i];
    }
    return keys[keys.length - 1];
  }

  function assignMotives(P, children) {
    children.forEach(function (c) {
      c.motiveName = pickMotive(P);
      c.motive = P.MOTIVES[c.motiveName] || P.MOTIVES.steady;
    });
  }

  function newRunState(P, childDefs, typeName) {
    var children = childDefs.map(function (d) { return makeChild(P, d); });
    assignMotives(P, children);
    rollPhraseTraits(P, children);
    var name = typeName || P.DARUMA_TYPE || "normal";
    var type = P.DARUMA_TYPES[name] || P.DARUMA_TYPES.normal;
    var staminaMax = P.STAMINA_MAX * type.staminaScale;
    return {
      typeName: name,
      type: type,
      staminaMax: staminaMax,
      // D: what this daruma has actually been doing, newest last. 1 = turned.
      // Shared, because every kid watched the same game.
      turnLog: [],
      stamina: staminaMax,
      cycle: 1,
      elapsedTicks: 0,
      chantProgress: 0,
      tempoValue: 45,
      reward: "mid",
      turnArmed: false,
      catches: 0,
      turnedCycles: 0,
      whiffedTurns: 0,
      brokeCycles: 0,
      firstBrokeCycle: null,
      minStamina: staminaMax,
      resolvedCycles: 0,
      rewardGained: 0,
      turnCostPaid: 0,
      tempoChangeCostPaid: 0,
      children: children
    };
  }

  // Speeding up costs stamina; easing off is free. Returns the value actually
  // applied — you can't buy more speed than you can pay for.
  //
  // It used to also push a delayed "nervousness" bump at every kid, on the
  // theory that a speed-up rattles them into braking. That was measured to be
  // working against the thing it was meant to enable, and it's gone: tempo now
  // affects the kids in exactly one way, by changing how many ticks are left
  // in the phrase.
  function applyTempoChange(P, st, newVal) {
    var signedDelta = newVal - st.tempoValue;
    if (signedDelta > 0) {
      var perUnit = P.TEMPO_CHANGE_COST_PER_UNIT * st.type.tempoScale;
      var maxAffordable = st.stamina / perUnit;
      if (signedDelta > maxAffordable) {
        signedDelta = maxAffordable;
        newVal = st.tempoValue + maxAffordable;
      }
      var cost = signedDelta * perUnit;
      st.stamina -= cost;
      st.tempoChangeCostPaid += cost;
    }
    st.tempoValue = newVal;
    return newVal;
  }

  // What a skip pays right now.
  function currentSkipReward(P, st) {
    return P.REWARD[st.reward].reward * st.type.skipRewardScale;
  }

  // What turning at this 強気度 actually costs THIS daruma. Everything that
  // asks "can I afford to turn" has to go through here, or a type's discount
  // applies to the bill but not to the decision to pay it.
  // 1 tick でどれだけ速くなるか（2026-10-18）。accT（全速まで何 tick）があれば人の走り出しと同じ伸び方：
  //   速さ = 全速 ×（1 −（1 − 時間/accT）^1.5）。最初の一歩はすぐ出て、全速に近づくほどゆっくり伸びる
  //   （0.1秒で10%、0.5秒で46%、1秒で81%、1.5秒で100%）。いまの速さから「曲線のどこにいるか」を逆算して進める
  //   なければ前と同じで、いつも accel ずつ
  function accelStep(c, top) {
    if (!c.accT) return c.accel;
    var m = c.maxSpeed, r = Math.min(1, c.vel / m);
    var t = 1 - Math.pow(1 - r, 1 / 1.5);
    var t2 = Math.min(1, t + 1 / c.accT);
    return Math.max(0, Math.min(top, m * (1 - Math.pow(1 - t2, 1.5))) - c.vel);
  }

  function turnCostOf(P, st, tier) {
    return P.REWARD[tier || st.reward].turnCost * st.type.turnCostScale;
  }

  // One tick of the whole world. Returns:
  //   { reached: child|null, chantDone: bool, timeUp: bool }
  // The caller resolves the cycle (so it can animate first).
  function tick(P, st) {
    st.stamina = Math.max(0, st.stamina - tempoDrain(P, st.tempoValue) * st.type.tempoScale);
    if (st.stamina <= 0 && st.tempoValue > 0) {
      st.tempoValue = 0; // out of gas -> the pace collapses to a crawl, for free
    }
    st.chantProgress += tempoFill(P, st.tempoValue);


    st.elapsedTicks += 1;
    // How much time is left on the clock. Everyone can see it, and it makes the
    // required-pace read simple: distance remaining over time remaining.
    var ticksLeftOverall = Math.max(1, P.GOAL_TICKS - st.elapsedTicks);

    // Can't even afford the cheapest turn -> no real threat left, and it shows.
    var darumaBroke = st.stamina < turnCostOf(P, st, "low");
    if (st.stamina < st.minStamina) st.minStamina = st.stamina;

    var auraBoldness = P.AURA_BOLDNESS[st.reward] || 0;

    // Herd sense reads everyone's velocity as of the END of last tick, before
    // anyone reacts this tick.
    var groupMovingFraction = st.children.filter(function (c) {
      return c.vel > P.CATCH_VEL_THRESHOLD;
    }).length / st.children.length;
    var herdSignal = (groupMovingFraction - 0.5) * 2;

    // ⑦b How many of them can still get there at all — distance left over time
    // left, against a pace they could hold. This is the same sum each kid
    // already does for itself; here it is done for everyone, because how many
    // teammates are still in it is something you can see.
    //
    // The weight on each survivor is 1/n rather than a flag that only fires for
    // the last one standing: two left is already heavier than four. Measured
    // against a FULL field, not against zero — with everybody still in it
    // nobody is carrying anything unusual, and charging responsibility from the
    // first phrase just made the kids globally more careful (it cost a plain
    // reader 5 points and a turn-every-phrase daruma 20). What this is about is
    // the field thinning out, so that is what it measures.
    var viableCount = 0;
    st.children.forEach(function (c) {
      var need = Math.max(0, P.GOAL_POS - c.pos) / ticksLeftOverall;
      if (need <= c.maxSpeed * P.PACE_FEASIBLE_FRACTION) viableCount += 1;
    });
    var burden = viableCount > 0
      ? Math.max(0, 1 / viableCount - 1 / st.children.length)
      : 0;

    // ⑦ The daruma watches whoever is furthest along, so the front of the field
    // is a position with a price on it. Who is actually out front — clear of
    // the next kid by LEAD_MARGIN — decides who is paying it.
    var ordered = st.children.map(function (c) { return c.pos; })
      .sort(function (a, b) { return b - a; });
    var frontPos = ordered[0];
    var runnerUpPos = ordered.length > 1 ? ordered[1] : ordered[0];

    // D What the record says about this daruma. Nobody has any idea before the
    // first phrase resolves, so an unseen daruma is treated as a coin flip.
    // What this daruma has been doing, weighed against what one of those is
    // supposed to do. On phrase one the assumption is all they have; by the
    // end the record has all but buried it.
    var turnsSeen = st.turnLog.length;
    var sum = 0;
    for (var m = 0; m < turnsSeen; m++) sum += st.turnLog[m];
    var prior = P.TYPE_PRIOR_PHRASES;
    var turnedRate = (sum + st.type.expectTurn * prior) / (turnsSeen + prior);

    var reached = null;
    st.children.forEach(function (c) {
      if (c.burstCooldown > 0) c.burstCooldown -= 1;
      var oldVel = c.vel;

      if (c.caughtNow) {
        // 見つかった子は、その場で固まる（押し戻されるのは見終わってから）
        c.vel = 0;
      } else if (st.looking && !c.human) {
        // だるまがこっちを見ている。CPU の子はみんな止まろうとする
        c.vel = Math.max(0, c.vel - c.brake);
      } else if (c.human) {
        // 人が走らせている子（2026-10-18）。押している間は加速、離すとブレーキ。考えるのは人なので、
        // 下の AI は飛ばす。体（体力・疲れ）は CPU の子とまったく同じ：走ると減り、速さを変えるだけでも減り、
        // 0 になると「ぜぇ」で遅くなる。疲れているほどブレーキも効きにくい
        var hTop = c.winded ? c.maxSpeed * P.WINDED_SPEED_MULT : c.maxSpeed;
        var hFat = (1 - c.energy / c.energyMax) * (1 - c.motorControl) * P.MOTOR_DEGRADE_SCALE;
        var hBrake = c.brake * clamp(1 - hFat, 0.2, 1);
        if (c.input) c.vel = c.vel > hTop ? Math.max(hTop, c.vel - hBrake) : Math.min(hTop, c.vel + accelStep(c, hTop));
        else c.vel = Math.max(0, c.vel - hBrake);
        var hEffort = P.RUN_DRAIN_EXPONENT === 1 ? 1
          : Math.pow(clamp(c.vel / Math.max(0.001, c.maxSpeed), 0, 1), P.RUN_DRAIN_EXPONENT - 1);
        var hSteady = (c.vel < c.maxSpeed * P.REGEN_VEL_RATIO)
          ? P.REST_REGEN_RATE * c.regenScale
          : -(c.vel * P.RUN_DRAIN_RATE * c.drainScale * hEffort);
        c.energy = clamp(c.energy + hSteady - Math.abs(c.vel - oldVel) * P.CHANGE_DRAIN_RATE, 0, c.energyMax);
        c.feltEnergy = c.energy;
      } else if (c.burstTicks > 0) {
        // mid-dash: committed, ignores nervousness entirely.
        c.burstTicks -= 1;
        c.vel = c.maxSpeed * P.BURST_SPEED_MULT;
        c.energy = Math.max(0, c.energy - c.vel * P.RUN_DRAIN_RATE);
      } else {
        var burstChance = c.winded ? 0
          : P.BURST_CHANCE_BASE * (0.5 + c.boldness) * (c.energy / c.energyMax);
        if (!c.winded && c.burstCooldown <= 0 && c.energy >= P.BURST_ENERGY_COST && P.rand() < burstChance) {
          c.burstTicks = P.BURST_DURATION;
          c.burstCooldown = P.BURST_COOLDOWN;
          c.energy -= P.BURST_ENERGY_COST;
          c.vel = c.maxSpeed * P.BURST_SPEED_MULT;
        } else {
          var effMaxSpeed = c.winded ? c.maxSpeed * P.WINDED_SPEED_MULT : c.maxSpeed;
          // ⑦ Am I the one being watched? Only the kid clear of the field by
          // LEAD_MARGIN is; everyone else is just part of the scenery.
          var isOutFront = c.pos >= frontPos - 1e-9 &&
            (c.pos - runnerUpPos) >= P.LEAD_MARGIN;
          // ⑦b Does the weight of it land on this kid? Only if it can still get
          // there itself — someone already out of contention has nothing left
          // to carry. And not everybody feels it: it takes both caring how the
          // thing goes (effort) and minding being the one who blew it (shame),
          // so the kid who doesn't mind getting caught doesn't feel this at all.
          var myNeed = Math.max(0, P.GOAL_POS - c.pos) / ticksLeftOverall;
          var responsibility = (myNeed <= c.maxSpeed * P.PACE_FEASIBLE_FRACTION)
            ? burden * clamp(c.motive.effort * c.motive.shame * 2, 0, 1)
            : 0;
          // B 疲労の自覚 — what they BELIEVE is left in the tank. The bias only
          // runs one way on purpose: nobody ever feels more tired than they are.
          // A kid with low bodyAwareness therefore commits to runs its legs
          // cannot finish, which is a catch with a reason you can narrate.
          c.feltEnergy = c.energy +
            (c.energyMax - c.energy) * P.FATIGUE_MISREAD * (1 - c.bodyAwareness);
          // below half a tank, cautious kids start pacing themselves; bold kids
          // barely notice and keep pushing until they're actually winded. What
          // they pace against is the felt number, not the real one.
          var energyCaution = clamp((c.energyMax * 0.5 - c.feltEnergy) / (c.energyMax * 0.5), 0, 1);

          // "the goal is that far and there's that much time left — can I still
          // make it at a pace I can stop from?" Under PACE_COMFORT they're ahead
          // of schedule and can afford to be careful; past 1.0 no safe pace gets
          // them there and the only option left is to take risks.
          var neededSpeed = Math.max(0, P.GOAL_POS - c.pos) / ticksLeftOverall;
          var feasibleSpeed = Math.max(0.001, effMaxSpeed * P.PACE_FEASIBLE_FRACTION);
          var pressure = (neededSpeed / feasibleSpeed) * c.paceMisread;
          var paceBoldness = clamp(pressure - P.PACE_COMFORT, -P.PACE_COMFORT, 1.5) * P.PACE_WEIGHT;

          var herdBoldness = c.conformity * herdSignal * P.HERD_SCALE;
          var effBoldness = clamp(
            c.boldness + paceBoldness +
            (darumaBroke ? 0.2 : 0) + auraBoldness + herdBoldness -
            energyCaution * c.selfControl * P.PACING_SCALE, 0, 0.97);
          // fatigue degrades braking power, gated by motor control. This one
          // reads the REAL number: your legs don't care what you think.
          var fatigueRatio = 1 - c.energy / c.energyMax;
          var motorDegrade = fatigueRatio * (1 - c.motorControl) * P.MOTOR_DEGRADE_SCALE;
          var effBrake = c.brake * clamp(1 - motorDegrade, 0.2, 1);

          // ① Do they even mean to stop this phrase? Rolled once, on the first
          // tick, because the daruma's 強気度 tell is only set during prep and
          // is part of what they're reading. A daruma too broke to turn is no
          // threat at all, so nobody bothers.
          if (!c.intentionRolled) {
            c.intentionRolled = true;
            // D どれくらい振り向いてきた相手か。A suspicious kid leans on the
            // record, a trusting one goes on the tell and the even odds.
            var memW = clamp(P.MEMORY_WEIGHT * c.skepticism * 2, 0, 1);
            var threat = (1 - memW) * 0.5 + memW * turnedRate;
            var gambleChance = clamp(
              c.boldness * P.GAMBLE_BASE + auraBoldness + paceBoldness +
              (0.5 - threat) * P.GAMBLE_THREAT_WEIGHT +
              // 得点欲: the closer it is, the harder the one who wants it pushes
              (c.motive.greed - 0.5) * (c.pos / P.GOAL_POS) * P.GAMBLE_GREED_WEIGHT -
              (1 - c.motive.effort) * P.GAMBLE_EFFORT_WEIGHT -
              // ⑦b it's on me — not the moment to try anything
              responsibility * P.RESPONSIBILITY_GAMBLE,
              0, 0.95);
            c.intendsToStop = P.rand() >= gambleChance;
          }

          // Kids hear the chant, so roughly WHEN it lands is not in doubt — but
          // how fast it is going right now is a thing you notice, not a thing
          // you are told. PERCEIVED_TEMPO_LAG is what makes a late ramp a feint
          // rather than just a shorter phrase: a kid still running on the old
          // speed budgets too much time and gets left moving.
          //
          // This was cut once for earning nothing, which was true as measured —
          // against opponents who never changed tempo mid-phrase there is
          // nothing to be late about. Against a daruma that ramps at the end it
          // is worth several points, and it is the counterweight that stops
          // "reads the daruma well" from being a pure upgrade.
          var trueFill = tempoFill(P, st.tempoValue);
          c.perceivedFill = (c.perceivedFill == null || P.PERCEIVED_TEMPO_LAG <= 0)
            ? trueFill
            : c.perceivedFill + (trueFill - c.perceivedFill) / (1 + P.PERCEIVED_TEMPO_LAG);
          var ticksLeft = Math.max(0, (100 - st.chantProgress) / c.perceivedFill);
          // what matters is getting under the catch threshold, not to a dead
          // stop — you're safe the moment you're slow enough not to register
          var ticksToSafe = effBrake > 0
            ? Math.max(0, (c.vel - P.CATCH_VEL_THRESHOLD) / effBrake) : Infinity;
          // ② they act on their belief about that distance, not the truth
          var believedTicksToSafe = ticksToSafe * c.stoppingMisread;
          // ⑤ plus however much margin their nerve demands, plus whatever the
          // thought of being the FIRST one sent back is worth to them. That
          // second part fades as the clock runs down — there is nothing
          // embarrassing about getting caught on the last phrase.
          var shameNow = c.motive.shame * (1 - st.elapsedTicks / P.GOAL_TICKS);
          var lead = P.FREEZE_LEAD_MAX -
            effBoldness * (P.FREEZE_LEAD_MAX - P.FREEZE_LEAD_MIN) +
            shameNow * P.SHAME_LEAD +
            // ⑤b still shaken from last phrase's near miss
            (c.spooked ? P.NEAR_MISS_LEAD : 0) +
            // ⑦b and the weight of being what's left of the team
            responsibility * P.RESPONSIBILITY_LEAD;

          // they budget for their own reaction time as well as the braking
          var needsToStop = c.intendsToStop && !darumaBroke &&
            ticksLeft <= believedTicksToSafe + lead + c.reactionDelay;

          // ③ realising the phrase is ending and acting on it are not the same
          // instant — but it's ONE realisation per phrase, not one per
          // decision. Kids dip in and out of the danger window several times a
          // phrase (braking shortens the stopping distance, which hands back
          // enough room to open up again), and charging the delay every time
          // meant anything above 0 left somebody stranded every single phrase:
          // turning could never whiff. Once they've woken up to it, they're
          // awake for the rest of the phrase.
          if (needsToStop && !c.reacted) {
            if (c.reactionCountdown === null) c.reactionCountdown = c.reactionActual;
            if (c.reactionCountdown > 0) c.reactionCountdown -= 1;
            else c.reacted = true;
          }
          c.freezing = needsToStop && c.reacted;

          if (c.freezing) {
            c.vel = Math.max(0, c.vel - effBrake);
          } else {
            // ⑥ how hard to run. Distance costs energy at a rate that climbs
            // with speed (RUN_DRAIN_EXPONENT), so this is a real trade and not
            // the formality it was when everyone simply ran flat out.
            //
            // The tank can carry me the whole rest of the way -> nothing left to
            // save it for. That test is the last spurt: it fires on its own, and
            // it fires at a different moment for every kid because the answer
            // depends on their own tank and their own burn rate.
            var distToGoal = Math.max(0, P.GOAL_POS - c.pos);
            var energyHome = distToGoal * P.RUN_DRAIN_RATE * c.drainScale;
            var want = (c.feltEnergy >= energyHome)
              ? 1
              // otherwise: the pace that gets them there with the margin they'd
              // want, plus however much more than that this kid wants it.
              // Dividing by PACE_COMFORT matters — pacing to the bare minimum
              // means running with no slack at all, which ends with the whole
              // field behind schedule and gambling. They only ease off when
              // genuinely ahead.
              : clamp(pressure / P.PACE_COMFORT, 0, 1) +
                P.GREED_PACE_BONUS * c.motive.greed * c.motive.effort;
            // ⑦ out front is where the daruma is looking. How much that is
            // worth easing off for is exactly how much being caught bothers you.
            if (isOutFront) want -= P.LEAD_SHYNESS * c.motive.shame;
            // やる気: a kid who isn't really trying has a lower ceiling, full
            // stop — no read, no clock and no tank talks them past it.
            var effortCeil = P.EFFORT_SPEED_FLOOR +
              (1 - P.EFFORT_SPEED_FLOOR) * c.motive.effort;
            var target = effMaxSpeed * clamp(want, P.CRUISE_MIN, effortCeil);
            c.vel = (c.vel > target)
              ? Math.max(target, c.vel - effBrake * 0.5)
              : Math.min(target, c.vel + accelStep(c, effMaxSpeed));
          }

          // energy: sustained speed drains/regens, PLUS the act of changing
          // speed at all (speeding up OR braking) costs its own share.
          //
          // The effort premium is normalised at the kid's own top speed, so an
          // exponent of 1 reproduces the original linear drain exactly. Above 1
          // it is what makes a slower cruise actually buy something: without it
          // a given distance costs the same whatever pace you take it at.
          var effort = P.RUN_DRAIN_EXPONENT === 1 ? 1
            : Math.pow(clamp(c.vel / Math.max(0.001, c.maxSpeed), 0, 1),
                       P.RUN_DRAIN_EXPONENT - 1);
          var steadyDelta = (c.vel < c.maxSpeed * P.REGEN_VEL_RATIO)
            ? P.REST_REGEN_RATE * c.regenScale
            : -(c.vel * P.RUN_DRAIN_RATE * c.drainScale * effort);
          var changeCost = Math.abs(c.vel - oldVel) * P.CHANGE_DRAIN_RATE;
          c.energy = clamp(c.energy + steadyDelta - changeCost, 0, c.energyMax);
        }
      }
      if (c.winded && c.energy >= P.WINDED_RECOVER_AT) c.winded = false;
      if (c.energy <= 0) c.winded = true;

      // ⑤b how long they have been under the wire, for the near-miss read at
      // the end of the phrase
      if (c.vel <= P.CATCH_VEL_THRESHOLD) c.safeTicks += 1;
      else c.safeTicks = 0;

      c.pos = Math.min(100, c.pos + c.vel);
      if (c.pos >= P.GOAL_POS && !reached) reached = c;
    });

    return {
      reached: reached,
      chantDone: st.chantProgress >= 100,
      // the clock can run out mid-phrase; lasting that long is the win
      timeUp: st.elapsedTicks >= P.GOAL_TICKS
    };
  }

  // Resolve the end of a phrase. Returns a description of what happened so the
  // front end can log/animate it:
  //   { turned, underpowered, caught: [child], whiff, gained, cost, gameOver }
  function resolveCycle(P, st) {
    st.chantProgress = 100;
    var r = P.REWARD[st.reward];
    st.resolvedCycles += 1;
    if (st.stamina < turnCostOf(P, st, "low")) {
      st.brokeCycles += 1;
      if (st.firstBrokeCycle == null) st.firstBrokeCycle = st.cycle;
    }

    var out = { turned: false, underpowered: false, caught: [], whiff: false, gained: 0, cost: 0 };
    var turnCost = turnCostOf(P, st);
    var canAfford = st.stamina >= turnCost;

    if (st.turnArmed && canAfford) {
      st.turnedCycles += 1;
      st.stamina -= turnCost;
      st.turnCostPaid += turnCost;
      out.turned = true;
      out.cost = turnCost;
      st.children.forEach(function (c) {
        if (c.vel > P.CATCH_VEL_THRESHOLD) {
          out.caught.push(c);
          // CATCH_KNOCK（2026-10-18）：null ならスタートへ。数なら、その分だけ下がる
          var back = P.CATCH_KNOCK == null ? c.pos - 2 : Math.min(c.pos - 2, P.CATCH_KNOCK);
          c.pos -= back; c.vel = 0; c.burstTicks = 0;
          // Walking back to the line is the one real rest anybody gets, so the
          // tank comes back with them. Without this the punishment is double —
          // a kid caught late restarts the whole 94 units on an empty tank and
          // is out of the game in everything but name, which is neither how it
          // works nor interesting to watch.
          // 下がった分だけ戻る（スタートまでなら満タン）
          c.energy = P.CATCH_KNOCK == null ? c.energyMax : Math.min(c.energyMax, c.energy + c.energyMax * back / (P.GOAL_POS - 2));
          if (c.energy >= P.WINDED_RECOVER_AT) c.winded = false;
          st.catches += 1;
        }
      });
      if (out.caught.length === 0) { st.whiffedTurns += 1; out.whiff = true; }
    } else if (st.turnArmed && !canAfford) {
      // desperate, underpowered attempt: burns whatever's left, catches nobody,
      // and — since you weren't skipping — earns no reward either.
      out.underpowered = true;
      out.cost = st.stamina;
      st.turnCostPaid += st.stamina;
      st.stamina = 0;    } else {
      var before = st.stamina;
      var gained = currentSkipReward(P, st);
      st.stamina = Math.min(st.staminaMax, st.stamina + gained);
      st.rewardGained += st.stamina - before;
      out.gained = st.stamina - before;
    }

    // D What the kids just watched happen. An underpowered lunge still reads as
    // "they turned" from the front — the kids can't see a stamina bar, only
    // whether the head came round.
    st.turnLog.push((out.turned || out.underpowered) ? 1 : 0);
    if (st.turnLog.length > P.DARUMA_MEMORY_SPAN) st.turnLog.shift();

    // ⑤b Who just had a fright. Read BEFORE the traits are rerolled, applied
    // after — it lasts exactly one phrase and never stacks. A kid that was
    // caught doesn't get this: it didn't have a near miss, it had a miss.
    var frights = [];
    st.children.forEach(function (c) {
      var scared = P.NEAR_MISS_TICKS > 0 &&
        out.caught.indexOf(c) < 0 &&
        c.safeTicks > 0 && c.safeTicks <= P.NEAR_MISS_TICKS &&
        P.rand() < P.NEAR_MISS_CHANCE;
      frights.push(scared);
    });

    st.chantProgress = 0;
    st.cycle += 1;
    st.turnArmed = false;
    rollPhraseTraits(P, st.children);
    st.children.forEach(function (c, i) { c.spooked = frights[i]; });
    return out;
  }

  return {
    DEFAULTS: DEFAULTS,
    CHANT_CHARS: CHANT_CHARS,
    ROSTER: ROSTER,
    makeConfig: makeConfig,
    adoptedOverrides: adoptedOverrides,
    adoptBalance: adoptBalance,
    clearAdoptedBalance: clearAdoptedBalance,
    clamp: clamp,
    tempoFill: tempoFill,
    tempoDrain: tempoDrain,
    tempoLabel: tempoLabel,
    rollPhraseTraits: rollPhraseTraits,
    pickActiveChildren: pickActiveChildren,
    laneFor: laneFor,
    makeChild: makeChild,
    pickMotive: pickMotive,
    assignMotives: assignMotives,
    newRunState: newRunState,
    applyTempoChange: applyTempoChange,
    currentSkipReward: currentSkipReward,
    turnCostOf: turnCostOf,
    tick: tick,
    resolveCycle: resolveCycle
  };
});
