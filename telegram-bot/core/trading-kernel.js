import {
  getBestTrade,
  getLatestTokenPrice,
  recordTradeOutcomeFromSignalContext,
  analyzeToken
} from "../scan-engine.js";

import {
  getPortfolio,
  getPositions,
  getStrategyConfig,
  resetPortfolio,
  openPosition,
  closePosition,
  markPosition,
  maybeTakeRunnerPartial,
  setStrategyConfig,
  getClosedTrades
} from "../portfolio.js";

import { buildStrategyPlans } from "../strategy-engine.js";
import {
  buildDashboard,
  buildBalanceText,
  buildEntryText,
  buildExitText,
  buildPositionUpdateText,
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

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildLinksText(links = {}) {
  const rows = [];
  if (links.website) rows.push(`🌐 <a href="${escapeHtml(links.website)}">Website</a>`);
  if (links.twitter) rows.push(`🐦 <a href="${escapeHtml(links.twitter)}">Twitter/X</a>`);
  if (links.telegram) rows.push(`✈️ <a href="${escapeHtml(links.telegram)}">Telegram</a>`);
  if (links.instagram) rows.push(`📸 <a href="${escapeHtml(links.instagram)}">Instagram</a>`);
  if (links.facebook) rows.push(`📘 <a href="${escapeHtml(links.facebook)}">Facebook</a>`);
  return rows.length ? rows.join(" | ") : "none";
}

function buildDexText(token) {
  const rows = [];
  if (token?.url) rows.push(`📊 <a href="${escapeHtml(token.url)}">DexScreener</a>`);
  if (token?.chainId) rows.push(`Chain: ${escapeHtml(token.chainId)}`);
  if (token?.dexId) rows.push(`DEX: ${escapeHtml(token.dexId)}`);
  return rows.join(" | ") || "n/a";
}

function buildHeroCaption(analyzed) {
  const tkn = analyzed.token || {};
  const links = analyzed.socials?.links || {};
  return `🧾 <b>Scanning CA</b>

<b>${escapeHtml(tkn.name || "Unknown")}</b>
<code>${escapeHtml(tkn.ca || "")}</code>

<b>Links:</b> ${buildLinksText(links)}
<b>Dex:</b> ${buildDexText(tkn)}`.slice(0, 1024);
}

function buildAnalysisText(analyzed, plans) {
  const tkn = analyzed.token || {};
  const reasons = (analyzed.reasons || [])
    .slice(0, 14)
    .map((r) => `• ${escapeHtml(r)}`)
    .join("\n");

  const plansText = plans.length
    ? plans
        .map(
          (p) =>
            `• <b>${escapeHtml(p.strategyKey.toUpperCase())}</b> | edge ${round(
              p.expectedEdgePct,
              2
            )}% | hold ${Math.round(p.plannedHoldMs / 60000)}m | SL ${p.stopLossPct}% | TP ${
              p.takeProfitPct || "runner"
            }`
        )
        .join("\n")
    : "• none";

  return `🔎 <b>ANALYSIS</b>

<b>Token:</b> ${escapeHtml(tkn.name || "Unknown")}
<b>Symbol:</b> ${escapeHtml(tkn.symbol || "")}
<b>CA:</b> <code>${escapeHtml(tkn.ca || "")}</code>

<b>Dex:</b> ${buildDexText(tkn)}
<b>DEX Paid:</b> ${escapeHtml(analyzed.dexPaid?.status || "Unknown")}
<b>Token Type:</b> ${escapeHtml(analyzed.mechanics?.tokenType || "Unknown")}
<b>Reward Model:</b> ${escapeHtml(analyzed.mechanics?.rewardModel || "Unknown")}
<b>Beneficiary Signal:</b> ${escapeHtml(analyzed.mechanics?.beneficiarySignal || "Unknown")}
<b>Claim Signal:</b> ${escapeHtml(analyzed.mechanics?.claimSignal || "Unknown")}

<b>Price:</b> ${escapeHtml(tkn.price)}
<b>Liquidity:</b> ${escapeHtml(tkn.liquidity)}
<b>Volume 24h:</b> ${escapeHtml(tkn.volume)}
<b>Txns 24h:</b> ${escapeHtml(tkn.txns)}
<b>FDV:</b> ${escapeHtml(tkn.fdv)}

<b>Narrative:</b> ${escapeHtml(analyzed.narrative?.verdict || "Unknown")}
<b>Links:</b> ${buildLinksText(analyzed.socials?.links || {})}

<b>Available plans</b>
${plansText}

<b>Reasons:</b>
${reasons || "• none"}`;
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
    const closed = await this.forceCloseAllPositions("KILL_SWITCH");
    await this.applyPendingIfPossible();
    finishRuntime(this.runtime);
    await this.persistSnapshot();
    return closed;
  }

  async forceCloseAllPositions(reason = "KILL_SWITCH") {
    const closed = [];
    for (const p of [...getPositions()]) {
      const price = p.lastPrice || p.entryReferencePrice;
      const row = closePosition(p.id, price, reason);
      if (row) {
        this.recentlyTraded.set(row.ca, Date.now());
        await recordTradeOutcomeFromSignalContext(row.signalContext, row.netPnlPct);
        closed.push(row);
      }
    }
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

  shouldClosePosition(position, analyzedNow) {
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
      const pullbackFromHighPct =
        position.highestPrice > 0
          ? ((position.highestPrice - mark.currentPrice) / position.highestPrice) * 100
          : 0;
      if (mark.grossPnlPct > 25 && pullbackFromHighPct > 12) {
        return { close: true, reason: "RUNNER_TRAIL_EXIT" };
      }
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

  async syncLeaderScores() {
    const leaders = this.copytradeManager.listLeaders(this.runtime.activeConfig);
    if (!leaders.length) return [];
    const intel = await this.gmgnLeaderIntel.refreshMany(leaders.map((x) => x.address));
    for (const row of intel) {
      this.copytradeManager.setLeaderScore(this.runtime.activeConfig, row.address, row.score);
    }
    this.copytradeManager.refreshLeaderStates(this.runtime.activeConfig);
    await this.persistSnapshot();
    return intel;
  }

  async tick(send) {
    this.runtime.cycleCount += 1;
    this.runtime.lastCycleAt = Date.now();
    this.pruneRecentlyTraded();

    for (const p of getPositions()) {
      const latest = await getLatestTokenPrice(p.ca);
      if (!latest?.price) continue;

      const mark = markPosition(p, latest.price);
      if (!mark) continue;

      const partial = maybeTakeRunnerPartial(p, latest.price);
      if (partial) {
        await send.text(
          `🎯 <b>RUNNER PARTIAL</b>

<b>Token:</b> ${escapeHtml(p.token)}
<b>Target:</b> ${partial.targetPct}%
<b>Sold fraction:</b> ${round(partial.soldFraction * 100, 0)}%
<b>Cash added:</b> ${round(partial.netValueSol, 4)} SOL`
        );
      }

      const analyzedNow = await getBestTrade({ excludeCas: [] }).catch(() => null);
      const verdict = this.shouldClosePosition(
        p,
        analyzedNow?.token?.ca === p.ca ? analyzedNow : null
      );

      await send.text(buildPositionUpdateText(p, mark, verdict.reason));

      if (verdict.close) {
        const closed = closePosition(p.id, latest.price, verdict.reason);
        if (closed) {
          this.recentlyTraded.set(closed.ca, Date.now());
          await recordTradeOutcomeFromSignalContext(closed.signalContext, closed.netPnlPct);
          await send.photoOrText(closed.signalContext?.imageUrl || null, buildExitText(closed));
        }
      }
    }

    if (this.runtime.stopRequested && getPositions().length === 0) {
      await this.applyPendingIfPossible();
      finishRuntime(this.runtime);
      await this.persistSnapshot();
      await send.text("✅ Stop completed. No open positions left.");
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
        await send.text(report);
      }
      return;
    }

    const candidate = await getBestTrade({
      excludeCas: [...this.recentlyTraded.keys(), ...getPositions().map((p) => p.ca)]
    });

    if (!candidate) {
      await send.text("❌ No candidates found");
      return;
    }

    const allPlans = buildStrategyPlans(candidate);
    const plans = allPlans.filter((plan) => isStrategyAllowed(this.runtime, plan.strategyKey));

    const heroImage =
      candidate.token.headerUrl ||
      candidate.token.imageUrl ||
      candidate.token.iconUrl ||
      null;

    await send.photoOrText(heroImage, buildHeroCaption(candidate));
    await send.text(buildAnalysisText(candidate, plans));

    for (const plan of plans) {
      const alreadyOpenSameStrategy = getPositions().some((p) => p.strategy === plan.strategyKey);
      if (alreadyOpenSameStrategy) continue;
      if (candidate.corpse.isCorpse) continue;
      if (candidate.falseBounce.rejected) continue;
      if (candidate.developer.verdict === "Bad") continue;
      if (candidate.score < 85 && plan.strategyKey !== "copytrade") continue;

      if (plan.strategyKey === "copytrade") {
        const leaderEval = this.copytradeManager.pickBestLeader(this.runtime.activeConfig);
        if (!leaderEval) continue;
        if (!this.copytradeManager.isLeaderTradable(this.runtime.activeConfig, leaderEval.address)) continue;
      }

      const walletId = this.walletRouter.getPrimaryWalletId(this.runtime.activeConfig, plan.strategyKey);
      const walletCheck = this.walletRouter.validateWalletForStrategy(
        this.runtime.activeConfig,
        walletId,
        plan.strategyKey
      );
      if (!walletCheck.ok) continue;

      const position = openPosition({
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

      if (position) {
        await send.photoOrText(heroImage, buildEntryText(position));
      }
    }

    const portfolio = getPortfolio();
    const shouldReport =
      !this.runtime.lastStatusAt || Date.now() - this.runtime.lastStatusAt >= 15 * 60 * 1000;

    if (shouldReport) {
      this.runtime.lastStatusAt = Date.now();
      const report = buildPeriodicReport(this.runtime, portfolio, this.previousReportEquity);
      this.previousReportEquity = portfolio.equity;
      await send.text(report);
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
    const leaders = this.copytradeManager.listLeaders(this.runtime.activeConfig);
    const lines = ["📋 <b>Copytrade</b>", ""];
    lines.push(`enabled: ${this.runtime.activeConfig.copytrade.enabled ? "yes" : "no"}`);
    lines.push(`rescoring: ${this.runtime.activeConfig.copytrade.rescoringEnabled ? "yes" : "no"}`);
    lines.push(`min score: ${this.runtime.activeConfig.copytrade.minLeaderScore}`);
    lines.push(`cooldown min: ${this.runtime.activeConfig.copytrade.cooldownMinutes}`);
    lines.push("");

    if (!leaders.length) {
      lines.push("leaders: none");
    } else {
      for (const leader of leaders) {
        lines.push(
          `• <b>${escapeHtml(leader.address)}</b>
state: ${escapeHtml(leader.state)}
score: ${safeNum(leader.score)}
source: ${escapeHtml(leader.source || "manual")}
last sync: ${escapeHtml(leader.lastSyncAt || "-")}`
        );
        lines.push("");
      }
    }

    lines.push(`<code>/addleader</code>`);
    return lines.join("\n");
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
    const h = this.gmgnLeaderIntel.getHealth();
    return `🛰 <b>GMGN Status</b>

enabled: ${h.enabled ? "yes" : "no"}
mode: ${escapeHtml(h.mode)}
auto refresh sec: ${h.autoRefreshSec}
min recent winrate: ${h.minRecentWinrate}
min recent pnl pct: ${h.minRecentPnlPct}
max drawdown pct: ${h.maxDrawdownPct}
cooldown min: ${h.cooldownMin}
cached leaders: ${h.cachedLeaders}`;
  }

  async buildLeaderHealthText() {
    const leaders = this.copytradeManager.listLeaders(this.runtime.activeConfig);
    if (!leaders.length) {
      return `🫀 <b>Leader Health</b>

leaders: none`;
    }

    const intel = await this.gmgnLeaderIntel.refreshMany(leaders.map((x) => x.address));
    const lines = ["🫀 <b>Leader Health</b>", ""];
    for (const row of intel) {
      lines.push(
        `• <b>${escapeHtml(row.address)}</b>
state: ${escapeHtml(row.state)}
score: ${safeNum(row.score)}
recent winrate: ${safeNum(row.recentWinrate)}%
recent pnl: ${safeNum(row.recentPnlPct)}%
max drawdown: ${safeNum(row.maxDrawdownPct)}%
source: ${escapeHtml(row.source)}
last sync: ${escapeHtml(row.lastSyncAt)}`
      );
      lines.push("");
    }
    return lines.join("\n");
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
    const DEX_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";
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
    const token = await this.fetchTokenByCA(ca);
    if (!token) {
      await send.text("❌ Token not found by CA.");
      return;
    }

    const analyzed = await analyzeToken(token);
    const plans = buildStrategyPlans(analyzed).filter((plan) =>
      isStrategyAllowed(this.runtime, plan.strategyKey)
    );
    const heroImage =
      analyzed.token.headerUrl ||
      analyzed.token.imageUrl ||
      analyzed.token.iconUrl ||
      null;

    await send.photoOrText(heroImage, buildHeroCaption(analyzed));
    await send.text(buildAnalysisText(analyzed, plans));
  }
}
