export default class Level6PositionRiskEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.rules = {
      maxPerWalletSupplyPct: this.#num(options.rules?.maxPerWalletSupplyPct, 3.5),
      maxAggregateSupplyPct: this.#num(options.rules?.maxAggregateSupplyPct, 6.0),
      maxPerWalletLiquidityPct: this.#num(options.rules?.maxPerWalletLiquidityPct, 8.0),
      maxAggregateLiquidityPct: this.#num(options.rules?.maxAggregateLiquidityPct, 15.0),
      maxPerWalletVolume1mPct: this.#num(options.rules?.maxPerWalletVolume1mPct, 25.0),
      maxSlippagePct: this.#num(options.rules?.maxSlippagePct, 12.0)
    };
  }

  evaluate(input = {}) {
    const token = input.token && typeof input.token === "object" ? input.token : {};
    const planned = input.planned && typeof input.planned === "object" ? input.planned : {};
    const portfolio =
      input.portfolio && typeof input.portfolio === "object" ? input.portfolio : {};

    const totalSupply = this.#num(token.totalSupply, 0);
    const liquidityUsd = this.#num(token.liquidityUsd, 0);
    const volume1mUsd = this.#num(token.volume1mUsd, 0);
    const tokenPriceUsd = this.#num(token.tokenPriceUsd, 0);

    const plannedTokenAmount = this.#num(planned.plannedTokenAmount, 0);
    const plannedUsd = this.#num(planned.plannedUsd, 0);
    const expectedSlippagePct = this.#num(planned.expectedSlippagePct, 0);
    const walletId = String(planned.walletId || "unknown_wallet");

    const existingWalletTokenAmount = this.#num(portfolio.existingWalletTokenAmount, 0);
    const existingAggregateTokenAmount = this.#num(portfolio.existingAggregateTokenAmount, 0);
    const existingWalletUsd = this.#num(portfolio.existingWalletUsd, 0);
    const existingAggregateUsd = this.#num(portfolio.existingAggregateUsd, 0);

    const perWalletTokenAfter = existingWalletTokenAmount + plannedTokenAmount;
    const aggregateTokenAfter = existingAggregateTokenAmount + plannedTokenAmount;

    const perWalletSupplyPct =
      totalSupply > 0 ? (perWalletTokenAfter / totalSupply) * 100 : 0;

    const aggregateSupplyPct =
      totalSupply > 0 ? (aggregateTokenAfter / totalSupply) * 100 : 0;

    const perWalletLiquidityPct =
      liquidityUsd > 0 ? ((existingWalletUsd + plannedUsd) / liquidityUsd) * 100 : 0;

    const aggregateLiquidityPct =
      liquidityUsd > 0 ? ((existingAggregateUsd + plannedUsd) / liquidityUsd) * 100 : 0;

    const perWalletVolume1mPct =
      volume1mUsd > 0 ? (plannedUsd / volume1mUsd) * 100 : 0;

    const reasons = [];
    const warnings = [];

    if (perWalletSupplyPct > this.rules.maxPerWalletSupplyPct) {
      reasons.push(
        `per_wallet_supply_cap_exceeded:${perWalletSupplyPct.toFixed(4)}`
      );
    }

    if (aggregateSupplyPct > this.rules.maxAggregateSupplyPct) {
      reasons.push(
        `aggregate_supply_cap_exceeded:${aggregateSupplyPct.toFixed(4)}`
      );
    }

    if (perWalletLiquidityPct > this.rules.maxPerWalletLiquidityPct) {
      reasons.push(
        `per_wallet_liquidity_cap_exceeded:${perWalletLiquidityPct.toFixed(4)}`
      );
    }

    if (aggregateLiquidityPct > this.rules.maxAggregateLiquidityPct) {
      reasons.push(
        `aggregate_liquidity_cap_exceeded:${aggregateLiquidityPct.toFixed(4)}`
      );
    }

    if (perWalletVolume1mPct > this.rules.maxPerWalletVolume1mPct) {
      reasons.push(
        `per_wallet_volume1m_cap_exceeded:${perWalletVolume1mPct.toFixed(4)}`
      );
    }

    if (expectedSlippagePct > this.rules.maxSlippagePct) {
      reasons.push(
        `expected_slippage_too_high:${expectedSlippagePct.toFixed(4)}`
      );
    }

    if (totalSupply <= 0) warnings.push("total_supply_unknown");
    if (liquidityUsd <= 0) warnings.push("liquidity_unknown");
    if (volume1mUsd <= 0) warnings.push("volume1m_unknown");
    if (tokenPriceUsd <= 0) warnings.push("token_price_unknown");

    const ok = reasons.length === 0;

    return {
      ok,
      hardReject: !ok,
      walletId,
      reasons,
      warnings,
      metrics: {
        plannedTokenAmount,
        plannedUsd,
        tokenPriceUsd,
        totalSupply,
        liquidityUsd,
        volume1mUsd,
        expectedSlippagePct,
        perWalletSupplyPct,
        aggregateSupplyPct,
        perWalletLiquidityPct,
        aggregateLiquidityPct,
        perWalletVolume1mPct
      },
      limits: { ...this.rules }
    };
  }

  buildSuggestedSize(input = {}) {
    const token = input.token && typeof input.token === "object" ? input.token : {};
    const portfolio =
      input.portfolio && typeof input.portfolio === "object" ? input.portfolio : {};
    const walletId = String(input.walletId || "unknown_wallet");
    const desiredUsd = this.#num(input.desiredUsd, 0);

    const totalSupply = this.#num(token.totalSupply, 0);
    const tokenPriceUsd = this.#num(token.tokenPriceUsd, 0);
    const liquidityUsd = this.#num(token.liquidityUsd, 0);
    const volume1mUsd = this.#num(token.volume1mUsd, 0);

    const existingWalletTokenAmount = this.#num(portfolio.existingWalletTokenAmount, 0);
    const existingAggregateTokenAmount = this.#num(portfolio.existingAggregateTokenAmount, 0);
    const existingWalletUsd = this.#num(portfolio.existingWalletUsd, 0);
    const existingAggregateUsd = this.#num(portfolio.existingAggregateUsd, 0);

    let maxUsdBySupplyWallet = Infinity;
    let maxUsdBySupplyAggregate = Infinity;
    let maxUsdByLiquidityWallet = Infinity;
    let maxUsdByLiquidityAggregate = Infinity;
    let maxUsdByVolume1mWallet = Infinity;

    if (totalSupply > 0 && tokenPriceUsd > 0) {
      const walletRemainingTokens =
        (this.rules.maxPerWalletSupplyPct / 100) * totalSupply - existingWalletTokenAmount;
      const aggregateRemainingTokens =
        (this.rules.maxAggregateSupplyPct / 100) * totalSupply - existingAggregateTokenAmount;

      maxUsdBySupplyWallet = Math.max(0, walletRemainingTokens) * tokenPriceUsd;
      maxUsdBySupplyAggregate = Math.max(0, aggregateRemainingTokens) * tokenPriceUsd;
    }

    if (liquidityUsd > 0) {
      maxUsdByLiquidityWallet =
        Math.max(0, (this.rules.maxPerWalletLiquidityPct / 100) * liquidityUsd - existingWalletUsd);

      maxUsdByLiquidityAggregate =
        Math.max(0, (this.rules.maxAggregateLiquidityPct / 100) * liquidityUsd - existingAggregateUsd);
    }

    if (volume1mUsd > 0) {
      maxUsdByVolume1mWallet =
        Math.max(0, (this.rules.maxPerWalletVolume1mPct / 100) * volume1mUsd);
    }

    const suggestedUsd = Math.max(
      0,
      Math.min(
        desiredUsd || Infinity,
        maxUsdBySupplyWallet,
        maxUsdBySupplyAggregate,
        maxUsdByLiquidityWallet,
        maxUsdByLiquidityAggregate,
        maxUsdByVolume1mWallet
      )
    );

    return {
      ok: suggestedUsd > 0,
      walletId,
      desiredUsd,
      suggestedUsd,
      caps: {
        maxUsdBySupplyWallet,
        maxUsdBySupplyAggregate,
        maxUsdByLiquidityWallet,
        maxUsdByLiquidityAggregate,
        maxUsdByVolume1mWallet
      }
    };
  }

  #num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
}
