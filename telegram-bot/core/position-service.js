import {
  getPositions as portfolioGetPositions,
  openPosition as portfolioOpenPosition,
  closePosition as portfolioClosePosition,
  markPosition as portfolioMarkPosition,
  maybeTakeRunnerPartial as portfolioMaybeTakeRunnerPartial
} from "../portfolio.js";
import { getLatestTokenPrice, recordTradeOutcomeFromSignalContext } from "../scan-engine.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function hasPartialLadder(position) {
  return Array.isArray(position?.runnerTargetsPct) && position.runnerTargetsPct.length > 0;
}

function usesPartialLadder(position) {
  return ["runner", "migration_survivor"].includes(String(position?.strategy || ""));
}

export default class PositionService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.onExternalClose = options.onExternalClose || null;
    this.onExternalPartial = options.onExternalPartial || null;
  }

  getPositions() {
    return portfolioGetPositions();
  }

  buildCopytradeExitState(position, analyzedNow) {
    const meta = clone(position.copytradeExitState || {});
    const leaderTrade = analyzedNow?.leaderTrade || null;
    const leaderSold = Boolean(
      leaderTrade?.action === "sell" || analyzedNow?.copytradeMeta?.leaderSold
    );

    if (!meta.createdAt) meta.createdAt = Date.now();
    if (!meta.mode) meta.mode = "independent_exit";
    if (!meta.leaderSellSoftWarning) meta.leaderSellSoftWarning = false;
    if (!meta.leaderSellSeenAt) meta.leaderSellSeenAt = 0;
    if (!meta.tightenedStopLossPct) meta.tightenedStopLossPct = 0;
    if (!meta.tightenedAt) meta.tightenedAt = 0;
    if (!meta.maxHoldMsOverride) meta.maxHoldMsOverride = 0;
    if (!meta.reason) meta.reason = "";

    if (leaderSold && !meta.leaderSellSoftWarning) {
      meta.leaderSellSoftWarning = true;
      meta.leaderSellSeenAt = Date.now();
      meta.reason = "LEADER_SOFT_EXIT_SIGNAL";

      const currentStop = Math.abs(safeNum(position.stopLossPct, 0));
      const tightenedStop = currentStop > 0 ? Math.min(currentStop, 4.5) : 4.5;
      meta.tightenedStopLossPct = tightenedStop;
      meta.tightenedAt = Date.now();

      const currentHold = safeNum(position.plannedHoldMs, 0);
      if (currentHold > 0) {
        meta.maxHoldMsOverride = Math.min(
          currentHold,
          Math.max(15 * 60 * 1000, Math.floor(currentHold * 0.5))
        );
      } else {
        meta.maxHoldMsOverride = 30 * 60 * 1000;
      }
    }

    return meta;
  }

  shouldClosePosition(position, analyzedNow) {
    const mark = position.lastMark;
    if (!mark) return { close: false, reason: "NO_MARK" };

    const ageMs = mark.ageMs;

    if (position.strategy === "scalp") {
      if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) {
        return { close: true, reason: "SCALP_STOP" };
      }
      if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) {
        return { close: true, reason: "SCALP_TP" };
      }
      if (ageMs >= position.plannedHoldMs) {
        return { close: true, reason: "SCALP_TIME_EXIT" };
      }
      return { close: false, reason: "SCALP_HOLD" };
    }

    if (position.strategy === "reversal") {
      if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) {
        return { close: true, reason: "REVERSAL_STOP" };
      }
      if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) {
        return { close: true, reason: "REVERSAL_TP" };
      }
      if (ageMs >= position.plannedHoldMs && mark.netPnlPct < 8) {
        return { close: true, reason: "REVERSAL_TIME_EXIT" };
      }
      if (analyzedNow?.corpse?.isCorpse) {
        return { close: true, reason: "REVERSAL_CORPSE_EXIT" };
      }
      return { close: false, reason: "REVERSAL_HOLD" };
    }

    if (position.strategy === "runner") {
      if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) {
        return { close: true, reason: "RUNNER_STOP" };
      }

      const pullbackFromHighPct =
        position.highestPrice > 0
          ? ((position.highestPrice - mark.currentPrice) / position.highestPrice) * 100
          : 0;

      if (mark.grossPnlPct > 25 && pullbackFromHighPct > 12) {
        return { close: true, reason: "RUNNER_TRAIL_EXIT" };
      }

      if (analyzedNow?.corpse?.isCorpse) {
        return { close: true, reason: "RUNNER_CORPSE_EXIT" };
      }

      return { close: false, reason: "RUNNER_HOLD" };
    }

    if (position.strategy === "migration_survivor") {
      if (mark.netPnlPct <= -Math.abs(position.stopLossPct || 8)) {
        return { close: true, reason: "MIGRATION_STOP" };
      }

      const pullbackFromHighPct =
        position.highestPrice > 0
          ? ((position.highestPrice - mark.currentPrice) / position.highestPrice) * 100
          : 0;

      if (mark.grossPnlPct >= 70 && pullbackFromHighPct >= 10) {
        return { close: true, reason: "MIGRATION_TRAIL_HARD_EXIT" };
      }

      if (mark.grossPnlPct >= 35 && pullbackFromHighPct >= 12) {
        return { close: true, reason: "MIGRATION_TRAIL_EXIT" };
      }

      if (analyzedNow?.corpse?.isCorpse) {
        return { close: true, reason: "MIGRATION_CORPSE_EXIT" };
      }

      if (analyzedNow?.falseBounce?.rejected && mark.netPnlPct <= 12) {
        return { close: true, reason: "MIGRATION_FALSE_BOUNCE_EXIT" };
      }

      if (ageMs >= position.plannedHoldMs && mark.netPnlPct < 12) {
        return { close: true, reason: "MIGRATION_TIME_EXIT" };
      }

      return { close: false, reason: "MIGRATION_HOLD" };
    }

    if (position.strategy === "copytrade") {
      const exitState = this.buildCopytradeExitState(position, analyzedNow);
      position.copytradeExitState = exitState;

      const effectiveStopLossPct = exitState.tightenedStopLossPct
        ? Math.abs(exitState.tightenedStopLossPct)
        : Math.abs(position.stopLossPct);

      const effectiveHoldMs = exitState.maxHoldMsOverride
        ? exitState.maxHoldMsOverride
        : position.plannedHoldMs;

      const pullbackFromHighPct =
        position.highestPrice > 0
          ? ((position.highestPrice - mark.currentPrice) / position.highestPrice) * 100
          : 0;

      if (mark.netPnlPct <= -effectiveStopLossPct) {
        return {
          close: true,
          reason: exitState.leaderSellSoftWarning ? "COPY_SOFT_SIGNAL_STOP" : "COPY_STOP"
        };
      }

      if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) {
        return { close: true, reason: "COPY_OWN_TP" };
      }

      if (mark.grossPnlPct > 18 && pullbackFromHighPct > 9) {
        return {
          close: true,
          reason: exitState.leaderSellSoftWarning
            ? "COPY_SOFT_SIGNAL_TRAIL_EXIT"
            : "COPY_TRAIL_EXIT"
        };
      }

      if (analyzedNow?.corpse?.isCorpse) {
        return { close: true, reason: "COPY_CORPSE_EXIT" };
      }

      if (analyzedNow?.falseBounce?.rejected) {
        return { close: true, reason: "COPY_FALSE_BOUNCE_EXIT" };
      }

      if (ageMs >= effectiveHoldMs) {
        return {
          close: true,
          reason: exitState.leaderSellSoftWarning
            ? "COPY_SOFT_SIGNAL_TIME_EXIT"
            : "COPY_TIME_EXIT"
        };
      }

      return {
        close: false,
        reason: exitState.leaderSellSoftWarning
          ? "COPY_HOLD_SOFT_WARNING"
          : "COPY_HOLD"
      };
    }

    return { close: false, reason: "HOLD" };
  }

  async updateOpenPositions({
    runtimeConfig,
    notificationService,
    candidateProbeFn,
    recentlyTraded
  }) {
    const closedRows = [];

    for (const p of portfolioGetPositions()) {
      const latest = await getLatestTokenPrice(p.ca);
      if (!latest?.price) continue;

      const mark = portfolioMarkPosition(p, latest.price);
      if (!mark) continue;

      const partial =
        usesPartialLadder(p) && hasPartialLadder(p)
          ? portfolioMaybeTakeRunnerPartial(p, latest.price)
          : null;

      if (partial) {
        try {
          if (this.onExternalPartial) {
            await this.onExternalPartial({
              runtimeConfig,
              position: p,
              partial,
              latestPrice: latest.price
            });
          }
        } catch (error) {
          this.logger.log("external partial hook error:", error.message);
        }

        await notificationService.sendRunnerPartial(p, partial);
      }

      const analyzedNow = await candidateProbeFn(p.ca);
      const verdict = this.shouldClosePosition(p, analyzedNow);

      await notificationService.sendPositionUpdate(p, mark, verdict.reason);

      if (verdict.close) {
        try {
          if (this.onExternalClose) {
            await this.onExternalClose({
              runtimeConfig,
              position: p,
              reason: verdict.reason,
              latestPrice: latest.price
            });
          }
        } catch (error) {
          this.logger.log("external close hook error:", error.message);
        }

        const closed = portfolioClosePosition(p.id, latest.price, verdict.reason);
        if (closed) {
          recentlyTraded.set(closed.ca, Date.now());
          await recordTradeOutcomeFromSignalContext(
            closed.signalContext,
            closed.netPnlPct
          );
          closedRows.push(closed);
          await notificationService.sendExit(
            closed.signalContext?.imageUrl || null,
            closed
          );
        }
      }
    }

    return closedRows;
  }

  maybeOpenPosition({ plan, candidate, heroImage, walletId }) {
    return portfolioOpenPosition({
      strategy: plan.strategyKey,
      token: candidate.token,
      thesis: plan.thesis,
      plannedHoldMs: plan.plannedHoldMs,
      stopLossPct: plan.stopLossPct,
      takeProfitPct: plan.takeProfitPct,
      runnerTargetsPct: plan.runnerTargetsPct,
      signalScore: candidate.score,
      expectedEdgePct: plan.expectedEdgePct,
      signalContext: {
        imageUrl: heroImage,
        narrative: candidate.narrative,
        socials: candidate.socials,
        developer: candidate.developer,
        mechanics: candidate.mechanics,
        migration: candidate.migration,
        dexPaid: candidate.dexPaid,
        reasons: candidate.reasons,
        baseStrategy: candidate.strategy,
        chosenPlan: plan
      },
      walletId,
      entryMode: plan.entryMode,
      planName: plan.planName,
      planObjective: plan.objective,
      copytradeExitState:
        plan.strategyKey === "copytrade"
          ? {
              mode: "independent_exit",
              leaderSellSoftWarning: false,
              leaderSellSeenAt: 0,
              tightenedStopLossPct: 0,
              tightenedAt: 0,
              maxHoldMsOverride: 0,
              reason: ""
            }
          : null
    });
  }

  async forceCloseAll(runtimeConfig, reason = "KILL_SWITCH") {
    const closed = [];

    for (const p of [...portfolioGetPositions()]) {
      const price = p.lastPrice || p.entryReferencePrice;

      try {
        if (this.onExternalClose) {
          await this.onExternalClose({
            runtimeConfig,
            position: p,
            reason,
            latestPrice: price
          });
        }
      } catch (error) {
        this.logger.log("external close hook error:", error.message);
      }

      const row = portfolioClosePosition(p.id, price, reason);
      if (row) {
        closed.push(row);
      }
    }

    return closed;
  }
}
