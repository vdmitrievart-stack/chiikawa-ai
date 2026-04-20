import ExecutionIntentBuilder from "./execution-intent-builder.js";
import ExecutorAdapter from "./executor-adapter.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class WalletOrchestrator {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.walletRouter = options.walletRouter || null;
    this.intentBuilder =
      options.intentBuilder || new ExecutionIntentBuilder();
    this.executorAdapter =
      options.executorAdapter ||
      new ExecutorAdapter({
        logger: this.logger,
        walletRouter: this.walletRouter,
        manualApprovalBridge: options.manualApprovalBridge || null
      });

    this.intentCounter = 0;
  }

  getWalletMeta(runtimeConfig, walletId) {
    return clone(runtimeConfig?.wallets?.[walletId] || null);
  }

  getPrimaryWalletId(runtimeConfig, strategyKey) {
    if (!this.walletRouter) return null;
    return this.walletRouter.getPrimaryWalletId(runtimeConfig, strategyKey);
  }

  validateForStrategy(runtimeConfig, walletId, strategyKey) {
    if (!this.walletRouter) {
      return { ok: false, reason: "wallet_router_missing" };
    }

    return this.walletRouter.validateWalletForStrategy(
      runtimeConfig,
      walletId,
      strategyKey
    );
  }

  async executeOpen(runtimeConfig, { walletId, plan, candidate, heroImage }) {
    const walletMeta = this.getWalletMeta(runtimeConfig, walletId);
    const intent = this.intentBuilder.buildOpenIntent({
      walletId,
      walletMeta,
      plan,
      candidate,
      heroImage
    });

    intent.intentId = this.makeIntentId("open", walletId, intent?.token?.ca);
    intent.createdAt = new Date().toISOString();

    const execution = await this.executorAdapter.execute(runtimeConfig, intent);

    return {
      intent,
      execution
    };
  }

  async executeClose(runtimeConfig, { walletId, position, reason, exitReferencePrice }) {
    const walletMeta = this.getWalletMeta(runtimeConfig, walletId);
    const intent = this.intentBuilder.buildCloseIntent({
      walletId,
      walletMeta,
      position,
      reason,
      exitReferencePrice
    });

    intent.intentId = this.makeIntentId("close", walletId, intent?.token?.ca);
    intent.createdAt = new Date().toISOString();
    intent.amountRaw = position?.tokenAmountRaw || 0;
    intent.tokenAmountRaw = position?.tokenAmountRaw || 0;

    const execution = await this.executorAdapter.execute(runtimeConfig, intent);

    return {
      intent,
      execution
    };
  }

  async executePartial(runtimeConfig, { walletId, position, targetPct, soldFraction, currentPrice }) {
    const walletMeta = this.getWalletMeta(runtimeConfig, walletId);
    const intent = this.intentBuilder.buildPartialIntent({
      walletId,
      walletMeta,
      position,
      targetPct,
      soldFraction,
      currentPrice
    });

    intent.intentId = this.makeIntentId("partial", walletId, intent?.token?.ca);
    intent.createdAt = new Date().toISOString();
    intent.amountRaw = position?.tokenAmountRaw || 0;
    intent.tokenAmountRaw = position?.tokenAmountRaw || 0;

    const execution = await this.executorAdapter.execute(runtimeConfig, intent);

    return {
      intent,
      execution
    };
  }

  makeIntentId(kind, walletId, tokenCa) {
    this.intentCounter += 1;
    return [
      kind || "intent",
      walletId || "wallet",
      String(tokenCa || "unknown").slice(0, 12),
      Date.now(),
      this.intentCounter
    ].join("-");
  }
}
