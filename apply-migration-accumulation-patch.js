import fs from "node:fs";
import path from "node:path";

const TARGET = path.resolve("telegram-bot/core/candidate-service.js");

function fail(msg) {
  console.error("❌ Patch failed:", msg);
  process.exit(1);
}

if (!fs.existsSync(TARGET)) {
  fail(`File not found: ${TARGET}. Run this script from repository root where telegram-bot/ exists.`);
}

let src = fs.readFileSync(TARGET, "utf8");

function findMethodRange(source, signature) {
  const idx = source.indexOf(signature);
  if (idx === -1) return null;

  const braceStart = source.indexOf("{", idx);
  if (braceStart === -1) return null;

  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return { start: idx, end: i + 1 };
    }
  }

  return null;
}

function insertBefore(signature, block, marker) {
  if (src.includes(marker)) {
    console.log(`Already patched: ${marker}`);
    return;
  }

  const idx = src.indexOf(signature);
  if (idx === -1) fail(`Cannot find signature: ${signature}`);
  src = src.slice(0, idx) + block + "\n\n  " + src.slice(idx);
  console.log(`Inserted: ${marker}`);
}

function replaceExact(oldText, newText, label) {
  if (src.includes(newText)) {
    console.log(`Already patched: ${label}`);
    return;
  }
  if (!src.includes(oldText)) fail(`Cannot find block for: ${label}`);
  src = src.replace(oldText, newText);
  console.log(`Patched: ${label}`);
}

const migrationAccumulationBlock = `  // PATCH_MIGRATION_ACCUMULATION_START
  buildMigrationAccumulationSignals(candidate = {}) {
    const token = candidate?.token || {};
    const holder = candidate?.holderAccumulation || {};
    const migration = candidate?.migration || {};
    const scalpMetrics = candidate?.scalp?.metrics || {};

    const pairAgeMin = safeNum(migration?.pairAgeMin, 99999);
    const fdv = safeNum(token?.fdv, 0);
    const liquidity = safeNum(token?.liquidity, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const volumeH6 = safeNum(token?.volumeH6, 0);
    const volumeH24 = safeNum(token?.volumeH24, token?.volume, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
    const txnsH6 = safeNum(token?.txnsH6, 0);
    const txnsH24 = safeNum(token?.txnsH24, token?.txns, 0);

    const priceM5 = safeNum(candidate?.delta?.priceM5Pct, safeNum(token?.priceChangeM5, 0));
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, safeNum(token?.priceChangeH1, 0));
    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, safeNum(token?.priceChangeH6, 0));
    const priceH24 = safeNum(candidate?.delta?.priceH24Pct, safeNum(token?.priceChangeH24, 0));

    const buyPressureM5 = safeNum(scalpMetrics?.buyPressureM5, 0);
    const buyPressureH1 = safeNum(scalpMetrics?.buyPressureH1, 0);
    const buyPressureH24 = safeNum(scalpMetrics?.buyPressureH24, 0);

    const retention30m = safeNum(holder?.retention30mPct, 0);
    const retention2h = safeNum(holder?.retention2hPct, 0);
    const netControlPct = safeNum(holder?.netControlPct, 0);
    const netAccumulationPct = safeNum(holder?.netAccumulationPct, 0);
    const freshWalletBuyCount = safeNum(holder?.freshWalletBuyCount, 0);
    const bottomTouches = safeNum(holder?.bottomTouches, 0);
    const reloadCount = safeNum(holder?.reloadCount, 0);
    const dipBuyRatio = safeNum(holder?.dipBuyRatio, 0);

    const quietAccumulation = Boolean(holder?.quietAccumulationPass);
    const warehouseStorage =
      Boolean(holder?.warehouseStoragePass) ||
      String(holder?.cohortArchetype || "") === "warehouse_storage";
    const bottomPack = Boolean(holder?.bottomPackReversalPass);

    const ageWindow =
      pairAgeMin >= 60 &&
      pairAgeMin <= 36 * 60;

    const mcWindow =
      fdv >= 12000 &&
      fdv <= 180000;

    const deepCorrection =
      priceH24 <= -25 ||
      priceH6 <= -18 ||
      (priceH1 <= -8 && pairAgeMin >= 90);

    const notFullyDead =
      liquidity >= 7000 &&
      volumeH24 >= 12000 &&
      txnsH24 >= 90;

    const stillBreathing =
      volumeH1 >= 1200 ||
      txnsH1 >= 18 ||
      volumeH6 >= 6000 ||
      txnsH6 >= 60;

    const baseStabilizing =
      priceM5 >= -5 &&
      priceH1 >= -16 &&
      priceH1 <= 18;

    const earlyReclaim =
      priceM5 > -1 &&
      (
        buyPressureM5 >= 52 ||
        buyPressureH1 >= 50 ||
        priceH1 > 0
      );

    const accumulationEvidence =
      quietAccumulation ||
      warehouseStorage ||
      bottomPack ||
      retention30m >= 45 ||
      retention2h >= 25 ||
      netControlPct >= 25 ||
      netAccumulationPct >= 35 ||
      freshWalletBuyCount >= 8 ||
      bottomTouches >= 2 ||
      reloadCount >= 2 ||
      dipBuyRatio >= 0.35;

    const antiRugHard =
      Boolean(candidate?.antiRug?.hardVeto) ||
      safeNum(candidate?.rug?.risk, 0) >= 80 ||
      Boolean(candidate?.corpse?.isCorpse);

    const liquidityOkRelative =
      fdv > 0
        ? (liquidity / Math.max(fdv, 1)) * 100 >= 5
        : liquidity >= 10000;

    let score = 0;

    if (ageWindow) score += 14;
    if (mcWindow) score += 12;
    if (deepCorrection) score += 16;
    if (notFullyDead) score += 12;
    if (stillBreathing) score += 10;
    if (baseStabilizing) score += 12;
    if (earlyReclaim) score += 14;
    if (accumulationEvidence) score += 16;
    if (liquidityOkRelative) score += 8;

    if (quietAccumulation) score += 10;
    if (warehouseStorage) score += 8;
    if (bottomPack) score += 12;
    if (retention30m >= 55) score += 6;
    if (retention2h >= 35) score += 8;
    if (netControlPct >= 45) score += 8;
    if (freshWalletBuyCount >= 14) score += 6;
    if (bottomTouches >= 3) score += 6;

    if (buyPressureH24 < 42 && buyPressureH1 < 48 && buyPressureM5 < 50) score -= 10;
    if (liquidity < 6000) score -= 16;
    if (fdv > 250000) score -= 12;
    if (priceH1 > 35 || priceM5 > 18) score -= 14;
    if (antiRugHard) score -= 35;

    const allow =
      !antiRugHard &&
      ageWindow &&
      mcWindow &&
      deepCorrection &&
      notFullyDead &&
      stillBreathing &&
      baseStabilizing &&
      accumulationEvidence &&
      score >= 58;

    const priorityWatch =
      !antiRugHard &&
      ageWindow &&
      mcWindow &&
      deepCorrection &&
      notFullyDead &&
      (accumulationEvidence || earlyReclaim) &&
      score >= 48;

    const probeEligible =
      allow &&
      score >= 66 &&
      (
        bottomPack ||
        quietAccumulation ||
        warehouseStorage ||
        netControlPct >= 40 ||
        retention2h >= 32
      );

    const mode =
      bottomPack ? "bottom_pack_after_migration" :
      quietAccumulation || warehouseStorage ? "quiet_accumulation_after_migration" :
      earlyReclaim ? "early_reclaim_after_migration" :
      "post_migration_base";

    return {
      allow,
      priorityWatch,
      probeEligible,
      score: clamp(Math.round(score), 0, 99),
      mode,
      ageWindow,
      mcWindow,
      deepCorrection,
      notFullyDead,
      stillBreathing,
      baseStabilizing,
      earlyReclaim,
      accumulationEvidence,
      liquidityOkRelative,
      metrics: {
        pairAgeMin,
        fdv,
        liquidity,
        volumeH1,
        volumeH6,
        volumeH24,
        txnsH1,
        txnsH6,
        txnsH24,
        priceM5,
        priceH1,
        priceH6,
        priceH24,
        buyPressureM5,
        buyPressureH1,
        buyPressureH24,
        retention30m,
        retention2h,
        netControlPct,
        netAccumulationPct,
        freshWalletBuyCount,
        bottomTouches,
        reloadCount,
        dipBuyRatio
      }
    };
  }

  buildMigrationAccumulationPlan(candidate = {}) {
    return {
      strategyKey: "migration_survivor",
      thesis: "Post-migration dump → accumulation base → early reversal attempt",
      plannedHoldMs: 4 * 60 * 60 * 1000,
      stopLossPct: 6.5,
      takeProfitPct: 0,
      runnerTargetsPct: [18, 35, 65],
      signalScore: safeNum(candidate?.migrationAccumulation?.score, safeNum(candidate?.score, 0)),
      expectedEdgePct: 18,
      entryMode: candidate?.migrationAccumulation?.probeEligible ? "SCALED" : "PROBE",
      planName: "Migration Accumulation",
      objective: "catch post-migration base before expansion"
    };
  }
  // PATCH_MIGRATION_ACCUMULATION_END`;

insertBefore("buildReversalPlan(candidate = {})", migrationAccumulationBlock, "PATCH_MIGRATION_ACCUMULATION_START");

// Add migrationAccumulation in enrichCandidateWithHolderLive
replaceExact(
`      candidate.packaging = this.buildPackagingSignals(candidate);
      candidate.runnerLike = this.buildRunnerLikeSignals(candidate);
      candidate.reversal = this.buildReversalSignals(candidate);
      return this.recomputeCompositeScore(candidate);`,
`      candidate.packaging = this.buildPackagingSignals(candidate);
      candidate.runnerLike = this.buildRunnerLikeSignals(candidate);
      candidate.reversal = this.buildReversalSignals(candidate);
      candidate.migrationAccumulation = this.buildMigrationAccumulationSignals(candidate);
      return this.recomputeCompositeScore(candidate);`,
"holder-live no-engine branch migrationAccumulation"
);

replaceExact(
`    candidate.packaging = this.buildPackagingSignals(candidate);
    candidate.runnerLike = this.buildRunnerLikeSignals(candidate);
    candidate.reversal = this.buildReversalSignals(candidate);
    return this.recomputeCompositeScore(candidate);`,
`    candidate.packaging = this.buildPackagingSignals(candidate);
    candidate.runnerLike = this.buildRunnerLikeSignals(candidate);
    candidate.reversal = this.buildReversalSignals(candidate);
    candidate.migrationAccumulation = this.buildMigrationAccumulationSignals(candidate);
    return this.recomputeCompositeScore(candidate);`,
"holder-live normal branch migrationAccumulation"
);

// Recompute score
replaceExact(
`    if (candidate?.migration?.passes) {
      score = Math.max(score, Math.round(score * 0.7 + safeNum(candidate?.migration?.survivorScore, 0) * 0.3));
    }
    if (candidate?.runnerLike?.allow) {`,
`    if (candidate?.migration?.passes) {
      score = Math.max(score, Math.round(score * 0.7 + safeNum(candidate?.migration?.survivorScore, 0) * 0.3));
    }
    if (candidate?.migrationAccumulation?.priorityWatch) {
      score = Math.max(score, Math.round(score * 0.62 + safeNum(candidate?.migrationAccumulation?.score, 0) * 0.38));
    }
    if (candidate?.runnerLike?.allow) {`,
"recompute migrationAccumulation score"
);

// Build plans
replaceExact(
`    if (candidate?.migration?.passes) {
      plans.push({
        strategyKey: "migration_survivor",
        thesis: "Post-migration survivor with retained demand",
        plannedHoldMs: 3 * 60 * 60 * 1000,
        stopLossPct: 8,
        takeProfitPct: 0,
        runnerTargetsPct: [25, 50, 80],
        signalScore: Math.max(score, safeNum(candidate?.migration?.survivorScore, 0)),
        expectedEdgePct: 22,
        entryMode: "SCALED",
        planName: "Migration Survivor",
        objective: "post-migration expansion"
      });
    }`,
`    if (candidate?.migration?.passes) {
      plans.push({
        strategyKey: "migration_survivor",
        thesis: "Post-migration survivor with retained demand",
        plannedHoldMs: 3 * 60 * 60 * 1000,
        stopLossPct: 8,
        takeProfitPct: 0,
        runnerTargetsPct: [25, 50, 80],
        signalScore: Math.max(score, safeNum(candidate?.migration?.survivorScore, 0)),
        expectedEdgePct: 22,
        entryMode: "SCALED",
        planName: "Migration Survivor",
        objective: "post-migration expansion"
      });
    } else if (candidate?.migrationAccumulation?.probeEligible || candidate?.migrationAccumulation?.allow) {
      plans.push(this.buildMigrationAccumulationPlan(candidate));
    }`,
"buildPlans migration accumulation plan"
);

// Rank
replaceExact(
`    if (strategyScope === "migration_survivor") {
      return candidate?.migration?.passes
        ? safeNum(candidate?.migration?.survivorScore, 0)
        : 0;
    }`,
`    if (strategyScope === "migration_survivor") {
      if (candidate?.migration?.passes) {
        return safeNum(candidate?.migration?.survivorScore, 0);
      }
      if (candidate?.migrationAccumulation?.priorityWatch || candidate?.migrationAccumulation?.allow) {
        return safeNum(candidate?.migrationAccumulation?.score, 0) + safeNum(candidate?.holderAccumulation?.netControlPct, 0) * 1.2;
      }
      return 0;
    }`,
"migration survivor rank includes accumulation"
);

replaceExact(
`      safeNum(candidate?.packaging?.score, 0)
    );`,
`      safeNum(candidate?.packaging?.score, 0),
      safeNum(candidate?.migrationAccumulation?.score, 0)
    );`,
"general rank includes migrationAccumulation"
);

// Telemetry counters in findBestCandidate
replaceExact(
`    let migrationStructure = 0;
    let trapRejected = 0;`,
`    let migrationStructure = 0;
    let migrationAccumulation = 0;
    let trapRejected = 0;`,
"telemetry variable migrationAccumulation"
);

replaceExact(
`      if (row?.migration?.passes) migrationStructure += 1;
      if (row?.reversal?.allow || row?.packaging?.priorityWatch) reversalWatch += 1;
      if (row?.packaging?.detected || row?.reversal?.allow || row?.migration?.passes || row?.runnerLike?.allow) watchlist += 1;`,
`      if (row?.migration?.passes) migrationStructure += 1;
      if (row?.migrationAccumulation?.priorityWatch || row?.migrationAccumulation?.allow) migrationAccumulation += 1;
      if (row?.reversal?.allow || row?.packaging?.priorityWatch || row?.migrationAccumulation?.priorityWatch) reversalWatch += 1;
      if (row?.packaging?.detected || row?.reversal?.allow || row?.migration?.passes || row?.migrationAccumulation?.priorityWatch || row?.runnerLike?.allow) watchlist += 1;`,
"telemetry counting migrationAccumulation"
);

replaceExact(
`      migrationStructure,
      trapRejected,`,
`      migrationStructure,
      migrationAccumulation,
      trapRejected,`,
"telemetry assign migrationAccumulation"
);

// Smart-wallet publish-worthy
replaceExact(
`      smartWalletPublishWorthy: ranked.filter((row) => row?.smartWalletFeed && (row?.packaging?.priorityWatch || row?.reversal?.allow || row?.migration?.passes || row?.runnerLike?.allow)).length,`,
`      smartWalletPublishWorthy: ranked.filter((row) => row?.smartWalletFeed && (row?.packaging?.priorityWatch || row?.reversal?.allow || row?.migration?.passes || row?.migrationAccumulation?.priorityWatch || row?.runnerLike?.allow)).length,`,
"smart wallet publish-worthy migrationAccumulation"
);

// Sorting include migrationAccumulation, two occurrences possible
replaceExact(
`      safeNum(b?.packaging?.score, 0)
    );
    const aScore = Math.max(
      safeNum(a?.score, 0),
      safeNum(a?.migration?.survivorScore, 0),
      safeNum(a?.scalp?.score, 0),
      safeNum(a?.reversal?.score, 0),
      safeNum(a?.packaging?.score, 0)
    );`,
`      safeNum(b?.packaging?.score, 0),
      safeNum(b?.migrationAccumulation?.score, 0)
    );
    const aScore = Math.max(
      safeNum(a?.score, 0),
      safeNum(a?.migration?.survivorScore, 0),
      safeNum(a?.scalp?.score, 0),
      safeNum(a?.reversal?.score, 0),
      safeNum(a?.packaging?.score, 0),
      safeNum(a?.migrationAccumulation?.score, 0)
    );`,
"fetchMarket sorting includes migrationAccumulation"
);

// Header helper if present
if (src.includes("getMainPlanLabel(plans = [], candidate = {})")) {
  replaceExact(
`    if (this.shouldPreferReversalOverRunner(candidate)) {
      const reversalPlan = nonCopy.find((p) =>
        p.strategyKey === "reversal" ||
        String(p?.planName || "").toLowerCase().includes("reversal") ||
        String(p?.planName || "").toLowerCase().includes("packaging")
      );
      if (reversalPlan) return "REVERSAL";
    }`,
`    const migrationAccumulationPlan = nonCopy.find((p) =>
      String(p?.planName || "").toLowerCase().includes("migration accumulation") ||
      (p.strategyKey === "migration_survivor" && candidate?.migrationAccumulation?.priorityWatch)
    );

    if (migrationAccumulationPlan) return "MIGRATION_ACCUMULATION";

    if (this.shouldPreferReversalOverRunner(candidate)) {
      const reversalPlan = nonCopy.find((p) =>
        p.strategyKey === "reversal" ||
        String(p?.planName || "").toLowerCase().includes("reversal") ||
        String(p?.planName || "").toLowerCase().includes("packaging")
      );
      if (reversalPlan) return "REVERSAL";
    }`,
"main plan label migrationAccumulation"
  );

  replaceExact(
`    const packagingScore = safeNum(candidate?.packaging?.score, 0);

    return \``,
`    const packagingScore = safeNum(candidate?.packaging?.score, 0);
    const migrationAccumulationScore = safeNum(candidate?.migrationAccumulation?.score, 0);

    return \``,
"top header migration score var"
  );

  replaceExact(
`↩️ <b>Reversal score:</b> \${reversalScore} | 🏃 <b>Runner-like:</b> \${runnerScore} | 📦 <b>Packaging:</b> \${packagingScore}\`;`,
`↩️ <b>Reversal score:</b> \${reversalScore} | 🧬 <b>Migration accumulation:</b> \${migrationAccumulationScore} | 🏃 <b>Runner-like:</b> \${runnerScore} | 📦 <b>Packaging:</b> \${packagingScore}\`;`,
"top header migrationAccumulation line"
  );
}

// Hero caption add fields
replaceExact(
`migration score: \${safeNum(candidate?.migration?.survivorScore, 0)}
price: \${safeNum(token.price, 0)}`,
`migration score: \${safeNum(candidate?.migration?.survivorScore, 0)}
migration accumulation: \${safeNum(candidate?.migrationAccumulation?.score, 0)} / \${escapeHtml(candidate?.migrationAccumulation?.mode || "-")}
price: \${safeNum(token.price, 0)}`,
"hero migration accumulation line"
);

// Analysis text add block after Migration block marker if possible
replaceExact(
`🧬 Migration Survivor:
score: \${safeNum(migration?.survivorScore, 0)}
passes: \${migration?.passes ? "yes" : "no"}
pair age min: \${safeNum(migration?.pairAgeMin, 0).toFixed(1)}
liq/mcap %: \${safeNum(migration?.liqToMcapPct, 0).toFixed(2)}
vol/liq %: \${safeNum(migration?.volToLiqPct, 0).toFixed(2)}

🎯 Plans: \${escapeHtml(planLine)}`,
`🧬 Migration Survivor:
score: \${safeNum(migration?.survivorScore, 0)}
passes: \${migration?.passes ? "yes" : "no"}
pair age min: \${safeNum(migration?.pairAgeMin, 0).toFixed(1)}
liq/mcap %: \${safeNum(migration?.liqToMcapPct, 0).toFixed(2)}
vol/liq %: \${safeNum(migration?.volToLiqPct, 0).toFixed(2)}

🧬 Migration Accumulation:
allow: \${candidate?.migrationAccumulation?.allow ? "yes" : "no"}
priority watch: \${candidate?.migrationAccumulation?.priorityWatch ? "yes" : "no"}
probe eligible: \${candidate?.migrationAccumulation?.probeEligible ? "yes" : "no"}
score: \${safeNum(candidate?.migrationAccumulation?.score, 0)}
mode: \${escapeHtml(candidate?.migrationAccumulation?.mode || "-")}
age window: \${candidate?.migrationAccumulation?.ageWindow ? "yes" : "no"}
deep correction: \${candidate?.migrationAccumulation?.deepCorrection ? "yes" : "no"}
still breathing: \${candidate?.migrationAccumulation?.stillBreathing ? "yes" : "no"}
base stabilizing: \${candidate?.migrationAccumulation?.baseStabilizing ? "yes" : "no"}
accumulation evidence: \${candidate?.migrationAccumulation?.accumulationEvidence ? "yes" : "no"}

🎯 Plans: \${escapeHtml(planLine)}`,
"analysis migration accumulation block"
);

fs.writeFileSync(TARGET, src, "utf8");
console.log("✅ Migration accumulation intelligence patch applied to:", TARGET);
