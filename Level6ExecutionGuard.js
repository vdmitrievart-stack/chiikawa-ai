export default class Level6ExecutionGuard {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.rules = {
      minReserveSol: this.#num(options.rules?.minReserveSol, 0.07),
      minReserveUsd: this.#num(options.rules?.minReserveUsd, 7),
      solPriceUsd: this.#num(options.rules?.solPriceUsd, 150),

      blockInternalTransfers: true
    };

    this.botWallets = new Set(options.botWallets || []);
  }

  validateExecution(input = {}) {
    const {
      walletAddress,
      targetWallet,
      walletBalanceSol,
      plannedSpendSol,
      isTransfer
    } = input;

    const reasons = [];

    // ❌ self-transfer check
    if (isTransfer && this.rules.blockInternalTransfers) {
      if (this.botWallets.has(targetWallet)) {
        reasons.push("blocked_internal_wallet_transfer");
      }
    }

    // 💰 reserve SOL check
    const remainingSol = walletBalanceSol - plannedSpendSol;

    if (remainingSol < this.rules.minReserveSol) {
      reasons.push("insufficient_sol_reserve");
    }

    // 💰 reserve USD check
    const remainingUsd = remainingSol * this.rules.solPriceUsd;

    if (remainingUsd < this.rules.minReserveUsd) {
      reasons.push("insufficient_usd_reserve");
    }

    return {
      ok: reasons.length === 0,
      reasons,
      metrics: {
        walletBalanceSol,
        plannedSpendSol,
        remainingSol,
        remainingUsd
      },
      limits: this.rules
    };
  }

  #num(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
}
