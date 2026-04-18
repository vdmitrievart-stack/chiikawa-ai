export default class Level6WalletScoringEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.defaults = {
      minTradesForConfidence: this.#num(options.minTradesForConfidence, 12),
      strongTradesThreshold: this.#num(options.strongTradesThreshold, 30),
      maxLookbackTrades: this.#num(options.maxLookbackTrades, 200)
    };
  }

  evaluateWallet(input = {}) {
    const trades = this.#normalizeTrades(input.trades || []);
    const walletAddress = String(input.walletAddress || input.address || "").trim();

    if (!trades.length) {
      return this.#emptyWalletScore(walletAddress);
    }

    const sliced = trades.slice(-this.defaults.maxLookbackTrades);

    const closedTrades = sliced.filter(t => t.isClosed);
    const wins = closedTrades.filter(t => t.realizedRoi > 1);
    const losses = closedTrades.filter(t => t.realizedRoi <= 1);

    const tradesCount = closedTrades.length;
    const winsCount = wins.length;
    const lossesCount = losses.length;

    const winRate = tradesCount > 0 ? winsCount / tradesCount : 0;
    const averageROI = this.#avg(closedTrades.map(t => t.realizedRoi), 1);
    const medianROI = this.#median(closedTrades.map(t => t.realizedRoi), 1);
    const averagePnLUsd = this.#avg(closedTrades.map(t => t.realizedPnlUsd), 0);
    const medianPnLUsd = this.#median(closedTrades.map(t => t.realizedPnlUsd), 0);

    const maxDrawdown = this.#computeMaxDrawdown(closedTrades);
    const averageHoldMinutes = this.#avg(
      closedTrades
        .map(t => t.holdMinutes)
        .filter(v => Number.isFinite(v) && v >= 0),
      0
    );

    const earlyEntryScore = this.#computeEarlyEntryScore(closedTrades);
    const chasePenalty = this.#computeChasePenalty(closedTrades);
    const dumpPenalty = this.#computeDumpPenalty(closedTrades);
    const consistencyScore = this.#computeConsistencyScore(closedTrades);
    const sizeDisciplineScore = this.#computeSizeDisciplineScore(closedTrades);

    const confidence = this.#computeConfidence(tradesCount);
    const walletScore = this.#computeWalletScore({
      tradesCount,
      winRate,
      averageROI,
      medianROI,
      maxDrawdown,
      averageHoldMinutes,
      earlyEntryScore,
      chasePenalty,
      dumpPenalty,
      consistencyScore,
      sizeDisciplineScore,
      confidence
    });

    return {
      ok: true,
      walletAddress,
      tradesCount,
      winsCount,
      lossesCount
