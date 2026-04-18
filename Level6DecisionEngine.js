import Level6SafetyEngine from "./Level6SafetyEngine.js";
import Level6BubbleMapEngine from "./Level6BubbleMapEngine.js";
import Level6PositionRiskEngine from "./Level6PositionRiskEngine.js";

export default class Level6DecisionEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.safetyEngine =
      options.safetyEngine ||
      new Level6SafetyEngine({
        logger: this.logger,
        rugcheckClient: options.rugcheckClient,
        goplusClient: options.goplusClient
      });

    this.bubbleMapEngine =
      options.bubbleMapEngine ||
      new Level6BubbleMapEngine({
        logger: this.logger
      });

    this.positionRiskEngine =
      options.positionRiskEngine ||
      new Level6PositionRiskEngine({
        logger: this.logger,
        rules: options.positionRules
      });

    this.weights = {
      safety: this.#num(options.weights?.safety, 0.28),
      wallet: this.#num(options.weights?.wallet, 0.28),
      volume: this.#num(options.weights?.volume, 0.18),
      social: this.#num(options.weights?.social, 0.14),
      bubble: this.#num(options.weights?.bubble, 0.12)
    };

    this.thresholds = {
      hardBuy: this.#num(options.thresholds?.hardBuy, 0.80),
      buy: this.#num(options.thresholds?.buy, 0.68),
      probeBuy: this.#num(options.thresholds?.probeBuy, 0.58)
    };

    this.guardrails = {
      minConsensusLeaders: this.#num(options.guardrails?.minConsensusLeaders, 1),
      maxPump1mPct: this.#num(options.guardrails?.maxPump1mPct, 120),
      minUniqueBuyersDelta: this.#num(options.guardrails?.minUniqueBuyersDelta, 2)
    };
  }

  async evaluateTradeCandidate(candidate = {}) {
    const normalized = this.#normalizeCandidate(candidate);

    const safety = await this.safetyEngine.evaluateToken(normalized.token);
    if (!safety.ok) {
      return this.#reject("safety_reject", normalized, {
        safety,
        bubble: null,
        positionRisk: null
      });
    }

    const bubble = this.bubbleMapEngine.evaluate(normalized.bubbleMapIntel);
    if (!bubble.ok) {
      return this.#reject("bubblemap_reject", normalized, {
        safety,
        bubble,
        positionRisk: null
      });
    }

    const walletScore = this.#scoreWalletIntel(normalized.walletIntel);
    const volumeScore = this.#scoreVolumeIntel(normalized.volumeIntel);
    const socialScore = this.#scoreSocialIntel(normalized.socialIntel);
    const safetyScore = this.#normalizeSafetyScore(safety);
    const bubbleScore = this.#normalizeBubbleScore(bubble);

    const guardrailResult = this.#applyGuardrails(normalized, {
      safety,
      bubble,
      walletScore,
      volumeScore,
      socialScore
    });

    if (!guardrailResult.ok) {
      return this.#reject(guardrailResult.reason, normalized, {
        safety,
        bubble,
        positionRisk: null
      });
    }

    const finalScore =
      safetyScore * this.weights.safety +
      walletScore * this.weights.wallet +
      volumeScore * this.weights.volume +
      socialScore * this.weights.social +
      bubbleScore * this.weights.bubble;

    const action = this.#mapScoreToAction(finalScore);
    const confidence = this.#deriveConfidence(finalScore, action);

    const desiredUsd = this.#deriveDesiredUsd(normalized, {
      action,
      confidence,
      walletScore,
      volumeScore,
      socialScore
    });

    const suggestedSize = this.positionRiskEngine.buildSuggestedSize({
      token: normalized.token,
      portfolio: normalized.portfolio,
      walletId: normalized.execution.walletId,
      desiredUsd
    });

    const plannedTokenAmount =
      normalized.token.tokenPriceUsd > 0
        ? suggestedSize.suggestedUsd / normalized.token.tokenPriceUsd
        : this.#num(normalized.execution.plannedTokenAmount, 0);

    const positionRisk = this.positionRiskEngine.evaluate({
      token: normalized.token,
      planned: {
        walletId: normalized.execution.walletId,
        plannedUsd: suggestedSize.suggestedUsd,
        plannedTokenAmount,
        expectedSlippagePct: normalized.execution.expectedSlippagePct
      },
      portfolio: normalized.portfolio
    });

    if (!positionRisk.ok) {
      return this.#reject("position_risk_reject", normalized, {
        safety,
        bubble,
        positionRisk
      });
    }

    return {
      ok: true,
      action,
      confidence,
      finalScore,
      desiredUsd,
      suggestedUsd: suggestedSize.suggestedUsd,
      suggestedTokenAmount: plannedTokenAmount,
      componentScores: {
        safety: safetyScore,
        wallet: walletScore,
        volume: volumeScore,
        social: socialScore,
        bubble: bubbleScore
      },
      safety,
      bubble,
      positionRisk,
      reasons: this.#buildReasons({
        action,
        safety,
        bubble,
        walletScore,
        volumeScore,
        socialScore,
        positionRisk
      }),
      suggestedRiskMode: this.#suggestRiskMode(action, confidence),
      candidate: normalized,
      timestamp: new Date().toISOString()
    };
  }

  #normalizeCandidate(candidate = {}) {
    return {
      token: candidate.token && typeof candidate.token === "object" ? candidate.token : {},
      walletIntel:
        candidate.walletIntel && typeof candidate.walletIntel === "object"
          ? candidate.walletIntel
          : {},
      volumeIntel:
        candidate.volumeIntel && typeof candidate.volumeIntel === "object"
          ? candidate.volumeIntel
          : {},
      socialIntel:
        candidate.socialIntel && typeof candidate.socialIntel === "object"
          ? candidate.socialIntel
          : {},
      bubbleMapIntel:
        candidate.bubbleMapIntel && typeof candidate.bubbleMapIntel === "object"
          ? candidate.bubbleMapIntel
          : {},
      portfolio:
        candidate.portfolio && typeof candidate.portfolio === "object"
          ? candidate.portfolio
          : {},
      execution:
        candidate.execution && typeof candidate.execution === "object"
          ? candidate.execution
          : {},
      context:
        candidate.context && typeof candidate.context === "object"
          ? candidate.context
          : {}
    };
  }

  #reject(reason, normalized, engines) {
    return {
      ok: true,
      action: "REJECT",
      confidence: 0.08,
      finalScore: 0,
      desiredUsd: 0,
      suggestedUsd: 0,
      suggestedTokenAmount: 0,
      componentScores: {
        safety: engines.safety ? this.#normalizeSafetyScore(engines.safety) : 0,
        wallet: 0,
        volume: 0,
        social: 0,
        bubble: engines.bubble ? this.#normalizeBubbleScore(engines.bubble) : 0
      },
      safety: engines.safety || null,
      bubble: engines.bubble || null,
      positionRisk: engines.positionRisk || null,
      reasons: [
        reason,
        ...(engines.safety?.issues || []).slice(0, 4),
        ...(engines.bubble?.reasons || []).slice(0, 4),
        ...(engines.positionRisk?.reasons || []).slice(0, 4)
      ].filter(Boolean),
      suggestedRiskMode: "none",
      candidate: normalized,
      timestamp: new Date().toISOString()
    };
  }

  #scoreWalletIntel(wallet = {}) {
    const winRate = this.#num(wallet.winRate, 0);
    const medianROI = this.#num(wallet.medianROI, 1);
    const averageROI = this.#num(wallet.averageROI, 1);
    const maxDrawdown = this.#num(wallet.maxDrawdown, 1);
    const tradesCount = this.#num(wallet.tradesCount, 0);
    const earlyEntryScore = this.#num(wallet.earlyEntryScore, 0.5);
    const chasePenalty = this.#num(wallet.chasePenalty, 0);
    const dumpPenalty = this.#num(wallet.dumpPenalty, 0);
    const consistencyScore = this.#num(wallet.consistencyScore, 0.5);
    const consensusLeaders = this.#num(wallet.consensusLeaders, 1);

    let score = 0.18;

    if (tradesCount >= 50) score += 0.12;
    else if (tradesCount >= 20) score += 0.08;

    if (winRate >= 0.65) score += 0.18;
    else if (winRate >= 0.55) score += 0.10;
    else if (winRate < 0.45) score -= 0.10;

    if (medianROI >= 1.8) score += 0.14;
    else if (medianROI >= 1.3) score += 0.08;
    else if (medianROI < 1.0) score -= 0.08;

    if (averageROI >= 1.5) score += 0.07;
    else if (averageROI < 1.0) score -= 0.05;

    if (maxDrawdown <= 0.25) score += 0.08;
    else if (maxDrawdown > 0.50) score -= 0.12;

    score += (earlyEntryScore - 0.5) * 0.16;
    score -= chasePenalty * 0.12;
    score -= dumpPenalty * 0.12;
    score += (consistencyScore - 0.5) * 0.14;

    if (consensusLeaders >= 3) score += 0.12;
    else if (consensusLeaders >= 2) score += 0.06;

    return this.#clamp(score, 0, 1);
  }

  #scoreVolumeIntel(volume = {}) {
    const growthRate1m = this.#num(volume.growthRate1m, 1);
    const buyPressure = this.#num(volume.buyPressure, 0.5);
    const uniqueBuyersDelta = this.#num(volume.uniqueBuyersDelta, 0);
    const repeatedBuyers = this.#num(volume.repeatedBuyers, 0);
    const dumpSpike = Boolean(volume.dumpSpike);
    const sellPressure = this.#num(volume.sellPressure, 0.5);

    let score = 0.18;

    if (growthRate1m >= 1.3 && growthRate1m <= 3.0) score += 0.16;
    else if (growthRate1m > 3.0 && growthRate1m <= 5.0) score += 0.06;
    else if (growthRate1m > 5.0) score -= 0.12;

    if (buyPressure >= 0.68) score += 0.18;
    else if (buyPressure >= 0.58) score += 0.10;
    else if (buyPressure < 0.45) score -= 0.12;

    if (uniqueBuyersDelta >= 10) score += 0.14;
    else if (uniqueBuyersDelta >= 4) score += 0.08;
    else if (uniqueBuyersDelta < 1) score -= 0.06;

    if (repeatedBuyers >= 2) score += 0.05;
    if (sellPressure > 0.65) score -= 0.10;
    if (dumpSpike) score -= 0.18;

    return this.#clamp(score, 0, 1);
  }

  #scoreSocialIntel(social = {}) {
    const uniqueAuthors = this.#num(social.uniqueAuthors, 0);
    const avgLikes = this.#num(social.avgLikes, 0);
    const avgReplies = this.#num(social.avgReplies, 0);
    const botPatternScore = this.#num(social.botPatternScore, 0);
    const engagementDiversity = this.#num(social.engagementDiversity, 0.5);
    const trustedMentions = this.#num(social.trustedMentions, 0);

    let score = 0.16;

    if (uniqueAuthors >= 20) score += 0.16;
    else if (uniqueAuthors >= 8) score += 0.09;
    else if (uniqueAuthors < 3) score -= 0.09;

    if (avgLikes >= 50) score += 0.12;
    else if (avgLikes >= 15) score += 0.06;

    if (avgReplies >= 8) score += 0.08;
    else if (avgReplies >= 3) score += 0.04;

    score += (engagementDiversity - 0.5) * 0.14;
    score -= botPatternScore * 0.24;

    if (trustedMentions >= 3) score += 0.10;
    else if (trustedMentions >= 1) score += 0.05;

    return this.#clamp(score, 0, 1);
  }

  #normalizeSafetyScore(safety) {
    if (!safety?.ok) return 0;
    if (safety.safetyBand === "safe") return 0.92;
    if (safety.safetyBand === "watch") return 0.66;
    return 0.18;
  }

  #normalizeBubbleScore(bubble) {
    if (!bubble) return 0.35;
    if (!bubble.ok) return 0;
    if (bubble.holderDistributionBand === "safe") return 0.88;
    if (bubble.holderDistributionBand === "watch") return 0.60;
    return 0.20;
  }

  #applyGuardrails(normalized, scores) {
    const wallet = normalized.walletIntel || {};
    const volume = normalized.volumeIntel || {};

    if (
      this.#num(wallet.consensusLeaders, 1) < this.guardrails.minConsensusLeaders &&
      this.#num(wallet.winRate, 0) < 0.60
    ) {
      return { ok: false, reason: "insufficient_wallet_consensus" };
    }

    if (this.#num(volume.pump1mPct, 0) > this.guardrails.maxPump1mPct) {
      return { ok: false, reason: "vertical_pump_risk" };
    }

    if (
      this.#num(volume.uniqueBuyersDelta, 0) < this.guardrails.minUniqueBuyersDelta &&
      scores.volumeScore < 0.45
    ) {
      return { ok: false, reason: "weak_buyer_expansion" };
    }

    return { ok: true };
  }

  #deriveDesiredUsd(normalized, inputs) {
    const base = this.#num(normalized.execution.baseDesiredUsd, 100);
    const action = inputs.action;

    if (action === "BUY") {
      return base * (inputs.confidence >= 0.85 ? 1.0 : 0.75);
    }
    if (action === "SMALL_BUY") {
      return base * 0.50;
    }
    if (action === "PROBE_BUY") {
      return base * 0.20;
    }
    return 0;
  }

  #mapScoreToAction(score) {
    if (score >= this.thresholds.hardBuy) return "BUY";
    if (score >= this.thresholds.buy) return "SMALL_BUY";
    if (score >= this.thresholds.probeBuy) return "PROBE_BUY";
    return "REJECT";
  }

  #deriveConfidence(score, action) {
    if (action === "REJECT") return this.#clamp(score * 0.5, 0.05, 0.45);
    return this.#clamp(0.46 + score * 0.54, 0.46, 0.98);
  }

  #buildReasons({
    action,
    safety,
    bubble,
    walletScore,
    volumeScore,
    socialScore,
    positionRisk
  }) {
    const reasons = [];

    if (action === "REJECT") {
      reasons.push(...(safety?.issues || []).slice(0, 4));
      reasons.push(...(bubble?.reasons || []).slice(0, 4));
      reasons.push(...(positionRisk?.reasons || []).slice(0, 4));
      if (!reasons.length) reasons.push("composite_score_below_threshold");
      return reasons;
    }

    if (walletScore >= 0.70) reasons.push("smart_wallet_signal_strong");
    if (volumeScore >= 0.65) reasons.push("healthy_volume_expansion");
    if (socialScore >= 0.60) reasons.push("real_social_momentum");
    if (safety?.safetyBand === "safe") reasons.push("token_safety_strong");
    if (bubble?.holderDistributionBand === "safe") reasons.push("holder_distribution_clean");

    reasons.push(
      `per_wallet_supply_pct:${positionRisk.metrics.perWalletSupplyPct.toFixed(4)}`
    );
    reasons.push(
      `aggregate_supply_pct:${positionRisk.metrics.aggregateSupplyPct.toFixed(4)}`
    );

    return reasons;
  }

  #suggestRiskMode(action, confidence) {
    if (action === "BUY" && confidence >= 0.85) return "normal";
    if (action === "BUY" || action === "SMALL_BUY") return "reduced";
    if (action === "PROBE_BUY") return "probe";
    return "none";
  }

  #num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  #clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
}
