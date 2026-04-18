import Level6DecisionEngine from "./Level6DecisionEngine.js";
import Level6EntryEngine from "./Level6EntryEngine.js";
import Level6ExitEngine from "./Level6ExitEngine.js";
import Level6TradeJournal from "./Level6TradeJournal.js";
import Level6WalletScoringEngine from "./Level6WalletScoringEngine.js";
import Level6BubbleMapEngine from "./Level6BubbleMapEngine.js";
import Level6PositionRiskEngine from "./Level6PositionRiskEngine.js";
import Level6ExecutionGuard from "./Level6ExecutionGuard.js";
import Level6SafetyEngine from "./Level6SafetyEngine.js";

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
      executionProvider: options.executionProvider || null,
      candidateBuilder: options.candidateBuilder || null
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

    this.config = {
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
      defaultWalletId: options.defaultWalletId || null
    };
  }

  async init() {
    const result = await this.tradeJournal.init();

    return {
      ok: true,
      journal: result,
      config: this.config
    };
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

    const entryRecord = {
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
      },
      notes: [
        `timing_urgency:${entryDecision.timing?.urgency || "unknown"}`,
        `final_score:${this.#num(entryDecision.finalScore, 0).toFixed(4)}`
      ]
    };

    const journalEntry = await this.tradeJournal.recordEntry(entryRecord);

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
            exitTokenAmount: this.#num(
              trade.entryTokenAmount,
              0
            ) * this.#num(exitDecision.sellFraction, 1)
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

  async buildCandidate(input = {}) {
    if (this.deps.candidateBuilder?.buildCandidate) {
      return this.deps.candidateBuilder.buildCandidate(input);
    }

    const tokenInput =
      input.token && typeof input.token === "object" ? input.token : {};

    const walletId =
      input.walletId ||
      input.execution?.walletId ||
      this.config.defaultWalletId ||
      "wallet_1";

    const token = await this.buildTokenIntel(tokenInput);
    const walletIntel = await this.buildWalletIntel(input.walletIntel || {}, input);
    const volumeIntel = await this.buildVolumeIntel(input.volumeIntel || {}, input);
    const socialIntel = await this.buildSocialIntel(input.socialIntel || {}, input);
    const bubbleMapIntel = await this.buildBubbleMapIntel(
      input.bubbleMapIntel || {},
      token,
      input
    );
    const portfolio = await this.buildPortfolioState(
      input.portfolio || {},
      walletId,
      token,
      input
    );
    const execution = await this.buildExecutionContext(
      input.execution || {},
      walletId,
      portfolio,
      token,
      input
    );

    return {
      token,
      walletIntel,
      volumeIntel,
      socialIntel,
      bubbleMapIntel,
      portfolio,
      execution,
      context:
        input.context && typeof input.context === "object" ? input.context : {}
    };
  }

  async buildTokenIntel(rawToken = {}, input = {}) {
    const external =
      this.deps.marketDataProvider?.getTokenIntel
        ? await this.deps.marketDataProvider.getTokenIntel(rawToken.ca || rawToken.mint || "", input)
        : {};

    const merged = {
      ...external,
      ...rawToken
    };

    return {
      ca: String(merged.ca || merged.mint || "").trim(),
      symbol: String(merged.symbol || "UNKNOWN").trim(),
      name: String(merged.name || "").trim(),
      totalSupply: this.#num(merged.totalSupply, 0),
      tokenPriceUsd: this.#num(merged.tokenPriceUsd, 0),
      liquidityUsd: this.#num(merged.liquidityUsd, 0),
      volume1mUsd: this.#num(merged.volume1mUsd, 0),
      top10HolderPct: this.#num(merged.top10HolderPct, null),
      creatorHolderPct: this.#num(merged.creatorHolderPct, null),
      lpLockedPct: this.#num(merged.lpLockedPct, null),
      mintAuthorityEnabled: this.#boolOrNull(merged.mintAuthorityEnabled),
      freezeAuthorityEnabled: this.#boolOrNull(merged.freezeAuthorityEnabled),
      transferRestrictionRisk: this.#boolOrNull(merged.transferRestrictionRisk),
      blacklistRisk: this.#boolOrNull(merged.blacklistRisk),
      whitelistRisk: this.#boolOrNull(merged.whitelistRisk),
      honeypotLikeRisk: this.#boolOrNull(merged.honeypotLikeRisk),
      canRemoveLiquidity: this.#boolOrNull(merged.canRemoveLiquidity),
      topHolders: Array.isArray(merged.topHolders) ? merged.topHolders : []
    };
  }

  async buildWalletIntel(rawWalletIntel = {}, input = {}) {
    const sourceWalletIntel =
      this.deps.walletRegistryProvider?.getWalletIntel
        ? await this.deps.walletRegistryProvider.getWalletIntel(input)
        : rawWalletIntel;

    const scored =
      sourceWalletIntel.trades && this.walletScoringEngine.evaluateWallet
        ? this.walletScoringEngine.evaluateWallet(sourceWalletIntel)
        : null;

    if (scored?.ok) {
      return {
        ...rawWalletIntel,
        ...sourceWalletIntel,
        ...scored,
        consensusLeaders: this.#num(
          rawWalletIntel.consensusLeaders ?? sourceWalletIntel.consensusLeaders,
          1
        )
      };
    }

    return {
      winRate: this.#num(sourceWalletIntel.winRate, 0),
      medianROI: this.#num(sourceWalletIntel.medianROI, 1),
      averageROI: this.#num(sourceWalletIntel.averageROI, 1),
      maxDrawdown: this.#num(sourceWalletIntel.maxDrawdown, 1),
      tradesCount: this.#num(sourceWalletIntel.tradesCount, 0),
      earlyEntryScore: this.#num(sourceWalletIntel.earlyEntryScore, 0.5),
      chasePenalty: this.#num(sourceWalletIntel.chasePenalty, 0),
      dumpPenalty: this.#num(sourceWalletIntel.dumpPenalty, 0),
      consistencyScore: this.#num(sourceWalletIntel.consistencyScore, 0.5),
      consensusLeaders: this.#num(sourceWalletIntel.consensusLeaders, 1)
    };
  }

  async buildVolumeIntel(rawVolumeIntel = {}, input = {}) {
    const external =
      this.deps.marketDataProvider?.getVolumeIntel
        ? await this.deps.marketDataProvider.getVolumeIntel(input)
        : {};

    const merged = {
      ...external,
      ...rawVolumeIntel
    };

    return {
      growthRate1m: this.#num(merged.growthRate1m, 1),
      buyPressure: this.#num(merged.buyPressure, 0.5),
      uniqueBuyersDelta: this.#num(merged.uniqueBuyersDelta, 0),
      repeatedBuyers: this.#num(merged.repeatedBuyers, 0),
      sellPressure: this.#num(merged.sellPressure, 0.5),
      dumpSpike: Boolean(merged.dumpSpike),
      pump1mPct: this.#num(merged.pump1mPct, 0),
      spreadHealthy:
        merged.spreadHealthy !== undefined ? Boolean(merged.spreadHealthy) : true
    };
  }

  async buildSocialIntel(rawSocialIntel = {}, input = {}) {
    const external =
      this.deps.socialIntelProvider?.getSocialIntel
        ? await this.deps.socialIntelProvider.getSocialIntel(input)
        : {};

    const merged = {
      ...external,
      ...rawSocialIntel
    };

    return {
      uniqueAuthors: this.#num(merged.uniqueAuthors, 0),
      avgLikes: this.#num(merged.avgLikes, 0),
      avgReplies: this.#num(merged.avgReplies, 0),
      botPatternScore: this.#num(merged.botPatternScore, 0),
      engagementDiversity: this.#num(merged.engagementDiversity, 0.5),
      trustedMentions: this.#num(merged.trustedMentions, 0),
      socialMomentum: this.#num(merged.socialMomentum, 0.5)
    };
  }

  async buildBubbleMapIntel(rawBubbleMapIntel = {}, token = {}, input = {}) {
    const external =
      this.deps.bubbleMapProvider?.getBubbleMapIntel
        ? await this.deps.bubbleMapProvider.getBubbleMapIntel(token.ca, input)
        : {};

    const merged = {
      ...external,
      ...rawBubbleMapIntel
    };

    return {
      top10HolderPct: this.#num(merged.top10HolderPct ?? token.top10HolderPct, null),
      holders: Array.isArray(merged.holders) ? merged.holders : [],
      links: Array.isArray(merged.links) ? merged.links : []
    };
  }

  async buildPortfolioState(rawPortfolio = {}, walletId, token = {}, input = {}) {
    const external =
      this.deps.portfolioProvider?.getPortfolioState
        ? await this.deps.portfolioProvider.getPortfolioState({
            walletId,
            token,
            input
          })
        : {};

    const merged = {
      ...external,
      ...rawPortfolio
    };

    return {
      existingWalletTokenAmount: this.#num(merged.existingWalletTokenAmount, 0),
      existingAggregateTokenAmount: this.#num(
        merged.existingAggregateTokenAmount,
        0
      ),
      existingWalletUsd: this.#num(merged.existingWalletUsd, 0),
      existingAggregateUsd: this.#num(merged.existingAggregateUsd, 0),
      walletBalanceSol: this.#num(merged.walletBalanceSol, 0),
      targetWallet: merged.targetWallet || null,
      botWallets: Array.isArray(merged.botWallets) ? merged.botWallets : []
    };
  }

  async buildExecutionContext(rawExecution = {}, walletId, portfolio = {}, token = {}, input = {}) {
    const external =
      this.deps.executionProvider?.getExecutionContext
        ? await this.deps.executionProvider.getExecutionContext({
            walletId,
            portfolio,
            token,
            input
          })
        : {};

    const merged = {
      ...external,
      ...rawExecution
    };

    return {
      walletId,
      baseDesiredUsd: this.#num(merged.baseDesiredUsd, 100),
      expectedSlippagePct: this.#num(merged.expectedSlippagePct, 0),
      walletBalanceSol: this.#num(
        merged.walletBalanceSol,
        portfolio.walletBalanceSol
      ),
      isTransfer: Boolean(merged.isTransfer),
      targetWallet: merged.targetWallet || portfolio.targetWallet || null
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
        candidate,
        entryDecision,
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
    const token = trade.token || {};

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

  async summarizeJournal() {
    return this.tradeJournal.summarizePerformance();
  }

  async getOpenTrades() {
    return this.tradeJournal.getOpenTrades();
  }

  async getTradeById(tradeId) {
    return this.tradeJournal.getTradeById(tradeId);
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

  #boolOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const v = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y", "enabled"].includes(v)) return true;
    if (["false", "0", "no", "n", "disabled"].includes(v)) return false;
    return null;
  }
}
