import { buildLevel6SocialIntel } from "./x-engine.js";

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round((safeNum(value) + Number.EPSILON) * p) / p;
}

function nowMs() {
  return Date.now();
}

function pct(a, b) {
  if (!b) return 0;
  return (a / b) * 100;
}

export class Level6TradingOrchestrator {
  constructor({
    dryRun = true,
    feeReserveSol = Number(process.env.LEVEL6_FEE_RESERVE_SOL || 0.07),
    maxWalletExposurePct = Number(process.env.LEVEL6_MAX_WALLET_EXPOSURE_PCT || 3.5),
    maxAggregateExposurePct = Number(process.env.LEVEL6_MAX_AGGREGATE_EXPOSURE_PCT || 7),
    minLiquidityUsd = Number(process.env.LEVEL6_MIN_LIQUIDITY_USD || 12000),
    maxCreatorHolderPct = Number(process.env.LEVEL6_MAX_CREATOR_HOLDER_PCT || 8),
    maxTop10HolderPct = Number(process.env.LEVEL6_MAX_TOP10_HOLDER_PCT || 48),
    minLpLockedPct = Number(process.env.LEVEL6_MIN_LP_LOCKED_PCT || 85),
    maxExpectedSlippagePct = Number(process.env.LEVEL6_MAX_SLIPPAGE_PCT || 8),
    hardStopLossPct = Number(process.env.LEVEL6_HARD_STOP_LOSS_PCT || 12),
    softStopLossPct = Number(process.env.LEVEL6_SOFT_STOP_LOSS_PCT || 8),
    takeProfitPct = Number(process.env.LEVEL6_TAKE_PROFIT_PCT || 25),
    trailArmPct = Number(process.env.LEVEL6_TRAIL_ARM_PCT || 14),
    trailGivebackPct = Number(process.env.LEVEL6_TRAIL_GIVEBACK_PCT || 8),
    maxTradeLifeMs = Number(process.env.LEVEL6_MAX_TRADE_LIFE_MS || 15 * 60 * 1000)
  } = {}) {
    this.dryRun = dryRun;
    this.feeReserveSol = feeReserveSol;
    this.maxWalletExposurePct = maxWalletExposurePct;
    this.maxAggregateExposurePct = maxAggregateExposurePct;
    this.minLiquidityUsd = minLiquidityUsd;
    this.maxCreatorHolderPct = maxCreatorHolderPct;
    this.maxTop10HolderPct = maxTop10HolderPct;
    this.minLpLockedPct = minLpLockedPct;
    this.maxExpectedSlippagePct = maxExpectedSlippagePct;
    this.hardStopLossPct = hardStopLossPct;
    this.softStopLossPct = softStopLossPct;
    this.takeProfitPct = takeProfitPct;
    this.trailArmPct = trailArmPct;
    this.trailGivebackPct = trailGivebackPct;
    this.maxTradeLifeMs = maxTradeLifeMs;

    this.openTrades = [];
    this.journal = [];
  }

  getOpenTrades() {
    return this.openTrades;
  }

  getJournal() {
    return this.journal;
  }

  async enrichCandidate(candidate = {}) {
    const enriched = {
      token: candidate.token || {},
      walletIntel: candidate.walletIntel || {},
      volumeIntel: candidate.volumeIntel || {},
      socialIntel: candidate.socialIntel || {},
      bubbleMapIntel: candidate.bubbleMapIntel || {},
      portfolio: candidate.portfolio || {},
      execution: candidate.execution || {}
    };

    const token = enriched.token;
    const keywords = [
      token.symbol,
      token.name,
      token.ca,
      ...(Array.isArray(token.keywords) ? token.keywords : [])
    ].filter(Boolean);

    if (
      (!enriched.socialIntel || Object.keys(enriched.socialIntel).length === 0) &&
      (token.ca || token.symbol || keywords.length)
    ) {
      try {
        enriched.socialIntel = await buildLevel6SocialIntel({
          ca: token.ca || "",
          symbol: token.symbol || "",
          keywords
        });
      } catch (error) {
        enriched.socialIntel = {
          uniqueAuthors: 0,
          avgLikes: 0,
          avgReplies: 0,
          botPatternScore: 1,
          engagementDiversity: 0,
          trustedMentions: 0,
          suspiciousBurst: false,
          organicScore: 0,
          error: error.message
        };
      }
    }

    return enriched;
  }

  evaluateSafety(candidate = {}) {
    const token = candidate.token || {};
    const bubble = candidate.bubbleMapIntel || {};
    const execution = candidate.execution || {};

    const reasons = [];
    let blocked = false;
    let safetyScore = 100;

    if (safeNum(token.liquidityUsd) < this.minLiquidityUsd) {
      blocked = true;
      reasons.push(`Liquidity too low: $${safeNum(token.liquidityUsd)}`);
      safetyScore -= 35;
    }

    if (token.mintAuthorityEnabled === true) {
      blocked = true;
      reasons.push("Mint authority still enabled");
      safetyScore -= 30;
    }

    if (token.freezeAuthorityEnabled === true) {
      blocked = true;
      reasons.push("Freeze authority still enabled");
      safetyScore -= 30;
    }

    if (safeNum(token.creatorHolderPct) > this.maxCreatorHolderPct) {
      blocked = true;
      reasons.push(`Creator concentration too high: ${safeNum(token.creatorHolderPct)}%`);
      safetyScore -= 25;
    }

    const top10 = safeNum(token.top10HolderPct || bubble.top10HolderPct);
    if (top10 > this.maxTop10HolderPct) {
      blocked = true;
      reasons.push(`Top-10 concentration too high: ${top10}%`);
      safetyScore -= 22;
    }

    if (safeNum(token.lpLockedPct) < this.minLpLockedPct) {
      blocked = true;
      reasons.push(`LP lock too weak: ${safeNum(token.lpLockedPct)}%`);
      safetyScore -= 20;
    }

    if (safeNum(execution.expectedSlippagePct) > this.maxExpectedSlippagePct) {
      blocked = true;
      reasons.push(`Expected slippage too high: ${safeNum(execution.expectedSlippagePct)}%`);
      safetyScore -= 18;
    }

    const suspiciousLinks = Array.isArray(bubble.links) ? bubble.links.length : 0;
    if (suspiciousLinks >= 8) {
      reasons.push(`Bubble map shows dense wallet linking: ${suspiciousLinks} links`);
      safetyScore -= 10;
    }

    return {
      blocked,
      safetyScore: clamp(round(safetyScore, 2), 0, 100),
      reasons
    };
  }

  evaluateExposure(candidate = {}) {
    const token = candidate.token || {};
    const portfolio = candidate.portfolio || {};
    const execution = candidate.execution || {};

    const totalSupply = safeNum(token.totalSupply);
    const tokenPriceUsd = safeNum(token.tokenPriceUsd, 0);
    const desiredUsd = safeNum(execution.baseDesiredUsd, 0);

    const desiredTokens =
      tokenPriceUsd > 0 ? desiredUsd / tokenPriceUsd : 0;

    const currentWalletTokenAmount = safeNum(portfolio.existingWalletTokenAmount);
    const currentAggregateTokenAmount = safeNum(portfolio.existingAggregateTokenAmount);

    const walletPctAfter =
      totalSupply > 0 ? pct(currentWalletTokenAmount + desiredTokens, totalSupply) : 0;
    const aggregatePctAfter =
      totalSupply > 0 ? pct(currentAggregateTokenAmount + desiredTokens, totalSupply) : 0;

    const reasons = [];
    let blocked = false;

    if (walletPctAfter > this.maxWalletExposurePct) {
      blocked = true;
      reasons.push(
        `Wallet exposure would exceed ${this.maxWalletExposurePct}% (${round(walletPctAfter, 3)}%)`
      );
    }

    if (aggregatePctAfter > this.maxAggregateExposurePct) {
      blocked = true;
      reasons.push(
        `Aggregate exposure would exceed ${this.maxAggregateExposurePct}% (${round(aggregatePctAfter, 3)}%)`
      );
    }

    return {
      blocked,
      desiredTokens: round(desiredTokens, 4),
      walletPctAfter: round(walletPctAfter, 4),
      aggregatePctAfter: round(aggregatePctAfter, 4),
      reasons
    };
  }

  evaluateWallets(candidate = {}) {
    const intel = candidate.walletIntel || {};

    const winRate = safeNum(intel.winRate);
    const medianROI = safeNum(intel.medianROI);
    const averageROI = safeNum(intel.averageROI);
    const maxDrawdown = safeNum(intel.maxDrawdown);
    const tradesCount = safeNum(intel.tradesCount);
    const earlyEntryScore = safeNum(intel.earlyEntryScore);
    const chasePenalty = safeNum(intel.chasePenalty);
    const dumpPenalty = safeNum(intel.dumpPenalty);
    const consistencyScore = safeNum(intel.consistencyScore);
    const consensusLeaders = safeNum(intel.consensusLeaders);

    let score = 0;

    score += clamp(winRate * 35, 0, 35);
    score += clamp((medianROI - 1) * 18, 0, 18);
    score += clamp((averageROI - 1) * 12, 0, 12);
    score += clamp(earlyEntryScore * 15, 0, 15);
    score += clamp(consistencyScore * 12, 0, 12);
    score += clamp(consensusLeaders * 3, 0, 9);

    score -= clamp(chasePenalty * 20, 0, 20);
    score -= clamp(dumpPenalty * 18, 0, 18);
    score -= clamp(maxDrawdown * 18, 0, 18);

    if (tradesCount < 15) score -= 10;
    if (tradesCount < 8) score -= 15;

    const reasons = [];
    if (winRate < 0.52) reasons.push("Win rate too weak");
    if (earlyEntryScore < 0.45) reasons.push("Early-entry quality too weak");
    if (chasePenalty > 0.22) reasons.push("Chase behavior too high");
    if (dumpPenalty > 0.2) reasons.push("Dump-follow behavior too high");

    return {
      score: clamp(round(score, 2), 0, 100),
      reasons
    };
  }

  evaluateVolume(candidate = {}) {
    const intel = candidate.volumeIntel || {};

    const growthRate1m = safeNum(intel.growthRate1m);
    const buyPressure = safeNum(intel.buyPressure);
    const uniqueBuyersDelta = safeNum(intel.uniqueBuyersDelta);
    const repeatedBuyers = safeNum(intel.repeatedBuyers);
    const sellPressure = safeNum(intel.sellPressure);
    const dumpSpike = Boolean(intel.dumpSpike);
    const pump1mPct = safeNum(intel.pump1mPct);

    let score = 0;

    score += clamp(growthRate1m * 12, 0, 24);
    score += clamp(buyPressure * 28, 0, 28);
    score += clamp(uniqueBuyersDelta * 2, 0, 18);

    if (repeatedBuyers <= 2) score += 8;
    if (repeatedBuyers >= 5) score -= 8;

    score -= clamp(sellPressure * 22, 0, 22);
    if (dumpSpike) score -= 20;
    if (pump1mPct >= 45) score -= 14;
    else if (pump1mPct >= 30) score -= 8;

    const reasons = [];
    if (buyPressure < 0.52) reasons.push("Buy pressure weak");
    if (sellPressure > 0.48) reasons.push("Sell pressure too high");
    if (dumpSpike) reasons.push("Dump spike detected");
    if (pump1mPct > 50) reasons.push("Late chase risk after sharp move");

    return {
      score: clamp(round(score, 2), 0, 100),
      reasons
    };
  }

  evaluateSocial(candidate = {}) {
    const intel = candidate.socialIntel || {};

    const uniqueAuthors = safeNum(intel.uniqueAuthors);
    const avgLikes = safeNum(intel.avgLikes);
    const avgReplies = safeNum(intel.avgReplies);
    const botPatternScore = safeNum(intel.botPatternScore);
    const engagementDiversity = safeNum(intel.engagementDiversity);
    const trustedMentions = safeNum(intel.trustedMentions);
    const suspiciousBurst = Boolean(intel.suspiciousBurst);
    const organicScore = safeNum(intel.organicScore);

    let score = 0;

    score += clamp(uniqueAuthors * 1.5, 0, 18);
    score += clamp(avgLikes * 0.35, 0, 14);
    score += clamp(avgReplies * 1.4, 0, 12);
    score += clamp(engagementDiversity * 22, 0, 22);
    score += clamp(trustedMentions * 4, 0, 16);
    score += clamp(organicScore * 0.22, 0, 22);

    score -= clamp(botPatternScore * 28, 0, 28);
    if (suspiciousBurst) score -= 18;

    const reasons = [];
    if (botPatternScore > 0.62) reasons.push("Bot pattern score too high");
    if (engagementDiversity < 0.35) reasons.push("Engagement diversity too weak");
    if (suspiciousBurst) reasons.push("Suspicious social burst detected");

    return {
      score: clamp(round(score, 2), 0, 100),
      reasons
    };
  }

  evaluateMomentum(candidate = {}) {
    const token = candidate.token || {};

    let score = 0;
    score += clamp(safeNum(token.volume1mUsd) / 300, 0, 16);
    score += clamp(safeNum(token.liquidityUsd) / 2500, 0, 18);

    return {
      score: clamp(round(score, 2), 0, 100),
      reasons: []
    };
  }

  buildDecision(candidate = {}) {
    const safety = this.evaluateSafety(candidate);
    const exposure = this.evaluateExposure(candidate);
    const wallets = this.evaluateWallets(candidate);
    const volume = this.evaluateVolume(candidate);
    const social = this.evaluateSocial(candidate);
    const momentum = this.evaluateMomentum(candidate);

    const blockedReasons = [
      ...safety.reasons,
      ...exposure.reasons
    ];

    const score =
      safety.safetyScore * 0.18 +
      wallets.score * 0.24 +
      volume.score * 0.24 +
      social.score * 0.2 +
      momentum.score * 0.14;

    const confidence =
      score >= 78 ? "high" :
      score >= 62 ? "medium" :
      "low";

    const reasons = [
      ...wallets.reasons,
      ...volume.reasons,
      ...social.reasons
    ];

    const allowed =
      !safety.blocked &&
      !exposure.blocked &&
      score >= 58;

    return {
      allowed,
      score: round(score, 2),
      confidence,
      blockedReasons,
      reasons,
      safety,
      exposure,
      wallets,
      volume,
      social,
      momentum
    };
  }

  async tryEnter(candidate = {}) {
    const enriched = await this.enrichCandidate(candidate);
    const decision = this.buildDecision(enriched);

    if (!decision.allowed) {
      return null;
    }

    const token = enriched.token || {};
    const execution = enriched.execution || {};

    const trade = {
      token: token.symbol || token.name || "UNKNOWN",
      ca: token.ca || "",
      entry: safeNum(token.tokenPriceUsd || candidate.price, 0),
      current: safeNum(token.tokenPriceUsd || candidate.price, 0),
      pnl: 0,
      peakPnl: 0,
      score: decision.score,
      confidence: decision.confidence,
      createdAt: nowMs(),
      walletId: execution.walletId || "wallet_1",
      desiredUsd: safeNum(execution.baseDesiredUsd, 0),
      decision,
      socialIntel: enriched.socialIntel || {},
      notes: {
        blockedReasons: decision.blockedReasons,
        reasons: decision.reasons
      }
    };

    this.openTrades.push(trade);
    return trade;
  }

  updateTrade(trade, price, extra = {}) {
    trade.current = safeNum(price, trade.current);
    trade.pnl = trade.entry > 0
      ? round(((trade.current - trade.entry) / trade.entry) * 100, 2)
      : 0;

    trade.peakPnl = Math.max(safeNum(trade.peakPnl), safeNum(trade.pnl));

    if (extra.socialIntel) {
      trade.socialIntel = extra.socialIntel;
    }

    if (extra.marketMood) {
      trade.marketMood = extra.marketMood;
    }

    return trade;
  }

  shouldExit(trade) {
    const ageMs = nowMs() - safeNum(trade.createdAt);

    if (safeNum(trade.pnl) <= -this.hardStopLossPct) {
      return "HARD_STOP";
    }

    if (
      ageMs > 3 * 60 * 1000 &&
      safeNum(trade.pnl) <= -this.softStopLossPct
    ) {
      return "SOFT_STOP";
    }

    if (safeNum(trade.pnl) >= this.takeProfitPct) {
      return "TAKE_PROFIT";
    }

    if (
      safeNum(trade.peakPnl) >= this.trailArmPct &&
      safeNum(trade.peakPnl) - safeNum(trade.pnl) >= this.trailGivebackPct
    ) {
      return "TRAIL_EXIT";
    }

    if (
      trade.socialIntel &&
      safeNum(trade.socialIntel.botPatternScore) > 0.78 &&
      safeNum(trade.pnl) > 0
    ) {
      return "SOCIAL_RISK_EXIT";
    }

    if (ageMs >= this.maxTradeLifeMs) {
      return "TIME_EXIT";
    }

    return null;
  }

  closeTrade(trade, reason) {
    this.openTrades = this.openTrades.filter(t => t !== trade);

    const closed = {
      ...trade,
      exitReason: reason,
      closedAt: nowMs()
    };

    this.journal.push(closed);
    return closed;
  }

  buildEntryExplanation(candidate = {}, trade = null) {
    const decision = trade?.decision || this.buildDecision(candidate);
    const social = decision.social;
    const volume = decision.volume;
    const wallets = decision.wallets;
    const safety = decision.safety;
    const exposure = decision.exposure;

    const positive = [
      `Wallet score: ${wallets.score}`,
      `Volume score: ${volume.score}`,
      `Social score: ${social.score}`,
      `Safety score: ${safety.safetyScore}`,
      `Wallet exposure after entry: ${exposure.walletPctAfter}%`,
      `Aggregate exposure after entry: ${exposure.aggregatePctAfter}%`
    ];

    const cautions = [
      ...decision.reasons.slice(0, 4),
      ...decision.blockedReasons.slice(0, 4)
    ];

    return {
      score: decision.score,
      confidence: decision.confidence,
      positive,
      cautions
    };
  }

  async analyzeOnly(candidate = {}) {
    const enriched = await this.enrichCandidate(candidate);
    const decision = this.buildDecision(enriched);

    return {
      candidate: enriched,
      decision,
      explanation: this.buildEntryExplanation(enriched)
    };
  }
}
