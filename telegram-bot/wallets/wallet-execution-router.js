import Level5ExecutionEngine from "../Level5ExecutionEngine.js";
import WalletSecretResolver from "./wallet-secret-resolver.js";

export default class WalletExecutionRouter {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.secretResolver =
      options.secretResolver || new WalletSecretResolver({ logger: this.logger });
    this.executionFactory =
      options.executionFactory || ((cfg) => new Level5ExecutionEngine(cfg));
    this.cache = new Map();
  }

  getWalletMeta(runtimeConfig, walletId) {
    return runtimeConfig?.wallets?.[walletId] || null;
  }

  validateWalletForStrategy(runtimeConfig, walletId, strategyKey) {
    const wallet = this.getWalletMeta(runtimeConfig, walletId);
    if (!wallet) return { ok: false, reason: "wallet_not_found" };
    if (!wallet.enabled) return { ok: false, reason: "wallet_disabled" };
    if (
      Array.isArray(wallet.allowedStrategies) &&
      !wallet.allowedStrategies.includes(strategyKey)
    ) {
      return { ok: false, reason: "strategy_not_allowed" };
    }
    return { ok: true, wallet };
  }

  getWalletIdsForStrategy(runtimeConfig, strategyKey) {
    return Array.isArray(runtimeConfig?.strategyRouting?.[strategyKey])
      ? runtimeConfig.strategyRouting[strategyKey]
      : [];
  }

  getPrimaryWalletId(runtimeConfig, strategyKey) {
    const ids = this.getWalletIdsForStrategy(runtimeConfig, strategyKey);
    return ids[0] || null;
  }

  buildExecutionEngine(runtimeConfig, walletId) {
    const wallet = this.getWalletMeta(runtimeConfig, walletId);
    if (!wallet) {
      return { ok: false, reason: "wallet_not_found" };
    }

    const mode = wallet.executionMode || (runtimeConfig?.dryRun ? "dry_run" : "live");
    const cacheKey = `${walletId}:${mode}:${wallet.secretRef || ""}`;

    if (this.cache.has(cacheKey)) {
      return { ok: true, engine: this.cache.get(cacheKey), wallet };
    }

    const live = mode === "live";
    let secretKeyBase58 = "";

    if (live) {
      const resolved = this.secretResolver.resolve(wallet.secretRef || "");
      if (!resolved.ok) {
        return { ok: false, reason: resolved.reason };
      }
      secretKeyBase58 = resolved.secret;
    }

    try {
      const engine = this.executionFactory({
        logger: this.logger,
        rpcUrl: process.env.SOLANA_RPC_URL,
        jupiterApiKey: process.env.JUP_API_KEY,
        isDryRun: !live,
        secretKeyBase58: live
          ? secretKeyBase58
          : process.env.SOLANA_PRIVATE_KEY_BASE58 ||
            "11111111111111111111111111111111"
      });

      this.cache.set(cacheKey, engine);
      return { ok: true, engine, wallet };
    } catch (error) {
      return { ok: false, reason: error.message || "engine_build_failed" };
    }
  }
}
