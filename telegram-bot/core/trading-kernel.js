import {
  getPortfolio,
  getPositions,
  getStrategyConfig,
  resetPortfolio,
  setStrategyConfig,
  getClosedTrades
} from "../portfolio.js";

import {
  buildDashboard,
  buildBalanceText,
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

import WalletOrchestrator from "../wallets/wallet-orchestrator.js";
import ManualApprovalBridge from "../wallets/manual-approval-bridge.js";
import JupiterQuoteService from "../jupiter/jupiter-quote-service.js";
import TxLifecycleStore from "./tx-lifecycle-store.js";

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

export default class TradingKernel {
  constructor({
    walletRouter,
    copytradeManager,
    gmgnLeaderIntel,
    persistence,
    txStore,
    jupiterQuoteService,
    manualApprovalBridge,
    initialConfig,
    logger = console
  }) {
    this.logger = logger;
    this.walletRouter = walletRouter;
    this.copytradeManager = copytradeManager;
    this.gmgnLeaderIntel = gmgnLeaderIntel;
    this.persistence = persistence || null;

    this.startBalanceSol = safeNum(initialConfig?.startBalanceSol, 10);

    this.runtime = createTradingRuntime(
      buildDefaultRuntimeConfig(
        initialConfig || {
          language: "ru",
          dryRun: true,
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

    this.txStore =
      txStore ||
      new TxLifecycleStore({
        logger: this.logger
      });

    this.jupiterQuoteService =
      jupiterQuoteService ||
      new JupiterQuoteService({
        logger: this.logger
      });

    this.manualApprovalBridge =
      manualApprovalBridge ||
      new ManualApprovalBridge({
        logger: this.logger,
        txStore: this.txStore,
        jupiterQuoteService: this.jupiterQuoteService
      });

    this.walletOrchestrator = new WalletOrchestrator({
      walletRouter: this.walletRouter,
      manualApprovalBridge: this.manualApprovalBridge,
      logger: this.logger
    });

    this.candidateService = new CandidateService({
      logger: this.logger
    });

    this.positionService = new PositionService({
      logger: this.logger,
      walletOrchestrator: this.walletOrchestrator
    });

    this.copytradeService = new CopytradeService({
      copytradeManager: this.copytradeManager,
      gmgnLeaderIntel: this.gmgnLeaderIntel,
      logger: this.logger
    });

    this.recentlyTraded = new Map();
    this.previousReportEquity = null;
  }

  async initialize() {
    await this.txStore.load();
    await this.restoreIfAvailable();
    return true;
  }

  async restoreIfAvailable() {
    if (!this.persistence) return false;

    const runtimeSnapshot = await this.persistence.loadRuntimeSnapshot();
    if (!runtimeSnapshot) return false;

    if (runtimeSnapshot?.runtime?.activeConfig) {
      this.runtime.activeConfig = runtimeSnapshot.runtime.activeConfig;
      this.runtime.pendingConfig = runtimeSnapshot.runtime.pendingConfig || null;
      this.runtime.pendingReason = runtimeSnapshot.runtime.pendingReason || null;
      this.runtime.pendingQueuedAt = runtimeSnapshot.runtime.pendingQueuedAt || null;
      this.runtime.mode = "stopped";
      this.runtime.strategyScope = "all";
      this.runtime.stopRequested = false;
      this.runtime.killRequested = false;
      this.startBalanceSol = safeNum(
        runtimeSnapshot.runtime.startBalanceSol,
        this.startBalanceSol
      );
      this.syncPortfolioStrategyBudget();
    }

    return true;
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

  getPendingTxIntents() {
    return this.txStore.listPendingIntents();
  }

  getTxIntent(intentId) {
    return this.txStore.getIntent(intentId);
  }

  async markIntentSigned(intentId, signedTxBase64 = null) {
    return this.manualApprovalBridge.markSigned(intentId, signedTxBase64);
  }

  async markIntentSubmitted(intentId, signature = null) {
    return this.manualApprovalBridge.markSubmitted(intentId, signature);
  }

  async markIntentConfirmed(intentId, signature = null) {
    return this.manualApprovalBridge.markConfirmed(intentId, signature);
  }

  async markIntentFailed(intentId, reason = "unknown") {
    return this.manualApprovalBridge.markFailed(intentId, reason);
  }

  setLanguage(lang) {
    this.runtime.activeConfig.language = lang === "en" ? "en" : "ru";
    this.persistSnapshot();
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
      }
    };
    setStrategyConfig(nextCfg);
  }

  start(strategyScope = "all", mode = "infinite", chatId = null, userId = null) {
    startRuntime(this.runtime, { mode, strategyScope, chatId, userId });
    this.previousReportEquity = null;
    this.syncPortfolioStrategyBudget();
    resetPortfolio(this.startBalanceSol, getStrategyConfig());
    this.persistSnapshot();
    return this.runtime;
  }

  requestSoftStop() {
    requestStop(this.runtime);
    this.persistSnapshot();
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

    this.persistSnapshot();

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
      await notificationService.sendText(
        "✅ Stop completed. No open positions left."
      );
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
          this.previousReportEquity
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
      await notificationService.sendText("❌ No candidates found");
      await this.persistSnapshot();
      return;
    }

    let { candidate, plans, heroImage } = result;
    candidate = await this.enrichCandidateForCopytrade(candidate);

    await notificationService.sendPhotoOrText(
      heroImage,
      this.candidateService.buildHeroCaption(candidate)
    );

    await notificationService.sendText(
      this.candidateService.buildAnalysisText(candidate, plans)
    );

    for (const rawPlan of plans) {
      const alreadyOpenSameStrategy = getPositions().some(
        (p) => p.strategy === rawPlan.strategyKey
      );
      if (alreadyOpenSameStrategy) continue;
      if (candidate.corpse?.isCorpse && rawPlan.strategyKey !== "copytrade") continue;
      if (candidate.falseBounce?.rejected && rawPlan.strategyKey !== "copytrade") continue;
      if (candidate.developer?.verdict === "Bad" && rawPlan.strategyKey !== "copytrade") continue;
      if (candidate.score < 85 && rawPlan.strategyKey !== "copytrade") continue;

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

          await notificationService.sendText(
            `🚫 <b>COPYTRADE REJECTED</b>

<b>Leader:</b> ${escapeHtml(copyVerdict.leader?.address || "-")}
<b>Reason:</b> ${escapeHtml(copyVerdict.reason || "COPY_REJECT")}
<b>Details:</b>
${(copyVerdict.reasons || []).map((x) => `• ${escapeHtml(x)}`).join("\n") || "• rejected"}`
          );
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

        if (copyVerdict.mode === "probe_only") {
          await notificationService.sendText(
            `⚠️ <b>COPYTRADE PROBE MODE</b>

<b>Leader:</b> ${escapeHtml(copyVerdict.leader?.address || "-")}
<b>Reason:</b> ${escapeHtml(copyVerdict.reason || "COPY_BORDERLINE")}
<b>Details:</b>
${(copyVerdict.reasons || []).map((x) => `• ${escapeHtml(x)}`).join("\n") || "• probe"}`
          );
        }
      }

      const walletId = this.walletOrchestrator.getPrimaryWalletId(
        this.runtime.activeConfig,
        plan.strategyKey
      );

      const walletCheck = this.walletOrchestrator.validateForStrategy(
        this.runtime.activeConfig,
        walletId,
        plan.strategyKey
      );

      if (!walletCheck.ok) continue;

      const position = await this.positionService.orchestrateAndOpen(
        this.runtime.activeConfig,
        {
          plan,
          candidate,
          heroImage,
          walletId
        }
      );

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
        this.previousReportEquity
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
pending intents: ${this.txStore.listPendingIntents().length}`;
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
pending intents: ${this.txStore.listPendingIntents().length}`;
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

  buildStatusText() {
    const base = buildDashboard(this.runtime, getPortfolio());
    return `${base}

${this.buildCopytradeStatusSummary()}

${this.buildExecutionModelSummary()}`;
  }

  buildBalanceText() {
    return buildBalanceText(getPortfolio());
  }

  buildWalletsText() {
    const lines = ["👛 <b>Wallets</b>", ""];

    for (const [walletId, w] of Object.entries(
      this.runtime.activeConfig.wallets || {}
    )) {
      const validation = this.walletRouter.validateWalletForAnyUse(
        this.runtime.activeConfig,
        walletId
      );

      lines.push(
        `• <b>${escapeHtml(walletId)}</b>
label: ${escapeHtml(w.label || "-")}
role: ${escapeHtml(w.role || "-")}
enabled: ${w.enabled ? "yes" : "no"}
mode: ${escapeHtml(w.executionMode || "dry_run")}
publicKey: ${escapeHtml(w.publicKey || w.address || "-")}
strategies: ${escapeHtml((w.allowedStrategies || []).join(", ") || "-")}
secretRef: ${escapeHtml(w.secretRef || "-")}
ready: ${validation.ok ? "yes" : "no"} (${escapeHtml(validation.reason || "ok")})`
      );

      lines.push("");
    }

    lines.push(`<code>/setsecret</code>`);
    return lines.join("\n");
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

Send: <code>budget 25 25 25 25</code>`;
  }

  buildGmgnStatusText() {
    return this.copytradeService.buildGmgnStatusText();
  }

  async buildLeaderHealthText() {
    return this.copytradeService.buildLeaderHealthText(
      this.runtime.activeConfig
    );
  }

  buildPendingIntentText(limit = 10) {
    const intents = this.txStore.listPendingIntents().slice(0, limit);

    if (!intents.length) {
      return `🧾 <b>Pending Intents</b>

none`;
    }

    const lines = ["🧾 <b>Pending Intents</b>", ""];

    for (const row of intents) {
      lines.push(
        `• <b>${escapeHtml(row.intentId)}</b>
status: ${escapeHtml(row.status || "-")}
wallet: ${escapeHtml(row.walletId || "-")}
strategy: ${escapeHtml(row.strategy || "-")}
side: ${escapeHtml(row.side || "-")}
token: ${escapeHtml(row.token?.name || row.token?.ca || "-")}
publicKey: ${escapeHtml(row.publicKey || "-")}
createdAt: ${escapeHtml(row.createdAt || "-")}`
      );
      lines.push("");
    }

    return lines.join("\n");
  }

  addLeader(address) {
    const row = this.copytradeManager.addLeader(
      this.runtime.activeConfig,
      address,
      "manual"
    );
    this.persistSnapshot();
    return row;
  }

  setWalletSecretRef(walletId, secretRef) {
    if (!this.runtime.activeConfig.wallets[walletId]) return false;
    this.runtime.activeConfig.wallets[walletId].secretRef = secretRef;
    this.persistSnapshot();
    return true;
  }

  async fetchTokenByCA(ca) {
    const DEX_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";
    const res = await fetch(`${DEX_TOKEN_API}/${encodeURIComponent(ca)}`);
    if (!res.ok) {
      throw new Error(`DexScreener HTTP ${res.status}`);
    }

    const json = await res.json();
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    if (!pairs.length) return null;

    const bestRaw = pairs.sort(
      (a, b) =>
        safeNum(b?.liquidity?.usd) - safeNum(a?.liquidity?.usd) ||
        safeNum(b?.volume?.h24) - safeNum(a?.volume?.h24)
    )[0];

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
      description:
        bestRaw?.info?.description || bestRaw?.info?.header || "",
      links
    };
  }

  async scanCA(ca, send) {
    await send.text(`🧾 <b>Scanning CA</b>\n<code>${escapeHtml(ca)}</code>`);

    const result = await this.candidateService.scanCA({
      runtime: this.runtime,
      fetchTokenByCA: (value) => this.fetchTokenByCA(value),
      ca
    });

    if (!result) {
      await send.text("❌ Token not found by CA.");
      return;
    }

    const enrichedAnalyzed = await this.enrichCandidateForCopytrade(result.analyzed);

    await send.photoOrText(
      result.heroImage,
      this.candidateService.buildHeroCaption(enrichedAnalyzed)
    );

    await send.text(
      this.candidateService.buildAnalysisText(enrichedAnalyzed, result.plans)
    );
  }
}
