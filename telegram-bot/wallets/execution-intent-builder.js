function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class ExecutionIntentBuilder {
  buildOpenIntent({
    walletId,
    walletMeta,
    plan,
    candidate,
    heroImage
  }) {
    return {
      type: "OPEN_POSITION",
      walletId,
      walletRole: walletMeta?.role || "trader",
      executionMode: walletMeta?.executionMode || "dry_run",
      strategy: plan.strategyKey,
      entryMode: plan.entryMode,
      planName: plan.planName || "",
      planObjective: plan.objective || "",
      token: clone(candidate.token),
      thesis: plan.thesis,
      plannedHoldMs: safeNum(plan.plannedHoldMs),
      stopLossPct: safeNum(plan.stopLossPct),
      takeProfitPct: safeNum(plan.takeProfitPct),
      runnerTargetsPct: Array.isArray(plan.runnerTargetsPct) ? [...plan.runnerTargetsPct] : [],
      signalScore: safeNum(candidate.score),
      expectedEdgePct: safeNum(plan.expectedEdgePct),
      signalContext: {
        imageUrl: heroImage,
        narrative: clone(candidate.narrative),
        socials: clone(candidate.socials),
        developer: clone(candidate.developer),
        mechanics: clone(candidate.mechanics),
        dexPaid: clone(candidate.dexPaid),
        reasons: clone(candidate.reasons),
        baseStrategy: clone(candidate.strategy),
        chosenPlan: clone(plan)
      }
    };
  }

  buildCloseIntent({
    walletId,
    walletMeta,
    position,
    reason,
    exitReferencePrice
  }) {
    return {
      type: "CLOSE_POSITION",
      walletId,
      walletRole: walletMeta?.role || "trader",
      executionMode: walletMeta?.executionMode || "dry_run",
      strategy: position?.strategy || "",
      positionId: position?.id || "",
      token: {
        name: position?.token || "",
        symbol: position?.symbol || "",
        ca: position?.ca || "",
        dexId: position?.dexId || "",
        chainId: position?.chainId || "",
        url: position?.url || ""
      },
      reason: reason || "MANUAL_CLOSE",
      exitReferencePrice: safeNum(exitReferencePrice),
      signalContext: clone(position?.signalContext || {})
    };
  }

  buildPartialIntent({
    walletId,
    walletMeta,
    position,
    targetPct,
    soldFraction,
    currentPrice
  }) {
    return {
      type: "PARTIAL_SELL",
      walletId,
      walletRole: walletMeta?.role || "trader",
      executionMode: walletMeta?.executionMode || "dry_run",
      strategy: position?.strategy || "",
      positionId: position?.id || "",
      token: {
        name: position?.token || "",
        symbol: position?.symbol || "",
        ca: position?.ca || ""
      },
      targetPct: safeNum(targetPct),
      soldFraction: safeNum(soldFraction),
      currentPrice: safeNum(currentPrice),
      signalContext: clone(position?.signalContext || {})
    };
  }
}
