import Level6SafetyEngine from "./Level6SafetyEngine.js";

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

    this.weights = {
      safety: this.#num(options.weights?.safety, 0.30),
      wallet: this.#num(options.weights?.wallet, 0.30),
      volume: this.#num(options.weights?.volume, 0.20),
      social: this.#num(options.weights?.social, 0.20)
    };

    this.thresholds = {
      hardBuy: this.#num(options.thresholds?.hardBuy, 0.78),
      buy: this.#num(options.thresholds?.buy, 0.66),
      probeBuy: this.#num(options.thresholds?.probeBuy, 0.56),
      reject: this.#num(options.thresholds?.reject, 0.40)
    };

    this.guardrails = {
      minConsensusLeaders: this.#num(options.guardrails?.minConsensusLeaders, 1),
      maxPump1mPct: this.#num(options.guardrails?.maxPump1mPct, 120),
      minUniqueBuyersDelta: this.#num(options.guardrails?.minUniqueBuyersDelta, 2),
      maxTop10PctForEntry: this.#num(options.guardrails?.maxTop10PctForEntry, 75)
    };
  }

  async evaluateTradeCandidate(candidate = {}) {
    const normalized = this.#normalizeCandidate(candidate);

    const safety = await this.safetyEngine.evaluateToken(normalized.token);

    if (!safety.ok) {
      return this.#buildDecision({
        action: "REJECT",
        confidence: 0.05,
        reason: "safety_reject",
        safety,
        normalized,
        componentScores: {
          safety: 0,
          wallet: 0,
          volume: 0,
          social: 0
        },
        finalScore: 0
      });
    }

    const walletScore = this.#scoreWalletIntel(normalized.walletIntel);
    const volumeScore = this.#scoreVolumeIntel(normalized.volumeIntel);
    const socialScore = this.#scoreSocialIntel(normalized.socialIntel);
    const safetyScore = this.#normalizeSafetyScore(safety);

    const guardrailResult = this.#applyGuardrails(normalized, {
      safety,
      walletScore,
      volumeScore,
      socialScore
    });

    if (!guardrailResult.ok) {
      return this.#buildDecision({
        action: "REJECT",
        confidence: 0.10,
        reason: guardrailResult.reason,
        safety,
        normalized,
        componentScores: {
          safety: safetyScore,
          wallet: walletScore,
          volume: volumeScore,
          social: socialScore
        },
        finalScore: 0
      });
    }

    const finalScore =
      safetyScore * this.weights.safety +
      walletScore * this.weights.wallet +
      volumeScore * this.weights.volume +
      socialScore * this.weights.social;

    const action = this.#mapScoreToAction(finalScore);
    const confidence = this.#deriveConfidence(finalScore, action);

    return this.#buildDecision({
      action,
      confidence,
      reason: "scored_decision",
      safety,
      normalized,
      componentScores: {
        safety: safetyScore,
        wallet: walletScore,
        volume: volumeScore,
        social: socialScore
      },
      finalScore
    });
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
      marketIntel:
        candidate.marketIntel && typeof candidate.marketIntel === "object"
          ? candidate.marketIntel
          : {},
      context:
        candidate.context && typeof candidate.context === "object"
          ? candidate.context
          : {}
    };
  }

  #scoreWalletIntel(wallet = {}) {
    const tradesCount = this.#num(wallet.tradesCount, 0);
    const winRate = this.#num(wallet.winRate, 0); // 0-1
    const medianROI = this.#num(wallet.medianROI, 1); // multiplier style: 1.25, 1.6, etc
    const averageROI = this.#num(wallet.averageROI, 1);
    const maxDrawdown = this.#num(wallet.maxDrawdown, 1); // 0-1
    const earlyEntryScore = this.#num(wallet.earlyEntryScore, 0.5); // 0-1
    const chasePenalty = this.#num(wallet.chasePenalty, 0); // 0-1
    const dumpPenalty = this.#num(wallet.dumpPenalty, 0); // 0-1
    const consensusLeaders = this.#num(wallet.consensusLeaders, 1);

    let score = 0.20;

    if (tradesCount >= 50) score += 0.15;
    else if (tradesCount >= 20) score += 0.10;
    else if (tradesCount >= 10) score += 0.05;

    if (winRate >= 0.65) score += 0.20;
    else if (winRate >= 0.55) score += 0.12;
    else if (winRate < 0.45) score -= 0.12;

    if (medianROI >= 1.8) score += 0.18;
    else if (medianROI >= 1.3) score += 0.10;
    else if (medianROI < 1.0) score -= 0.08;

    if (averageROI >= 1.5) score += 0.08;
    else if (averageROI < 1.0) score -= 0.05;

    if (maxDrawdown <= 0.25) score += 0.10;
    else if (maxDrawdown > 0.50) score -= 0.12;

    score += (earlyEntryScore - 0.5) * 0.20;
    score -= chasePenalty * 0.12;
    score -= dumpPenalty * 0.12;

    if (consensusLeaders >= 3) score += 0.12;
    else if (consensusLeaders >= 2) score += 0.07;

    return this.#clamp(score, 0, 1);
  }

  #scoreVolumeIntel(volume = {}) {
    const growthRate1m = this.#num(volume.growthRate1m, 1);
    const buyPressure = this.#num(volume.buyPressure, 0.5); // 0-1
    const uniqueBuyersDelta = this.#num(volume.uniqueBuyersDelta, 0);
    const repeatedBuyers = this.#num(volume.repeatedBuyers, 0);
    const dumpSpike = Boolean(volume.dumpSpike);
    const sellPressure = this.#num(volume.sellPressure, 0.5);
    const spreadHealthy = volume.spreadHealthy !== undefined ? Boolean(volume.spreadHealthy) : true;

    let score = 0.20;

    if (growthRate1m >= 1.3 && growthRate1m <= 3.0) score += 0.18;
    else if (growthRate1m > 3.0 && growthRate1m <= 5.0) score += 0.08;
    else if (growthRate1m > 5.0) score -= 0.12;

    if (buyPressure >= 0.68) score += 0.18;
    else if (buyPressure >= 0.58) score += 0.10;
    else if (buyPressure < 0.45) score -= 0.14;

    if (sellPressure > 0.65) score -= 0.12;

    if (uniqueBuyersDelta >= 10) score += 0.16;
    else if (uniqueBuyersDelta >= 4) score += 0.10;
    else if (uniqueBuyersDelta < 1) score -= 0.08;

    if (repeatedBuyers >= 2) score += 0.06;
    if (dumpSpike) score -= 0.20;
    if (!spreadHealthy) score -= 0.08;

    return this.#clamp(score, 0, 1);
  }

  #scoreSocialIntel(social = {}) {
    const uniqueAuthors = this.#num(social.uniqueAuthors, 0);
    const avgLikes = this.#num(social.avgLikes, 0);
    const avgReplies = this.#num(social.avgReplies, 0);
    const botPatternScore = this.#num(social.botPatternScore, 0); // 0-1, higher = more bot-like
    const engagementDiversity = this.#num(social.engagementDiversity, 0.5); // 0-1
    const trustedMentions = this.#num(social.trustedMentions, 0);

    let score = 0.18;

    if (uniqueAuthors >= 20) score += 0.18;
    else if (uniqueAuthors >= 8) score += 0.10;
    else if (uniqueAuthors < 3) score -= 0.10;

    if (avgLikes >= 50) score += 0.14;
    else if (avgLikes >= 15) score += 0.08;

    if (avgReplies >= 8) score += 0.10;
    else if (avgReplies >= 3) score += 0.05;

    score += (engagementDiversity - 0.5) * 0.16;
    score -= botPatternScore * 0.24;

    if (trustedMentions >= 3) score += 0.12;
    else if (trustedMentions >= 1) score += 0.06;

    return this.#clamp(score, 0, 1);
  }

  #normalizeSafetyScore(safety) {
    if (!safety?.ok) return 0;
    if (safety.safetyBand === "safe") return 0.90;
    if (safety.safetyBand === "watch") return 0.65;
    return 0.20;
  }

  #applyGuardrails(normalized, scores) {
    const token = normalized.token || {};
    const wallet = normalized.walletIntel || {};
    const volume = normalized.volumeIntel || {};

    if (
      this.#num(wallet.consensusLeaders, 1) < this.guardrails.minConsensusLeaders &&
      this.#num(wallet.winRate, 0) < 0.60
    ) {
      return { ok: false, reason: "insufficient_wallet_consensus" };
    }

    if (
      this.#num(volume.growthRate1m, 1) > 0 &&
      this.#num(volume.pump1mPct, 0) > this.guardrails.maxPump1mPct
    ) {
      return { ok: false, reason: "vertical_pump_risk" };
    }

    if (
      this.#num(volume.uniqueBuyersDelta, 0) < this.guardrails.minUniqueBuyersDelta &&
      scores.volumeScore < 0.45
    ) {
      return { ok: false, reason: "weak_buyer_expansion" };
    }

    if (
      token.top10HolderPct !== undefined &&
      token.top10HolderPct !== null &&
      this.#num(token.top10HolderPct, 100) > this.guardrails.maxTop10PctForEntry
    ) {
      return { ok: false, reason: "holder_concentration_guardrail" };
    }

    return { ok: true };
  }

  #mapScoreToAction(score) {
    if (score >= this.thresholds.hardBuy) return "BUY";
    if (score >= this.thresholds.buy) return "SMALL_BUY";
    if (score >= this.thresholds.probeBuy) return "PROBE_BUY";
    return "REJECT";
  }

  #deriveConfidence(score, action) {
    if (action === "REJECT") return this.#clamp(score * 0.5, 0.05, 0.45);
    return this.#clamp(0.45 + score * 0.55, 0.45, 0.98);
  }

  #buildDecision({
    action,
    confidence,
    reason,
    safety,
    normalized,
    componentScores,
    finalScore
  }) {
    const reasons = this.#buildReasonList({
      action,
      safety,
      componentScores,
      normalized
    });

    return {
      ok: true,
      action,
      confidence,
      reason,
      finalScore,
      componentScores,
      safety,
      reasons,
      candidate: normalized,
      suggestedRiskMode: this.#suggestRiskMode(action, confidence, safety),
      timestamp: new Date().toISOString()
    };
  }

  #buildReasonList({ action, safety, componentScores, normalized }) {
    const reasons = [];

    if (action === "REJECT") {
      if (safety?.hardReject) {
        reasons.push(...(safety.issues || []).slice(0, 5));
      } else {
        reasons.push("composite_score_below_threshold");
      }
      return reasons;
    }

    if (componentScores.safety >= 0.85) reasons.push("token_safety_strong");
    else if (componentScores.safety >= 0.60) reasons.push("token_safety_acceptable");

    if (componentScores.wallet >= 0.70) reasons.push("smart_wallet_signal_strong");
    if (componentScores.volume >= 0.65) reasons.push("healthy_volume_expansion");
    if (componentScores.social >= 0.60) reasons.push("real_social_momentum");

    const cas = normalized?.token?.ca;
    if (cas) reasons.push(`token:${cas}`);

    return reasons;
  }

  #suggestRiskMode(action, confidence, safety) {
    if (action === "BUY" && confidence >= 0.85 && safety?.safetyBand === "safe") {
      return "normal";
    }
    if (action === "BUY" || action === "SMALL_BUY") {
      return "reduced";
    }
    if (action === "PROBE_BUY") {
      return "probe";
    }
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
