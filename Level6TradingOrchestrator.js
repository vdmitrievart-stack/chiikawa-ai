// Level6TradingOrchestrator.js

export class Level6TradingOrchestrator {
  constructor(opts = {}) {
    this.dryRun = opts.dryRun ?? true;

    this.openTrades = [];
    this.journal = [];
  }

  // =====================
  // ENTRY
  // =====================

  async tryEnter(signal) {
    const score = this.calculateScore(signal);

    if (score < 70) return null;

    const trade = {
      id: Date.now(),
      token: signal.token,
      entry: signal.price,
      current: signal.price,
      pnl: 0,
      score,
      createdAt: Date.now(),
      updates: 0
    };

    this.openTrades.push(trade);

    return trade;
  }

  // =====================
  // SCORE
  // =====================

  calculateScore(signal) {
    let score = 50;

    if (signal.volumeSpike) score += 15;
    if (signal.smartWallets) score += 15;
    if (signal.liquidity > 10000) score += 10;
    if (signal.hypeScore > 70) score += 10;

    return score;
  }

  // =====================
  // UPDATE TRADE
  // =====================

  updateTrade(trade, price) {
    trade.current = price;
    trade.pnl = ((price - trade.entry) / trade.entry) * 100;
    trade.updates++;

    return trade;
  }

  // =====================
  // EXIT LOGIC
  // =====================

  shouldExit(trade) {
    if (trade.pnl >= 25) return "TP";
    if (trade.pnl <= -12) return "SL";
    if (trade.updates > 10 && trade.pnl < 5) return "WEAK";

    return null;
  }

  closeTrade(trade, reason) {
    this.openTrades = this.openTrades.filter(t => t.id !== trade.id);

    const result = {
      ...trade,
      closedAt: Date.now(),
      reason
    };

    this.journal.push(result);

    return result;
  }

  // =====================
  // GETTERS
  // =====================

  getOpenTrades() {
    return this.openTrades;
  }

  getJournal() {
    return this.journal;
  }
}
