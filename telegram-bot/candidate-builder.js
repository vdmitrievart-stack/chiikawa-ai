/**
 * telegram-bot/candidate-builder.js
 *
 * Level 6 candidate builder (REAL DATA VERSION)
 */

import {
  fetchDexMarketSnapshot,
  buildFallbackMarketSnapshot
} from "./market-data.js";

function safeNum(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function round(v, d = 2) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

/**
 * =========================
 * 🧠 SOCIAL INTEL
 * =========================
 */

function buildSocialIntel() {
  // пока без X API deep integration
  // но логика уже готова

  const uniqueAuthors = Math.floor(Math.random() * 25);
  const avgLikes = Math.floor(Math.random() * 50);
  const avgReplies = Math.floor(Math.random() * 20);

  const botPatternScore = Math.floor(Math.random() * 100);
  const engagementDiversity = Math.floor(Math.random() * 100);
  const trustedMentions = Math.floor(Math.random() * 5);

  const suspiciousBurst =
    botPatternScore > 70 && engagementDiversity < 30;

  const organicScore =
    engagementDiversity +
    trustedMentions * 10 -
    botPatternScore * 0.6;

  return {
    uniqueAuthors,
    avgLikes,
    avgReplies,
    botPatternScore,
    engagementDiversity,
    trustedMentions,
    suspiciousBurst,
    organicScore: round(organicScore, 2)
  };
}

/**
 * =========================
 * 🛡 RUG DETECTION
 * =========================
 */

function buildRugRisk(market) {
  const liquidity = safeNum(market.liquidityUsd);
  const volume5m = safeNum(market.volume5mUsd);
  const buys = safeNum(market.buys5m);
  const sells = safeNum(market.sells5m);

  let risk = 0;
  const reasons = [];

  if (liquidity < 5000) {
    risk += 35;
    reasons.push("Low liquidity");
  }

  if (volume5m < 500) {
    risk += 15;
    reasons.push("Weak volume");
  }

  if (buys < sells) {
    risk += 10;
    reasons.push("Sell pressure");
  }

  if (liquidity < 2000 && volume5m > 3000) {
    risk += 25;
    reasons.push("Fake pump (low liq + high volume)");
  }

  if (market.pairCreatedAt > Date.now() - 10 * 60 * 1000) {
    risk += 20;
    reasons.push("Very new pair");
  }

  const level =
    risk > 70 ? "HIGH" :
    risk > 40 ? "MEDIUM" :
    "LOW";

  return {
    score: risk,
    level,
    reasons
  };
}

/**
 * =========================
 * 👛 WALLET INTEL (GMGN READY)
 * =========================
 */

function buildWalletIntel() {
  // пока заглушка — но структура готова под GMGN API

  const smartMoneyBuys = Math.floor(Math.random() * 5);
  const smartMoneySells = Math.floor(Math.random() * 5);
  const topHolderShare = Math.random() * 0.5;

  const score =
    smartMoneyBuys * 15 -
    smartMoneySells * 10 -
    topHolderShare * 100;

  return {
    smartMoneyBuys,
    smartMoneySells,
    topHolderShare: round(topHolderShare, 3),
    walletScore: round(score, 2)
  };
}

/**
 * =========================
 * 🎯 MAIN BUILDER
 * =========================
 */

export async function buildTokenCandidate({
  ca = "",
  chain = "solana"
} = {}) {

  let market =
    await fetchDexMarketSnapshot({
      chainId: chain,
      tokenAddress: ca
    });

  if (!market) {
    market = buildFallbackMarketSnapshot({
      chainId: chain,
      tokenAddress: ca
    });
  }

  const social = buildSocialIntel();
  const rug = buildRugRisk(market);
  const wallet = buildWalletIntel();

  /**
   * =========================
   * SCORE MODEL
   * =========================
   */

  let score = 0;

  // liquidity
  score += Math.min(market.liquidityUsd / 1000, 30);

  // volume
  score += Math.min(market.volume5mUsd / 200, 25);

  // buy pressure
  score += Math.min(market.buys5m * 2, 20);

  // price momentum
  score += Math.max(market.priceChange5mPct, 0);

  // social
  score += social.organicScore * 0.3;

  // wallet
  score += wallet.walletScore * 0.2;

  // rug penalty
  score -= rug.score * 0.5;

  score = round(score, 2);

  /**
   * =========================
   * DECISION
   * =========================
   */

  const allowed =
    score > 40 &&
    rug.level !== "HIGH";

  const confidence =
    score > 70 ? "HIGH" :
    score > 50 ? "MEDIUM" :
    "LOW";

  return {
    ca,
    chain,

    market,
    socialIntel: social,
    walletIntel: wallet,
    rugRisk: rug,

    decision: {
      allowed,
      score,
      confidence,
      reasons: [
        `Liquidity: ${market.liquidityUsd}`,
        `Volume5m: ${market.volume5mUsd}`,
        `Buy pressure: ${market.buys5m}`,
        `Organic: ${social.organicScore}`,
        `Wallet: ${wallet.walletScore}`
      ],
      blockedReasons:
        rug.level === "HIGH"
          ? rug.reasons
          : []
    }
  };
}
