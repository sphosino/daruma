"use strict";
// Headless batch simulator: runs a set of daruma-playing policies against the
// shared game loop in daruma-core.js and reports how each one does.
//
// This file holds NO game logic — only policies and reporting. daruma-game.html
// and daruma-balance-lab.html run the exact same core, so a result measured
// here is a result about the actual game.
//
// Usage:
//   node daruma-sim.js
//   SPEED_SCALE=0.6 node daruma-sim.js          -> re-scale child speed
//   CREEP_LINE=65 node daruma-sim.js            -> where the readers decide to turn
//   ONLY=smart_line,front_load node daruma-sim.js -> just those batches
//   N=300 node daruma-sim.js                    -> fewer games per batch
// Any core knob can be overridden the same way: STAMINA_MAX, MISREAD,
// FREEZE_LEAD_MIN/MAX, DRAIN_MAX (= TEMPO_MAX.drainPerTick), KIDS, ROSTER.

const Core = require("./daruma-core.js");

const num = (name, fallback) => (process.env[name] ? parseFloat(process.env[name]) : fallback);

// SPEED_SCALE=1.0 matches the values shipped in daruma-core.js. Override to
// explore other tunings without editing the roster.
const SPEED_SCALE = num("SPEED_SCALE", 1.0);

const P = Core.makeConfig({
  STAMINA_MAX: num("STAMINA_MAX", Core.DEFAULTS.STAMINA_MAX),
  GOAL_TICKS: num("GOAL_TICKS", Core.DEFAULTS.GOAL_TICKS),
  // DARUMA_TYPE=oni node daruma-sim.js -> run every policy as that type
  DARUMA_TYPE: process.env.DARUMA_TYPE || Core.DEFAULTS.DARUMA_TYPE,
  FREEZE_LEAD_MIN: num("FREEZE_LEAD_MIN", Core.DEFAULTS.FREEZE_LEAD_MIN),
  FREEZE_LEAD_MAX: num("FREEZE_LEAD_MAX", Core.DEFAULTS.FREEZE_LEAD_MAX),
  STOPPING_MISREAD_SPREAD: num("MISREAD", Core.DEFAULTS.STOPPING_MISREAD_SPREAD),
  REACTION_TICKS_MAX: num("REACTION_MAX", Core.DEFAULTS.REACTION_TICKS_MAX),
  REACTION_JITTER: num("REACTION_JITTER", Core.DEFAULTS.REACTION_JITTER),
  PACE_FEASIBLE_FRACTION: num("PACE_FRAC", Core.DEFAULTS.PACE_FEASIBLE_FRACTION),
  PACE_COMFORT: num("PACE_COMFORT", Core.DEFAULTS.PACE_COMFORT),
  PACE_WEIGHT: num("PACE_WEIGHT", Core.DEFAULTS.PACE_WEIGHT),
  // Note: TEMPO_DRAIN_CURVE does nothing to a ramp that goes to exactly 100
  // (ratio = 1^n = 1). The two knobs that actually price an ambush are the
  // top-end drain and the one-off cost of speeding up.
  TEMPO_CHANGE_COST_PER_UNIT: num("CHANGE_COST", Core.DEFAULTS.TEMPO_CHANGE_COST_PER_UNIT),
  TEMPO_DRAIN_CURVE: num("DRAIN_CURVE", Core.DEFAULTS.TEMPO_DRAIN_CURVE),
  TEMPO_FILL_CURVE: num("FILL_CURVE", Core.DEFAULTS.TEMPO_FILL_CURVE),
  TEMPO_MAX: {
    fillPerTick: num("FILL_MAX", Core.DEFAULTS.TEMPO_MAX.fillPerTick),
    drainPerTick: num("DRAIN_MAX", Core.DEFAULTS.TEMPO_MAX.drainPerTick)
  }
});

const GOAL_TICKS = P.GOAL_TICKS;

// ROSTER=random draws 4 of the 10 fresh for every game, which is what the game
// itself does. The default fixed 4 keep results comparable run to run, but they
// are NOT a neutral sample: they brake 15% worse and are 11% bolder than the
// roster average, both of which make them easier to catch. Measure against
// random before trusting a number as "how the game plays".
const scaled = d => Object.assign({}, d, {
  maxSpeed: d.maxSpeed * SPEED_SCALE,
  accel: d.accel * SPEED_SCALE,
  brake: d.brake * SPEED_SCALE
});
// KIDS=n puts n runners on the track at once. The game itself is always 4
// (four lanes, pickActiveChildren(P, 4)); this exists to show how steep that
// lever is, not because other counts are the game.
const KIDS = process.env.KIDS ? parseInt(process.env.KIDS, 10) : 4;
const RANDOM_ROSTER = process.env.ROSTER === "random" || KIDS !== 4;
const FIXED_DEFS = Core.ROSTER.slice(0, KIDS).map(scaled);
const childDefs = () => RANDOM_ROSTER
  ? Core.pickActiveChildren(P, KIDS).map(scaled)
  : FIXED_DEFS;

// --- Risk projection helpers shared by the non-random policies -------------
function projectedPosOf(st, c) {
  const remainingProgress = 100 - st.chantProgress;
  const ticksLeft = Math.max(0, remainingProgress / Core.tempoFill(P, st.tempoValue));
  const rampTicks = Math.min(ticksLeft, 4);
  const projectedVel = Math.min(c.maxSpeed, c.vel + c.accel * rampTicks);
  const avgVel = (c.vel + projectedVel) / 2;
  return c.pos + avgVel * ticksLeft;
}

// "will anyone cross before this chant ends" — immediate, this-cycle danger.
function projectedDanger(st, marginTicks) {
  return st.children.some(c => projectedPosOf(st, c) >= P.GOAL_POS - marginTicks);
}

// How much track is left in front of the leader. This is the danger the
// this-cycle projection can't see: kids creep forward every cycle you skip, and
// turning only resets the ones actually MOVING at the instant of resolution. A
// kid parked one step short of the goal is untouchable — they win the moment
// they pick a cycle to walk it in. A daruma who only reacts to "someone will
// cross RIGHT NOW" has already lost the position battle by the time it fires.
const CREEP_LINE = num("CREEP_LINE", 65);
// How far into the phrase the ambush policies slam the tempo up. Late enough
// and the kids have already committed to their stop, so there's nobody left to
// strand — AMBUSH_AT is the knob for testing that.
const AMBUSH_AT = num("AMBUSH_AT", 65);
// Ticks left in the phrase (measured at full tempo) when the ambush fires. The
// meaningful scale: kids need roughly 2-13 ticks for reaction + braking + margin.
const AMBUSH_TICKS_LEFT = num("AMBUSH_TICKS", 6);
function leaderProjectedPos(st) {
  return st.children.reduce((m, c) => Math.max(m, projectedPosOf(st, c)), 0);
}
// Turning only pays if it actually resets somebody, so a reader wants to know
// whether anyone is still moving. It must work that out the way a player does:
// by watching the drawn positions change.
//
// Reading c.vel against CATCH_VEL_THRESHOLD would be cheating, and not by a
// little. At the catch threshold a runner covers 0.25px per frame on the
// rendered track and 2.5px in a whole second — invisible. The exact cutoff
// between "catchable" and "safe" is not information a human can have.
//
// So: compare each runner's position against where it was MOVE_WINDOW ticks
// ago. 0.4 pos units is about 2px on screen, roughly the smallest drift a
// person would notice over that window. The lag is the point — a reader learns
// that someone stopped only after they've been stopped for a moment.
// And only for ONE runner. Watching four of them closely enough to call each
// one still is not something a person does; you watch whoever is furthest
// along, because that's the one about to end your game.
const MOVE_WINDOW = 8;  // ticks (0.8s)
const MOVE_EPS = 0.4;   // pos units (~2px)

function recordPositions(st) {
  if (!st._posLog) st._posLog = [];
  st._posLog.push(st.children.map(c => c.pos));
  if (st._posLog.length > MOVE_WINDOW + 1) st._posLog.shift();
}
function leaderMoving(st) {
  const log = st._posLog;
  if (!log || log.length < 2) return true; // nothing observed yet — assume the worst
  const now = log[log.length - 1];
  const then = log[0];
  let lead = 0;
  for (let i = 1; i < now.length; i++) if (now[i] > now[lead]) lead = i;
  return now[lead] - then[lead] > MOVE_EPS;
}

// --- What a player can actually read off the track -------------------------
// Not a projection. A person doesn't compute where a runner lands; they see
// "that one's close" and "that one's slowing down, they're about to stop".
// Both of these use only drawn positions.
function leaderIndex(now) {
  let lead = 0;
  for (let i = 1; i < now.length; i++) if (now[i] > now[lead]) lead = i;
  return lead;
}
// How far along the leader is, right now, as drawn.
function leaderPos(st) {
  const log = st._posLog;
  if (!log || !log.length) return 0;
  const now = log[log.length - 1];
  return now[leaderIndex(now)];
}
// Is the leader easing off? Compare how much ground they covered in the first
// half of the observed window against the second half.
function leaderSlowing(st) {
  const log = st._posLog;
  if (!log || log.length < 5) return false;
  const mid = Math.floor(log.length / 2);
  const i = leaderIndex(log[log.length - 1]);
  const early = log[mid][i] - log[0][i];
  const late = log[log.length - 1][i] - log[mid][i];
  return late < early * 0.6; // noticeably slower than a moment ago
}

// --- Policies --------------------------------------------------------------
// onPrep(st) runs once per new cycle (sets reward + starting tempo),
// onTick(st) runs every tick during chanting (may adjust tempo / turnArmed).
const setTempo = (st, v) => Core.applyTempoChange(P, st, v);

const policies = {
  // fixed rhythm, no reading at all: odd cycles turn cheap, even cycles skip
  // big. Tests whether a cheap-defense/big-bank pattern beats watching.
  alternate: {
    onPrep(st) {
      const willTurn = st.cycle % 2 === 1;
      st.reward = willTurn ? "low" : "max";
      setTempo(st, 45);
    },
    onTick(st) { st.turnArmed = st.cycle % 2 === 1; }
  },
  // another fixed script: bank big for 3 cycles (kids can't be dangerous yet),
  // then defend cheaply every cycle after.
  front_load: {
    onPrep(st) {
      const early = st.cycle <= 3;
      st.reward = early ? "max" : "low";
      setTempo(st, 45);
    },
    onTick(st) { st.turnArmed = st.cycle > 3; }
  },
  turtle: {
    onPrep(st) { st.reward = "low"; setTempo(st, 15); },
    onTick(st) { st.turnArmed = projectedDanger(st, 6); }
  },
  rusher: {
    onPrep(st) { st.reward = "high"; setTempo(st, 85); },
    onTick(st) { st.turnArmed = projectedDanger(st, 2); }
  },
  smart: {
    onPrep(st) {
      const healthy = st.stamina > st.staminaMax * 0.5;
      st.reward = healthy ? "high" : "low";
      setTempo(st, healthy ? 55 : 25);
    },
    onTick(st) { st.turnArmed = projectedDanger(st, 4); }
  },
  // smart, but reading POSITION instead of only imminent crossings: turns as
  // soon as the leader is past the creep line, so kids never get to set up camp
  // next to the goal. This is what "actually watching the board" should mean.
  smart_line: {
    onPrep(st) {
      const healthy = st.stamina > st.staminaMax * 0.5;
      st.reward = healthy ? "high" : "low";
      setTempo(st, healthy ? 55 : 25);
    },
    onTick(st) {
      st.turnArmed = projectedDanger(st, 4) || leaderProjectedPos(st) >= CREEP_LINE;
    }
  },
  // same, but refuses to pay for a turn that would catch nobody — unless
  // someone is about to cross, in which case you turn regardless and hope.
  smart_line_moving: {
    onPrep(st) {
      const healthy = st.stamina > st.staminaMax * 0.5;
      st.reward = healthy ? "high" : "low";
      setTempo(st, healthy ? 55 : 25);
    },
    onTick(st) {
      const crossing = projectedDanger(st, 4);
      const creeping = leaderProjectedPos(st) >= CREEP_LINE;
      st.turnArmed = crossing || (creeping && leaderMoving(st));
    }
  },
  // The honest reader: everything it knows comes off the drawn track. No
  // velocities, no accelerations, no projected landing points — just "the
  // leader is far enough along to worry me" and "they're easing off, so
  // they'll probably be stopped by the time I turn, and I'd be paying for
  // nothing". This is the benchmark for what a human could actually play.
  smart_human: {
    onPrep(st) {
      const healthy = st.stamina > st.staminaMax * 0.5;
      st.reward = healthy ? "high" : "low";
      setTempo(st, healthy ? 55 : 25);
    },
    onTick(st) {
      const close = leaderPos(st) >= CREEP_LINE;
      st.turnArmed = close && leaderMoving(st) && !leaderSlowing(st);
    }
  },
  // 強気度 is chosen before the chant starts and cannot be changed once it's
  // running — that pre-commitment is what stands in for the daruma not being
  // able to see. These four read the board exactly like smart_human but lock a
  // single tier for the whole game: if they score the same, the commitment
  // costs nothing and the mechanic is a formality.
  fixed_low: {
    onPrep(st) { st.reward = "low"; setTempo(st, 55); },
    onTick(st) { st.turnArmed = leaderPos(st) >= CREEP_LINE && leaderMoving(st) && !leaderSlowing(st); }
  },
  fixed_mid: {
    onPrep(st) { st.reward = "mid"; setTempo(st, 55); },
    onTick(st) { st.turnArmed = leaderPos(st) >= CREEP_LINE && leaderMoving(st) && !leaderSlowing(st); }
  },
  fixed_high: {
    onPrep(st) { st.reward = "high"; setTempo(st, 55); },
    onTick(st) { st.turnArmed = leaderPos(st) >= CREEP_LINE && leaderMoving(st) && !leaderSlowing(st); }
  },
  fixed_max: {
    onPrep(st) { st.reward = "max"; setTempo(st, 55); },
    onTick(st) { st.turnArmed = leaderPos(st) >= CREEP_LINE && leaderMoving(st) && !leaderSlowing(st); }
  },
  // Speeding up and NOT turning is a move in its own right: a short phrase is
  // a phrase the kids spend mostly stopping, so it buys ground back without
  // paying any turn cost. These two isolate that.
  //
  // feint_only never turns at all, so every difference from never_turn is pure
  // suppression — how much later the kids arrive, bought with tempo alone.
  feint_only: {
    onPrep(st) {
      st.reward = "max";
      setTempo(st, 55);
      st._ramped = false;
    },
    onTick(st) {
      st.turnArmed = false;
      const ticksAfterRamp = (100 - st.chantProgress) / Core.tempoFill(P, 100);
      if (!st._ramped && ticksAfterRamp <= AMBUSH_TICKS_LEFT) {
        setTempo(st, 100);
        st._ramped = true;
      }
      if (st.chantProgress < 5) st._ramped = false;
    }
  },
  // The playable combination: read as usual, and on the cycles it has decided
  // NOT to turn, spend a little tempo to shorten the phrase instead.
  smart_human_feint: {
    onPrep(st) {
      const healthy = st.stamina > st.staminaMax * 0.5;
      st.reward = healthy ? "high" : "low";
      setTempo(st, healthy ? 55 : 25);
      st._ramped = false;
    },
    onTick(st) {
      const close = leaderPos(st) >= CREEP_LINE;
      const wantTurn = close && leaderMoving(st) && !leaderSlowing(st);
      st.turnArmed = wantTurn;
      const ticksAfterRamp = (100 - st.chantProgress) / Core.tempoFill(P, 100);
      if (!wantTurn && !st._ramped && ticksAfterRamp <= AMBUSH_TICKS_LEFT) {
        setTempo(st, 100);
        st._ramped = true;
      }
      if (st.chantProgress < 5) st._ramped = false;
    }
  },
  // The tempo attack on top of the honest reader — the only comparison that
  // means anything now. Identical to smart_human except that on the cycles it
  // has decided to turn, it slams the tempo up late and holds it there.
  //
  // It is no longer about deception: the perceived-tempo mechanic it was built
  // for was measured to be inert and removed. All a late ramp does now is
  // compress the ticks left in the phrase — so it can only strand somebody if
  // what remains AFTER the ramp is shorter than the reaction and braking they
  // still need. That budget is about 2-13 ticks (reaction 0-5, braking 2-3,
  // safety margin 0-5), which is why the trigger is "ticks remaining", not a
  // percentage: ramping at 40% of the phrase still leaves ~16 ticks and every
  // kid simply recalculates and stops normally, for no gain and a real cost.
  smart_human_ambush: {
    onPrep(st) {
      const healthy = st.stamina > st.staminaMax * 0.5;
      st.reward = healthy ? "high" : "low";
      setTempo(st, healthy ? 55 : 25);
      st._ambushed = false;
    },
    onTick(st) {
      const close = leaderPos(st) >= CREEP_LINE;
      const wantTurn = close && leaderMoving(st) && !leaderSlowing(st);
      // ticks left at the tempo we'd be ramping TO — that's the window the
      // kids would actually be given
      const ticksAfterRamp = (100 - st.chantProgress) / Core.tempoFill(P, 100);
      if (wantTurn && !st._ambushed && ticksAfterRamp <= AMBUSH_TICKS_LEFT) {
        setTempo(st, 100);
        st._ambushed = true;
      }
      st.turnArmed = wantTurn;
      if (st.chantProgress < 5) st._ambushed = false;
    }
  },
  // The tempo attack layered on top of good positional reading. Isolates what
  // the perception lag is worth: same turn decisions as smart_line_moving, but
  // on the cycles it commits to a turn it slams the tempo late so kids working
  // off the old pace can't stop in time.
  //
  // Measured result: it does NOT pay, and the reason is cost, not the kids.
  // Holding tempo 100 for the rest of a phrase burns ~7 stamina plus the ~5
  // change cost, and that money comes straight out of the turn budget — the
  // ambush version turns on 11.9% of cycles versus 25.9% for the plain reader
  // (turn spend 28.9 vs 68.4). Buying the speed-up means you can't afford to
  // turn, which is the only thing that actually catches anyone. Tested with the
  // nervousness braking disabled and at trigger points from 15% to 65% of the
  // phrase; negative in every combination. AMBUSH_AT re-runs that experiment.
  smart_line_ambush: {
    onPrep(st) {
      const healthy = st.stamina > st.staminaMax * 0.5;
      st.reward = healthy ? "high" : "low";
      setTempo(st, healthy ? 55 : 25);
      st._ambushed = false;
    },
    onTick(st) {
      const crossing = projectedDanger(st, 4);
      const creeping = leaderProjectedPos(st) >= CREEP_LINE;
      const wantTurn = crossing || (creeping && leaderMoving(st));
      if (wantTurn && !st._ambushed && st.chantProgress > AMBUSH_AT) {
        setTempo(st, 100);
        st._ambushed = true;
      }
      st.turnArmed = wantTurn;
      if (st.chantProgress < 5) st._ambushed = false;
    }
  },
  // every ~1.2s pulse tempo up-then-back-down purely to spook the kids, even
  // on cycles it plans to skip. Tests whether feinting is worth its cost.
  smart_feint: {
    onPrep(st) {
      const healthy = st.stamina > st.staminaMax * 0.5;
      st.reward = healthy ? "high" : "low";
      setTempo(st, healthy ? 55 : 25);
      st._feintTimer = 0;
    },
    onTick(st) {
      st.turnArmed = projectedDanger(st, 4);
      st._feintTimer = (st._feintTimer || 0) + 1;
      if (st._feintTimer % 12 === 0) {
        const base = st.tempoValue;
        setTempo(st, Math.min(100, base + 15));
        setTempo(st, base);
      }
    }
  },
  // Turning every cycle never collects the skip reward, so the only lever left
  // is turnCost — reward:"low" is strictly the cheapest way to run this. Split
  // by tempo to see whether speed matters once you've committed to catching.
  always_turn_slow: {
    onPrep(st) { st.reward = "low"; setTempo(st, 10); },
    onTick(st) { st.turnArmed = true; }
  },
  always_turn_mid: {
    onPrep(st) { st.reward = "low"; setTempo(st, 50); },
    onTick(st) { st.turnArmed = true; }
  },
  always_turn_fast: {
    onPrep(st) { st.reward = "low"; setTempo(st, 90); },
    onTick(st) { st.turnArmed = true; }
  },
  never_turn: {
    onPrep(st) { st.reward = "max"; setTempo(st, 50); },
    onTick(st) { st.turnArmed = false; }
  },
  // Banks as often as it can get away with — only turns when danger is nearly
  // certain. Shows how much reward is bankable in a near-optimal greedy run.
  greedy_skip: {
    onPrep(st) { st.reward = "max"; setTempo(st, 20); },
    onTick(st) { st.turnArmed = projectedDanger(st, 1); }
  },
  random: {
    onPrep(st) {
      const tiers = ["low", "mid", "high", "max"];
      st.reward = tiers[Math.floor(Math.random() * tiers.length)];
      setTempo(st, Math.random() * 100);
    },
    onTick(st) {
      if (Math.random() < 0.05) setTempo(st, Math.random() * 100);
      st.turnArmed = Math.random() < 0.03 ? !st.turnArmed : st.turnArmed;
    }
  }
};

function simulateGame(policy, maxTicks = 20000) {
  const st = Core.newRunState(P, childDefs());
  policy.onPrep(st);
  let ticks = 0;
  const snapshot = reason => ({
    reason, cycle: st.cycle, elapsed: st.elapsedTicks, catches: st.catches, stamina: st.stamina,
    turnedCycles: st.turnedCycles, whiffedTurns: st.whiffedTurns,
    brokeCycles: st.brokeCycles, firstBrokeCycle: st.firstBrokeCycle,
    minStamina: st.minStamina, resolvedCycles: st.resolvedCycles,
    rewardGained: st.rewardGained, turnCostPaid: st.turnCostPaid,
    tempoChangeCostPaid: st.tempoChangeCostPaid
  });

  while (ticks < maxTicks) {
    ticks += 1;
    const res = Core.tick(P, st);
    recordPositions(st); // what the player would now see on the track
    if (res.reached) return snapshot("child_win");
    if (res.timeUp) return snapshot("daruma_win");
    if (res.chantDone) {
      Core.resolveCycle(P, st);
      st._posLog = null; // everyone's back at the start line
      policy.onPrep(st);
    } else {
      policy.onTick(st);
    }
  }
  return snapshot("timeout");
}

function avg(arr, f) { return arr.length ? arr.reduce((a, r) => a + f(r), 0) / arr.length : NaN; }

// ONLY=smart_line,front_load -> run just those batches. Handy when sweeping one
// knob without re-running all of them.
const ONLY = process.env.ONLY ? process.env.ONLY.split(",").map(s => s.trim()) : null;

function runBatch(name, policy, n) {
  if (ONLY && !ONLY.some(k => name.startsWith(k))) return;
  const results = [];
  for (let i = 0; i < n; i++) results.push(simulateGame(policy));
  const wins = results.filter(r => r.reason === "daruma_win");
  const childWins = results.filter(r => r.reason === "child_win");
  const avgTurnRate = avg(results, r => (r.resolvedCycles ? r.turnedCycles / r.resolvedCycles : 0));
  const avgWhiffRate = avg(results, r => (r.turnedCycles ? r.whiffedTurns / r.turnedCycles : 0));
  const everBroke = results.filter(r => r.brokeCycles > 0);
  console.log(`\n== ${name} (n=${n}) ==`);
  console.log(`  daruma win: ${(100 * wins.length / n).toFixed(1)}%   child win: ${(100 * childWins.length / n).toFixed(1)}%`);
  console.log(`  avg 詠唱回数: ${avg(results, r => r.cycle - 1).toFixed(2)}   avg 経過tick: ${avg(results, r => r.elapsed).toFixed(0)} / ${GOAL_TICKS}   avg catches: ${avg(results, r => r.catches).toFixed(2)}`);
  console.log(`  avg fraction of cycles where turn was armed: ${(100 * avgTurnRate).toFixed(1)}%   of those turns, caught nobody: ${(100 * avgWhiffRate).toFixed(1)}%`);
  console.log(`  went broke (couldn't afford any turn) in ${(100 * everBroke.length / n).toFixed(1)}% of games   avg lowest stamina: ${avg(results, r => r.minStamina).toFixed(1)}` +
    (everBroke.length ? `   [of those] first broke at 詠唱${avg(everBroke, r => r.firstBrokeCycle).toFixed(1)}回目, daruma still won: ${(100 * everBroke.filter(r => r.reason === "daruma_win").length / everBroke.length).toFixed(1)}%` : ""));
  if (wins.length) {
    console.log(`  [when daruma WINS] avg reward banked: ${avg(wins, r => r.rewardGained).toFixed(1)}   avg turnCost paid: ${avg(wins, r => r.turnCostPaid).toFixed(1)}   avg tempo-change cost: ${avg(wins, r => r.tempoChangeCostPaid).toFixed(1)}   avg stamina left: ${avg(wins, r => r.stamina).toFixed(1)}`);
  }
}

const N = process.env.N ? parseInt(process.env.N, 10) : 1500;
console.log(`SPEED_SCALE = ${SPEED_SCALE}   CREEP_LINE = ${CREEP_LINE}`);
runBatch("always_turn_slow (毎周振り向く・激遅テンポ・報酬低)", policies.always_turn_slow, N);
runBatch("always_turn_mid (毎周振り向く・ふつうテンポ・報酬低)", policies.always_turn_mid, N);
runBatch("always_turn_fast (毎周振り向く・激速テンポ・報酬低)", policies.always_turn_fast, N);
runBatch("never_turn (絶対振り向かない)", policies.never_turn, N);
runBatch("greedy_skip (ほぼ見送って報酬を貯める)", policies.greedy_skip, N);
runBatch("alternate (低振向/激見送りの固定交互)", policies.alternate, N);
runBatch("front_load (最初3周だけ激見送り→以降ずっと低振向)", policies.front_load, N);
runBatch("turtle (慎重)", policies.turtle, N);
runBatch("rusher (強気)", policies.rusher, N);
runBatch("smart (適応・この周に届くかだけ見る)", policies.smart, N);
runBatch(`smart_line (適応・先頭位置で判断 line=${CREEP_LINE})`, policies.smart_line, N);
runBatch(`smart_line_moving (適応・位置＋先頭の動きを見て空振り回避 line=${CREEP_LINE})`, policies.smart_line_moving, N);
runBatch(`smart_human (人間の読み・描画位置だけ line=${CREEP_LINE})`, policies.smart_human, N);
runBatch(`feint_only (振り向かず残り${AMBUSH_TICKS_LEFT}tickで加速だけ)`, policies.feint_only, N);
runBatch(`smart_human_feint (人間の読み＋見送る周に加速)`, policies.smart_human_feint, N);
runBatch(`smart_human_ambush (人間の読み＋残り${AMBUSH_TICKS_LEFT}tickで加速)`, policies.smart_human_ambush, N);
runBatch(`smart_line_ambush (読み＋振り向く周だけ終盤に加速 line=${CREEP_LINE})`, policies.smart_line_ambush, N);
runBatch("smart_feint (適応+定期フェイント)", policies.smart_feint, N);
runBatch("random (デタラメ)", policies.random, N);
