function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class ExecutorAdapter {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.walletRouter = options.walletRouter || null;
    this.manualApprovalBridge = options.manualApprovalBridge || null;
  }

  async execute(runtimeConfig, intent) {
    const mode = String(intent?.executionMode || "dry_run").toLowerCase();

    if (mode === "dry_run") {
      return this.executeDry(intent);
    }

    if (mode === "manual_approval") {
      return this.executeManualApproval(runtimeConfig, intent);
    }

    if (mode === "live") {
      return this.executeLiveAsApproval(runtimeConfig, intent);
    }

    return {
      ok: false,
      mode,
      reason: "unsupported_execution_mode"
    };
  }

  async executeDry(intent) {
    return {
      ok: true,
      mode: "dry_run",
      intentId: intent?.intentId || null,
      intentType: intent?.type || "UNKNOWN",
      walletId: intent?.walletId || null,
      status: "simulated",
      filled: true,
      txid: null,
      details: {
        note: "Simulated execution path",
        strategy: intent?.strategy || null,
        entryMode: intent?.entryMode || null,
        token: clone(intent?.token || null)
      }
    };
  }

  async executeManualApproval(runtimeConfig, intent) {
    if (!this.manualApprovalBridge) {
      return {
        ok: false,
        mode: "manual_approval",
        reason: "manual_approval_bridge_missing"
      };
    }

    const publicKey = this.resolveWalletPublicKey(runtimeConfig, intent.walletId);

    try {
      if (intent.type === "OPEN_POSITION") {
        const row = await this.manualApprovalBridge.createOpenApproval({
          runtimeConfig,
          intent,
          publicKey
        });

        return {
          ok: true,
          mode: "manual_approval",
          intentId: intent.intentId,
          intentType: intent.type,
          walletId: intent.walletId,
          status: row?.status || "awaiting_approval",
          filled: false,
          txid: null,
          approval: clone(row)
        };
      }

      if (intent.type === "CLOSE_POSITION") {
        const amountRaw = this.estimateCloseAmountRaw(intent);
        const row = await this.manualApprovalBridge.createCloseApproval({
          runtimeConfig,
          intent,
          publicKey,
          amountRaw
        });

        return {
          ok: true,
          mode: "manual_approval",
          intentId: intent.intentId,
          intentType: intent.type,
          walletId: intent.walletId,
          status: row?.status || "awaiting_approval",
          filled: false,
          txid: null,
          approval: clone(row)
        };
      }

      if (intent.type === "PARTIAL_SELL") {
        const amountRaw = this.estimatePartialAmountRaw(intent);
        const row = await this.manualApprovalBridge.createCloseApproval({
          runtimeConfig,
          intent,
          publicKey,
          amountRaw
        });

        return {
          ok: true,
          mode: "manual_approval",
          intentId: intent.intentId,
          intentType: intent.type,
          walletId: intent.walletId,
          status: row?.status || "awaiting_approval",
          filled: false,
          txid: null,
          approval: clone(row)
        };
      }

      return {
        ok: false,
        mode: "manual_approval",
        reason: "unsupported_intent_type"
      };
    } catch (error) {
      this.logger.log("manual approval execute error:", error.message);
      return {
        ok: false,
        mode: "manual_approval",
        reason: error.message || "manual_approval_failed"
      };
    }
  }

  async executeLiveAsApproval(runtimeConfig, intent) {
    return this.executeManualApproval(runtimeConfig, {
      ...intent,
      executionMode: "manual_approval"
    });
  }

  resolveWalletPublicKey(runtimeConfig, walletId) {
    const wallet = runtimeConfig?.wallets?.[walletId];
    return wallet?.publicKey || wallet?.address || null;
  }

  estimateCloseAmountRaw(intent) {
    const maybeRaw = safeNum(intent?.amountRaw, 0);
    if (maybeRaw > 0) return Math.floor(maybeRaw);

    const fallback = safeNum(intent?.tokenAmountRaw, 0);
    if (fallback > 0) return Math.floor(fallback);

    return 1;
  }

  estimatePartialAmountRaw(intent) {
    const baseRaw =
      safeNum(intent?.tokenAmountRaw, 0) ||
      safeNum(intent?.amountRaw, 0);

    const soldFraction = safeNum(intent?.soldFraction, 0);
    if (baseRaw > 0 && soldFraction > 0) {
      return Math.max(1, Math.floor(baseRaw * soldFraction));
    }

    return Math.max(1, Math.floor(baseRaw || 1));
  }
}
