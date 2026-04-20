function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default class ManualApprovalBridge {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.txStore = options.txStore;
    this.jupiterQuoteService = options.jupiterQuoteService;
  }

  async createOpenApproval({
    runtimeConfig,
    intent,
    publicKey
  }) {
    const tokenMint = intent?.token?.ca;
    const amountSol = this.estimateAmountSolFromIntent(intent);

    const swapPlan = await this.jupiterQuoteService.buildOpenSwapPlan({
      tokenMint,
      amountSol,
      userPublicKey: publicKey,
      slippageBps: runtimeConfig?.execution?.slippageBps || 100
    });

    const row = {
      intentId: intent.intentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "awaiting_approval",
      intentType: intent.type,
      walletId: intent.walletId,
      strategy: intent.strategy,
      side: "BUY",
      token: clone(intent.token),
      amountSol,
      quote: clone(swapPlan.quote),
      swapPayload: clone(swapPlan.swapPayload),
      publicKey: publicKey || null
    };

    await this.txStore.upsertIntent(row);
    return row;
  }

  async createCloseApproval({
    runtimeConfig,
    intent,
    publicKey,
    amountRaw
  }) {
    const tokenMint = intent?.token?.ca;

    const swapPlan = await this.jupiterQuoteService.buildCloseSwapPlan({
      tokenMint,
      amountRaw,
      userPublicKey: publicKey,
      slippageBps: runtimeConfig?.execution?.slippageBps || 100
    });

    const row = {
      intentId: intent.intentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "awaiting_approval",
      intentType: intent.type,
      walletId: intent.walletId,
      strategy: intent.strategy,
      side: "SELL",
      token: clone(intent.token),
      amountRaw,
      quote: clone(swapPlan.quote),
      swapPayload: clone(swapPlan.swapPayload),
      publicKey: publicKey || null
    };

    await this.txStore.upsertIntent(row);
    return row;
  }

  async markSigned(intentId, signedTxBase64 = null) {
    return this.txStore.setStatus(intentId, "signed", {
      signedTxBase64: signedTxBase64 || null
    });
  }

  async markSubmitted(intentId, signature = null) {
    return this.txStore.setStatus(intentId, "submitted", {
      signature: signature || null,
      submittedAt: new Date().toISOString()
    });
  }

  async markConfirmed(intentId, signature = null) {
    return this.txStore.setStatus(intentId, "confirmed", {
      signature: signature || null,
      confirmedAt: new Date().toISOString()
    });
  }

  async markFailed(intentId, reason = "unknown") {
    return this.txStore.setStatus(intentId, "failed", {
      failureReason: reason
    });
  }

  estimateAmountSolFromIntent(intent) {
    const edge = safeNum(intent?.expectedEdgePct, 0);
    if (edge >= 25) return 1.5;
    if (edge >= 15) return 1.0;
    if (edge >= 8) return 0.6;
    return 0.25;
  }
}
