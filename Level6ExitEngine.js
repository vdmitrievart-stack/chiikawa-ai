export default class Level6ExitEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.rules = {
      probeStopLossPct: this.#num(options.rules?.probeStopLossPct, 10),
      smallBuyStopLossPct: this.#num(options.rules?.smallBuyStopLossPct, 13),
      fullBuyStopLossPct: this.#num(options.rules?.fullBuyStopLossPct, 16),

      tp1Pct: this.#num(options.rules?.tp1Pct, 25),
      tp2Pct: this.#num(options.rules?.tp2Pct, 60),

      tp1SellFraction: this.#num(options.rules?.tp1SellFraction, 0.25),
      tp2SellFraction: this.#num(options.rules?.tp2SellFraction, 0.25),

      trailingStopPct: this.#num(options.rules?.trailingStopPct, 14),
      tighterTrailingStopPct: this.#num(options.rules?.tighterTrailingStopPct, 10),

      stalePositionMinutes: this.#num(options.rules?.stalePositionMinutes, 35),
      emergencyExitLiquidityDropPct: this.#num(
        options.rules?.emergencyExitLiquidityDropPct,
        30
      ),

      minRunnerFraction: this.#num(options.rules?.minRunnerFraction, 0.20)
    };
  }

  evaluateExit(position = {}, market = {}, context = {}) {
    const normalized = this.#normalize(position, market, context);

    const hardExit = this.#checkHardExit(normalized);
    if (hardExit.triggered) {
      return this.#buildExitResult("FULL_EXIT", hardExit.reason, normalized, {
        stopLossPct: hardExit.stopLossPct,
        sellFraction: 1
      });
    }

    const emergency = this.#checkEmergencyExit(normalized);
    if (emergency.triggered) {
      return this.#buildExitResult("FULL_EXIT", emergency.reason, normalized, {
        sellFraction: 1
      });
    }

    const partialTakeProfit = this.#checkPartialTakeProfit(normalized);
    if (partialTakeProfit.triggered) {
      return this.#buildExitResult(
        partialTakeProfit.stage,
        partialTakeProfit.reason,
        normalized,
        {
          sellFraction: partialTakeProfit.sellFraction
        }
      );
    }

    const trailing = this.#checkTrailingExit(normalized);
    if (trailing.triggered) {
      return this.#buildExitResult("RUNNER_EXIT", trailing.reason, normalized, {
        sellFraction: trailing.sellFraction
      });
    }

    const stale = this.#checkStaleExit(normalized);
    if (stale.triggered) {
      return this.#buildExitResult("PARTIAL_EXIT", stale.reason, normalized, {
        sellFraction: stale.sellFraction
      });
    }

    return {
      ok: true,
      action: "HOLD",
      reason: "position_still_valid",
      sellFraction: 0,
      metrics: normalized.metrics,
      reasons: [
        `pnl_pct:${normalized.metrics.pnlPct.toFixed(2)}`,
        `drawdown_from_peak_pct:${normalized.metrics.drawdownFromPeakPct.toFixed(2)}`
      ],
      timestamp: new Date().toISOString()
    };
  }

  buildInitialExitPlan(entry = {}) {
    const entryMode = String(entry.entryMode || "SCALED").toUpperCase();
    const entryPriceUsd = this.#num(entry.entryPriceUsd, 0);
    const sizeTokenAmount = this.#num(entry.sizeTokenAmount, 0);

    const stopLossPct = this.#getStopLossPct(entryMode);
    const tp1Pct = this.rules.tp1Pct;
    const tp2Pct = this.rules.tp2Pct;

    const stopPriceUsd =
      entryPriceUsd > 0 ? entryPriceUsd * (1 - stopLossPct / 100) : 0;
    const tp1PriceUsd =
      entryPriceUsd > 0 ? entryPriceUsd * (1 + tp1Pct / 100) : 0;
    const tp2PriceUsd =
      entryPriceUsd > 0 ? entryPriceUsd * (1 + tp2Pct / 100) : 0;

    return {
      ok: true,
      entryMode,
      stopLossPct,
      tp1Pct,
      tp2Pct,
      stopPriceUsd,
      tp1PriceUsd,
      tp2PriceUsd,
      tp1SellFraction: this.rules.tp1SellFraction,
      tp2SellFraction: this.rules.tp2SellFraction,
      runnerFraction: Math.max(
        this.rules.minRunnerFraction,
        1 - this.rules.tp1SellFraction - this.rules.tp2SellFraction
      ),
      sizeTokenAmount,
      timestamp: new Date().toISOString()
    };
  }

  #normalize(position, market, context) {
    const entryMode = String(position.entryMode || "SCALED").toUpperCase();
    const entryPriceUsd = this.#num(position.entryPriceUsd, 0);
    const currentPriceUsd = this.#num(market.currentPriceUsd, entryPriceUsd);
    const peakPriceUsd = this.#num(
      position.peakPriceUsd,
      Math.max(entryPriceUsd, currentPriceUsd)
    );

    const pnlPct =
      entryPriceUsd > 0
        ? ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
        : 0;

    const drawdownFromPeakPct =
      peakPriceUsd > 0
        ? ((peakPriceUsd - currentPriceUsd) / peakPriceUsd) * 100
        : 0;

    const ageMinutes = this.#num(position.ageMinutes, 0);

    return {
      position,
      market,
      context,
      metrics: {
        entryMode,
        entryPriceUsd,
        currentPriceUsd,
        peakPriceUsd,
        pnlPct,
        drawdownFromPeakPct,
        ageMinutes,
        tp1Taken: Boolean(position.tp1Taken),
        tp2Taken: Boolean(position.tp2Taken),
        runnerRemainingFraction: this.#num(position.runnerRemainingFraction, 1),
        buyPressure: this.#num(market.buyPressure, 0.5),
        sellPressure: this.#num(market.sellPressure, 0.5),
        socialMomentum: this.#num(context.socialMomentum, 0.5),
        walletExitSignal: this.#num(context.walletExitSignal, 0),
        liquidityDropPct: this.#num(context.liquidityDropPct, 0),
        safetyDegraded: Boolean(context.safetyDegraded),
        bubbleRiskIncreased: Boolean(context.bubbleRiskIncreased),
        dumpSpike: Boolean(market.dumpSpike)
      }
    };
  }

  #checkHardExit(normalized) {
    const m = normalized.metrics;
    const stopLossPct = this.#getStopLossPct(m.entryMode);

    if (m.pnlPct <= -stopLossPct) {
      return {
        triggered: true,
        reason: `hard_stop_loss_hit:${m.pnlPct.toFixed(2)}`,
        stopLossPct
      };
    }

    return { triggered: false };
  }

  #checkEmergencyExit(normalized) {
    const m = normalized.metrics;

    if (m.safetyDegraded) {
      return { triggered: true, reason: "safety_degraded" };
    }

    if (m.bubbleRiskIncreased) {
      return { triggered: true, reason: "bubble_risk_increased" };
    }

    if (m.liquidityDropPct >= this.rules.emergencyExitLiquidityDropPct) {
      return {
        triggered: true,
        reason: `liquidity_drop_too_large:${m.liquidityDropPct.toFixed(2)}`
      };
    }

    if (m.dumpSpike && m.sellPressure >= 0.70) {
      return { triggered: true, reason: "dump_spike_with_high_sell_pressure" };
    }

    if (m.walletExitSignal >= 0.75) {
      return { triggered: true, reason: "smart_wallet_exit_signal" };
    }

    return { triggered: false };
  }

  #checkPartialTakeProfit(normalized) {
    const m = normalized.metrics;

    if (!m.tp1Taken && m.pnlPct >= this.rules.tp1Pct) {
      return {
        triggered: true,
        stage: "TP1_EXIT",
        reason: `tp1_hit:${m.pnlPct.toFixed(2)}`,
        sellFraction: this.rules.tp1SellFraction
      };
    }

    if (!m.tp2Taken && m.pnlPct >= this.rules.tp2Pct) {
      return {
        triggered: true,
        stage: "TP2_EXIT",
        reason: `tp2_hit:${m.pnlPct.toFixed(2)}`,
        sellFraction: this.rules.tp2SellFraction
      };
    }

    return { triggered: false };
  }

  #checkTrailingExit(normalized) {
    const m = normalized.metrics;

    const baseTrailing =
      m.socialMomentum < 0.45 || m.walletExitSignal > 0.45
        ? this.rules.tighterTrailingStopPct
        : this.rules.trailingStopPct;

    const runnerFraction = Math.max(
      this.rules.minRunnerFraction,
      m.runnerRemainingFraction
    );

    if (m.pnlPct > this.rules.tp1Pct && m.drawdownFromPeakPct >= baseTrailing) {
      return {
        triggered: true,
        reason: `trailing_stop_hit:${m.drawdownFromPeakPct.toFixed(2)}`,
        sellFraction: runnerFraction
      };
    }

    return { triggered: false };
  }

  #checkStaleExit(normalized) {
    const m = normalized.metrics;

    if (
      m.ageMinutes >= this.rules.stalePositionMinutes &&
      m.pnlPct < 8 &&
      m.buyPressure < 0.55 &&
      m.socialMomentum < 0.50
    ) {
      return {
        triggered: true,
        reason: "stale_position_no_continuation",
        sellFraction: 0.50
      };
    }

    return { triggered: false };
  }

  #buildExitResult(action, reason, normalized, extra = {}) {
    return {
      ok: true,
      action,
      reason,
      sellFraction: this.#num(extra.sellFraction, 1),
      stopLossPct: this.#num(extra.stopLossPct, 0),
      metrics: normalized.metrics,
      reasons: [
        reason,
        `pnl_pct:${normalized.metrics.pnlPct.toFixed(2)}`,
        `drawdown_from_peak_pct:${normalized.metrics.drawdownFromPeakPct.toFixed(2)}`
      ],
      timestamp: new Date().toISOString()
    };
  }

  #getStopLossPct(entryMode) {
    if (entryMode === "PROBE") return this.rules.probeStopLossPct;
    if (entryMode === "FULL") return this.rules.fullBuyStopLossPct;
    return this.rules.smallBuyStopLossPct;
  }

  #num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
}
