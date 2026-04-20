import ExecutionIntentBuilder from "./execution-intent-builder.js";
import ExecutorAdapter from "./executor-adapter.js";

export default class WalletOrchestrator {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.walletRouter = options.walletRouter;
    this.intentBuilder =
      options.intentBuilder || new ExecutionIntentBuilder();
    this.executorAdapter =
      options.executorAdapter ||
      new ExecutorAdapter({
        logger: this.logger,
        walletRouter: this.walletRouter
      });
  }

  getWalletMeta(runtimeConfig, walletId) {
    return runtimeConfig?.wallets?.[walletId] || null;
  }

  validateForStrategy(runtimeConfig, walletId, strategyKey) {
    if (!this.walletRouter) {
      return { ok: false, reason: "wallet_router_missing" };
    }
    return this.walletRouter.validateWalletForStrategy(runtimeConfig, walletId, strategyKey);
  }

  getPrimaryWalletId(runtimeConfig, strategyKey) {
    if (!this.walletRouter) return null;
    return this.walletRouter.getPrimaryWalletId(runtimeConfig, strategyKey);
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

    const execution = await this.executorAdapter.execute(runtimeConfig, intent);
    return {
      intent,
      execution
    };
  }
}
