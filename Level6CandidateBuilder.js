export default class Level6CandidateBuilder {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.providers = {
      marketDataProvider: options.marketDataProvider || null,
      safetyDataProvider: options.safetyDataProvider || null,
      bubbleMapProvider: options.bubbleMapProvider || null,
      socialIntelProvider: options.socialIntelProvider || null,
      portfolioProvider: options.portfolioProvider || null,
      walletRegistryProvider: options.walletRegistryProvider || null,
      executionProvider: options.executionProvider || null
    };

    this.defaults = {
      defaultWalletId: options.defaultWalletId || "wallet_1",
      baseDesiredUsd: this.#num(options.baseDesiredUsd, 100),
      expectedSlippagePct: this.#num(options.expectedSlippagePct, 4.5),
      tokenPriceUsdFallback: this.#num(options.tokenPriceUsdFallback, 0),
      minLiquidityUsdFallback: this.#num(options.minLiquidityUsdFallback, 0)
    };
  }

  async buildCandidate(input = {}) {
    const walletId =
      input.walletId ||
      input.execution?.walletId ||
      this.defaults.defaultWalletId;

    const token = await this.buildTokenIntel(input.token || {}, input);
    const walletIntel = await this.buildWalletIntel(input.walletIntel || {}, input);
    const volumeIntel = await this.buildVolumeIntel(input.volumeIntel || {}, token, input);
    const socialIntel = await this.buildSocialIntel(input.socialIntel || {}, token, input);
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
      this.providers.marketDataProvider?.getTokenIntel
        ? await this.providers.marketDataProvider.getTokenIntel(
            rawToken.ca || rawToken.mint || "",
            input
          )
        : {};

    const safety =
      this.providers.safetyDataProvider?.getTokenSafetyIntel
        ? await this.providers.safetyDataProvider.getTokenSafetyIntel(
            rawToken.ca || rawToken.mint || "",
            input
          )
        : {};

    const merged = {
      ...external,
      ...safety,
      ...rawToken
    };

    return {
      ca: String(merged.ca || merged.mint || "").trim(),
      mint: String(merged.mint || merged.ca || "").trim(),
      chain: String(merged.chain || "solana").trim(),
      symbol: String(merged.symbol || "UNKNOWN").trim(),
      name: String(merged.name || "").trim(),

      totalSupply: this.#num(merged.totalSupply, 0),
      tokenPriceUsd: this.#num(
        merged.tokenPriceUsd,
        this.defaults.tokenPriceUsdFallback
      ),
      liquidityUsd: this.#num(
        merged.liquidityUsd,
        this.defaults.minLiquidityUsdFallback
      ),
      volume1mUsd: this.#num(merged.volume1mUsd, 0),
      fdvUsd: this.#num(merged.fdvUsd, 0),
      marketCapUsd: this.#num(merged.marketCapUsd, 0),

      top10HolderPct: this.#numOrNull(merged.top10HolderPct),
      creatorHolderPct: this.#numOrNull(merged.creatorHolderPct),
      lpLockedPct: this.#numOrNull(merged.lpLockedPct),

      mintAuthorityEnabled: this.#boolOrNull(merged.mintAuthorityEnabled),
      freezeAuthorityEnabled: this.#boolOrNull(merged.freezeAuthorityEnabled),
      transferRestrictionRisk: this.#boolOrNull(merged.transferRestrictionRisk),
      blacklistRisk: this.#boolOrNull(merged.blacklistRisk),
      whitelistRisk: this.#boolOrNull(merged.whitelistRisk),
      honeypotLikeRisk: this.#boolOrNull(merged.honeypotLikeRisk),
      canRemoveLiquidity: this.#boolOrNull(merged.canRemoveLiquidity),

      topHolders: Array.isArray(merged.topHolders) ? merged.topHolders : [],
      metadata:
        merged.metadata && typeof merged.metadata === "object"
          ? merged.metadata
          : {}
    };
  }

  async buildWalletIntel(rawWalletIntel = {}, input = {}) {
    const external =
      this.providers.walletRegistryProvider?.getWalletIntel
        ? await this.providers.walletRegistryProvider.getWalletIntel(input)
        : {};

    const merged = {
      ...external,
      ...rawWalletIntel
    };

    return {
      walletAddress: String(
        merged.walletAddress || merged.address || ""
      ).trim(),

      winRate: this.#num(merged.winRate, 0),
      medianROI: this.#num(merged.medianROI, 1),
      averageROI: this.#num(merged.averageROI, 1),
      maxDrawdown: this.#num(merged.maxDrawdown, 1),
      tradesCount: this.#num(merged.tradesCount, 0),

      earlyEntryScore: this.#num(merged.earlyEntryScore, 0.5),
      chasePenalty: this.#num(merged.chasePenalty, 0),
      dumpPenalty: this.#num(merged.dumpPenalty, 0),
      consistencyScore: this.#num(merged.consistencyScore, 0.5),

      consensusLeaders: this.#num(merged.consensusLeaders, 1),
      trades: Array.isArray(merged.trades) ? merged.trades : []
    };
  }

  async buildVolumeIntel(rawVolumeIntel = {}, token = {}, input = {}) {
    const external =
      this.providers.marketDataProvider?.getVolumeIntel
        ? await this.providers.marketDataProvider.getVolumeIntel(
            token.ca,
            input
          )
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

  async buildSocialIntel(rawSocialIntel = {}, token = {}, input = {}) {
    const external =
      this.providers.socialIntelProvider?.getSocialIntel
        ? await this.providers.socialIntelProvider.getSocialIntel(
            token.ca,
            input
          )
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
      this.providers.bubbleMapProvider?.getBubbleMapIntel
        ? await this.providers.bubbleMapProvider.getBubbleMapIntel(
            token.ca,
            input
          )
        : {};

    const merged = {
      ...external,
      ...rawBubbleMapIntel
    };

    return {
      top10HolderPct: this.#numOrNull(
        merged.top10HolderPct ?? token.top10HolderPct
      ),
      holders: Array.isArray(merged.holders) ? merged.holders : [],
      links: Array.isArray(merged.links) ? merged.links : []
    };
  }

  async buildPortfolioState(rawPortfolio = {}, walletId, token = {}, input = {}) {
    const external =
      this.providers.portfolioProvider?.getPortfolioState
        ? await this.providers.portfolioProvider.getPortfolioState({
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
      this.providers.executionProvider?.getExecutionContext
        ? await this.providers.executionProvider.getExecutionContext({
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
      baseDesiredUsd: this.#num(
        merged.baseDesiredUsd,
        this.defaults.baseDesiredUsd
      ),
      expectedSlippagePct: this.#num(
        merged.expectedSlippagePct,
        this.defaults.expectedSlippagePct
      ),
      walletBalanceSol: this.#num(
        merged.walletBalanceSol,
        portfolio.walletBalanceSol
      ),
      isTransfer: Boolean(merged.isTransfer),
      targetWallet: merged.targetWallet || portfolio.targetWallet || null,

      plannedTokenAmount: this.#num(merged.plannedTokenAmount, 0)
    };
  }

  #num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  #numOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
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
