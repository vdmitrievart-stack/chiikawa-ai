export default class Level6EntryEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.decisionEngine = options.decisionEngine;

    if (!this.decisionEngine) {
      throw new Error("Level6EntryEngine requires decisionEngine");
    }

    this.rules = {
      minProbeUsd: this.#num(options.rules?.minProbeUsd, 25),
      minSmallBuyUsd: this.#num(options.rules?.minSmallBuyUsd, 75),
      minFullBuyUsd: this.#num(options.rules?.minFullBuyUsd, 150),

      probeFraction: this.#num(options.rules?.probeFraction, 0.20),
      smallBuyFraction: this.#num(options.rules?.smallBuyFraction, 0.50),
      fullBuyFraction: this.#num(options.rules?.fullBuyFraction, 1.00),

      minConfidenceForEntry: this.#num(options.rules?.minConfidenceForEntry, 0.58),
      maxExpectedSlippagePct: this.#num(options.rules?.maxExpectedSlippagePct, 10),

      requirePositiveSocialForFullBuy:
        options.rules?.requirePositiveSocialForFullBuy !== undefined
          ? Boolean(options.rules.requirePositiveSocialForFullBuy)
          : true,

      requireConsensusForFullBuy:
        options.rules?.requireConsensusForFullBuy !== undefined
          ? Boolean(options.rules.requireConsensusForFullBuy)
          : true
    };
  }

  async evaluateEntry(candidate = {}) {
    const decision = await this.decisionEngine.evaluateTradeCandidate(candidate);

    if (!decision.ok) {
      return this.#reject("decision_engine_failed", decision);
    }

    if (decision.action === "REJECT") {
      return this.#reject("decision_reject", decision);
    }

    if (decision.confidence < this.rules.minConfidenceForEntry) {
      return this.#reject("confidence_too_low", decision);
    }

    const expectedSlippagePct = this.#num(
      candidate?.execution?.expectedSlippagePct,
      0
    );

    if (expectedSlippagePct > this.rules.maxExpectedSlippagePct) {
      return this.#reject("slippage_too_high", decision);
    }

    const entryMode = this.#deriveEntryMode(decision, candidate);
    const sized = this.#deriveEntrySizing(decision, entryMode);
    const timing = this.#deriveTimingWindow(candidate, decision);

    if (!sized.ok) {
      return this.#reject("entry_sizing_invalid", decision);
    }

    return {
      ok: true,
      action: "ENTER",
      entryMode,
      confidence: decision.confidence,
      finalScore: decision.finalScore,
      sizedUsd: sized.sizedUsd,
      sizedTokenAmount: sized.sizedTokenAmount,
      timing,
      decision,
      reasons: [
        `entry_mode:${entryMode}`,
        `sized_usd:${sized.sizedUsd.toFixed(2)}`,
        `confidence:${decision.confidence.toFixed(4)}`,
        ...(decision.reasons || []).slice(0, 8)
      ],
      timestamp: new Date().toISOString()
    };
  }

  #deriveEntryMode(decision, candidate) {
    const componentScores = decision.componentScores || {};
    const consensusLeaders = this.#num(
      candidate?.walletIntel?.consensusLeaders,
      1
    );

    if (decision.action === "PROBE_BUY") {
      return "PROBE";
    }

    if (decision.action === "SMALL_BUY") {
      return "SCALED";
    }

    if (decision.action === "BUY") {
      if (
        this.rules.requirePositiveSocialForFullBuy &&
        this.#num(componentScores.social, 0) < 0.55
      ) {
        return "SCALED";
      }

      if (
        this.rules.requireConsensusForFullBuy &&
        consensusLeaders < 2
      ) {
        return "SCALED";
      }

      return "FULL";
    }

    return "NONE";
  }

  #deriveEntrySizing(decision, entryMode) {
    const suggestedUsd = this.#num(decision.suggestedUsd, 0);
    const tokenPriceUsd = this.#num(
      decision?.candidate?.token?.tokenPriceUsd,
      0
    );

    let multiplier = 0;
    let minUsd = 0;

    if (entryMode === "PROBE") {
      multiplier = this.rules.probeFraction;
      minUsd = this.rules.minProbeUsd;
    } else if (entryMode === "SCALED") {
      multiplier = this.rules.smallBuyFraction;
      minUsd = this.rules.minSmallBuyUsd;
    } else if (entryMode === "FULL") {
      multiplier = this.rules.fullBuyFraction;
      minUsd = this.rules.minFullBuyUsd;
    } else {
      return { ok: false, sizedUsd: 0, sizedTokenAmount: 0 };
    }

    const sizedUsd = Math.max(minUsd, suggestedUsd * multiplier);
    const cappedUsd = Math.min(sizedUsd, suggestedUsd);

    const sizedTokenAmount =
      tokenPriceUsd > 0 ? cappedUsd / tokenPriceUsd : 0;

    return {
      ok: cappedUsd > 0,
      sizedUsd: cappedUsd,
      sizedTokenAmount
    };
  }

  #deriveTimingWindow(candidate, decision) {
    const volumeIntel = candidate?.volumeIntel || {};
    const socialIntel = candidate?.socialIntel || {};

    const growthRate1m = this.#num(volumeIntel.growthRate1m, 1);
    const uniqueAuthors = this.#num(socialIntel.uniqueAuthors, 0);
    const buyPressure = this.#num(volumeIntel.buyPressure, 0.5);

    let urgency = "normal";
    let validForSeconds = 120;

    if (growthRate1m >= 2.5 && buyPressure >= 0.70) {
      urgency = "fast";
      validForSeconds = 45;
    } else if (uniqueAuthors >= 20 && buyPressure >= 0.65) {
      urgency = "fast";
      validForSeconds = 60;
    } else if (decision.action === "PROBE_BUY") {
      urgency = "cautious";
      validForSeconds = 180;
    }

    return {
      urgency,
      validForSeconds,
      expiresAt: Date.now() + validForSeconds * 1000
    };
  }

  #reject(reason, decision = null) {
    return {
      ok: true,
      action: "SKIP_ENTRY",
      reason,
      decision,
      reasons: [
        reason,
        ...(decision?.reasons || []).slice(0, 6)
      ],
      timestamp: new Date().toISOString()
    };
  }

  #num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
}
