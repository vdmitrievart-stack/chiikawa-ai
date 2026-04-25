import fs from "node:fs";
import path from "node:path";

const targetPath = path.resolve("telegram-bot/core/candidate-service.js");

if (!fs.existsSync(targetPath)) {
  console.error("❌ File not found:", targetPath);
  console.error("Run this script from the repository root where telegram-bot/ exists.");
  process.exit(1);
}

let src = fs.readFileSync(targetPath, "utf8");

function fail(msg) {
  console.error("❌ Patch failed:", msg);
  process.exit(1);
}

function applyOnce(marker, fn) {
  if (src.includes(marker)) {
    console.log("Already patched:", marker);
    return;
  }
  src = fn(src);
}

// 1) Insert buildAntiRugIntel after buildLiquidityTrapSignals method.
applyOnce("buildAntiRugIntel(candidate = {})", (s) => {
  const anchor = "buildLiquidityTrapSignals(candidate = {})";
  const idx = s.indexOf(anchor);
  if (idx === -1) fail("buildLiquidityTrapSignals(candidate = {}) not found");

  let braceStart = s.indexOf("{", idx);
  if (braceStart === -1) fail("Cannot locate buildLiquidityTrapSignals opening brace");

  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < s.length; i++) {
    if (s[i] === "{") depth++;
    if (s[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end === -1) fail("Cannot locate buildLiquidityTrapSignals closing brace");

  const method = `

  buildAntiRugIntel(candidate = {}) {
    const token = candidate?.token || {};
    const holder = candidate?.holderAccumulation || {};
    const trap = candidate?.liquidityTrap || {};
    const migration = candidate?.migration || {};

    const liquidity = safeNum(token?.liquidity, 0);
    const fdv = safeNum(token?.fdv, 0);
    const volumeH24 = safeNum(token?.volumeH24, token?.volume, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const txnsH24 = safeNum(token?.txnsH24, token?.txns, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);

    const priceM5 = safeNum(token?.priceChangeM5, 0);
    const priceH1 = safeNum(token?.priceChangeH1, 0);
    const priceH6 = safeNum(token?.priceChangeH6, 0);
    const priceH24 = safeNum(token?.priceChangeH24, 0);

    const rugRisk = safeNum(candidate?.rug?.risk, 0);
    const corpseScore = safeNum(candidate?.corpse?.score, 0);
    const botActivity = safeNum(candidate?.bots?.botActivity, 0);
    const concentration = safeNum(candidate?.wallet?.concentration, 0);
    const distribution = safeNum(candidate?.distribution?.score, 0);
    const absorption = safeNum(candidate?.absorption?.score, 0);
    const accumulation = safeNum(candidate?.accumulation?.score, 0);

    const retention30m = safeNum(holder?.retention30mPct, 0);
    const retention2h = safeNum(holder?.retention2hPct, 0);
    const netControlPct = safeNum(holder?.netControlPct, 0);
    const netAccumulationPct = safeNum(holder?.netAccumulationPct, 0);
    const freshWalletBuyCount = safeNum(holder?.freshWalletBuyCount, 0);
    const quietAccumulation = Boolean(holder?.quietAccumulationPass);
    const warehouseStorage = Boolean(holder?.warehouseStoragePass);
    const bottomPack = Boolean(holder?.bottomPackReversalPass);

    const liqToMcapPct = fdv > 0 ? (liquidity / Math.max(fdv, 1)) * 100 : 0;
    const volToLiqPct = liquidity > 0 ? (volumeH24 / Math.max(liquidity, 1)) * 100 : 0;
    const isPumpAddress = String(token?.ca || "").toLowerCase().endsWith("pump");

    const reasons = [];
    const warnings = [];
    let riskScore = 0;
    let protectionScore = 0;

    if (liquidity < 5000) {
      riskScore += 28;
      reasons.push("critical liquidity under $5k");
    } else if (liquidity < 10000) {
      riskScore += 18;
      reasons.push("thin liquidity under $10k");
    }

    if (fdv >= 100000 && liquidity < 12000) {
      riskScore += 22;
      reasons.push("high FDV on thin liquidity");
    }

    if (fdv >= 500000 && liquidity < 30000) {
      riskScore += 24;
      reasons.push("six-figure+ FDV with fragile liquidity");
    }

    if (fdv > 0 && liqToMcapPct < 4 && fdv >= 80000) {
      riskScore += 22;
      reasons.push("liquidity/MC ratio critically weak");
    } else if (fdv > 0 && liqToMcapPct < 8 && fdv >= 80000) {
      riskScore += 14;
      warnings.push("liquidity/MC ratio weak");
    }

    if (volumeH24 > liquidity * 12 && liquidity < 20000) {
      riskScore += 20;
      reasons.push("oversized churn on thin liquidity");
    }

    if (txnsH24 > 2500 && liquidity < 12000) {
      riskScore += 18;
      reasons.push("too many transactions for weak liquidity");
    }

    if (priceH24 < -65 && volumeH24 > 50000) {
      riskScore += 24;
      reasons.push("major collapse with remaining churn");
    }

    if (priceH6 < -45 && priceH1 <= 5) {
      riskScore += 18;
      reasons.push("post-dump weak recovery");
    }

    if (priceM5 > 15 && txnsH1 < 80 && volumeH1 < 10000) {
      riskScore += 14;
      reasons.push("sharp micro pump without enough participation");
    }

    if (corpseScore >= 65) {
      riskScore += 26;
      reasons.push("corpse score critical");
    } else if (corpseScore >= 45) {
      riskScore += 14;
      warnings.push("corpse score elevated");
    }

    if (rugRisk >= 70) {
      riskScore += 24;
      reasons.push("rug risk critical");
    } else if (rugRisk >= 55) {
      riskScore += 12;
      warnings.push("rug risk elevated");
    }

    if (botActivity >= 55) {
      riskScore += 18;
      reasons.push("bot activity elevated");
    }

    if (concentration >= 55) {
      riskScore += 14;
      reasons.push("holder concentration proxy high");
    }

    if (distribution > accumulation + 15 && distribution > absorption + 15) {
      riskScore += 18;
      reasons.push("distribution dominates accumulation");
    }

    if (trap?.veto) {
      riskScore += 28;
      reasons.push(\`liquidity trap veto: \${(trap.reasons || []).join(", ") || "trap"}\`);
    }

    if (isPumpAddress && priceH24 < -55 && liquidity < 18000) {
      riskScore += 12;
      warnings.push("pump-style post-collapse structure");
    }

    if (quietAccumulation) {
      protectionScore += 12;
      warnings.push("quiet accumulation softens risk");
    }

    if (warehouseStorage) {
      protectionScore += 12;
      warnings.push("warehouse storage softens risk");
    }

    if (bottomPack) {
      protectionScore += 10;
      warnings.push("bottom-pack reversal softens risk");
    }

    if (retention30m >= 55) protectionScore += 8;
    if (retention2h >= 35) protectionScore += 8;
    if (netControlPct >= 45) protectionScore += 10;
    if (netAccumulationPct >= 55) protectionScore += 8;
    if (freshWalletBuyCount >= 12) protectionScore += 6;

    const adjustedRisk = clamp(Math.round(riskScore - protectionScore), 0, 100);

    const hardVeto =
      adjustedRisk >= 72 ||
      (trap?.veto && adjustedRisk >= 55) ||
      (liquidity < 5000 && fdv >= 50000) ||
      (priceH24 < -80 && liquidity < 20000) ||
      (corpseScore >= 75 && rugRisk >= 55);

    const softVeto =
      !hardVeto &&
      (
        adjustedRisk >= 55 ||
        (rugRisk >= 60 && liquidity < 15000) ||
        (volumeH24 > liquidity * 15 && liquidity < 25000)
      );

    const verdict =
      hardVeto ? "HARD_BLOCK" :
      softVeto ? "SOFT_BLOCK" :
      adjustedRisk >= 40 ? "RISKY" :
      adjustedRisk >= 22 ? "WATCH" :
      "CLEAN";

    return {
      verdict,
      riskScore: adjustedRisk,
      rawRiskScore: clamp(Math.round(riskScore), 0, 100),
      protectionScore: clamp(Math.round(protectionScore), 0, 100),
      hardVeto,
      softVeto,
      tradeBlocked: hardVeto,
      probeOnly: softVeto,
      liqToMcapPct,
      volToLiqPct,
      reasons,
      warnings
    };
  }`;

  return s.slice(0, end) + method + s.slice(end);
});

// 2) Insert antiRug calculation after liquidityTrap declaration.
applyOnce("const antiRug = this.buildAntiRugIntel({", (s) => {
  const marker = "const liquidityTrap = this.buildLiquidityTrapSignals";
  const idx = s.indexOf(marker);
  if (idx === -1) fail("liquidityTrap declaration not found");

  const semi = s.indexOf(";", idx);
  if (semi === -1) fail("liquidityTrap declaration semicolon not found");

  const insert = `

    const antiRug = this.buildAntiRugIntel({
      token,
      rug: { risk: rugRisk },
      corpse: {
        score: corpseScore,
        isCorpse
      },
      falseBounce: {
        rejected: falseBounceRejected
      },
      developer: {
        verdict: developerVerdict
      },
      wallet: {
        concentration: proxyConcentration
      },
      bots: {
        botActivity
      },
      distribution: {
        score: distributionScore
      },
      accumulation: {
        score: accumulationScore
      },
      absorption: {
        score: absorptionScore
      },
      migration,
      liquidityTrap
    });`;

  return s.slice(0, semi + 1) + insert + s.slice(semi + 1);
});

// 3) Add score penalty.
applyOnce("if (antiRug.hardVeto) {", (s) => {
  const oldBlock = `if (liquidityTrap?.veto) {
      score = Math.max(0, score - 26);
    }
    score = clamp(score, 0, 99);`;

  const newBlock = `if (liquidityTrap?.veto) {
      score = Math.max(0, score - 26);
    }

    if (antiRug.hardVeto) {
      score = Math.max(0, score - 45);
    } else if (antiRug.softVeto) {
      score = Math.max(0, score - 24);
    } else if (antiRug.riskScore >= 40) {
      score = Math.max(0, score - 12);
    }

    score = clamp(score, 0, 99);`;

  if (!s.includes(oldBlock)) fail("score penalty block not found");
  return s.replace(oldBlock, newBlock);
});

// 4) Add reasons.
applyOnce("anti-rug hard block:", (s) => {
  const oldBlock = `if (liquidityTrap?.veto) {
      reasons.push(\`LP/liquidity trap veto: \${liquidityTrap.reasons.join(', ') || 'liquidity trap'}\`);
    }`;

  const newBlock = `if (liquidityTrap?.veto) {
      reasons.push(\`LP/liquidity trap veto: \${liquidityTrap.reasons.join(', ') || 'liquidity trap'}\`);
    }

    if (antiRug.hardVeto) {
      reasons.push(\`anti-rug hard block: \${antiRug.reasons.join(", ") || "critical risk"}\`);
    } else if (antiRug.softVeto) {
      reasons.push(\`anti-rug soft block: \${antiRug.reasons.join(", ") || "elevated risk"}\`);
    } else if (antiRug.riskScore >= 40) {
      reasons.push(\`anti-rug watch: \${antiRug.warnings.join(", ") || "risk elevated"}\`);
    }`;

  if (!s.includes(oldBlock)) fail("liquidityTrap reasons block not found");
  return s.replace(oldBlock, newBlock);
});

// 5) Add antiRug to return object near liquidityTrap.
applyOnce("antiRug,", (s) => {
  const anchor = "liquidityTrap,";
  if (!s.includes(anchor)) fail("liquidityTrap return field not found");
  return s.replace(anchor, "antiRug,\n      liquidityTrap,");
});

// 6) Hard veto in isNoiseCandidate.
applyOnce("candidate?.antiRug?.hardVeto", (s) => {
  const anchor = "if (candidate?.liquidityTrap?.veto) return true;";
  if (s.includes(anchor)) {
    return s.replace(anchor, `${anchor}\n    if (candidate?.antiRug?.hardVeto) return true;`);
  }

  const alt = "isNoiseCandidate(candidate = {}) {";
  const idx = s.indexOf(alt);
  if (idx === -1) fail("isNoiseCandidate method not found");
  const brace = s.indexOf("{", idx);
  return s.slice(0, brace + 1) + "\n    if (candidate?.antiRug?.hardVeto) return true;" + s.slice(brace + 1);
});

// 7) Cap recomputeCompositeScore.
applyOnce("candidate?.antiRug?.softVeto", (s) => {
  const anchor = "candidate.score = clamp(score, 0, 99);";
  if (!s.includes(anchor)) fail("candidate.score clamp not found");
  return s.replace(anchor, `if (candidate?.antiRug?.hardVeto) {
      score = Math.min(score, 35);
    } else if (candidate?.antiRug?.softVeto) {
      score = Math.min(score, 58);
    }

    ${anchor}`);
});

fs.writeFileSync(targetPath, src);
console.log("✅ Anti-rug intelligence patch applied to", targetPath);
