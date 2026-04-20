import {
  getLatestTokenPrice,
  recordTradeOutcomeFromSignalContext,
  analyzeToken
} from "../scan-engine.js";

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
  isStrategyAllowed,
  canOpenNewPositions
} from "./trading-runtime.js";

import CandidateService from "./candidate-service.js";
import PositionService from "./position-service.js";
import CopytradeService from "./copytrade-service.js";
import NotificationService from "./notification-service.js";

const DEX_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";

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

export default class TradingKernel {
  constructor({
    walletRouter,
    copytradeManager,
    gmgnLeaderIntel,
    persistence,
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

    this.candidateService = new CandidateService({ logger: this.logger });
    this.positionService = new PositionService({ logger: this.logger });
    this.copytradeService = new CopytradeService({
      copytradeManager: this.copytradeManager,
      gmgnLeaderIntel: this.gmgnLeaderIntel,
      logger: this.logger
    });

    this.recentlyTraded = new Map();
    this.previousReportEquity = null;
  }

  async restoreIfAvailable() {
    if (!this.persistence) return false;
    const snapshot = await this.persistence.loadSnapshot();
    if (!snapshot) return false;

    if (snapshot?.runtime?.activeConfig) {
      this.runtime.activeConfig = snapshot.runtime.activeConfig;
      this.runtime.pendingConfig = snapshot.runtime.pendingConfig || null;
      this.runtime.pendingReason = snapshot.runtime.pendingReason || null;
      this.runtime.pendingQueuedAt = snapshot.runtime.pendingQueuedAt || null;
      this.runtime.mode = "stopped";
      this.runtime.strategyScope = "all";
      this.runtime.stopRequested = false;
      this.runtime.killRequested = false;
      this.startBalanceSol = safeNum(snapshot.runtime.startBalanceSol, this.startBalanceSol);
      this.syncPortfolioStrategyBudget();
    }

    return true;
  }

  async persistSnapshot() {
    if (!this.persistence) return false;
    return this.persistence.saveSnapshot({
      runtime: {
        activeConfig: this.runtime.activeConfig,
        pendingConfig: this.runtime.pendingConfig,
        pendingReason: this.runtime.pendingReason,
        pendingQueuedAt: this.runtime.pendingQueuedAt,
        startBalanceSol: this.startBalanceSol
      }
    });
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
    this.persistSnapshot();
    return this.runtime.activeConfig.language;
  }

  syncPortfolioStrategyBudget() {
    const cfg = getStrategyConfig();
    const nextCfg = {
      ...cfg,
      scalp: { ...(cfg.scalp || {}), allocationPct: this.runtime.activeConfig.strategyBudget.scalp },
      reversal: { ...(cfg.reversal || {}), allocationPct: this.runtime.activeConfig.strategyBudget.reversal },
      runner: { ...(cfg.runner || {}), allocationPct: this.runtime.activeConfig.strategyBudget.runner },
      copytrade: { ...(cfg.copytrade || {}), allocationPct: this.runtime.activeConfig.strategyBudget.copytrade }
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
    const closed = await this.positionService.forceCloseAll("KILL_SWITCH");
    for (const row of closed) {
      this.recentlyTraded.set(row.ca, Date.now());
      await recordTradeOutcomeFromSignalContext(row.signalContext, row.netPnlPct);
    }
    await this.applyPendingIfPossible();
    finishRuntime(this.runtime);
    await this.persistSnapshot();
    return closed;
  }

  queueBudgetUpdate(values) {
    const validated = validateBudgetPercents(values);
    if (!validated.ok) return validated;
    queuePendingConfig(this.runtime, { strategyBudget: validated.budget }, "budget_update");
    this.persistSnapshot();
    return { ok: true, budget: validated.budget };
  }

  async applyPendingIfPossible() {
    if (!canApplyPendingConfig(this.runtime, getPositions().length)) return false;
    applyPendingConfig(this.runtime);
    this.syncPortfolioStrategyBudget();
    await this.persistSnapshot();
    return true;
  }

  pruneRecentlyTraded() {
    const now = Date.now();
    for (const [ca, ts] of this.recentlyTraded.entries()) {
      if (now - ts > 2 * 60 * 60 * 1000) this.recentlyTraded.delete(ca);
    }
  }

  async syncLeaderScores() {
    const intel = await this.copytradeService.syncLeaderScores(this.runtime.activeConfig);
    await this.persistSnapshot();
    return intel;
  }

  async tick(sendBridge) {
    this.runtime.cycleCount += 1;
    this.runtime.lastCycleAt = Date.now();
    this.pruneRecentlyTraded();

    const notificationService = new NotificationService({ send: sendBridge });

    await this.positionService.updateOpenPositions({
      notificationService,
      recentlyTraded: this.recentlyTraded,
      candidateProbeFn: async (ca) => {
        const probe = await this.candidateService.findBestCandidate({
          runtime: this.runtime,
          openPositions: [],
          recentlyTraded: []
        }).catch(() => null);

        return probe?.candidate?.token?.ca === ca ? probe.candidate : null;
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
        !this.runtime.lastStatusAt || Date.now() - this.runtime.lastStatusAt >= 15 * 60 * 1000;

      if (shouldReport) {
        this.runtime.lastStatusAt = Date.now();
        const report = buildPeriodicReport(this.runtime, portfolio, this.previousReportEquity);
        this.previousReportEquity = portfolio.equity;
        await notificationService.sendText(report);
      }
      return;
    }

    const result = await this.candidateService.findBestCandidate({
      runtime: this.runtime,
      openPositions: getPositions(),
      recentlyTraded: [...this.recentlyTraded.keys()]
    });

    if (!result) {
      await notificationService.sendText("❌ No candidates found");
      return;
    }

    const { candidate, plans, heroImage } = result;

    await notificationService.sendPhotoOrText(
      heroImage,
      this.candidateService.buildHeroCaption(candidate)
    );
    await notificationService.sendText(
      this.candidateService.buildAnalysisText(candidate, plans)
    );

    for (const plan of plans) {
      const alreadyOpenSameStrategy = getPositions().some((p) => p.strategy === plan.strategyKey);
      if (alreadyOpenSameStrategy) continue;
      if (candidate.corpse.isCorpse) continue;
      if (candidate.falseBounce.rejected) continue;
      if (candidate.developer.verdict === "Bad") continue;
      if (candidate.score < 85 && plan.strategyKey !== "copytrade") continue;

      if (plan.strategyKey === "copytrade") {
        if (!this.copytradeService.canTradeCopy(this.runtime.activeConfig)) continue;
      }

      const walletId = this.walletRouter.getPrimaryWalletId(this.runtime.activeConfig, plan.strategyKey);
      const walletCheck = this.walletRouter.validateWalletForStrategy(
        this.runtime.activeConfig,
        walletId,
        plan.strategyKey
      );
      if (!walletCheck.ok) continue;

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
      !this.runtime.lastStatusAt || Date.now() - this.runtime.lastStatusAt >= 15 * 60 * 1000;

    if (shouldReport) {
      this.runtime.lastStatusAt = Date.now();
      const report = buildPeriodicReport(this.runtime, portfolio, this.previousReportEquity);
      this.previousReportEquity = portfolio.equity;
      await notificationService.sendText(report);
    }
  }

  buildStatusText() {
    return buildDashboard(this.runtime, getPortfolio());
  }

  buildBalanceText() {
    return buildBalanceText(getPortfolio());
  }

  buildWalletsText() {
    const lines = ["👛 <b>Wallets</b>", ""];
    for (const [walletId, w] of Object.entries(this.runtime.activeConfig.wallets || {})) {
      const validation = this.walletRouter.validateWalletForAnyUse(this.runtime.activeConfig, walletId);
      lines.push(
        `• <b>${escapeHtml(walletId)}</b>
label: ${escapeHtml(w.label || "-")}
role: ${escapeHtml(w.role || "-")}
enabled: ${w.enabled ? "yes" : "no"}
mode: ${escapeHtml(w.executionMode || "dry_run")}
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
    const current = this.runtime.activeConfig.strategyBudget || DEFAULT_STRATEGY_BUDGET;
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
    return this.copytradeService.buildLeaderHealthText(this.runtime.activeConfig);
  }

  addLeader(address) {
    const row = this.copytradeManager.addLeader(this.runtime.activeConfig, address, "manual");
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
    const res = await fetch(`${DEX_TOKEN_API}/${encodeURIComponent(ca)}`);
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);

    const json = await res.json();
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    if (!pairs.length) return null;

    const bestRaw = pairs.sort(
      (a, b) =>
        safeNum(b?.liquidity?.usd) - safeNum(a?.liquidity?.usd) ||
        safeNum(b?.volume?.h24) - safeNum(a?.volume?.h24)
    )[0];

    const socials = Array.isArray(bestRaw?.info?.socials) ? bestRaw.info.socials : [];
    const websites = Array.isArray(bestRaw?.info?.websites) ? bestRaw.info.websites : [];

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
      txns: safeNum(bestRaw?.txns?.h24?.buys) + safeNum(bestRaw?.txns?.h24?.sells),
      fdv: safeNum(bestRaw?.fdv),
      pairCreatedAt: safeNum(bestRaw?.pairCreatedAt),
      url: bestRaw?.url || "",
      imageUrl: bestRaw?.info?.imageUrl || null,
      description: bestRaw?.info?.description || bestRaw?.info?.header || "",
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

    await send.photoOrText(
      result.heroImage,
      this.candidateService.buildHeroCaption(result.analyzed)
    );
    await send.text(
      this.candidateService.buildAnalysisText(result.analyzed, result.plans)
    );
  }
}
