export default class Level5RiskEngine {
  constructor(options = {}) {
    this.maxTradeUsd = Number.isFinite(options.maxTradeUsd) ? options.maxTradeUsd : 250;
    this.maxSlippageBps = Number.isFinite(options.maxSlippageBps) ? options.maxSlippageBps : 300;
    this.allowedSides = new Set(["buy", "sell"]);
    this.blockedMints = new Set(Array.isArray(options.blockedMints) ? options.blockedMints : []);
  }

  validateTrade(trade = {}) {
    const side = String(trade.side || trade.action || "").toLowerCase();
    const inputMint = String(trade.inputMint || "").trim();
    const outputMint = String(trade.outputMint || "").trim();
    const amountAtomic = Number(trade.amountAtomic || 0);
    const sizeUsd = Number(trade.sizeUsd || 0);
    const slippageBps = Number(trade.slippageBps || 0);

    if (!this.allowedSides.has(side)) {
      return { ok: false, reason: "invalid_side" };
    }

    if (!inputMint || !outputMint) {
      return { ok: false, reason: "missing_mints" };
    }

    if (inputMint === outputMint) {
      return { ok: false, reason: "same_input_output_mint" };
    }

    if (!Number.isFinite(amountAtomic) || amountAtomic <= 0) {
      return { ok: false, reason: "invalid_amount_atomic" };
    }

    if (Number.isFinite(sizeUsd) && sizeUsd > 0 && sizeUsd > this.maxTradeUsd) {
      return { ok: false, reason: "trade_size_exceeds_limit" };
    }

    if (Number.isFinite(slippageBps) && slippageBps > this.maxSlippageBps) {
      return { ok: false, reason: "slippage_exceeds_limit" };
    }

    if (this.blockedMints.has(inputMint) || this.blockedMints.has(outputMint)) {
      return { ok: false, reason: "blocked_mint" };
    }

    return { ok: true };
  }
}
