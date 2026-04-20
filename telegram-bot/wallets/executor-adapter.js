function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default class ExecutorAdapter {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.walletRouter = options.walletRouter;
  }

  async execute(runtimeConfig, intent) {
    const mode = String(intent?.executionMode || "dry_run");

    if (mode !== "live") {
      return this.executeDry(intent);
    }

    return this.executeLive(runtimeConfig, intent);
  }

  async executeDry(intent) {
    return {
      ok: true,
      mode: "dry_run",
      intentType: intent?.type || "UNKNOWN",
      walletId: intent?.walletId || null,
      txid: null,
      filled: true,
      simulatedAmountSol:
        safeNum(intent?.token?.price) > 0
          ? safeNum(intent?.signalContext?.chosenPlan?.expectedEdgePct, 0)
          : 0,
      details: {
        note: "Simulated execution"
      }
    };
  }

  async executeLive(runtimeConfig, intent) {
    if (!this.walletRouter) {
      return {
        ok: false,
        mode: "live",
        reason: "wallet_router_missing"
      };
    }

    const built = this.walletRouter.buildExecutionEngine(runtimeConfig, intent.walletId);
    if (!built.ok) {
      return {
        ok: false,
        mode: "live",
        reason: built.reason || "engine_build_failed"
      };
    }

    const engine = built.engine;

    try {
      if (intent.type === "OPEN_POSITION") {
        return {
          ok: true,
          mode: "live",
          intentType: intent.type,
          walletId: intent.walletId,
          txid: null,
          filled: true,
          details: {
            note: "Live adapter placeholder open path"
          }
        };
      }

      if (intent.type === "CLOSE_POSITION") {
        return {
          ok: true,
          mode: "live",
          intentType: intent.type,
          walletId: intent.walletId,
          txid: null,
          filled: true,
          details: {
            note: "Live adapter placeholder close path"
          }
        };
      }

      if (intent.type === "PARTIAL_SELL") {
        return {
          ok: true,
          mode: "live",
          intentType: intent.type,
          walletId: intent.walletId,
          txid: null,
          filled: true,
          details: {
            note: "Live adapter placeholder partial path"
          }
        };
      }

      return {
        ok: false,
        mode: "live",
        reason: "unsupported_intent_type"
      };
    } catch (error) {
      this.logger.log("executor live error:", error.message);
      return {
        ok: false,
        mode: "live",
        reason: error.message || "live_execution_failed"
      };
    }
  }
}
