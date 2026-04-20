function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

export default class GMGNExecutionService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.walletService = options.walletService;
    this.orderStore = options.orderStore;

    this.defaultMode = asText(
      options.defaultMode || process.env.GMGN_EXECUTION_MODE,
      "dry_run"
    ); // dry_run | external_manual | disabled

    this.defaultSlippagePct = safeNum(
      options.defaultSlippagePct ?? process.env.GMGN_DEFAULT_SLIPPAGE_PCT,
      1
    );
  }

  requireDeps() {
    if (!this.walletService) {
      throw new Error("GMGNExecutionService requires walletService");
    }
    if (!this.orderStore) {
      throw new Error("GMGNExecutionService requires orderStore");
    }
  }

  makeClientOrderId(strategy, walletId, tokenCa, side) {
    return [
      "gmgn",
      asText(strategy, "strategy"),
      asText(side, "side"),
      asText(walletId, "wallet"),
      asText(tokenCa, "token").slice(0, 10),
      Date.now(),
      shortId()
    ].join("-");
  }

  normalizeSide(side) {
    const s = asText(side, "BUY").toUpperCase();
    return s === "SELL" ? "SELL" : "BUY";
  }

  estimateSizeFromIntent(intent = {}) {
    const strategy = asText(intent.strategy).toLowerCase();
    const edge = safeNum(intent.expectedEdgePct, 0);

    let amountSol = safeNum(intent.amountSol, 0);

    if (amountSol <= 0) {
      if (strategy === "runner") amountSol = 1.2;
      else if (strategy === "copytrade") amountSol = 0.7;
      else if (strategy === "reversal") amountSol = 0.8;
      else amountSol = 0.5;

      if (edge >= 20) amountSol += 0.3;
      if (edge >= 35) amountSol += 0.2;
    }

    return {
      amountSol,
      amountUsd: safeNum(intent.amountUsd, 0),
      tokenAmount: safeNum(intent.tokenAmount, 0)
    };
  }

  buildOrderPayload(runtimeConfig, {
    walletId,
    strategy,
    side,
    token,
    intent = {},
    note = ""
  }) {
    this.requireDeps();

    const profile = this.walletService.getWalletExecutionProfile(runtimeConfig, walletId);
    if (!profile) {
      throw new Error(`Wallet profile not found for ${walletId}`);
    }

    const tokenObj = clone(token || {});
    const clientOrderId = this.makeClientOrderId(
      strategy,
      walletId,
      tokenObj.ca,
      side
    );

    return {
      orderId: "",
      clientOrderId,
      walletId,
      gmgnWalletId: asText(profile.gmgnWalletId),
      gmgnAccountId: asText(profile.gmgnAccountId),
      strategy: asText(strategy),
      side: this.normalizeSide(side),
      status: "created",
      token: {
        name: asText(tokenObj.name),
        symbol: asText(tokenObj.symbol),
        ca: asText(tokenObj.ca),
        chainId: asText(tokenObj.chainId),
        dexId: asText(tokenObj.dexId),
        url: asText(tokenObj.url)
      },
      size: this.estimateSizeFromIntent(intent),
      pricing: {
        expectedEntryPrice: safeNum(intent.expectedEntryPrice ?? tokenObj.price, 0),
        executedEntryPrice: 0,
        expectedExitPrice: safeNum(intent.expectedExitPrice, 0),
        executedExitPrice: 0,
        slippagePct: safeNum(intent.slippagePct, this.defaultSlippagePct)
      },
      source: "gmgn",
      mode: asText(profile.executionMode, this.defaultMode),
      note: asText(note),
      reason: "",
      signature: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      history: [],
      raw: {
        walletProfile: profile,
        intent: clone(intent)
      }
    };
  }

  async createOrder(runtimeConfig, params) {
    const payload = this.buildOrderPayload(runtimeConfig, params);
    return this.orderStore.createOrder(payload);
  }

  async submitOrder(runtimeConfig, params) {
    const order = await this.createOrder(runtimeConfig, params);
    const mode = asText(order?.mode, this.defaultMode);

    if (mode === "disabled") {
      return this.orderStore.markFailed(
        { clientOrderId: order.clientOrderId },
        {
          reason: "execution_disabled",
          note: "GMGN execution disabled"
        }
      );
    }

    if (mode === "dry_run") {
      return this.orderStore.markSubmitted(
        { clientOrderId: order.clientOrderId },
        {
          note: "dry_run submitted"
        }
      );
    }

    if (mode === "external_manual") {
      return this.orderStore.markSubmitted(
        { clientOrderId: order.clientOrderId },
        {
          note: "waiting for external GMGN wallet execution"
        }
      );
    }

    return this.orderStore.markFailed(
      { clientOrderId: order.clientOrderId },
      {
        reason: "unsupported_execution_mode",
        note: `mode=${mode}`
      }
    );
  }

  async executeOpen(runtimeConfig, {
    walletId,
    strategy,
    token,
    intent = {},
    note = ""
  }) {
    return this.submitOrder(runtimeConfig, {
      walletId,
      strategy,
      side: "BUY",
      token,
      intent,
      note
    });
  }

  async executeClose(runtimeConfig, {
    walletId,
    strategy,
    token,
    intent = {},
    note = ""
  }) {
    return this.submitOrder(runtimeConfig, {
      walletId,
      strategy,
      side: "SELL",
      token,
      intent,
      note
    });
  }

  async executePartial(runtimeConfig, {
    walletId,
    strategy,
    token,
    soldFraction = 0,
    currentPrice = 0,
    intent = {},
    note = ""
  }) {
    return this.submitOrder(runtimeConfig, {
      walletId,
      strategy,
      side: "SELL",
      token,
      intent: {
        ...clone(intent),
        soldFraction: safeNum(soldFraction, 0),
        expectedExitPrice: safeNum(currentPrice, 0)
      },
      note: note || `partial sell ${safeNum(soldFraction, 0)}`
    });
  }

  async markOrderFilled(identifier, patch = {}) {
    return this.orderStore.markFilled(identifier, patch);
  }

  async markOrderPartial(identifier, patch = {}) {
    return this.orderStore.markPartial(identifier, patch);
  }

  async markOrderFailed(identifier, patch = {}) {
    return this.orderStore.markFailed(identifier, patch);
  }

  async markOrderCancelled(identifier, patch = {}) {
    return this.orderStore.markCancelled(identifier, patch);
  }

  getOrder(identifier = {}) {
    return this.orderStore.findOrder(identifier);
  }

  listOpenOrders() {
    return this.orderStore.listOpenOrders();
  }

  buildOrdersText(limit = 15) {
    return this.orderStore.buildOrdersText(limit);
  }

  buildExecutionSummaryText(runtimeConfig) {
    const openOrders = this.listOpenOrders();
    const mode = asText(this.defaultMode, "dry_run");

    const strategyLines = ["scalp", "reversal", "runner", "copytrade"]
      .map((strategy) => {
        const walletId = this.walletService.getPrimaryWalletId(runtimeConfig, strategy);
        return `• ${strategy}: ${asText(walletId, "-")}`;
      })
      .join("\n");

    return `📦 <b>GMGN Execution</b>

mode: ${mode}
open orders: ${openOrders.length}
default slippage pct: ${safeNum(this.defaultSlippagePct, 0)}

<b>Primary wallets</b>
${strategyLines}`;
  }
}
