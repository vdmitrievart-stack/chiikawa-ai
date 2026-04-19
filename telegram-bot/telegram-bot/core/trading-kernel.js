import { getBestTrade, getLatestTokenPrice, recordTradeOutcomeFromSignalContext } from "./scan-engine.js";
import {
  getPortfolio,
  getPositions,
  getClosedTrades,
  getStrategyConfig,
  resetPortfolio,
  openPosition,
  closePosition,
  markPosition,
  maybeTakeRunnerPartial,
  setStrategyConfig,
  hasOpenPositions
} from "./portfolio.js";
import { buildStrategyPlans } from "./strategy-engine.js";
import { createRuntimeState, setPendingConfig, applyPendingConfig } from "./trading-runtime.js";
import { buildDashboard, buildEntryText, buildExitText, buildPositionUpdateText, buildPeriodicReport } from "./reporting-engine.js";
import WalletExecutionRouter from "./wallet-execution-router.js";
import CopytradeManager from "./copytrade-manager.js";
import GMGNClient from "./gmgn-client.js";
import GMGNLeaderIntelService from "./gmgn-leader-intel-service.js";

export default class TradingKernel {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.runtime = createRuntimeState();
    this.executionRouter = options.executionRouter || new WalletExecutionRouter({ logger: this.logger });
    this.gmgnClient = options.gmgnClient || new GMGNClient({ logger: this.logger });
    this.gmgnLeaderIntel = options.gmgnLeaderIntel || new GMGNLeaderIntelService({ client: this.gmgnClient, logger: this.logger });
    this.copytradeManager = options.copytradeManager || new CopytradeManager({ logger: this.logger, gmgnLeaderIntel: this.gmgnLeaderIntel });
    this.recentlyTraded = new Map();
    this.previousReportEquity = null;
  }

  getRuntime() {
    return this.runtime;
  }

  getPortfolio() {
    return getPortfolio();
  }

  getStrategyConfig() {
    return getStrategyConfig();
  }

  reset(startBalance = 1) {
    setStrategyConfig(this.runtime.activeConfig.strategyBudget);
    resetPortfolio(startBalance, this.runtime.activeConfig.strategyBudget);
    this.previousReportEquity = null;
  }

  start({ mode = "infinite", chatId = null, userId = null, startBalance = 1 } = {}) {
    this.runtime.mode = mode;
    this.runtime.runId = `run-${Date.now()}`;
    this.runtime.startedAt = Date.now();
    this.runtime.stopRequested = false;
    this.runtime.killRequested = false;
    this.runtime.activeChatId = chatId;
    this.runtime.activeUserId = userId;
    this.reset(startBalance);
    return this.runtime;
  }

  requestStop() {
    this.runtime.stopRequested = true;
    this.runtime.mode = "stopping";
  }

  async killAllPositions(reason = "KILL") {
    const closed = [];
    for (const p of [...getPositions()]) {
      const price = p.lastPrice || p.entryReferencePrice;
      const row = closePosition(p.id, price, reason);
      if (row) {
        await recordTradeOutcomeFromSignalContext(row.signalContext, row.netPnlPct);
        closed.push(row);
      }
    }
    applyPendingConfig(this.runtime);
    if (this.runtime.activeConfig?.strategyBudget) {
      setStrategyConfig(this.runtime.activeConfig.strategyBudget);
    }
    this.runtime.killRequested = true;
    this.runtime.mode = "stopped";
    return closed;
  }

  queueConfigPatch(patch, reason = "manual_update") {
    return setPendingConfig(this.runtime, patch, reason);
  }

  maybeApplyPendingConfig() {
    if (!this.runtime.pendingConfig) return null;
    if (hasOpenPositions()) return null;
    const applied = applyPendingConfig(this.runtime);
    if (applied?.strategyBudget) setStrategyConfig(applied.strategyBudget);
    return applied;
  }

  buildDashboardText() {
    return buildDashboard(this.runtime, getPortfolio());
  }

  buildPeriodicReport() {
    const portfolio = getPortfolio();
    const text = buildPeriodicReport(this.runtime, portfolio, this.previousReportEquity);
    this.previousReportEquity = portfolio.equity;
    return text;
  }

  enrichCandidateWithGMGN(candidate) {
    if (!this.runtime.activeConfig.copytrade.enabled) return candidate;
    const preferredLeader = process.env.DEFAULT_COPYTRADE_LEADER || "";
    if (!preferredLeader) return candidate;
    return this.gmgnLeaderIntel.getLeaderIntel(preferredLeader).then((intel) => ({
      ...candidate,
      gmgnLeaderIntel: intel
    })).catch(() => candidate);
  }

  shouldClosePosition(position, analyzedNow = null) {
    const mark = position.lastMark;
    if (!mark) return { close: false, reason: "NO_MARK" };
    const ageMs = mark.ageMs;
    if (position.strategy === "scalp") {
      if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) return { close: true, reason: "SCALP_STOP" };
      if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) return { close: true, reason: "SCALP_TP" };
      if (ageMs >= position.plannedHoldMs) return { close: true, reason: "SCALP_TIME_EXIT" };
      return { close: false, reason: "SCALP_HOLD" };
    }
    if (position.strategy === "reversal") {
      if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) return { close: true, reason: "REVERSAL_STOP" };
      if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) return { close: true, reason: "REVERSAL_TP" };
      if (ageMs >= position.plannedHoldMs && mark.netPnlPct < 8) return { close: true, reason: "REVERSAL_TIME_EXIT" };
      if (analyzedNow?.corpse?.isCorpse) return { close: true, reason: "REVERSAL_CORPSE_EXIT" };
      return { close: false, reason: "REVERSAL_HOLD" };
    }
    if (position.strategy === "runner") {
      if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) return { close: true, reason: "RUNNER_STOP" };
      const pullbackFromHighPct = position.highestPrice > 0 ? ((position.highestPrice - mark.currentPrice) / position.highestPrice) * 100 : 0;
      if (mark.grossPnlPct > 25 && pullbackFromHighPct > 12) return { close: true, reason: "RUNNER_TRAIL_EXIT" };
      if (analyzedNow?.corpse?.isCorpse) return { close: true, reason: "RUNNER_CORPSE_EXIT" };
      return { close: false, reason: "RUNNER_HOLD" };
    }
    if (position.strategy === "copytrade") {
      if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) return { close: true, reason: "COPY_STOP" };
      if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) return { close: true, reason: "COPY_TP" };
      if (ageMs >= position.plannedHoldMs) return { close: true, reason: "COPY_TIME_EXIT" };
      return { close: false, reason: "COPY_HOLD" };
    }
    return { close: false, reason: "HOLD" };
  }

  pruneRecentlyTraded() {
    const now = Date.now();
    for (const [ca, ts] of this.recentlyTraded.entries()) {
      if (now - ts > 2 * 60 * 60 * 1000) this.recentlyTraded.delete(ca);
    }
  }

  async cycle(handlers = {}) {
    this.runtime.lastCycleAt = Date.now();
    this.pruneRecentlyTraded();

    const events = [];
    for (const p of [...getPositions()]) {
      const latest = await getLatestTokenPrice(p.ca).catch(() => null);
      if (!latest?.price) continue;

      const mark = markPosition(p, latest.price);
      if (!mark) continue;

      const partial = maybeTakeRunnerPartial(p, latest.price);
      if (partial) {
        events.push({ type: "partial", position: p, partial });
      }

      const analyzedNow = await getBestTrade({ excludeCas: [] }).catch(() => null);
      const verdict = this.shouldClosePosition(p, analyzedNow?.token?.ca === p.ca ? analyzedNow : null);
      events.push({ type: "update", position: p, mark, verdict });

      if (verdict.close) {
        const closed = closePosition(p.id, latest.price, verdict.reason);
        if (closed) {
          this.recentlyTraded.set(closed.ca, Date.now());
          await recordTradeOutcomeFromSignalContext(closed.signalContext, closed.netPnlPct);
          events.push({ type: "exit", trade: closed });
        }
      }
    }

    if (!this.runtime.stopRequested) {
      const candidate = await getBestTrade({ excludeCas: [...this.recentlyTraded.keys(), ...getPositions().map(p => p.ca)] });
      if (candidate) {
        const enriched = await this.enrichCandidateWithGMGN(candidate);
        const plans = buildStrategyPlans(enriched, { enabledStrategies: this.runtime.activeConfig.strategyEnabled });
        events.push({ type: "analysis", candidate: enriched, plans });

        for (const plan of plans) {
          const alreadyOpenSameStrategy = getPositions().some(p => p.strategy === plan.strategyKey);
          if (alreadyOpenSameStrategy) continue;
          if (candidate.corpse?.isCorpse) continue;
          if (candidate.falseBounce?.rejected) continue;
          if (candidate.developer?.verdict === "Bad") continue;
          if ((candidate.score || 0) < 85 && plan.strategyKey !== "copytrade") continue;

          if (plan.strategyKey === "copytrade" && this.runtime.activeConfig.copytrade.enabled) {
            const leaderAddress = process.env.DEFAULT_COPYTRADE_LEADER || "";
            if (leaderAddress) {
              const leaderEval = await this.copytradeManager.evaluateLeader(leaderAddress, this.runtime.activeConfig);
              if (!leaderEval.allowed) continue;
            }
          }

          const walletId = this.executionRouter.getPrimaryWalletId(this.runtime.activeConfig, plan.strategyKey);
          const walletCheck = walletId ? this.executionRouter.validateWalletForStrategy(this.runtime.activeConfig, walletId, plan.strategyKey) : { ok: true };
          if (!walletCheck.ok) continue;

          const position = openPosition({
            strategy: plan.strategyKey,
            token: enriched.token,
            thesis: plan.thesis,
            plannedHoldMs: plan.plannedHoldMs,
            stopLossPct: plan.stopLossPct,
            takeProfitPct: plan.takeProfitPct,
            runnerTargetsPct: plan.runnerTargetsPct,
            signalScore: enriched.score,
            expectedEdgePct: plan.expectedEdgePct,
            walletId,
            entryMode: plan.entryMode,
            planName: plan.planName,
            planObjective: plan.objective,
            signalContext: {
              imageUrl: enriched.token.imageUrl || null,
              narrative: enriched.narrative,
              socials: enriched.socials,
              developer: enriched.developer,
              reasons: enriched.reasons,
              baseStrategy: enriched.strategy,
              chosenPlan: plan,
              gmgnLeaderIntel: enriched.gmgnLeaderIntel || null
            }
          });

          if (position) {
            events.push({ type: "entry", position });
          }
        }
      } else {
        events.push({ type: "empty" });
      }
    }

    const applied = this.maybeApplyPendingConfig();
    if (applied) {
      events.push({ type: "config_applied", config: applied });
    }

    return events;
  }

  renderEventText(event) {
    if (event.type === "entry") return buildEntryText(event.position);
    if (event.type === "update") return buildPositionUpdateText(event.position, event.mark, event.verdict.reason);
    if (event.type === "exit") return buildExitText(event.trade);
    if (event.type === "config_applied") return `✅ <b>PENDING CONFIG APPLIED</b>`;
    if (event.type === "empty") return `❌ No candidates found`;
    return null;
  }
}
