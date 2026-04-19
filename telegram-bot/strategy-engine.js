function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function bool(v) {
  return v === true;
}

function minutes(n) {
  return Math.round(n * 60 * 1000);
}

function buildPlan({
  strategyKey,
  entryMode,
  planName,
  objective,
  thesis,
  plannedHoldMs,
  stopLossPct,
  takeProfitPct = 0,
  runnerTargetsPct = [],
  expectedEdgePct = 0
}) {
  return {
    strategyKey,
    entryMode,
    planName,
    objective,
    thesis,
    plannedHoldMs,
    stopLossPct,
    takeProfitPct,
    runnerTargetsPct,
    expectedEdgePct
  };
}

function getCoreFlags(a) {
  const score = safeNum(a?.score);
  const rugRisk = safeNum(a?.rug?.risk);
  const corpseScore = safeNum(a?.corpse?.score);
  const isCorpse = bool(a?.corpse?.isCorpse);
  const falseBounce = bool(a?.falseBounce?.rejected);
  const devVerdict = String(a?.developer?.verdict || "Unknown");
  const sentiment = safeNum(a?.sentiment?.sentiment);
  const botActivity = safeNum(a?.bots?.botActivity);
  const smartMoney = safeNum(a?.wallet?.smartMoney);
  const concentration = safeNum(a?.wallet?.concentration);
  const accumulation = safeNum(a?.accumulation?.score);
  const absorption = safeNum(a?.absorption?.score);
  const distribution = safeNum(a?.distribution?.score);
  const deltaPrice = safeNum(a?.delta?.priceDeltaPct);
  const deltaVolume = safeNum(a?.delta?.volumeDeltaPct);
  const deltaTxns = safeNum(a?.delta?.txnsDeltaPct);
  const deltaLiquidity = safeNum(a?.delta?.liquidityDeltaPct);
  const buyPressure = safeNum(a?.delta?.buyPressureDelta);
  const dexPaid = String(a?.dexPaid?.status || "Unknown");
  const rewardModel = String(a?.mechanics?.rewardModel || "None");
  const beneficiarySignal = String(a?.mechanics?.beneficiarySignal || "Unknown");
  const claimSignal = String(a?.mechanics?.claimSignal || "Unknown");
  const tokenType = String(a?.mechanics?.tokenType || "Standard");
  const narrativeVerdict = String(a?.narrative?.verdict || "Unknown");
  const socialCount = safeNum(a?.socials?.socialCount);
  const hasTwitter = Boolean(a?.socials?.links?.twitter);
  const hasTelegram = Boolean(a?.socials?.links?.telegram);
  const hasWebsite = Boolean(a?.socials?.links?.website);

  return {
    score,
    rugRisk,
    corpseScore,
    isCorpse,
    falseBounce,
    devVerdict,
    sentiment,
    botActivity,
    smartMoney,
    concentration,
    accumulation,
    absorption,
    distribution,
    deltaPrice,
    deltaVolume,
    deltaTxns,
    deltaLiquidity,
    buyPressure,
    dexPaid,
    rewardModel,
    beneficiarySignal,
    claimSignal,
    tokenType,
    narrativeVerdict,
    socialCount,
    hasTwitter,
    hasTelegram,
    hasWebsite
  };
}

function isHardRejected(flags) {
  if (flags.isCorpse) return true;
  if (flags.falseBounce) return true;
  if (flags.rugRisk >= 65) return true;
  if (flags.devVerdict === "Bad") return true;
  if (flags.botActivity >= 55) return true;
  return false;
}

function buildContextSummary(a, flags) {
  const parts = [];

  if (flags.accumulation > 0) parts.push(`accumulation ${flags.accumulation}`);
  if (flags.absorption > 0) parts.push(`absorption ${flags.absorption}`);
  if (flags.distribution > 0) parts.push(`distribution ${flags.distribution}`);
  if (flags.smartMoney > 0) parts.push(`smart money ${flags.smartMoney}`);
  if (flags.sentiment > 0) parts.push(`sentiment ${flags.sentiment}`);
  if (flags.deltaVolume !== 0) parts.push(`vol Δ ${flags.deltaVolume.toFixed(1)}%`);
  if (flags.deltaTxns !== 0) parts.push(`txns Δ ${flags.deltaTxns.toFixed(1)}%`);
  if (flags.buyPressure !== 0) parts.push(`buy pressure Δ ${flags.buyPressure.toFixed(2)}`);

  if (flags.dexPaid && flags.dexPaid !== "Unknown") {
    parts.push(`dex ${flags.dexPaid.toLowerCase()}`);
  }

  if (flags.rewardModel && flags.rewardModel !== "None") {
    parts.push(`mechanics ${flags.rewardModel.toLowerCase()}`);
  }

  if (flags.beneficiarySignal && flags.beneficiarySignal !== "Unknown") {
    parts.push(`beneficiary ${flags.beneficiarySignal.toLowerCase()}`);
  }

  if (flags.claimSignal && flags.claimSignal !== "Unknown") {
    parts.push(`claim ${flags.claimSignal.toLowerCase()}`);
  }

  return parts.join(" | ");
}

function maybeBuildScalp(a, flags) {
  const edge =
    safeNum(a?.strategy?.expectedEdgePct) +
    flags.accumulation * 0.08 +
    flags.absorption * 0.05 -
    flags.distribution * 0.06;

  const fastFlow =
    flags.deltaVolume > 8 ||
    flags.deltaTxns > 8 ||
    flags.buyPressure > 0.08 ||
    flags.sentiment >= 60;

  const scoreGate = flags.score >= 72;
  const riskGate = flags.rugRisk <= 45 && flags.botActivity <= 35;
  const structureGate = flags.concentration <= 35 || flags.smartMoney >= 55;

  if (!(scoreGate && riskGate && structureGate && fastFlow)) {
    return null;
  }

  const entryMode =
    flags.score >= 88 && flags.buyPressure > 0.12 ? "FULL" :
    flags.score >= 80 ? "SCALED" :
    "PROBE";

  const tp =
    flags.deltaPrice > 4 ? 8 :
    flags.accumulation >= 24 ? 10 :
    7;

  const sl =
    flags.rugRisk <= 25 ? 4.5 :
    flags.rugRisk <= 35 ? 5.5 :
    6.5;

  return buildPlan({
    strategyKey: "scalp",
    entryMode,
    planName: "Momentum scalp",
    objective: "capture fast continuation impulse",
    thesis: `Fast momentum setup from short-term flow. ${buildContextSummary(a, flags)}`,
    plannedHoldMs: minutes(20),
    stopLossPct: round2(sl),
    takeProfitPct: round2(tp),
    expectedEdgePct: round2(clamp(edge, 4, 18))
  });
}

function maybeBuildReversal(a, flags) {
  const reversalContext =
    flags.absorption >= 16 &&
    flags.distribution <= 18 &&
    flags.rugRisk <= 45 &&
    flags.botActivity <= 35;

  const quality =
    flags.score >= 68 &&
    flags.smartMoney >= 35 &&
    flags.concentration <= 40;

  const hasNarrativeSupport =
    flags.narrativeVerdict === "Strong" ||
    flags.narrativeVerdict === "OK" ||
    flags.socialCount >= 2 ||
    flags.hasWebsite;

  if (!(reversalContext && quality && hasNarrativeSupport)) {
    return null;
  }

  const entryMode =
    flags.absorption >= 24 && flags.smartMoney >= 55 ? "SCALED" : "PROBE";

  const tp =
    flags.absorption >= 22 ? 14 :
    flags.accumulation >= 18 ? 12 :
    10;

  const sl =
    flags.rugRisk <= 25 ? 6 :
    flags.rugRisk <= 35 ? 7 :
    8;

  const edge =
    safeNum(a?.strategy?.expectedEdgePct) +
    flags.absorption * 0.07 +
    flags.accumulation * 0.04 -
    flags.distribution * 0.05;

  return buildPlan({
    strategyKey: "reversal",
    entryMode,
    planName: "Absorption reversal",
    objective: "catch recovery from absorbed selling",
    thesis: `Reversal setup where selling seems absorbed and downside pressure is fading. ${buildContextSummary(a, flags)}`,
    plannedHoldMs: minutes(90),
    stopLossPct: round2(sl),
    takeProfitPct: round2(tp),
    expectedEdgePct: round2(clamp(edge, 6, 24))
  });
}

function maybeBuildRunner(a, flags) {
  const trendBase =
    flags.score >= 82 &&
    flags.rugRisk <= 40 &&
    flags.botActivity <= 30 &&
    flags.smartMoney >= 50 &&
    flags.accumulation >= 18 &&
    flags.distribution <= 16;

  const supportSignals =
    flags.sentiment >= 60 ||
    flags.dexPaid.includes("Yes") ||
    flags.rewardModel !== "None" ||
    flags.claimSignal === "Positive aligned claimer" ||
    flags.beneficiarySignal.includes("Renounced") ||
    flags.beneficiarySignal.includes("External aligned");

  if (!(trendBase && supportSignals)) {
    return null;
  }

  const entryMode =
    flags.score >= 92 && flags.accumulation >= 26 ? "FULL" :
    flags.score >= 86 ? "SCALED" :
    "PROBE";

  const sl =
    flags.rugRisk <= 25 ? 7 :
    flags.rugRisk <= 35 ? 8 :
    9;

  const edge =
    safeNum(a?.strategy?.expectedEdgePct) +
    flags.accumulation * 0.09 +
    flags.sentiment * 0.04 +
    flags.smartMoney * 0.03 -
    flags.distribution * 0.05;

  return buildPlan({
    strategyKey: "runner",
    entryMode,
    planName: "Trend runner",
    objective: "ride continuation with staged profit taking",
    thesis: `Higher-quality continuation candidate with support from flow, attention, and token mechanics. ${buildContextSummary(a, flags)}`,
    plannedHoldMs: minutes(240),
    stopLossPct: round2(sl),
    takeProfitPct: 0,
    runnerTargetsPct: [12, 22, 38],
    expectedEdgePct: round2(clamp(edge, 10, 40))
  });
}

function maybeBuildCopytrade(a, flags) {
  const baseline =
    flags.score >= 60 &&
    flags.rugRisk <= 50 &&
    flags.botActivity <= 40 &&
    !flags.isCorpse &&
    !flags.falseBounce;

  if (!baseline) return null;

  let bonus = 0;

  if (flags.dexPaid.includes("Yes")) bonus += 2;
  if (flags.rewardModel !== "None") bonus += 2;
  if (flags.beneficiarySignal.includes("External aligned")) bonus += 3;
  if (flags.beneficiarySignal.includes("Renounced")) bonus += 4;
  if (flags.claimSignal === "Positive aligned claimer") bonus += 5;
  if (flags.socialCount >= 2) bonus += 2;
  if (flags.hasTwitter || flags.hasWebsite) bonus += 2;

  const edge =
    safeNum(a?.strategy?.expectedEdgePct) +
    bonus +
    flags.smartMoney * 0.03 +
    flags.accumulation * 0.04 -
    flags.distribution * 0.04;

  const entryMode =
    flags.score >= 80 || bonus >= 6 ? "SCALED" : "PROBE";

  return buildPlan({
    strategyKey: "copytrade",
    entryMode,
    planName: "Leader-aligned copy setup",
    objective: "participate selectively in copytrade-ready token",
    thesis: `Copytrade candidate survives base risk checks and shows enough structure or alignment signals. ${buildContextSummary(a, flags)}`,
    plannedHoldMs: minutes(120),
    stopLossPct: round2(flags.rugRisk <= 30 ? 6 : 7.5),
    takeProfitPct: round2(flags.score >= 78 ? 13 : 10),
    expectedEdgePct: round2(clamp(edge, 5, 22))
  });
}

function maybeBuildProbeFallback(a, flags, enabledStrategies) {
  const mildlyViable =
    flags.score >= 52 &&
    flags.rugRisk <= 45 &&
    flags.botActivity <= 35 &&
    !flags.isCorpse &&
    !flags.falseBounce &&
    flags.devVerdict !== "Bad";

  if (!mildlyViable) return [];

  const plans = [];

  if (enabledStrategies.scalp) {
    plans.push(
      buildPlan({
        strategyKey: "scalp",
        entryMode: "PROBE",
        planName: "Probe scalp",
        objective: "small test entry while waiting for stronger confirmation",
        thesis: `Borderline but tradable token. Small-risk probe only. ${buildContextSummary(a, flags)}`,
        plannedHoldMs: minutes(15),
        stopLossPct: 5.5,
        takeProfitPct: 6.5,
        expectedEdgePct: round2(clamp(safeNum(a?.strategy?.expectedEdgePct), 3, 8))
      })
    );
  }

  if (enabledStrategies.copytrade && flags.smartMoney >= 30) {
    plans.push(
      buildPlan({
        strategyKey: "copytrade",
        entryMode: "PROBE",
        planName: "Probe copytrade",
        objective: "small copy allocation while structure is still forming",
        thesis: `Small copytrade probe for a token that is not strong yet but not broken. ${buildContextSummary(a, flags)}`,
        plannedHoldMs: minutes(60),
        stopLossPct: 6.5,
        takeProfitPct: 9,
        expectedEdgePct: round2(clamp(safeNum(a?.strategy?.expectedEdgePct), 4, 9))
      })
    );
  }

  return plans;
}

function round2(v) {
  return Math.round((safeNum(v) + Number.EPSILON) * 100) / 100;
}

export function buildStrategyPlans(analyzed, options = {}) {
  const enabledStrategies = {
    scalp: options.enabledStrategies?.scalp !== false,
    reversal: options.enabledStrategies?.reversal !== false,
    runner: options.enabledStrategies?.runner !== false,
    copytrade: options.enabledStrategies?.copytrade !== false
  };

  const flags = getCoreFlags(analyzed);

  if (isHardRejected(flags)) {
    return [];
  }

  const plans = [];

  if (enabledStrategies.scalp) {
    const scalp = maybeBuildScalp(analyzed, flags);
    if (scalp) plans.push(scalp);
  }

  if (enabledStrategies.reversal) {
    const reversal = maybeBuildReversal(analyzed, flags);
    if (reversal) plans.push(reversal);
  }

  if (enabledStrategies.runner) {
    const runner = maybeBuildRunner(analyzed, flags);
    if (runner) plans.push(runner);
  }

  if (enabledStrategies.copytrade) {
    const copytrade = maybeBuildCopytrade(analyzed, flags);
    if (copytrade) plans.push(copytrade);
  }

  if (!plans.length) {
    plans.push(...maybeBuildProbeFallback(analyzed, flags, enabledStrategies));
  }

  const unique = [];
  const seen = new Set();

  for (const plan of plans) {
    const key = `${plan.strategyKey}:${plan.entryMode}:${plan.planName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(plan);
  }

  unique.sort((a, b) => {
    const edgeDiff = safeNum(b.expectedEdgePct) - safeNum(a.expectedEdgePct);
    if (edgeDiff !== 0) return edgeDiff;

    const order = { FULL: 3, SCALED: 2, PROBE: 1 };
    return (order[b.entryMode] || 0) - (order[a.entryMode] || 0);
  });

  return unique;
}
