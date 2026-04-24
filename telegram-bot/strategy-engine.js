import { estimateRoundTripCostPct } from "./portfolio.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildScalpPlan(analyzed) {
  const { delta, accumulation, distribution, corpse, developer, strategy } = analyzed;
  const costs = estimateRoundTripCostPct();

  if (corpse.isCorpse) return null;
  if (developer.verdict === "Bad") return null;
  if (!delta.hasHistory) return null;

  const momentumOk =
    delta.volumeDeltaPct > 12 &&
    delta.txnsDeltaPct > 8 &&
    delta.buyPressureDelta > 0.06 &&
    delta.priceDeltaPct > 0 &&
    distribution.score < accumulation.score + 8;

  if (!momentumOk) return null;
  if (safeNum(strategy.expectedEdgePct) < costs + 1.0) return null;

  return {
    strategyKey: "scalp",
    thesis: "Fast momentum scalp on confirmed micro-acceleration.",
    plannedHoldMs: 4 * 60 * 1000,
    stopLossPct: 2.7,
    takeProfitPct: Math.max(5.5, safeNum(strategy.takeProfitPct)),
    runnerTargetsPct: [],
    expectedEdgePct: safeNum(strategy.expectedEdgePct)
  };
}

function buildReversalPlan(analyzed) {
  const { token, delta, absorption, accumulation, corpse, developer, strategy } = analyzed;
  const costs = estimateRoundTripCostPct();

  if (corpse.isCorpse) return null;
  if (developer.verdict === "Bad") return null;
  if (safeNum(token.liquidity) < 12000) return null;
  if (!delta.hasHistory) return null;

  const baseForming =
    delta.liquidityDeltaPct > -2.5 &&
    delta.priceDeltaPct > -4 &&
    delta.buyPressureDelta >= 0 &&
    absorption.score >= 12 &&
    accumulation.score >= 10;

  if (!baseForming) return null;

  const expectedEdge = Math.max(4.5, safeNum(strategy.expectedEdgePct) + 1.2);
  if (expectedEdge < costs + 1.2) return null;

  return {
    strategyKey: "reversal",
    thesis: "Bottom/reversal attempt: structure stabilizing with absorption and improving flow.",
    plannedHoldMs: 45 * 60 * 1000,
    stopLossPct: 6.5,
    takeProfitPct: 18,
    runnerTargetsPct: [],
    expectedEdgePct: expectedEdge
  };
}

function buildRunnerPlan(analyzed) {
  const { token, delta, absorption, accumulation, sentiment, developer, corpse, strategy } = analyzed;

  if (corpse.isCorpse) return null;
  if (developer.verdict === "Bad") return null;
  if (safeNum(token.liquidity) < 15000) return null;
  if (!delta.hasHistory) return null;

  const runnerCandidate =
    absorption.score >= 18 &&
    accumulation.score >= 18 &&
    sentiment.sentiment >= 50 &&
    developer.score >= 0 &&
    delta.buyPressureDelta > 0 &&
    delta.liquidityDeltaPct > -1 &&
    delta.priceDeltaPct > -2;

  if (!runnerCandidate) return null;

  return {
    strategyKey: "runner",
    thesis: "Potential runner: post-base continuation with room for multi-leg expansion.",
    plannedHoldMs: 12 * 60 * 60 * 1000,
    stopLossPct: 9.5,
    takeProfitPct: 0,
    runnerTargetsPct: [25, 60, 150],
    expectedEdgePct: Math.max(8, safeNum(strategy.expectedEdgePct) + 3)
  };
}

export function buildStrategyPlans(analyzed) {
  const plans = [];
  const scalp = buildScalpPlan(analyzed);
  if (scalp) plans.push(scalp);

  const reversal = buildReversalPlan(analyzed);
  if (reversal) plans.push(reversal);

  const runner = buildRunnerPlan(analyzed);
  if (runner) plans.push(runner);

  return plans;
}
