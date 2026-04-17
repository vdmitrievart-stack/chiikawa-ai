import Level5RiskEngine from "./Level5RiskEngine.js";
import Level5JupiterClient from "./Level5JupiterClient.js";
import Level5SolanaSigner from "./Level5SolanaSigner.js";

export default class Level5ExecutionEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.risk = options.risk || new Level5RiskEngine({
      maxTradeUsd: options.maxTradeUsd ?? 250,
      maxSlippageBps: options.maxSlippageBps ?? 300,
      blockedMints: options.blockedMints || []
    });

    this.signer = options.signer || new Level5SolanaSigner({
      rpcUrl: options.rpcUrl,
      secretKeyBase58: options.secretKeyBase58,
      commitment: "confirmed"
    });

    this.jupiter = options.jupiter || new Level5JupiterClient({
      apiKey: options.jupiterApiKey,
      defaultTimeoutMs: options.jupiterTimeoutMs ?? 15000
    });
  }

  getWalletAddress() {
    return this.signer.getPublicKeyBase58();
  }

  async buildExecutionPlan(trade = {}) {
    const validation = this.risk.validateTrade(trade);
    if (!validation.ok) {
      return {
        ok: false,
        stage: "risk",
        reason: validation.reason
      };
    }

    const taker = this.getWalletAddress();

    const order = await this.jupiter.getOrder({
      inputMint: trade.inputMint,
      outputMint: trade.outputMint,
      amount: trade.amountAtomic,
      taker,
      slippageBps: trade.slippageBps ?? 100,
      swapMode: trade.swapMode || "ExactIn"
    });

    return {
      ok: true,
      stage: "planned",
      taker,
      order
    };
  }

  async executeTrade(trade = {}) {
    const plan = await this.buildExecutionPlan(trade);
    if (!plan.ok) return plan;

    const requestId = plan.order?.requestId;
    const transaction = plan.order?.transaction;

    if (!requestId || !transaction) {
      return {
        ok: false,
        stage: "order",
        reason: "missing_request_id_or_transaction"
      };
    }

    const signedTx = this.signer.signVersionedTransaction(transaction);
    const signedBase64 = Buffer.from(signedTx.serialize()).toString("base64");

    const execution = await this.jupiter.executeOrder({
      requestId,
      signedTransaction: signedBase64
    });

    return {
      ok: true,
      stage: "executed",
      wallet: this.getWalletAddress(),
      requestId,
      execution
    };
  }

  async executeBuy({
    inputMint,
    outputMint,
    amountAtomic,
    sizeUsd = 0,
    slippageBps = 100
  }) {
    return this.executeTrade({
      side: "buy",
      inputMint,
      outputMint,
      amountAtomic,
      sizeUsd,
      slippageBps
    });
  }

  async executeSell({
    inputMint,
    outputMint,
    amountAtomic,
    sizeUsd = 0,
    slippageBps = 100
  }) {
    return this.executeTrade({
      side: "sell",
      inputMint,
      outputMint,
      amountAtomic,
      sizeUsd,
      slippageBps
    });
  }
}
