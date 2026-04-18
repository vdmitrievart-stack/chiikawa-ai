import Level6DecisionEngine from "./Level6DecisionEngine.js";
import Level6ExecutionGuard from "./Level6ExecutionGuard.js";

export default class Level6TradingKernel {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.decisionEngine = new Level6DecisionEngine(options);

    this.executionGuard = new Level6ExecutionGuard({
      botWallets: options.botWallets || [],
      rules: options.executionRules || {}
    });
  }

  async processCandidate(candidate) {
    const decision =
      await this.decisionEngine.evaluateTradeCandidate(candidate);

    if (decision.action === "REJECT") {
      return decision;
    }

    // 🔒 EXECUTION GUARD
    const guard = this.executionGuard.validateExecution({
      walletAddress: candidate.execution.walletId,
      walletBalanceSol: candidate.execution.walletBalanceSol,
      plannedSpendSol:
        decision.suggestedUsd / 150,
      isTransfer: false
    });

    if (!guard.ok) {
      return {
        ...decision,
        action: "REJECT",
        reasons: [...decision.reasons, ...guard.reasons]
      };
    }

    return {
      ...decision,
      executionApproved: true
    };
  }
}
