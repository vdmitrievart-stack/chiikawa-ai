export default class Level6PositionRiskEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.rules = {
      maxPerWalletSupplyPct: 3.5,
      maxAggregateSupplyPct: 6.0,
      maxPerWalletLiquidityPct: 8,
      maxAggregateLiquidityPct: 15,
      maxPerWalletVolume1mPct: 25,

      minReserveSol: 0.07,
      solPriceUsd: 150
    };
  }

  evaluate(input = {}) {
    const {
      token,
      planned,
      portfolio,
      walletBalanceSol
    } = input;

    const reasons = [];

    const totalSupply = token.totalSupply;
    const liquidityUsd = token.liquidityUsd;
    const volume1mUsd = token.volume1mUsd;

    const plannedTokenAmount = planned.plannedTokenAmount;
    const plannedUsd = planned.plannedUsd;

    const perWalletSupply =
      (plannedTokenAmount + (portfolio.existingWalletTokenAmount || 0)) /
      totalSupply *
      100;

    if (perWalletSupply > this.rules.maxPerWalletSupplyPct) {
      reasons.push("max_supply_per_wallet_exceeded");
    }

    const aggregateSupply =
      (plannedTokenAmount + (portfolio.existingAggregateTokenAmount || 0)) /
      totalSupply *
      100;

    if (aggregateSupply > this.rules.maxAggregateSupplyPct) {
      reasons.push("max_supply_aggregate_exceeded");
    }

    const liquidityImpact =
      plannedUsd / liquidityUsd * 100;

    if (liquidityImpact > this.rules.maxPerWalletLiquidityPct) {
      reasons.push("liquidity_impact_too_high");
    }

    const volumeImpact =
      plannedUsd / volume1mUsd * 100;

    if (volumeImpact > this.rules.maxPerWalletVolume1mPct) {
      reasons.push("volume_impact_too_high");
    }

    // 🔥 reserve check
    const plannedSpendSol = plannedUsd / this.rules.solPriceUsd;
    const remainingSol = walletBalanceSol - plannedSpendSol;

    if (remainingSol < this.rules.minReserveSol) {
      reasons.push("breaks_sol_reserve_rule");
    }

    return {
      ok: reasons.length === 0,
      reasons,
      metrics: {
        perWalletSupply,
        aggregateSupply,
        liquidityImpact,
        volumeImpact,
        remainingSol
      }
    };
  }
}
