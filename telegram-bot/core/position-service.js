import {
  getPositions as portfolioGetPositions,
  openPosition as portfolioOpenPosition,
  closePosition as portfolioClosePosition,
  markPosition as portfolioMarkPosition,
  maybeTakeRunnerPartial as portfolioMaybeTakeRunnerPartial
} from "../portfolio.js";
import { getLatestTokenPrice, recordTradeOutcomeFromSignalContext } from "../scan-engine.js";

export default class PositionService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.walletOrchestrator = options.walletOrchestrator || null;
  }

  getPositions() {
    return portfolioGetPositions();
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

    if (position.strategy === "copytrade") {
      if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) {
        return { close: true, reason: "COPY_STOP" };
      }
      if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) {
        return { close: true, reason: "COPY_TP" };
      }
      if (ageMs >= position.plannedHoldMs) {
        return { close: true, reason: "COPY_TIME_EXIT" };
      }
      return { close: false, reason: "COPY_HOLD" };
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

      const partial = portfolioMaybeTakeRunnerPartial(p, latest.price);
      if (partial) {
        if (this.walletOrchestrator) {
          await this.walletOrchestrator.executePartial(runtimeConfig, {
            walletId: p.walletId,
            position: p,
            targetPct: partial.targetPct,
            soldFraction: partial.soldFraction,
            currentPrice: latest.price
          });
        }

        await notificationService.sendRunnerPartial(p, partial);
      }

      const analyzedNow = await candidateProbeFn(p.ca);
      const verdict = this.shouldClosePosition(p, analyzedNow);

      await notificationService.sendPositionUpdate(p, mark, verdict.reason);

      if (verdict.close) {
        if (this.walletOrchestrator) {
          await this.walletOrchestrator.executeClose(runtimeConfig, {
            walletId: p.walletId,
            position: p,
            reason: verdict.reason,
            exitReferencePrice: latest.price
          });
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
        dexPaid: candidate.dexPaid,
        reasons: candidate.reasons,
        baseStrategy: candidate.strategy,
        chosenPlan: plan
      },
      walletId,
      entryMode: plan.entryMode,
      planName: plan.planName,
      planObjective: plan.objective
    });
  }

  async orchestrateAndOpen(runtimeConfig, { plan, candidate, heroImage, walletId }) {
    if (this.walletOrchestrator) {
      const { execution } = await this.walletOrchestrator.executeOpen(runtimeConfig, {
        walletId,
        plan,
        candidate,
        heroImage
      });

      if (!execution?.ok) {
        return null;
      }
    }

    return this.maybeOpenPosition({
      plan,
      candidate,
      heroImage,
      walletId
    });
  }

  async forceCloseAll(runtimeConfig, reason = "KILL_SWITCH") {
    const closed = [];

    for (const p of [...portfolioGetPositions()]) {
      const price = p.lastPrice || p.entryReferencePrice;

      if (this.walletOrchestrator) {
        await this.walletOrchestrator.executeClose(runtimeConfig, {
          walletId: p.walletId,
          position: p,
          reason,
          exitReferencePrice: price
        });
      }

      const row = portfolioClosePosition(p.id, price, reason);
      if (row) {
        closed.push(row);
      }
    }

    return closed;
  }
}
