export class Level6TradingOrchestrator {
  constructor({ dryRun = true } = {}) {
    this.dryRun = dryRun;
    this.openTrades = [];
    this.journal = [];
  }

  tryEnter(signal) {
    const score = this.calculateScore(signal);

    if (score < 60) {
      return null;
    }

    const trade = {
      token: signal.token,
      entry: signal.price,
      current: signal.price,
      pnl: 0,
      score,
      createdAt: Date.now()
    };

    this.openTrades.push(trade);
    return trade;
  }

  calculateScore(signal) {
    let score = 0;

    if (signal.volumeSpike) score += 25;
    if (signal.smartWallets) score += 25;
    if (signal.liquidity > 10000) score += 20;
    if (signal.hypeScore > 70) score += 20;

    return score;
  }

  updateTrade(trade, price) {
    trade.current = price;
    trade.pnl = ((price - trade.entry) / trade.entry) * 100;
  }

  shouldExit(trade) {
    if (trade.pnl >= 25) return "TAKE_PROFIT";
    if (trade.pnl <= -12) return "STOP_LOSS";

    const life = Date.now() - trade.createdAt;
    if (life > 15000) return "TIME_EXIT";

    return null;
  }

  closeTrade(trade, reason) {
    this.openTrades = this.openTrades.filter(t => t !== trade);

    const closed = {
      ...trade,
      exitReason: reason,
      closedAt: Date.now()
    };

    this.journal.push(closed);
    return closed;
  }

  getOpenTrades() {
    return this.openTrades;
  }

  getJournal() {
    return this.journal;
  }
}
