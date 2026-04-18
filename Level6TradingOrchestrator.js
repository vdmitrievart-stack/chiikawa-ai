import Level6DecisionEngine from "./Level6DecisionEngine.js";
import Level6EntryEngine from "./Level6EntryEngine.js";
import Level6ExitEngine from "./Level6ExitEngine.js";
import Level6TradeJournal from "./Level6TradeJournal.js";
import Level6WalletScoringEngine from "./Level6WalletScoringEngine.js";
import Level6BubbleMapEngine from "./Level6BubbleMapEngine.js";
import Level6PositionRiskEngine from "./Level6PositionRiskEngine.js";
import Level6ExecutionGuard from "./Level6ExecutionGuard.js";
import Level6SafetyEngine from "./Level6SafetyEngine.js";
import Level6CandidateBuilder from "./Level6CandidateBuilder.js";

export default class Level6TradingOrchestrator {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir = options.baseDir;

    this.deps = {
      marketDataProvider: options.marketDataProvider || null,
      safetyDataProvider: options.safetyDataProvider || null,
      bubbleMapProvider: options.bubbleMapProvider || null,
      socialIntelProvider: options.socialIntelProvider || null,
      portfolioProvider: options.portfolioProvider || null,
      walletRegistryProvider: options.walletRegistryProvider || null,
      executionProvider: options.executionProvider || null
    };

    this.walletScoringEngine =
      options.walletScoringEngine ||
      new Level6WalletScoringEngine({
        logger: this.logger
      });

    this.safetyEngine =
      options.safetyEngine ||
      new Level6SafetyEngine({
        logger: this.logger,
        rugcheckClient: options.rugcheckClient,
        goplusClient: options.goplusClient
      });

    this.bubbleMapEngine =
      options.bubbleMapEngine ||
      new Level6BubbleMapEngine({
        logger: this.logger
      });

    this.positionRiskEngine =
      options.positionRiskEngine ||
      new Level6PositionRiskEngine({
        logger: this.logger,
        rules: options.positionRules || {}
      });

    this.executionGuard =
      options.executionGuard ||
      new Level6ExecutionGuard({
        logger: this.logger,
        botWallets: options.botWallets || [],
        rules: options.executionRules || {}
      });

    this.decisionEngine =
      options.decisionEngine ||
      new Level6DecisionEngine({
        logger: this.logger,
        safetyEngine: this.safetyEngine,
        bubbleMapEngine: this.bubbleMapEngine,
        positionRiskEngine: this.positionRiskEngine,
        rugcheckClient: options.rugcheckClient,
        goplusClient: options.goplusClient,
        weights: options.decisionWeights || {},
        thresholds: options.decisionThresholds || {},
        positionRules: options.positionRules || {}
      });

    this.entryEngine =
      options.entryEngine ||
      new Level6EntryEngine({
        logger: this.logger,
        decisionEngine: this.decisionEngine,
        rules: options.entryRules || {}
      });

    this.exitEngine =
      options.exitEngine ||
      new Level6ExitEngine({
        logger: this.logger,
        rules: options.exitRules || {}
      });

    this.tradeJournal =
      options.tradeJournal ||
      new Level6TradeJournal({
        logger: this.logger,
        baseDir: this.baseDir
      });

    this.candidateBuilder =
      options.candidateBuilder ||
      new Level6CandidateBuilder({
        logger: this.logger,
        marketDataProvider: options.marketDataProvider,
        safetyDataProvider: options.safetyDataProvider,
        bubbleMapProvider: options.bubbleMapProvider,
        socialIntelProvider: options.socialIntelProvider,
        portfolioProvider: options.portfolioProvider,
        walletRegistryProvider: options.walletRegistryProvider,
        executionProvider: options.executionProvider,
        defaultWalletId: options.defaultWalletId || "wallet_1"
      });

    this.config = {
      enabled:
        options.enabled !== undefined ? Boolean(options.enabled) : true,
      autoExecuteEntries:
        options.autoExecuteEntries !== undefined
          ? Boolean(options.autoExecuteEntries)
          : false,
      autoExecuteExits:
        options.autoExecuteExits !== undefined
          ? Boolean(options.autoExecuteExits)
          : false,
      dryRun:
        options.dryRun !== undefined ? Boolean(options.dryRun) : true,
      defaultWalletId: options.defaultWalletId || "wallet_1"
    };
  }

  async init() {
    const journal = await this.tradeJournal.init();

    return {
      ok: true,
      journal,
      config: { ...this.config }
    };
  }

  getStatus() {
    const trades = Array.isArray(this.tradeJournal?.state?.trades)
      ? this.tradeJournal.state.trades
      : [];
    const openTrades = trades.filter(t => !t.lifecycle?.closed);

    return {
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      autoEntries: this.config.autoExecuteEntries,
      autoExits: this.config.autoExecuteExits,
      openTrades: openTrades.length,
      journalTrades: trades.length
    };
  }

  setEnabled(value) {
    this.config.enabled = Boolean(value);
    return this.getStatus();
  }

  setDryRun(value) {
    this.config.dryRun = Boolean(value);
    return this.getStatus();
  }

  setAutoEntries(value) {
    this.config.autoExecuteEntries = Boolean(value);
    return this.getStatus();
  }

  setAutoExits(value) {
    this.config.autoExecuteExits = Boolean(value);
    return this.getStatus();
  }

  async summarizeJournal() {
    return this.tradeJournal.summarizePerformance();
  }

  async getOpenTrades() {
    return this.tradeJournal.getOpenTrades();
  }

  async getTradeById(tradeId) {
    return this.tradeJournal.getTradeById(tradeId);
  }

  async buildCandidate(input = {}) {
    return this.candidateBuilder.buildCandidate(input);
  }

  async evaluateTokenOpportunity(input = {}) {
    const candidate = await this.buildCandidate(input);
    const entryDecision = await this.entryEngine.evaluateEntry(candidate);

    return {
      ok: true,
      candidate,
      entryDecision
    };
  }

  async processTokenOpportunity(input = {}) {
    if (!this.config.enabled) {
      return {
        ok: true,
        action: "SKIP",
        reason: "level6_disabled"
      };
    }

    const candidate = await this.buildCandidate(input);
    const entryDecision = await this.entryEngine.evaluateEntry(candidate);

    if (!entryDecision.ok || entryDecision.action !== "ENTER") {
      return {
        ok: true,
        action: "SKIP",
        candidate,
        entryDecision,
        reason: entryDecision.reason || "entry_not_approved"
      };
    }

    const executionCheck = await this.validateEntryExecution(
      candidate,
      entryDecision
    );

    if (!executionCheck.ok) {
      return {
        ok: true,
        action: "SKIP",
        candidate,
        entryDecision,
        executionCheck,
        reason: "execution_guard_reject"
      };
    }

    const initialExitPlan = this.exitEngine.buildInitialExitPlan({
      entryMode: entryDecision.entryMode,
      entryPriceUsd: this.#num(candidate.token.tokenPriceUsd, 0),
      sizeTokenAmount: this.#num(entryDecision.sizedTokenAmount, 0)
    });

    const journalEntry = await this.tradeJournal.recordEntry({
      token: {
        ca: candidate.token.ca,
        symbol: candidate.token.symbol,
        name: candidate.token.name
      },
      walletId: candidate.execution.walletId,
      entryMode: entryDecision.entryMode,
      entryPriceUsd: this.#num(candidate.token.tokenPriceUsd, 0),
      entrySizeUsd: this.#num(entryDecision.sizedUsd, 0),
      entryTokenAmount: this.#num(entryDecision.sizedTokenAmount, 0),
      decision: entryDecision,
      exitPlan: initialExitPlan,
      snapshots: {
        token: candidate.token,
        walletIntel: candidate.walletIntel,
        volumeIntel: candidate.volumeIntel,
        socialIntel: candidate.socialIntel,
        bubbleMapIntel: candidate.bubbleMapIntel
      }
    });

    let executionResult = {
      ok: true,
      executed: false,
      dryRun: this.config.dryRun,
      mode: "entry"
    };

    if (this.config.autoExecuteEntries) {
      executionResult = await this.executeEntry(candidate, entryDecision, {
        tradeId: journalEntry.tradeId
      });
    }

    return {
      ok: true,
      action: "ENTER_APPROVED",
      tradeId: journalEntry.tradeId,
      candidate,
      entryDecision,
      executionCheck,
      initialExitPlan,
      executionResult
    };
  }

  async monitorOpenPositions(context = {}) {
    const openTrades = await this.tradeJournal.getOpenTrades();
    const results = [];

    for (const trade of openTrades) {
      try {
        const market = await this.buildExitMarketSnapshot(trade, context);
        const exitContext = await this.buildExitContext(trade, context);

        await this.tradeJournal.updateMarketSnapshot(trade.tradeId, {
          currentPriceUsd: market.currentPriceUsd
        });

        const exitDecision = this.exitEngine.evaluateExit(
          this.#buildPositionForExitEngine(trade),
          market,
          exitContext
        );

        let executionResult = {
          ok: true,
          executed: false,
          dryRun: this.config.dryRun,
          mode: "exit"
        };

        if (exitDecision.action !== "HOLD" && this.config.autoExecuteExits) {
          executionResult = await this.executeExit(trade, exitDecision);
        }

        if (
          executionResult.ok &&
          executionResult.executed &&
          executionResult.closedTrade
        ) {
          await this.tradeJournal.closeTrade(trade.tradeId, {
            reason: exitDecision.reason,
            action: exitDecision.action,
            exitPriceUsd: market.currentPriceUsd,
            exitTokenAmount:
              this.#num(trade.entryTokenAmount, 0) *
              this.#num(exitDecision.sellFraction, 1)
          });
        } else if (
          exitDecision.action === "TP1_EXIT" &&
          executionResult.ok &&
          executionResult.executed
        ) {
          await this.tradeJournal.markTpTaken(trade.tradeId, "TP1", {
            priceUsd: market.currentPriceUsd
          });
        } else if (
          exitDecision.action === "TP2_EXIT" &&
          executionResult.ok &&
          executionResult.executed
        ) {
          await this.tradeJournal.markTpTaken(trade.tradeId, "TP2", {
            priceUsd: market.currentPriceUsd
          });
        }

        results.push({
          tradeId: trade.tradeId,
          token: trade.token,
          exitDecision,
          executionResult
        });
      } catch (error) {
        this.logger.error(
          "Level6TradingOrchestrator monitorOpenPositions error:",
          error.message
        );

        results.push({
          tradeId: trade.tradeId,
          token: trade.token,
          ok: false,
          error: error.message
        });
      }
    }

    return {
      ok: true,
      openTrades: openTrades.length,
      results
    };
  }

  async validateEntryExecution(candidate, entryDecision) {
    const candidateExecution = candidate.execution || {};
    const candidatePortfolio = candidate.portfolio || {};
    const suggestedUsd = this.#num(entryDecision.sizedUsd, 0);
    const solPriceUsd = this.#num(
      this.executionGuard?.rules?.solPriceUsd,
      150
    );

    const plannedSpendSol =
      solPriceUsd > 0 ? suggestedUsd / solPriceUsd : 0;

    return this.executionGuard.validateExecution({
      walletAddress: candidateExecution.walletId,
      targetWallet: candidateExecution.targetWallet,
      walletBalanceSol: this.#num(
        candidateExecution.walletBalanceSol,
        candidatePortfolio.walletBalanceSol
      ),
      plannedSpendSol,
      isTransfer: candidateExecution.isTransfer
    });
  }

  async executeEntry(candidate, entryDecision, meta = {}) {
    if (this.config.dryRun || !this.deps.executionProvider?.executeEntry) {
      return {
        ok: true,
        executed: false,
        dryRun: true,
        mode: "entry",
        meta
      };
    }

    try {
      const result = await this.deps.executionProvider.executeEntry({
        candidate,
        entryDecision,
        meta
      });

      return {
        ok: true,
        executed: Boolean(result?.executed),
        dryRun: false,
        mode: "entry",
        result
      };
    } catch (error) {
      this.logger.error(
        "Level6TradingOrchestrator executeEntry error:",
        error.message
      );

      return {
        ok: false,
        executed: false,
        dryRun: false,
        mode: "entry",
        error: error.message
      };
    }
  }

  async executeExit(trade, exitDecision) {
    if (this.config.dryRun || !this.deps.executionProvider?.executeExit) {
      const closedTrade =
        exitDecision.action === "FULL_EXIT" ||
        exitDecision.action === "RUNNER_EXIT";

      return {
        ok: true,
        executed: false,
        dryRun: true,
        mode: "exit",
        closedTrade
      };
    }

    try {
      const result = await this.deps.executionProvider.executeExit({
        trade,
        exitDecision
      });

      const closedTrade =
        exitDecision.action === "FULL_EXIT" ||
        exitDecision.action === "RUNNER_EXIT";

      return {
        ok: true,
        executed: Boolean(result?.executed),
        dryRun: false,
        mode: "exit",
        closedTrade,
        result
      };
    } catch (error) {
      this.logger.error(
        "Level6TradingOrchestrator executeExit error:",
        error.message
      );

      return {
        ok: false,
        executed: false,
        dryRun: false,
        mode: "exit",
        error: error.message
      };
    }
  }

  async buildExitMarketSnapshot(trade, context = {}) {
    if (this.deps.marketDataProvider?.getExitMarketSnapshot) {
      return this.deps.marketDataProvider.getExitMarketSnapshot(trade, context);
    }

    return {
      currentPriceUsd: this.#num(
        context.currentPriceUsd,
        trade.performance?.currentPriceUsd || trade.entryPriceUsd
      ),
      buyPressure: this.#num(context.buyPressure, 0.5),
      sellPressure: this.#num(context.sellPressure, 0.5),
      dumpSpike: Boolean(context.dumpSpike)
    };
  }

  async buildExitContext(trade, context = {}) {
    if (this.deps.socialIntelProvider?.getExitContext) {
      return this.deps.socialIntelProvider.getExitContext(trade, context);
    }

    return {
      socialMomentum: this.#num(context.socialMomentum, 0.5),
      walletExitSignal: this.#num(context.walletExitSignal, 0),
      liquidityDropPct: this.#num(context.liquidityDropPct, 0),
      safetyDegraded: Boolean(context.safetyDegraded),
      bubbleRiskIncreased: Boolean(context.bubbleRiskIncreased)
    };
  }

  #buildPositionForExitEngine(trade) {
    const entryTokenAmount = this.#num(trade.entryTokenAmount, 0);
    const tp1Taken = Boolean(trade.lifecycle?.tp1Taken);
    const tp2Taken = Boolean(trade.lifecycle?.tp2Taken);

    let runnerRemainingFraction = 1;
    if (tp1Taken) runnerRemainingFraction -= 0.25;
    if (tp2Taken) runnerRemainingFraction -= 0.25;

    const createdAt = new Date(trade.createdAt).getTime();
    const ageMinutes = Number.isFinite(createdAt)
      ? (Date.now() - createdAt) / 60000
      : 0;

    return {
      tradeId: trade.tradeId,
      entryMode: trade.entryMode,
      entryPriceUsd: this.#num(trade.entryPriceUsd, 0),
      entryTokenAmount,
      peakPriceUsd: this.#num(
        trade.performance?.peakPriceUsd,
        trade.entryPriceUsd
      ),
      tp1Taken,
      tp2Taken,
      runnerRemainingFraction,
      ageMinutes
    };
  }

  #num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
}
