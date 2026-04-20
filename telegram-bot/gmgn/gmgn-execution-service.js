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

    this.dryRunAutoFill = options.dryRunAutoFill !== false;
  }

  requireDeps() {
    if (!this.walletService) {
      throw new Error("GMGNExecutionService requires walletService");
    }
    if (!this.orderStore) {
      throw new Error("GMGNExecutionService requires orderStore");
    }
  }

  makeClientOrderId(strategy, walletId, tokenCa, side, operation) {
    return [
      "gmgn",
      asText(strategy, "strategy"),
      asText(operation, "op"),
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

  normalizeOperation(operation) {
    const op = asText(operation, "open").toLowerCase();
    if (op === "close") return "close";
    if (op === "partial") return "partial";
    return "open";
  }

  estimateSizeFromIntent(intent = {}, operation = "open") {
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

      if (operation === "partial") {
        amountSol = Math.max(0.1, amountSol * 0.5);
      }
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
    operation,
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
    const normalizedOperation = this.normalizeOperation(operation);
    const clientOrderId = this.makeClientOrderId(
      strategy,
      walletId,
      tokenObj.ca,
      side,
      normalizedOperation
    );

    return {
      orderId: "",
      clientOrderId,
      walletId,
      gmgnWalletId: asText(profile.gmgnWalletId),
      gmgnAccountId: asText(profile.gmgnAccountId),
      strategy: asText(strategy),
      operation: normalizedOperation,
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
      size: this.estimateSizeFromIntent(
        {
          ...clone(intent),
          strategy
        },
        normalizedOperation
      ),
      pricing: {
        expectedEntryPrice: safeNum(intent.expectedEntryPrice ?? tokenObj.price, 0),
        executedEntryPrice: 0,
        expectedExitPrice: safeNum(intent.expectedExitPrice, 0),
        executedExitPrice: 0,
        slippagePct: safeNum(intent.slippagePct, this.defaultSlippagePct)
      },
      metrics: {
        pnlHintPct: 0,
        pnlHintSol: 0,
        soldFraction: safeNum(intent.soldFraction, 0)
      },
      source: "gmgn",
      mode: asText(profile.executionMode, this.defaultMode),
      note: asText(note),
      reason: "",
      signature: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [],
      raw: {
        walletProfile: profile,
        intent: clone(intent)
      }
    };
  }

  buildPnlHint(order) {
    const operation = this.normalizeOperation(order?.operation);
    const expectedEntryPrice = safeNum(order?.pricing?.expectedEntryPrice, 0);
    const expectedExitPrice = safeNum(order?.pricing?.expectedExitPrice, 0);
    const amountSol = safeNum(order?.size?.amountSol, 0);
    const soldFraction = safeNum(order?.metrics?.soldFraction, 0);

    if (operation === "open") {
      return {
        pnlHintPct: 0,
        pnlHintSol: 0,
        soldFraction
      };
    }

    if (expectedEntryPrice <= 0 || expectedExitPrice <= 0 || amountSol <= 0) {
      return {
        pnlHintPct: 0,
        pnlHintSol: 0,
        soldFraction
      };
    }

    const pnlHintPct = ((expectedExitPrice - expectedEntryPrice) / expectedEntryPrice) * 100;
    const pnlHintSol = amountSol * (pnlHintPct / 100);

    return {
      pnlHintPct,
      pnlHintSol,
      soldFraction
    };
  }

  buildDryRunFillPatch(order) {
    const operation = this.normalizeOperation(order?.operation);
    const side = this.normalizeSide(order?.side);
    const expectedEntryPrice = safeNum(order?.pricing?.expectedEntryPrice, 0);
    const expectedExitPrice = safeNum(order?.pricing?.expectedExitPrice, 0);

    const pricing = {
      expectedEntryPrice,
      executedEntryPrice: 0,
      expectedExitPrice,
      executedExitPrice: 0,
      slippagePct: safeNum(order?.pricing?.slippagePct, this.defaultSlippagePct)
    };

    if (operation === "open" && side === "BUY") {
      pricing.executedEntryPrice = expectedEntryPrice;
    } else {
      pricing.executedExitPrice = expectedExitPrice > 0 ? expectedExitPrice : expectedEntryPrice;
    }

    return {
      operation,
      note: `dry_run auto-filled (${operation})`,
      pricing,
      metrics: this.buildPnlHint({
        ...order,
        pricing
      })
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
          operation: order.operation,
          reason: "execution_disabled",
          note: "GMGN execution disabled"
        }
      );
    }

    const submitted = await this.orderStore.markSubmitted(
      { clientOrderId: order.clientOrderId },
      {
        operation: order.operation,
        metrics: {
          soldFraction: safeNum(order?.metrics?.soldFraction, 0)
        },
        note:
          mode === "external_manual"
            ? "waiting for external GMGN wallet execution"
            : `submitted (${mode})`
      }
    );

    if (mode === "dry_run" && this.dryRunAutoFill) {
      return this.orderStore.markFilled(
        { clientOrderId: order.clientOrderId },
        this.buildDryRunFillPatch(submitted || order)
      );
    }

    if (mode === "external_manual" || mode === "dry_run") {
      return this.orderStore.findOrder({ clientOrderId: order.clientOrderId });
    }

    return this.orderStore.markFailed(
      { clientOrderId: order.clientOrderId },
      {
        operation: order.operation,
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
      operation: "open",
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
      operation: "close",
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
      operation: "partial",
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
    const statusCounts = this.orderStore.countByStatus();
    const opCounts = this.orderStore.countByOperation();

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

<b>Status counters</b>
created: ${safeNum(statusCounts.created)}
submitted: ${safeNum(statusCounts.submitted)}
filled: ${safeNum(statusCounts.filled)}
partial: ${safeNum(statusCounts.partial)}
failed: ${safeNum(statusCounts.failed)}
cancelled: ${safeNum(statusCounts.cancelled)}

<b>Operation counters</b>
open: ${safeNum(opCounts.open)}
close: ${safeNum(opCounts.close)}
partial: ${safeNum(opCounts.partial)}

<b>Primary wallets</b>
${strategyLines}`;
  }
}
