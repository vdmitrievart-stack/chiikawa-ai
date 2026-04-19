import { estimateRoundTripCostPct } from "./portfolio.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildScalpPlan(analyzed) {
  const { delta, accumulation, distribution, corpse, developer, strategy } = analyzed;
  const costs = estimateRoundTripCostPct();
  if (corpse?.isCorpse) return null;
  if (developer?.verdict === "Bad") return null;
  if (!delta?.hasHistory) return null;

  const momentumOk =
    delta.volumeDeltaPct > 12 &&
    delta.txnsDeltaPct > 8 &&
    delta.buyPressureDelta > 0.06 &&
    delta.priceDeltaPct > 0 &&
    distribution.score < accumulation.score + 8;

  if (!momentumOk) return null;
  if (safeNum(strategy?.expectedEdgePct, 0) < costs + 1.0) return null;

  return {
    strategyKey: "scalp",
    thesis: "Fast momentum scalp on confirmed micro-acceleration.",
    objective: "capture quick impulse and exit cleanly",
    plannedHoldMs: 4 * 60 * 1000,
    stopLossPct: 2.7,
    takeProfitPct: Math.max(5.5, safeNum(strategy?.takeProfitPct, 0)),
    runnerTargetsPct: [],
    expectedEdgePct: safeNum(strategy?.expectedEdgePct, 0),
    entryMode: "SCALED",
    planName: "micro_momentum_scalp"
  };
}

function buildReversalPlan(analyzed) {
  const { token, delta, absorption, accumulation, corpse, developer, strategy } = analyzed;
  const costs = estimateRoundTripCostPct();
  if (corpse?.isCorpse) return null;
  if (developer?.verdict === "Bad") return null;
  if (safeNum(token?.liquidity, 0) < 12000) return null;
  if (!delta?.hasHistory) return null;

  const baseForming =
    delta.liquidityDeltaPct > -2.5 &&
    delta.priceDeltaPct > -4 &&
    delta.buyPressureDelta >= 0 &&
    absorption.score >= 12 &&
    accumulation.score >= 10;

  if (!baseForming) return null;
  const expectedEdge = Math.max(4.5, safeNum(strategy?.expectedEdgePct, 0) + 1.2);
  if (expectedEdge < costs + 1.2) return null;

  return {
    strategyKey: "reversal",
    thesis: "Bottom/reversal attempt: structure stabilizing with absorption and improving flow.",
    objective: "catch recovery into nearby liquidity zone",
    plannedHoldMs: 45 * 60 * 1000,
    stopLossPct: 6.5,
    takeProfitPct: 18,
    runnerTargetsPct: [],
    expectedEdgePct: expectedEdge,
    entryMode: "SCALED",
    planName: "base_reversal"
  };
}

function buildRunnerPlan(analyzed) {
  const { token, delta, absorption, accumulation, sentiment, developer, corpse, strategy } = analyzed;
  if (corpse?.isCorpse) return null;
  if (developer?.verdict === "Bad") return null;
  if (safeNum(token?.liquidity, 0) < 15000) return null;
  if (!delta?.hasHistory) return null;

  const runnerCandidate =
    absorption.score >= 18 &&
    accumulation.score >= 18 &&
    safeNum(sentiment?.sentiment, 0) >= 50 &&
    safeNum(developer?.score, 0) >= 0 &&
    delta.buyPressureDelta > 0 &&
    delta.liquidityDeltaPct > -1 &&
    delta.priceDeltaPct > -2;

  if (!runnerCandidate) return null;

  return {
    strategyKey: "runner",
    thesis: "Potential runner: post-base continuation with room for multi-leg expansion.",
    objective: "hold core position for multi-leg move with partial profits",
    plannedHoldMs: 12 * 60 * 60 * 1000,
    stopLossPct: 9.5,
    takeProfitPct: 0,
    runnerTargetsPct: [25, 60, 150],
    expectedEdgePct: Math.max(8, safeNum(strategy?.expectedEdgePct, 0) + 3),
    entryMode: "FULL",
    planName: "runner_continuation"
  };
}

function buildCopytradePlan(analyzed) {
  const gmgn = analyzed?.gmgnLeaderIntel || null;
  const leaderScore = safeNum(gmgn?.score, 0);
  if (!gmgn || gmgn.state === "cooldown") return null;
  if (leaderScore < 70) return null;

  return {
    strategyKey: "copytrade",
    thesis: `Copytrade leader flow: live leader score ${leaderScore} with ${gmgn.recentWinRate || 0}% recent winrate.`,
    objective: "mirror qualified leader flow only while live stats remain healthy",
    plannedHoldMs: 60 * 60 * 1000,
    stopLossPct: 8,
    takeProfitPct: 22,
    runnerTargetsPct: [],
    expectedEdgePct: Math.max(6, leaderScore / 10),
    entryMode: "PROBE",
    planName: "leader_follow"
  };
}

export function buildStrategyPlans(analyzed, options = {}) {
  const enabled = options.enabledStrategies || {
    scalp: true,
    reversal: true,
    runner: true,
    copytrade: true
  };

  const plans = [];
  if (enabled.scalp) {
    const row = buildScalpPlan(analyzed);
    if (row) plans.push(row);
  }
  if (enabled.reversal) {
    const row = buildReversalPlan(analyzed);
    if (row) plans.push(row);
  }
  if (enabled.runner) {
    const row = buildRunnerPlan(analyzed);
    if (row) plans.push(row);
  }
  if (enabled.copytrade) {
    const row = buildCopytradePlan(analyzed);
    if (row) plans.push(row);
  }
  return plans;
}
