import {
  getPortfolio,
  getPositions,
  getStrategyConfig,
  resetPortfolio,
  setStrategyConfig,
  getClosedTrades,
  hydratePortfolioSnapshot
} from "../portfolio.js";

import {
  buildDashboard,
  buildBalanceText as buildPortfolioBalanceText,
  buildPeriodicReport
} from "./reporting-engine.js";

import {
  DEFAULT_STRATEGY_BUDGET,
  validateBudgetPercents,
  formatBudgetLines
} from "./budget-manager.js";

import {
  buildDefaultRuntimeConfig,
  createTradingRuntime,
  startRuntime,
  requestStop,
  requestKill,
  finishRuntime,
  queuePendingConfig,
  canApplyPendingConfig,
  applyPendingConfig,
  canOpenNewPositions
} from "./trading-runtime.js";

import CandidateService from "./candidate-service.js";
import PositionService from "./position-service.js";
import CopytradeService from "./copytrade-service.js";
import NotificationService from "./notification-service.js";
import HolderAccumulationStore from "./holder-accumulation-store.js";
import HolderAccumulationEngine from "./holder-accumulation-engine.js";
import TeamWalletStore from "./team-wallet-store.js";
import TeamWalletIntelligence from "./team-wallet-intelligence.js";

import GMGNWalletService from "../gmgn/gmgn-wallet-service.js";
import GMGNOrderStateStore from "../gmgn/gmgn-order-state-store.js";
import GMGNExecutionService from "../gmgn/gmgn-execution-service.js";
import GMGNSmartWalletFeed from "./gmgn-smart-wallet-feed.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isSolanaChain(chainId) {
  return String(chainId || "").trim().toLowerCase() === "solana";
}

function normalizePlanWithCopyVerdict(plan, copyVerdict) {
  const nextPlan = clone(plan);

  if (copyVerdict?.mode === "probe_only") {
    nextPlan.entryMode = "PROBE";
  }

  if (copyVerdict?.adjustedPlan?.forceEntryMode) {
    nextPlan.entryMode = copyVerdict.adjustedPlan.forceEntryMode;
  }

  if (safeNum(copyVerdict?.adjustedPlan?.forceStopLossPct, 0) > 0) {
    nextPlan.stopLossPct = copyVerdict.adjustedPlan.forceStopLossPct;
  }

  return nextPlan;
}

function normalizeRestoredStrategyBudget(raw = {}) {
  const hasMigration = Object.prototype.hasOwnProperty.call(raw || {}, "migration_survivor");
  const oldFourTotal =
    safeNum(raw?.scalp, 0) +
    safeNum(raw?.reversal, 0) +
    safeNum(raw?.runner, 0) +
    safeNum(raw?.copytrade, 0);

  if (!hasMigration && Math.abs(oldFourTotal - 1) < 0.001) {
    return { ...DEFAULT_STRATEGY_BUDGET };
  }

  return {
    scalp: safeNum(raw?.scalp, DEFAULT_STRATEGY_BUDGET.scalp),
    reversal: safeNum(raw?.reversal, DEFAULT_STRATEGY_BUDGET.reversal),
    runner: safeNum(raw?.runner, DEFAULT_STRATEGY_BUDGET.runner),
    copytrade: safeNum(raw?.copytrade, DEFAULT_STRATEGY_BUDGET.copytrade),
    migration_survivor: safeNum(
      raw?.migration_survivor,
      DEFAULT_STRATEGY_BUDGET.migration_survivor
    )
  };
}

function normalizeRestoredActiveConfig(raw = {}, fallbackStartBalance = 10) {
  return buildDefaultRuntimeConfig({
    ...raw,
    startBalanceSol: safeNum(raw?.startBalanceSol, fallbackStartBalance),
    strategyBudget: normalizeRestoredStrategyBudget(raw?.strategyBudget || {}),
    strategyEnabled: {
      scalp: raw?.strategyEnabled?.scalp !== false,
      reversal: raw?.strategyEnabled?.reversal !== false,
      runner: raw?.strategyEnabled?.runner !== false,
      copytrade: raw?.strategyEnabled?.copytrade !== false,
      migration_survivor: raw?.strategyEnabled?.migration_survivor !== false
    },
    wallets: clone(raw?.wallets || {}),
    strategyRouting: clone(raw?.strategyRouting || {}),
    copytrade: clone(
      raw?.copytrade || {
        enabled: true,
        rescoringEnabled: true,
        minLeaderScore: 70,
        cooldownMinutes: 180,
        leaders: []
      }
    )
  });
}

export default class TradingKernel {
  constructor({
    walletRouter,
    copytradeManager,
    gmgnLeaderIntel,
    persistence,
    gmgnWalletService,
    gmgnOrderStore,
    gmgnExecutionService,
    initialConfig,
    logger = console
  }) {
    this.logger = logger;
    this.walletRouter = walletRouter || null;
    this.copytradeManager = copytradeManager;
    this.gmgnLeaderIntel = gmgnLeaderIntel;
    this.persistence = persistence || null;

    this.defaultStartBalanceSol = safeNum(initialConfig?.startBalanceSol, 10);
    this.startBalanceSol = this.defaultStartBalanceSol;

    this.runtime = createTradingRuntime(
      buildDefaultRuntimeConfig(
        initialConfig || {
          language: "ru",
          dryRun: true,
          startBalanceSol: 10,
          strategyBudget: { ...DEFAULT_STRATEGY_BUDGET },
          wallets: {},
          strategyRouting: {},
          copytrade: {
            enabled: true,
            rescoringEnabled: true,
            minLeaderScore: 70,
            cooldownMinutes: 180,
            leaders: []
          }
        }
      )
    );

    this.gmgnWalletService =
      gmgnWalletService ||
      new GMGNWalletService({
        logger: this.logger
      });

    this.gmgnOrderStore =
      gmgnOrderStore ||
      new GMGNOrderStateStore({
        logger: this.logger
      });

    this.gmgnExecutionService =
      gmgnExecutionService ||
      new GMGNExecutionService({
        logger: this.logger,
        walletService: this.gmgnWalletService,
        orderStore: this.gmgnOrderStore
      });

    this.holderAccumulationStore = new HolderAccumulationStore({
      logger: this.logger
    });

    this.holderAccumulationEngine = new HolderAccumulationEngine({
      logger: this.logger,
      store: this.holderAccumulationStore,
      rpcUrl: process.env.SOLANA_RPC_URL
    });

    this.teamWalletStore = new TeamWalletStore({
      logger: this.logger
    });

    this.teamWalletIntelligence = new TeamWalletIntelligence({
      logger: this.logger,
      rpcUrl: process.env.SOLANA_RPC_URL,
      holderAccumulationEngine: this.holderAccumulationEngine,
      holderStore: this.holderAccumulationStore,
      store: this.teamWalletStore
    });

    this.gmgnSmartWalletFeed = new GMGNSmartWalletFeed({
      logger: this.logger,
      apiKey: process.env.GMGN_API_KEY || '',
      enabled: process.env.GMGN_SMART_WALLET_ENABLED !== 'false'
    });

    this.candidateService = new CandidateService({
      logger: this.logger,
      holderAccumulationEngine: this.holderAccumulationEngine,
      smartWalletFeed: this.gmgnSmartWalletFeed
    });

    this.positionService = new PositionService({
      logger: this.logger,
      onExternalClose: async ({ runtimeConfig, position, reason, latestPrice }) => {
        return this.runGMGNClose(position, reason, latestPrice, runtimeConfig);
      },
      onExternalPartial: async ({ runtimeConfig, position, partial, latestPrice }) => {
        return this.runGMGNPartial(position, partial, latestPrice, runtimeConfig);
      }
    });

    this.copytradeService = new CopytradeService({
      copytradeManager: this.copytradeManager,
      gmgnLeaderIntel: this.gmgnLeaderIntel,
      logger: this.logger
    });

    this.recentlyTraded = new Map();
    this.noticeCooldowns = new Map();
    this.signalNoticeState = new Map();
    this.previousReportEquity = null;
    this.lastHolderSummary = null;
  }

  async initialize() {
    await this.gmgnOrderStore.load();
    await this.holderAccumulationEngine.initialize();
    await this.teamWalletIntelligence.initialize();
    await this.restoreIfAvailable();
    this.lastHolderSummary = this.holderAccumulationEngine.getDashboardSummary();
    return true;
  }

  async restoreIfAvailable() {
    let runtimeLoaded = false;
    let portfolioLoaded = false;

    if (this.persistence) {
      const runtimeSnapshot = await this.persistence.loadRuntimeSnapshot();

      if (runtimeSnapshot?.runtime?.activeConfig) {
        this.runtime.activeConfig = normalizeRestoredActiveConfig(
          runtimeSnapshot.runtime.activeConfig,
          this.defaultStartBalanceSol
        );

        this.runtime.pendingConfig = runtimeSnapshot.runtime.pendingConfig
          ? normalizeRestoredActiveConfig(
              runtimeSnapshot.runtime.pendingConfig,
              this.defaultStartBalanceSol
            )
          : null;

        this.runtime.pendingReason = runtimeSnapshot.runtime.pendingReason || null;
        this.runtime.pendingQueuedAt = runtimeSnapshot.runtime.pendingQueuedAt || null;
        this.runtime.mode = "stopped";
        this.runtime.strategyScope = "all";
        this.runtime.stopRequested = false;
        this.runtime.killRequested = false;
        this.startBalanceSol = safeNum(
          runtimeSnapshot.runtime.startBalanceSol,
          this.defaultStartBalanceSol
        );

        runtimeLoaded = true;
      }
    }

    this.syncPortfolioStrategyBudget();

    if (this.persistence) {
      const portfolioSnapshot = await this.persistence.loadPortfolioSnapshot();
      const savedPortfolio = portfolioSnapshot?.portfolio || null;

      const hasMeaningfulHistory =
        Boolean(savedPortfolio?.positions?.length) ||
        Boolean(savedPortfolio?.closedTrades?.length);

      if (!hasMeaningfulHistory && safeNum(this.startBalanceSol, 0) <= 1) {
        this.startBalanceSol = this.defaultStartBalanceSol;
      }

      if (savedPortfolio && !(safeNum(savedPortfolio?.startBalance, 0) <= 1 && !hasMeaningfulHistory)) {
        hydratePortfolioSnapshot(
          portfolioSnapshot,
          getStrategyConfig(),
          this.startBalanceSol
        );
        portfolioLoaded = true;
      }
    }

    if (!portfolioLoaded) {
      resetPortfolio(this.startBalanceSol, getStrategyConfig());
    }

    if (!runtimeLoaded) {
      await this.persistSnapshot();
    }

    return runtimeLoaded || portfolioLoaded;
  }

  async persistSnapshot() {
    if (!this.persistence) return false;

    const runtimeSaved = await this.persistence.saveRuntimeSnapshot({
      runtime: {
        activeConfig: this.runtime.activeConfig,
        pendingConfig: this.runtime.pendingConfig,
        pendingReason: this.runtime.pendingReason,
        pendingQueuedAt: this.runtime.pendingQueuedAt,
        startBalanceSol: this.startBalanceSol
      }
    });

    const portfolioSaved = await this.persistence.savePortfolioSnapshot({
      portfolio: getPortfolio(),
      runtimeMeta: {
        runId: this.runtime.runId,
        mode: this.runtime.mode,
        strategyScope: this.runtime.strategyScope,
        savedAt: new Date().toISOString()
      }
    });

    return runtimeSaved && portfolioSaved;
  }

  getRuntime() {
    return this.runtime;
  }

  getActiveConfig() {
    return this.runtime.activeConfig;
  }

  getPortfolio() {
    return getPortfolio();
  }

  getClosedTrades() {
    return getClosedTrades();
  }

  setLanguage(lang) {
    this.runtime.activeConfig.language = lang === "en" ? "en" : "ru";
    void this.persistSnapshot();
    return this.runtime.activeConfig.language;
  }

  syncPortfolioStrategyBudget() {
    const cfg = getStrategyConfig();
    const nextCfg = {
      ...cfg,
      scalp: {
        ...(cfg.scalp || {}),
        allocationPct: this.runtime.activeConfig.strategyBudget.scalp
      },
      reversal: {
        ...(cfg.reversal || {}),
        allocationPct: this.runtime.activeConfig.strategyBudget.reversal
      },
      runner: {
        ...(cfg.runner || {}),
        allocationPct: this.runtime.activeConfig.strategyBudget.runner
      },
      copytrade: {
        ...(cfg.copytrade || {}),
        allocationPct: this.runtime.activeConfig.strategyBudget.copytrade
      },
      migration_survivor: {
        ...(cfg.migration_survivor || {}),
        allocationPct: this.runtime.activeConfig.strategyBudget.migration_survivor
      }
    };
    setStrategyConfig(nextCfg);
  }

  start(strategyScope = "all", mode = "infinite", chatId = null, userId = null) {
    startRuntime(this.runtime, { mode, strategyScope, chatId, userId });
    this.previousReportEquity = null;
    this.syncPortfolioStrategyBudget();
    resetPortfolio(this.startBalanceSol, getStrategyConfig());
    void this.persistSnapshot();
    return this.runtime;
  }

  requestSoftStop() {
    requestStop(this.runtime);
    void this.persistSnapshot();
    return this.runtime;
  }

  async requestHardKill() {
    requestKill(this.runtime);

    const closed = await this.positionService.forceCloseAll(
      this.runtime.activeConfig,
      "KILL_SWITCH"
    );

    await this.applyPendingIfPossible();
    finishRuntime(this.runtime);
    await this.persistSnapshot();

    return closed;
  }

  queueBudgetUpdate(values) {
    const validated = validateBudgetPercents(values);
    if (!validated.ok) return validated;

    queuePendingConfig(
      this.runtime,
      { strategyBudget: validated.budget },
      "budget_update"
    );

    void this.persistSnapshot();

    return {
      ok: true,
      budget: validated.budget
    };
  }

  async applyPendingIfPossible() {
    if (!canApplyPendingConfig(this.runtime, getPositions().length)) {
      return false;
    }

    applyPendingConfig(this.runtime);
    this.syncPortfolioStrategyBudget();
    await this.persistSnapshot();

    return true;
  }

  pruneRecentlyTraded() {
    const now = Date.now();
    for (const [ca, ts] of this.recentlyTraded.entries()) {
      if (now - ts > 2 * 60 * 60 * 1000) {
        this.recentlyTraded.delete(ca);
      }
    }
  }

  canEmitNotice(key, cooldownMs = 15 * 60 * 1000) {
    const now = Date.now();
    const last = safeNum(this.noticeCooldowns.get(key), 0);
    if (now - last < cooldownMs) return false;
    this.noticeCooldowns.set(key, now);
    return true;
  }

  async syncLeaderScores() {
    const intel = await this.copytradeService.syncLeaderScores(
      this.runtime.activeConfig
    );
    await this.persistSnapshot();
    return intel;
  }

  async enrichCandidateForCopytrade(candidate) {
    if (!candidate) return candidate;

    if (!this.gmgnLeaderIntel?.enrichCandidateWithLeaderTrade) {
      return candidate;
    }

    try {
      return await this.gmgnLeaderIntel.enrichCandidateWithLeaderTrade(
        this.runtime.activeConfig,
        candidate
      );
    } catch (error) {
      this.logger.log("copytrade enrich failed:", error.message);
      return candidate;
    }
  }

  async runGMGNOpen(walletId, plan, candidate, runtimeConfig = this.runtime.activeConfig) {
    return this.gmgnExecutionService.executeOpen(runtimeConfig, {
      walletId,
      strategy: plan.strategyKey,
      token: candidate.token,
      intent: {
        expectedEdgePct: plan.expectedEdgePct,
        expectedEntryPrice: candidate?.token?.price || 0,
        amountSol: 0,
        slippagePct: 1
      },
      note: `${plan.strategyKey}:${plan.entryMode || "NORMAL"}`
    });
  }

  async runGMGNClose(position, reason, latestPrice, runtimeConfig = this.runtime.activeConfig) {
    if (!position?.walletId) return null;

    return this.gmgnExecutionService.executeClose(runtimeConfig, {
      walletId: position.walletId,
      strategy: position.strategy,
      token: {
        name: position.token,
        symbol: position.symbol,
        ca: position.ca
      },
      intent: {
        amountSol: safeNum(position.amountSol, 0),
        expectedEntryPrice:
          safeNum(position.entryEffectivePrice, 0) ||
          safeNum(position.entryReferencePrice, 0),
        expectedExitPrice: latestPrice || position.lastPrice || 0,
        tokenAmount: position.tokenAmountRaw || 0
      },
      note: reason || "close"
    });
  }

  async runGMGNPartial(position, partial, latestPrice, runtimeConfig = this.runtime.activeConfig) {
    if (!position?.walletId) return null;

    const soldFraction = safeNum(partial?.soldFraction, 0);
    const baseAmountSol = safeNum(position.amountSol, 0);

    return this.gmgnExecutionService.executePartial(runtimeConfig, {
      walletId: position.walletId,
      strategy: position.strategy,
      token: {
        name: position.token,
        symbol: position.symbol,
        ca: position.ca
      },
      soldFraction,
      currentPrice: latestPrice || 0,
      intent: {
        amountSol: baseAmountSol > 0 ? baseAmountSol * soldFraction : 0,
        expectedEntryPrice:
          safeNum(position.entryEffectivePrice, 0) ||
          safeNum(position.entryReferencePrice, 0),
        expectedExitPrice: latestPrice || 0,
        tokenAmount: position.tokenAmountRaw || 0
      },
      note: `runner partial ${safeNum(partial?.targetPct, 0)}`
    });
  }

  getPrimarySignalPlanKey(plans = []) {
    if (!Array.isArray(plans) || !plans.length) return "watch";
    return String(plans[0]?.strategyKey || "watch");
  }

  getSignalCooldownMs(planKey = "watch") {
    const key = String(planKey || "watch");

    if (key === "scalp") return 8 * 60 * 1000;
    if (key === "reversal") return 30 * 60 * 1000;
    if (key === "runner") return 45 * 60 * 1000;
    if (key === "copytrade") return 20 * 60 * 1000;
    if (key === "migration_survivor") return 30 * 60 * 1000;

    return 20 * 60 * 1000;
  }

  getSignalUpdateCooldownMs(planKey = "watch") {
    const key = String(planKey || "watch");

    if (key === "scalp") return 4 * 60 * 1000;
    if (key === "reversal") return 12 * 60 * 1000;
    if (key === "runner") return 18 * 60 * 1000;
    if (key === "copytrade") return 10 * 60 * 1000;
    if (key === "migration_survivor") return 15 * 60 * 1000;

    return 10 * 60 * 1000;
  }

  pctMove(from, to) {
    const a = safeNum(from, 0);
    const b = safeNum(to, 0);
    if (!a || !b) return 0;
    return ((b - a) / a) * 100;
  }

  buildSignalFingerprint(candidate = {}, plans = []) {
    const token = candidate?.token || {};
    const planKey = this.getPrimarySignalPlanKey(plans);

    return {
      ca: String(token.ca || ""),
      planKey,
      planSet: plans.map((plan) => plan.strategyKey).sort().join(","),
      score: safeNum(candidate?.score, 0),
      price: safeNum(token.price, 0),
      liquidity: safeNum(token.liquidity, 0),
      volumeH1: safeNum(token.volumeH1, 0),
      volumeH24: safeNum(token.volumeH24, token.volume || 0),
      txnsH1: safeNum(token.txnsH1, 0),
      scalpScore: safeNum(candidate?.scalp?.score, 0),
      reversalScore: safeNum(candidate?.reversal?.score, 0),
      migrationScore: safeNum(candidate?.migration?.survivorScore, 0),
      runnerScore: safeNum(candidate?.runner?.score, 0),
      corpseScore: safeNum(candidate?.corpse?.score, 0),
      netControlPct: safeNum(candidate?.holderAccumulation?.netControlPct, 0),
      quietAccumulation: Boolean(candidate?.holderAccumulation?.quietAccumulationPass),
      devVerdict: String(candidate?.developer?.verdict || "Unknown")
    };
  }

  getSignalShift(prev, next) {
    if (!prev) return { changed: true, reason: "first_seen" };

    if (prev.planKey !== next.planKey) {
      return { changed: true, reason: `plan:${prev.planKey}->${next.planKey}` };
    }

    if (prev.planSet !== next.planSet) {
      return { changed: true, reason: "plan_set_changed" };
    }

    if (Math.abs(next.score - prev.score) >= 8) {
      return { changed: true, reason: "score_shift" };
    }

    if (Math.abs(next.scalpScore - prev.scalpScore) >= 8) {
      return { changed: true, reason: "scalp_shift" };
    }

    if (Math.abs(next.reversalScore - prev.reversalScore) >= 8) {
      return { changed: true, reason: "reversal_shift" };
    }

    if (Math.abs(next.migrationScore - prev.migrationScore) >= 10) {
      return { changed: true, reason: "migration_shift" };
    }

    if (Math.abs(next.runnerScore - prev.runnerScore) >= 8) {
      return { changed: true, reason: "runner_shift" };
    }

    if (Math.abs(next.corpseScore - prev.corpseScore) >= 8) {
      return { changed: true, reason: "risk_shift" };
    }

    if (Math.abs(next.netControlPct - prev.netControlPct) >= 8) {
      return { changed: true, reason: "holder_control_shift" };
    }

    if (next.quietAccumulation !== prev.quietAccumulation) {
      return { changed: true, reason: "accumulation_state_changed" };
    }

    if (next.devVerdict !== prev.devVerdict) {
      return { changed: true, reason: "dev_verdict_changed" };
    }

    if (Math.abs(this.pctMove(prev.price, next.price)) >= 7) {
      return { changed: true, reason: "price_move" };
    }

    if (Math.abs(this.pctMove(prev.liquidity, next.liquidity)) >= 12) {
      return { changed: true, reason: "liquidity_move" };
    }

    return { changed: false, reason: "minor_noise" };
  }

  shouldEmitCandidateSignal(candidate = {}, plans = []) {
    const fingerprint = this.buildSignalFingerprint(candidate, plans);
    const ca = fingerprint.ca;

    if (!ca) {
      return { emit: true, mode: "full", reason: "no_ca", fingerprint };
    }

    const previous = this.signalNoticeState.get(ca);
    const now = Date.now();

    if (!previous) {
      return { emit: true, mode: "full", reason: "first_seen", fingerprint };
    }

    const shift = this.getSignalShift(previous.fingerprint, fingerprint);
    const fullCooldown = this.getSignalCooldownMs(fingerprint.planKey);
    const updateCooldown = this.getSignalUpdateCooldownMs(fingerprint.planKey);

    if (!shift.changed) {
      return { emit: false, mode: "silent", reason: shift.reason, fingerprint };
    }

    if (now - safeNum(previous.lastUpdateAt, 0) >= updateCooldown) {
      return { emit: true, mode: "update", reason: shift.reason, fingerprint };
    }

    if (now - safeNum(previous.lastFullAt, 0) >= fullCooldown) {
      return { emit: true, mode: "full", reason: shift.reason, fingerprint };
    }

    return { emit: false, mode: "silent", reason: shift.reason, fingerprint };
  }

  markCandidateSignal(candidate = {}, plans = [], decision = {}) {
    const fingerprint = decision?.fingerprint || this.buildSignalFingerprint(candidate, plans);
    if (!fingerprint.ca) return;

    const previous = this.signalNoticeState.get(fingerprint.ca);
    const now = Date.now();

    this.signalNoticeState.set(fingerprint.ca, {
      fingerprint,
      firstSeenAt: previous?.firstSeenAt || now,
      lastFullAt: decision?.mode === "full" ? now : safeNum(previous?.lastFullAt, now),
      lastUpdateAt: now
    });
  }

  buildSignalUpdateText(candidate = {}, plans = [], reason = "update") {
    const token = candidate?.token || {};
    const planLine = plans.map((plan) => plan.strategyKey).join(", ") || "none";

    return `🔁 <b>SIGNAL UPDATE</b>

<b>Token:</b> ${escapeHtml(token.name || token.symbol || "UNKNOWN")}
<b>Contract:</b> <code>${escapeHtml(token.ca || "-")}</code>
<b>Reason:</b> ${escapeHtml(reason)}

Score: ${safeNum(candidate?.score, 0)}
Plans: ${escapeHtml(planLine)}

Price: ${safeNum(token.price, 0)}
Liquidity: ${safeNum(token.liquidity, 0)}
Volume 1h: ${safeNum(token.volumeH1, 0)}
Volume 24h: ${safeNum(token.volumeH24, token.volume || 0)}

Scalp: ${safeNum(candidate?.scalp?.score, 0)}
Reversal: ${safeNum(candidate?.reversal?.score, 0)}
Migration: ${safeNum(candidate?.migration?.survivorScore, 0)}
Corpse: ${safeNum(candidate?.corpse?.score, 0)}
Holder control: ${safeNum(candidate?.holderAccumulation?.netControlPct, 0).toFixed(2)}%`;
  }

  async tick(sendBridge) {
    this.runtime.cycleCount += 1;
    this.runtime.lastCycleAt = Date.now();
    this.pruneRecentlyTraded();

    const notificationService = new NotificationService({
      send: sendBridge
    });

    await this.positionService.updateOpenPositions({
      runtimeConfig: this.runtime.activeConfig,
      notificationService,
      recentlyTraded: this.recentlyTraded,
      candidateProbeFn: async (ca) => {
        const probe = await this.candidateService
          .findBestCandidate({
            runtime: this.runtime,
            openPositions: [],
            recentlyTraded: []
          })
          .catch(() => null);

        const baseCandidate = probe?.candidate?.token?.ca === ca ? probe.candidate : null;
        if (!baseCandidate) return null;

        return this.enrichCandidateForCopytrade(baseCandidate);
      }
    });

    if (this.runtime.stopRequested && getPositions().length === 0) {
      await this.applyPendingIfPossible();
      finishRuntime(this.runtime);
      await this.persistSnapshot();
      await notificationService.sendText("✅ Stop completed. No open positions left.");
      return;
    }

    if (!canOpenNewPositions(this.runtime)) {
      const portfolio = getPortfolio();
      const shouldReport =
        !this.runtime.lastStatusAt ||
        Date.now() - this.runtime.lastStatusAt >= 15 * 60 * 1000;

      if (shouldReport) {
        this.runtime.lastStatusAt = Date.now();
        const report = buildPeriodicReport(
          this.runtime,
          portfolio,
          this.previousReportEquity,
          this.lastHolderSummary || this.holderAccumulationEngine.getDashboardSummary()
        );
        this.previousReportEquity = portfolio.equity;
        await notificationService.sendText(report);
      }

      await this.persistSnapshot();
      return;
    }

    const result = await this.candidateService.findBestCandidate({
      runtime: this.runtime,
      openPositions: getPositions(),
      recentlyTraded: [...this.recentlyTraded.keys()]
    });

    if (!result) {
      if (
        this.runtime.strategyScope === "scalp" &&
        this.canEmitNotice("scalp:no_candidate", 5 * 60 * 1000)
      ) {
        await notificationService.sendText(
          "🫧 <b>SCALP</b>\nПока не вижу нормального кандидата. Фильтры активны, жду что-то живое."
        );
      }

      await this.persistSnapshot();
      return;
    }

    let { candidate, plans, heroImage } = result;
    candidate = await this.enrichCandidateForCopytrade(candidate);
    this.lastHolderSummary = candidate?.holderAccumulation || this.holderAccumulationEngine.getDashboardSummary();

    if (!isSolanaChain(candidate?.token?.chainId)) {
      await this.persistSnapshot();
      return;
    }

    const signalDecision = this.shouldEmitCandidateSignal(candidate, plans);

    if (signalDecision.emit) {
      if (signalDecision.mode === "full") {
        await notificationService.sendPhotoOrText(
          heroImage,
          this.candidateService.buildHeroCaption(candidate)
        );

        await notificationService.sendText(
          this.candidateService.buildAnalysisText(candidate, plans)
        );
      } else {
        await notificationService.sendText(
          this.buildSignalUpdateText(candidate, plans, signalDecision.reason)
        );
      }

      this.markCandidateSignal(candidate, plans, signalDecision);
    } else {
      this.logger.log(
        "candidate signal suppressed:",
        candidate?.token?.ca,
        signalDecision.reason
      );
    }

    for (const rawPlan of plans) {
      const alreadyOpenSameStrategy = getPositions().some(
        (p) => p.strategy === rawPlan.strategyKey
      );
      if (alreadyOpenSameStrategy) continue;

      if (!isSolanaChain(candidate?.token?.chainId)) continue;
      if (candidate.corpse?.isCorpse && !["copytrade", "migration_survivor"].includes(rawPlan.strategyKey)) continue;
      if (candidate.falseBounce?.rejected && !["copytrade", "migration_survivor"].includes(rawPlan.strategyKey)) continue;
      if (candidate.developer?.verdict === "Bad" && !["copytrade", "migration_survivor"].includes(rawPlan.strategyKey)) continue;

      const minScoreByStrategy = {
        scalp: 68,
        reversal: 78,
        runner: 82,
        copytrade: 0,
        migration_survivor: 0
      };

      const minScore = minScoreByStrategy[rawPlan.strategyKey] ?? 85;

      if (
        candidate.score < minScore &&
        !["copytrade", "migration_survivor"].includes(rawPlan.strategyKey)
      ) {
        continue;
      }

      let plan = clone(rawPlan);

      if (plan.strategyKey === "copytrade") {
        const followDelaySec = safeNum(candidate?.copytradeMeta?.followDelaySec, 0);
        const priceExtensionPct = safeNum(
          candidate?.copytradeMeta?.priceExtensionPct,
          safeNum(candidate?.delta?.priceDeltaPct, 0)
        );

        const copyVerdict = this.copytradeService.canTradeCopy(
          this.runtime.activeConfig,
          candidate,
          {
            followDelaySec,
            priceExtensionPct
          }
        );

        if (!copyVerdict.allow) {
          if (copyVerdict.leader?.address) {
            this.copytradeService.registerRejectedTrap(
              this.runtime.activeConfig,
              copyVerdict.leader.address,
              copyVerdict.mode === "reject" ? "hard" : "soft"
            );
          }

          const isCopyOnlyMode = this.runtime.strategyScope === "copytrade";
          const isNoLeader = copyVerdict.reason === "NO_LEADER";

          let shouldNotifyReject = false;

          if (isNoLeader) {
            if (isCopyOnlyMode) {
              shouldNotifyReject = this.canEmitNotice(
                "copytrade:no_leader",
                30 * 60 * 1000
              );
            }
          } else {
            shouldNotifyReject = this.canEmitNotice(
              `copytrade:${candidate?.token?.ca || "unknown"}:${copyVerdict.reason || "reject"}`,
              20 * 60 * 1000
            );
          }

          if (shouldNotifyReject) {
            await notificationService.sendText(
              `🚫 <b>COPYTRADE REJECTED</b>

<b>Leader:</b> ${escapeHtml(copyVerdict.leader?.address || "-")}
<b>Reason:</b> ${escapeHtml(copyVerdict.reason || "COPY_REJECT")}
<b>Details:</b>
${(copyVerdict.reasons || []).map((x) => `• ${escapeHtml(x)}`).join("\n") || "• rejected"}`
            );
          }

          await this.persistSnapshot();
          continue;
        }

        plan = normalizePlanWithCopyVerdict(plan, copyVerdict);

        if (copyVerdict.leader?.address) {
          this.copytradeService.registerAcceptedQuality(
            this.runtime.activeConfig,
            copyVerdict.leader.address
          );
        }

        if (
          copyVerdict.mode === "probe_only" &&
          this.canEmitNotice(
            `copytrade:probe:${candidate?.token?.ca || "unknown"}`,
            20 * 60 * 1000
          )
        ) {
          await notificationService.sendText(
            `⚠️ <b>COPYTRADE PROBE MODE</b>

<b>Leader:</b> ${escapeHtml(copyVerdict.leader?.address || "-")}
<b>Reason:</b> ${escapeHtml(copyVerdict.reason || "COPY_BORDERLINE")}
<b>Details:</b>
${(copyVerdict.reasons || []).map((x) => `• ${escapeHtml(x)}`).join("\n") || "• probe"}`
          );
        }
      }

      const walletId = this.gmgnWalletService.getPrimaryWalletId(
        this.runtime.activeConfig,
        plan.strategyKey
      );

      const walletCheck = this.gmgnWalletService.validateWalletForStrategy(
        this.runtime.activeConfig,
        walletId,
        plan.strategyKey
      );

      if (!walletCheck.ok) continue;

      const order = await this.runGMGNOpen(walletId, plan, candidate);
      if (!order) continue;

      const position = this.positionService.maybeOpenPosition({
        plan,
        candidate,
        heroImage,
        walletId
      });

      if (position) {
        await notificationService.sendEntry(heroImage, position);
      }
    }

    const portfolio = getPortfolio();
    const shouldReport =
      !this.runtime.lastStatusAt ||
      Date.now() - this.runtime.lastStatusAt >= 15 * 60 * 1000;

    if (shouldReport) {
      this.runtime.lastStatusAt = Date.now();
      const report = buildPeriodicReport(
        this.runtime,
        portfolio,
        this.previousReportEquity,
        this.lastHolderSummary || this.holderAccumulationEngine.getDashboardSummary()
      );
      this.previousReportEquity = portfolio.equity;
      await notificationService.sendText(report);
    }

    await this.persistSnapshot();
  }

  buildCopytradeStatusSummary() {
    const leaders = this.runtime.activeConfig?.copytrade?.leaders || [];
    if (!leaders.length) {
      return `📋 <b>Copytrade status</b>
leader: -
state: -
score: 0
rejected traps: 0
accepted good: 0
open gmgn orders: ${this.gmgnOrderStore.listOpenOrders().length}`;
    }

    const sorted = [...leaders].sort(
      (a, b) => safeNum(b?.score, 0) - safeNum(a?.score, 0)
    );
    const leader = sorted[0] || {};

    return `📋 <b>Copytrade status</b>
leader: ${escapeHtml(leader.address || "-")}
state: ${escapeHtml(leader.state || "-")}
score: ${safeNum(leader.score, 0)}
rejected traps: ${safeNum(leader.rejectedTrapCount, 0)}
accepted good: ${safeNum(leader.acceptedGoodCount, 0)}
open gmgn orders: ${this.gmgnOrderStore.listOpenOrders().length}`;
  }

  buildExecutionModelSummary() {
    const r = this.copytradeService?.rules || {};
    return `🧠 <b>Execution model</b>
entry by leader: ${r.entryUsesLeader ? "yes" : "no"}
exit by bot strategy: yes
leader sell mode: ${escapeHtml(String(r.exitUsesLeaderMode || "soft_only"))}
leader sell tightens stop: ${r.leaderSellTightensStop ? "yes" : "no"}
leader sell immediate exit: ${r.leaderSellImmediateExit ? "yes" : "no"}
own TP priority: ${r.ownTpPriority ? "yes" : "no"}
own trail priority: ${r.ownTrailPriority ? "yes" : "no"}`;
  }

  buildRecentGMGNEventsSummary(limit = 3) {
    const rows = this.gmgnOrderStore.listRecentOrders(limit);

    if (!rows.length) {
      return `🕘 <b>Recent GMGN events</b>
none`;
    }

    const lines = ["🕘 <b>Recent GMGN events</b>", ""];

    for (const row of rows) {
      lines.push(
        `• ${escapeHtml(String(row.operation || "-").toUpperCase())} | ${escapeHtml(String(row.status || "-").toUpperCase())}
strategy: ${escapeHtml(row.strategy || "-")}
token: ${escapeHtml(row?.token?.symbol || row?.token?.name || row?.token?.ca || "-")}
note: ${escapeHtml(row.note || "-")}
updated: ${escapeHtml(row.updatedAt || "-")}`
      );
      lines.push("");
    }

    return lines.join("\n");
  }

  buildGMGNPnlHintSummary() {
    const rows = this.gmgnOrderStore
      .listOrders()
      .filter((row) => {
        const mode = String(row?.mode || "").toLowerCase();
        const status = String(row?.status || "").toLowerCase();
        const op = String(row?.operation || "").toLowerCase();
        return (
          mode === "dry_run" &&
          status === "filled" &&
          (op === "close" || op === "partial")
        );
      });

    const totalSol = rows.reduce(
      (sum, row) => sum + safeNum(row?.metrics?.pnlHintSol, 0),
      0
    );
    const positiveSol = rows.reduce((sum, row) => {
      const v = safeNum(row?.metrics?.pnlHintSol, 0);
      return v > 0 ? sum + v : sum;
    }, 0);
    const negativeSol = rows.reduce((sum, row) => {
      const v = safeNum(row?.metrics?.pnlHintSol, 0);
      return v < 0 ? sum + v : sum;
    }, 0);
    const avgPct =
      rows.length > 0
        ? rows.reduce((sum, row) => sum + safeNum(row?.metrics?.pnlHintPct, 0), 0) / rows.length
        : 0;

    return `💡 <b>Simulated GMGN close hints</b>
filled close/partial: ${rows.length}
sum pnlHintSol: ${totalSol.toFixed(4)}
positive pnlHintSol: ${positiveSol.toFixed(4)}
negative pnlHintSol: ${negativeSol.toFixed(4)}
avg pnlHintPct: ${avgPct.toFixed(2)}%`;
  }


  buildRadarSummaryText() {
    const t = this.candidateService?.getRadarTelemetry?.() || {};
    const byBucket = t?.byBucket || {};
    return `📡 <b>Radar</b>
scanned raw: ${safeNum(t?.scannedRaw, 0)}
unique pairs: ${safeNum(t?.uniquePairs, 0)}
after analysis: ${safeNum(t?.candidatesAfterAnalysis, 0)}
filtered noise: ${safeNum(t?.filteredNoise, 0)}
deep analyzed: ${safeNum(t?.deepAnalyzed, 0)}
watchlist: ${safeNum(t?.watchlist, 0)} | priority: ${safeNum(t?.priorityWatch, 0)}
packaging: ${safeNum(t?.packagingDetected, 0)} | probe: ${safeNum(t?.packagingProbe, 0)}
reversal watch: ${safeNum(t?.reversalWatch, 0)} | runner-like: ${safeNum(t?.runnerLike, 0)}
migration structure: ${safeNum(t?.migrationStructure, 0)}
trap rejected: ${safeNum(t?.trapRejected, 0)} | trade-ready: ${safeNum(t?.tradeReady, 0)}
smart-wallet raw/tokens/accepted: ${safeNum(t?.smartWalletFeedRaw, 0)} / ${safeNum(t?.smartWalletTokens, 0)} / ${safeNum(t?.smartWalletAccepted, 0)}
smart-wallet publish-worthy: ${safeNum(t?.smartWalletPublishWorthy, 0)}
buckets fresh/packaging/migration/momentum/forgotten/smart: ${safeNum(byBucket?.fresh, 0)} / ${safeNum(byBucket?.packaging, 0)} / ${safeNum(byBucket?.migration, 0)} / ${safeNum(byBucket?.momentum, 0)} / ${safeNum(byBucket?.forgotten, 0)} / ${safeNum(byBucket?.smart_wallets, 0)}`;
  }

  buildNoCandidateNotice() {
    const scope = String(this.runtime?.strategyScope || "all").toUpperCase();
    const t = this.candidateService?.getRadarTelemetry?.() || {};
    return `📡 <b>${escapeHtml(scope)}</b>
Пока не вижу нормального кандидата. Продолжаю сканировать рынок.

scanned: ${safeNum(t?.uniquePairs, 0)} | watchlist: ${safeNum(t?.watchlist, 0)} | packaging: ${safeNum(t?.packagingDetected, 0)} | migration: ${safeNum(t?.migrationStructure, 0)} | trap rejected: ${safeNum(t?.trapRejected, 0)} | trade-ready: ${safeNum(t?.tradeReady, 0)}
smart-wallet accepted/publish-worthy: ${safeNum(t?.smartWalletAccepted, 0)} / ${safeNum(t?.smartWalletPublishWorthy, 0)}`;
  }

  buildStatusText() {
    const base = buildDashboard(
      this.runtime,
      getPortfolio(),
      this.lastHolderSummary || this.holderAccumulationEngine.getDashboardSummary()
    );
    return `${base}

${this.buildRadarSummaryText()}

${this.buildCopytradeStatusSummary()}

${this.buildExecutionModelSummary()}

${this.buildGMGNExecutionText()}

${this.buildGMGNPnlHintSummary()}

${this.buildRecentGMGNEventsSummary()}`;
  }

  buildBalanceText() {
    return `${buildPortfolioBalanceText(
      getPortfolio(),
      this.lastHolderSummary || this.holderAccumulationEngine.getDashboardSummary()
    )}

${this.buildRadarSummaryText()}

${this.buildGMGNPnlHintSummary()}`;
  }

  buildWalletsText() {
    return `${this.gmgnWalletService.buildWalletSummaryText(this.runtime.activeConfig)}

${this.gmgnWalletService.buildStrategyMappingText(this.runtime.activeConfig)}

🕵️ <b>Team / Insider / Sniper Intel — V2 ACTIVE</b>
Отдельная проверка команды, инсайдеров, снайперов и dev history.

Команды:
<code>/teamscan CA</code>
<code>/teamintel CA</code>
<code>/snipers CA</code>
<code>/insiders CA</code>

Или нажми кнопку <b>🕵️ Team Scan</b> и отправь CA.`;
  }

  buildCopytradeText() {
    return this.copytradeService.buildCopytradeText(this.runtime.activeConfig);
  }

  buildBudgetText() {
    const current =
      this.runtime.activeConfig.strategyBudget || DEFAULT_STRATEGY_BUDGET;
    const pending = this.runtime.pendingConfig?.strategyBudget || null;

    return `🧮 <b>Budget</b>

<b>Current</b>
${formatBudgetLines(current)}

<b>Pending</b>
${pending ? formatBudgetLines(pending) : "none"}

Send:
<code>budget 20 20 20 20 20</code>`;
  }

  buildGmgnStatusText() {
    return this.copytradeService.buildGmgnStatusText();
  }

  buildGMGNExecutionText() {
    return this.gmgnExecutionService.buildExecutionSummaryText(
      this.runtime.activeConfig
    );
  }

  buildGMGNOrdersText(limit = 15) {
    return this.gmgnExecutionService.buildOrdersText(limit);
  }

  async buildLeaderHealthText() {
    return this.copytradeService.buildLeaderHealthText(
      this.runtime.activeConfig
    );
  }

  addLeader(address) {
    const row = this.copytradeManager.addLeader(
      this.runtime.activeConfig,
      address,
      "manual"
    );
    void this.persistSnapshot();
    return row;
  }

  setWalletSecretRef(walletId, secretRef) {
    if (!this.runtime.activeConfig.wallets[walletId]) return false;
    this.runtime.activeConfig.wallets[walletId].secretRef = secretRef;
    void this.persistSnapshot();
    return true;
  }

  async fetchTokenByCA(ca) {
    const DEX_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";
    const res = await fetch(`${DEX_TOKEN_API}/${encodeURIComponent(ca)}`);
    if (!res.ok) {
      throw new Error(`DexScreener HTTP ${res.status}`);
    }

    const json = await res.json();
    const pairsRaw = Array.isArray(json?.pairs) ? json.pairs : [];
    const pairs = pairsRaw.filter((p) => isSolanaChain(p?.chainId));
    if (!pairs.length) return null;

    const bestRaw = pairs.sort(
      (a, b) =>
        safeNum(b?.liquidity?.usd) - safeNum(a?.liquidity?.usd) ||
        safeNum(b?.volume?.h24) - safeNum(a?.volume?.h24)
    )[0];

    if (!isSolanaChain(bestRaw?.chainId)) return null;

    const socials = Array.isArray(bestRaw?.info?.socials)
      ? bestRaw.info.socials
      : [];
    const websites = Array.isArray(bestRaw?.info?.websites)
      ? bestRaw.info.websites
      : [];

    const links = [
      ...socials.map((x) => ({
        type: x?.type || "",
        label: x?.type || "",
        url: x?.url || ""
      })),
      ...websites.map((x) => ({
        type: "website",
        label: "website",
        url: x?.url || ""
      }))
    ];

    return {
      name: bestRaw?.baseToken?.name || bestRaw?.baseToken?.symbol || "UNKNOWN",
      symbol: bestRaw?.baseToken?.symbol || "",
      ca: bestRaw?.baseToken?.address || "",
      pairAddress: bestRaw?.pairAddress || "",
      chainId: bestRaw?.chainId || "",
      dexId: bestRaw?.dexId || "",
      price: safeNum(bestRaw?.priceUsd),
      liquidity: safeNum(bestRaw?.liquidity?.usd),
      volume: safeNum(bestRaw?.volume?.h24),
      buys: safeNum(bestRaw?.txns?.h24?.buys),
      sells: safeNum(bestRaw?.txns?.h24?.sells),
      txns:
        safeNum(bestRaw?.txns?.h24?.buys) +
        safeNum(bestRaw?.txns?.h24?.sells),
      fdv: safeNum(bestRaw?.fdv),
      pairCreatedAt: safeNum(bestRaw?.pairCreatedAt),
      url: bestRaw?.url || "",
      imageUrl: bestRaw?.info?.imageUrl || null,
      description: bestRaw?.info?.description || "",
      links
    };
  }


  async buildScanCaPayload(ca) {
    const token = await this.fetchTokenByCA(ca);
    if (!token) return null;

    let analyzed = null;
    let plans = [];
    let heroImage = token?.imageUrl || null;

    // V10 compatibility fix:
    // Some project versions do NOT have candidateService.analyzeSingleToken().
    // The current CandidateService API is scanCA(...) or analyzeToken(token).
    if (typeof this.candidateService?.scanCA === "function") {
      const scanResult = await this.candidateService.scanCA({
        runtime: this.runtime?.activeConfig || this.runtime || {},
        fetchTokenByCA: async (inputCa) => this.fetchTokenByCA(inputCa || ca),
        ca
      });

      if (scanResult?.analyzed) {
        analyzed = scanResult.analyzed;
        plans = Array.isArray(scanResult?.plans) ? scanResult.plans : [];
        heroImage = scanResult?.heroImage || heroImage;
      }
    }

    if (!analyzed) {
      if (typeof this.candidateService?.analyzeSingleToken === "function") {
        analyzed = await this.candidateService.analyzeSingleToken(token);
      } else if (typeof this.candidateService?.analyzeToken === "function") {
        analyzed = this.candidateService.analyzeToken(token);
      } else {
        throw new Error("CandidateService has no scanCA/analyzeToken method");
      }

      if (typeof this.candidateService?.enrichCandidateWithHolderLive === "function") {
        await this.candidateService.enrichCandidateWithHolderLive(analyzed);
      }
    }

    if (typeof this.enrichCandidateForCopytrade === "function") {
      try {
        analyzed = await this.enrichCandidateForCopytrade(analyzed);
      } catch (error) {
        this.logger.log?.("scan payload copytrade enrichment skipped:", error?.message || String(error));
      }
    }

    if (!plans.length && typeof this.candidateService?.buildPlans === "function") {
      plans = this.candidateService.buildPlans(
        analyzed,
        this.runtime?.activeConfig?.strategyScope || "all",
        this.runtime?.activeConfig || null
      );
    }

    return {
      token,
      analyzed,
      plans,
      heroImage
    };
  }


  buildScanCaTeamIntelBlock(analysis = {}) {
    const dev = analysis?.dev || {};
    const hist = analysis?.devHistory || {};
    const groups = analysis?.groups || {};
    const crossProjects = analysis?.crossProjects || {};
    const whaleBuys = analysis?.whaleBuys || {};
    const risk = analysis?.risk || {};
    const projects = Array.isArray(crossProjects?.projects) ? crossProjects.projects.slice(0, 4) : [];
    const whales = Array.isArray(whaleBuys?.rows) ? whaleBuys.rows.slice(0, 4) : [];

    const shortWallet = (value = "") => {
      const s = String(value || "");
      if (s.length <= 12) return escapeHtml(s || "-");
      return `${escapeHtml(s.slice(0, 4))}…${escapeHtml(s.slice(-4))}`;
    };

    const fmtPct = (value, d = 2) => `${safeNum(value, 0).toFixed(d)}%`;
    const fmtUsd = (value, d = 0) => `$${safeNum(value, 0).toFixed(d)}`;
    const fmtNum = (value, d = 2) => safeNum(value, 0).toFixed(d);

    const lines = [
      `🕵️ <b>Team / Insider / Sniper Intel — V13</b>`,
      `Risk — ${safeNum(risk?.score, 0) >= 70 ? "🚩" : safeNum(risk?.score, 0) >= 45 ? "🟡" : "✅"} ${escapeHtml(risk?.level || "LOW")} / ${safeNum(risk?.score, 0)}`,
      `Dev — ${dev?.devWallet ? `<code>${escapeHtml(dev.devWallet)}</code>` : "не определён"}`,
      `Dev launches — ${safeNum(hist?.launchesTotal, 0)} | dead/rug-like ${safeNum(hist?.scamLikeCount, 0)} | live/success ${safeNum(hist?.successfulLikeCount, 0)} | source ${escapeHtml(hist?.source || "unavailable")}`,
      `Snipers 1м / 5м / 15м — ${safeNum(groups?.snipers1m?.count, 0)} / ${safeNum(groups?.snipers5m?.count, 0)} / ${safeNum(groups?.snipers15m?.count, 0)} wallets`,
      `Team/insider wallets — ${safeNum(groups?.team?.count, 0)} | держат ${fmtPct(groups?.team?.pct, 2)} | dev держит ${fmtPct(groups?.dev?.pct, 2)}`,
      ``,
      `🧩 <b>Cross-project wallet overlap</b>`,
      `Проверено — ${safeNum(crossProjects?.checkedWallets, 0)} wallets | с другими токенами — ${safeNum(crossProjects?.walletsWithOtherTokens, 0)} | clusters ${safeNum(crossProjects?.clusteredProjectCount, 0)} | filtered ${safeNum(crossProjects?.skippedCommonProjectCount, 0)} | risk ${escapeHtml(crossProjects?.riskLevel || "LOW")}/${safeNum(crossProjects?.riskScore, 0)}`
    ];

    if (projects.length) {
      for (const project of projects) {
        lines.push(`• ${escapeHtml(project?.name || project?.symbol || "UNKNOWN")} ${project?.symbol ? `($${escapeHtml(project.symbol)})` : ""} — ${safeNum(project?.walletCount, 0)} wallets`);
        lines.push(`  CA: <code>${escapeHtml(project?.ca || "")}</code> | liq ${fmtUsd(project?.liquidityUsd, 0)} | FDV ${fmtUsd(project?.fdv || project?.marketCap, 0)}`);
      }
    } else {
      lines.push(`• явного скопления одних и тех же кошельков в других проектах пока нет`);
    }

    lines.push(``);
    lines.push(`🐋 <b>Whale buys</b>`);
    lines.push(`Whale signal — ${escapeHtml(whaleBuys?.signal || "LOW")} | holders ${safeNum(whaleBuys?.holderWhaleCount ?? whaleBuys?.whaleCount, 0)} | buyers ${safeNum(whaleBuys?.buyWhaleCount, 0)} | holding ${safeNum(whaleBuys?.holdingWhaleCount, 0)} | reducing ${safeNum(whaleBuys?.dumpingWhaleCount, 0)}`);
    lines.push(`Сейчас держат — ${fmtNum(whaleBuys?.totalCurrentAmount, 2)} tokens / ${fmtPct(whaleBuys?.totalCurrentPct, 2)} | ${fmtUsd(whaleBuys?.currentUsd, 0)}`);
    lines.push(`Суммарно куплено — ${fmtNum(whaleBuys?.totalBoughtAmount, 2)} tokens / ${fmtPct(whaleBuys?.totalBoughtPct, 2)} | ${fmtUsd(whaleBuys?.totalBoughtUsd, 0)}`);

    if (whales.length) {
      for (const row of whales) {
        const buyPart = row?.isBuyWhale
          ? `latest buy ${fmtPct(row?.latestBuyPct, 2)} | hold ${row?.holdingPct === null ? "n/a" : fmtPct(row?.holdingPct, 0)}`
          : `holder/transfer | bought ${fmtPct(row?.totalBoughtPct, 2)}`;
        lines.push(`• ${shortWallet(row?.owner)} — now ${fmtPct(row?.supplyPct, 2)} | ${buyPart}`);
      }
    } else {
      lines.push(`• крупных whale-buy признаков среди top holders пока нет`);
    }

    lines.push(``);
    lines.push(`⚠️ Cross-project overlap показывает текущие ненулевые SPL-балансы кошельков; USDC/USDT/wSOL/common assets отфильтрованы. Для полной истории нужен расширенный индексер.`);
    return lines.join("\n");
  }

  async buildScanCaTeamIntelText(payload = {}) {
    if (!payload?.token || !this.teamWalletIntelligence?.analyze) return "";
    try {
      const analysis = await this.teamWalletIntelligence.analyze({
        token: payload.token,
        candidate: payload.analyzed || { token: payload.token }
      });
      if (typeof this.teamWalletIntelligence.buildCompactReport === "function") {
        return this.teamWalletIntelligence.buildCompactReport(analysis);
      }
      return this.buildScanCaTeamIntelBlock(analysis);
    } catch (error) {
      this.logger.log?.("scan ca team intel append failed:", error?.message || String(error));
      return `🕵️ <b>Team / Insider / Sniper Intel — V13</b>\n⚠️ Team/whale intel unavailable: <code>${escapeHtml(String(error?.message || error).slice(0, 240))}</code>`;
    }
  }

  async buildTeamWalletIntelText(ca) {
    const payload = await this.buildScanCaPayload(ca);
    if (!payload?.token) {
      return `❌ <b>Team wallet scan</b>

No Solana pair found for:
<code>${escapeHtml(ca)}</code>`;
    }

    const analysis = await this.teamWalletIntelligence.analyze({
      token: payload.token,
      candidate: payload.analyzed || { token: payload.token }
    });

    return this.teamWalletIntelligence.buildReport(analysis);
  }

  async scanCA(ca, send) {
    const hero = await this.buildScanCaHero(ca);
    if (!hero) {
      await send.text(`❌ <b>CA scan</b>\n\nNo Solana pair found for:\n<code>${escapeHtml(ca)}</code>`);
      return null;
    }

    if (hero.heroImage && hero.caption && typeof send.photoOrText === "function") {
      await send.photoOrText(hero.heroImage, hero.caption);
    } else if (hero.caption && typeof send.text === "function") {
      await send.text(hero.caption);
    }

    if (hero.analysis && typeof send.text === "function") {
      await send.text(hero.analysis);
    }

    return hero;
  }

  async buildScanCaText(ca) {
    const payload = await this.buildScanCaPayload(ca);
    if (!payload?.token) {
      return `❌ <b>CA scan</b>

No Solana pair found for:
<code>${escapeHtml(ca)}</code>`;
    }

    const baseReport = this.candidateService.buildAnalysisText(payload.analyzed, payload.plans);
    const teamIntel = await this.buildScanCaTeamIntelText(payload);
    return teamIntel ? `${baseReport}\n\n${teamIntel}` : baseReport;
  }

  async buildScanCaHero(ca) {
    const payload = await this.buildScanCaPayload(ca);
    if (!payload?.token) return null;

    const baseAnalysis = this.candidateService.buildAnalysisText(payload.analyzed, payload.plans);
    const teamIntel = await this.buildScanCaTeamIntelText(payload);

    return {
      heroImage: payload.heroImage || this.candidateService.getHeroImage?.(payload.analyzed) || payload.token?.imageUrl || null,
      caption: this.candidateService.buildHeroCaption(payload.analyzed),
      analysis: teamIntel ? `${baseAnalysis}\n\n${teamIntel}` : baseAnalysis
    };
  }

  async scanMarketOnce(send) {
    const result = await this.candidateService.findBestCandidate({
      runtime: this.runtime,
      openPositions: getPositions(),
      recentlyTraded: [...this.recentlyTraded.keys()]
    });

    if (!result) {
      await send.text(this.buildNoCandidateNotice());
      return;
    }

    const enrichedCandidate = await this.enrichCandidateForCopytrade(result.candidate);

    await send.photoOrText(
      result.heroImage,
      this.candidateService.buildHeroCaption(enrichedCandidate)
    );

    await send.text(
      this.candidateService.buildAnalysisText(enrichedCandidate, result.plans)
    );
  }

  buildPendingIntentText(limit = 10) {
    return this.buildGMGNOrdersText(limit);
  }

  async markIntentSigned() {
    return null;
  }

  async markIntentSubmitted() {
    return null;
  }

  async markIntentConfirmed() {
    return null;
  }

  async markIntentFailed() {
    return null;
  }
}
