/**
 * Rug / scam detection engine
 *
 * Goal:
 * - hard-block obvious danger
 * - produce risk score + reasons
 * - plug into Level 6 candidate
 *
 * Inputs:
 * - token
 * - bubbleMapIntel
 * - socialIntel
 * - volumeIntel
 */

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round((safeNum(value) + Number.EPSILON) * p) / p;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export async function buildRugScamIntel(input = {}) {
  const token = input.token || input || {};
  const bubble = input.bubbleMapIntel || {};
  const social = input.socialIntel || {};
  const volume = input.volumeIntel || {};

  const reasons = [];
  let riskScore = 0;
  let blocked = false;

  const mintAuthorityEnabled = Boolean(token.mintAuthorityEnabled);
  const freezeAuthorityEnabled = Boolean(token.freezeAuthorityEnabled);
  const liquidityUsd = safeNum(token.liquidityUsd, 0);
  const lpLockedPct = safeNum(token.lpLockedPct, 0);
  const creatorHolderPct = safeNum(token.creatorHolderPct, 0);
  const top10HolderPct = safeNum(token.top10HolderPct || bubble.top10HolderPct, 0);
  const denseClusterRisk = safeNum(bubble.denseClusterRisk, 0);
  const linkCount = Array.isArray(bubble.links) ? bubble.links.length : 0;
  const botPatternScore = safeNum(social.botPatternScore, 0);
  const suspiciousBurst = Boolean(social.suspiciousBurst);
  const buyPressure = safeNum(volume.buyPressure, 0);
  const sellPressure = safeNum(volume.sellPressure, 0);
  const dumpSpike = Boolean(volume.dumpSpike);
  const pump1mPct = safeNum(volume.pump1mPct, 0);

  if (mintAuthorityEnabled) {
    riskScore += 28;
    reasons.push("Mint authority enabled");
    blocked = true;
  }

  if (freezeAuthorityEnabled) {
    riskScore += 28;
    reasons.push("Freeze authority enabled");
    blocked = true;
  }

  if (liquidityUsd < 5000) {
    riskScore += 22;
    reasons.push(`Very low liquidity: $${liquidityUsd}`);
  } else if (liquidityUsd < 12000) {
    riskScore += 12;
    reasons.push(`Low liquidity: $${liquidityUsd}`);
  }

  if (lpLockedPct < 50) {
    riskScore += 24;
    reasons.push(`LP lock dangerously low: ${lpLockedPct}%`);
    blocked = true;
  } else if (lpLockedPct < 85) {
    riskScore += 12;
    reasons.push(`LP lock weak: ${lpLockedPct}%`);
  }

  if (creatorHolderPct >= 15) {
    riskScore += 24;
    reasons.push(`Creator concentration extreme: ${creatorHolderPct}%`);
    blocked = true;
  } else if (creatorHolderPct >= 8) {
    riskScore += 12;
    reasons.push(`Creator concentration elevated: ${creatorHolderPct}%`);
  }

  if (top10HolderPct >= 70) {
    riskScore += 26;
    reasons.push(`Top-10 concentration extreme: ${top10HolderPct}%`);
    blocked = true;
  } else if (top10HolderPct >= 48) {
    riskScore += 12;
    reasons.push(`Top-10 concentration high: ${top10HolderPct}%`);
  }

  if (denseClusterRisk >= 0.85) {
    riskScore += 18;
    reasons.push("Bubble-map cluster risk very high");
  } else if (denseClusterRisk >= 0.7) {
    riskScore += 10;
    reasons.push("Bubble-map cluster risk elevated");
  }

  if (linkCount >= 12) {
    riskScore += 10;
    reasons.push(`Dense wallet linking detected: ${linkCount} links`);
  }

  if (botPatternScore >= 0.8) {
    riskScore += 18;
    reasons.push("Bot-pattern score extremely high");
  } else if (botPatternScore >= 0.62) {
    riskScore += 10;
    reasons.push("Bot-pattern score elevated");
  }

  if (suspiciousBurst) {
    riskScore += 12;
    reasons.push("Suspicious social burst");
  }

  if (dumpSpike) {
    riskScore += 16;
    reasons.push("Dump spike detected");
  }

  if (sellPressure >= 0.62) {
    riskScore += 14;
    reasons.push(`Sell pressure very high: ${round(sellPressure, 3)}`);
  } else if (sellPressure >= 0.5) {
    riskScore += 8;
    reasons.push(`Sell pressure elevated: ${round(sellPressure, 3)}`);
  }

  if (buyPressure < 0.42 && pump1mPct > 25) {
    riskScore += 12;
    reasons.push("Weak real buy pressure behind short-term move");
  }

  if (pump1mPct >= 60) {
    riskScore += 10;
    reasons.push(`Overheated pump profile: ${pump1mPct}%`);
  }

  riskScore = clamp(round(riskScore, 2), 0, 100);

  return {
    blocked,
    riskScore,
    reasons,
    checks: {
      mintAuthorityEnabled,
      freezeAuthorityEnabled,
      liquidityUsd,
      lpLockedPct,
      creatorHolderPct,
      top10HolderPct,
      denseClusterRisk,
      linkCount,
      botPatternScore,
      suspiciousBurst,
      buyPressure,
      sellPressure,
      dumpSpike,
      pump1mPct
    }
  };
}
