import fs from "fs";
import path from "path";

export default class Level6TradeJournal {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir =
      options.baseDir || path.join(process.cwd(), "data", "trading", "level6");
    this.filePath =
      options.filePath || path.join(this.baseDir, "level6-trade-journal.json");

    this.state = {
      trades: [],
      updatedAt: new Date().toISOString()
    };
  }

  async init() {
    await fs.promises.mkdir(this.baseDir, { recursive: true });

    try {
      const raw = await fs.promises.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      this.state = {
        trades: Array.isArray(parsed?.trades) ? parsed.trades : [],
        updatedAt: parsed?.updatedAt || new Date().toISOString()
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.logger.error("Level6TradeJournal init error:", error.message);
      }
      await this.#save();
    }

    return { ok: true, trades: this.state.trades.length };
  }

  async recordEntry(entry = {}) {
    const tradeId = String(
      entry.tradeId ||
        `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );

    const record = {
      tradeId,
      token: {
        ca: String(entry.token?.ca || ""),
        symbol: String(entry.token?.symbol || "UNKNOWN"),
        name: String(entry.token?.name || "")
      },
      walletId: String(entry.walletId || ""),
      entryMode: String(entry.entryMode || "UNKNOWN"),
      entryPriceUsd: this.#num(entry.entryPriceUsd, 0),
      entrySizeUsd: this.#num(entry.entrySizeUsd, 0),
      entryTokenAmount: this.#num(entry.entryTokenAmount, 0),
      decision: entry.decision || null,
      exitPlan: entry.exitPlan || null,
      snapshots: {
        token: entry.snapshots?.token || null,
        walletIntel: entry.snapshots?.walletIntel || null,
        volumeIntel: entry.snapshots?.volumeIntel || null,
        socialIntel: entry.snapshots?.socialIntel || null,
        bubbleMapIntel: entry.snapshots?.bubbleMapIntel || null
      },
      lifecycle: {
        tp1Taken: false,
        tp2Taken: false,
        closed: false
      },
      performance: {
        currentPriceUsd: this.#num(entry.entryPriceUsd, 0),
        peakPriceUsd: this.#num(entry.entryPriceUsd, 0),
        worstPriceUsd: this.#num(entry.entryPriceUsd, 0),
        realizedPnlUsd: 0,
        realizedPnlPct: 0,
        maxFavorableExcursionPct: 0,
        maxAdverseExcursionPct: 0
      },
      notes: Array.isArray(entry.notes) ? entry.notes : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.state.trades.unshift(record);
    await this.#trimAndSave();

    return { ok: true, tradeId };
  }

  async markTpTaken(tradeId, stage, data = {}) {
    const trade = this.#findTrade(tradeId);
    if (!trade) {
      return { ok: false, error: "trade_not_found" };
    }

    if (stage === "TP1") {
      trade.lifecycle.tp1Taken = true;
    }
    if (stage === "TP2") {
      trade.lifecycle.tp2Taken = true;
    }

    if (data.priceUsd !== undefined) {
      trade.performance.currentPriceUsd = this.#num(data.priceUsd, trade.performance.currentPriceUsd);
    }

    if (data.realizedPnlUsd !== undefined) {
      trade.performance.realizedPnlUsd = this.#num(data.realizedPnlUsd, trade.performance.realizedPnlUsd);
    }

    if (data.realizedPnlPct !== undefined) {
      trade.performance.realizedPnlPct = this.#num(data.realizedPnlPct, trade.performance.realizedPnlPct);
    }

    trade.updatedAt = new Date().toISOString();
    await this.#save();

    return { ok: true };
  }

  async updateMarketSnapshot(tradeId, snapshot = {}) {
    const trade = this.#findTrade(tradeId);
    if (!trade) {
      return { ok: false, error: "trade_not_found" };
    }

    const priceUsd = this.#num(snapshot.currentPriceUsd, trade.performance.currentPriceUsd);
    trade.performance.currentPriceUsd = priceUsd;
    trade.performance.peakPriceUsd = Math.max(
      this.#num(trade.performance.peakPriceUsd, priceUsd),
      priceUsd
    );
    trade.performance.worstPriceUsd = Math.min(
      this.#num(trade.performance.worstPriceUsd, priceUsd),
      priceUsd
    );

    const entryPriceUsd = this.#num(trade.entryPriceUsd, 0);
    if (entryPriceUsd > 0) {
      const mfe =
        ((trade.performance.peakPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
      const mae =
        ((trade.performance.worstPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;

      trade.performance.maxFavorableExcursionPct = Math.max(
        this.#num(trade.performance.maxFavorableExcursionPct, 0),
        mfe
      );

      trade.performance.maxAdverseExcursionPct = Math.min(
        this.#num(trade.performance.maxAdverseExcursionPct, 0),
        mae
      );
    }

    trade.updatedAt = new Date().toISOString();
    await this.#save();

    return { ok: true };
  }

  async closeTrade(tradeId, exit = {}) {
    const trade = this.#findTrade(tradeId);
    if (!trade) {
      return { ok: false, error: "trade_not_found" };
    }

    const exitPriceUsd = this.#num(exit.exitPriceUsd, trade.performance.currentPriceUsd);
    const exitTokenAmount = this.#num(exit.exitTokenAmount, trade.entryTokenAmount);
    const entryPriceUsd = this.#num(trade.entryPriceUsd, 0);

    const realizedPnlUsd =
      (exitPriceUsd - entryPriceUsd) * exitTokenAmount;

    const realizedPnlPct =
      entryPriceUsd > 0
        ? ((exitPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
        : 0;

    trade.lifecycle.closed = true;
    trade.exit = {
      reason: String(exit.reason || "unknown_exit"),
      action: String(exit.action || "FULL_EXIT"),
      exitPriceUsd,
      exitTokenAmount,
      timestamp: new Date().toISOString()
    };

    trade.performance.currentPriceUsd = exitPriceUsd;
    trade.performance.realizedPnlUsd = realizedPnlUsd;
    trade.performance.realizedPnlPct = realizedPnlPct;

    trade.updatedAt = new Date().toISOString();
    await this.#save();

    return {
      ok: true,
      realizedPnlUsd,
      realizedPnlPct
    };
  }

  async summarizePerformance() {
    const closed = this.state.trades.filter(t => t.lifecycle?.closed);

    if (!closed.length) {
      return {
        ok: true,
        totalTrades: 0,
        closedTrades: 0,
        winRate: 0,
        averagePnlPct: 0,
        medianPnlPct: 0,
        totalPnlUsd: 0
      };
    }

    const pnls = closed.map(t => this.#num(t.performance?.realizedPnlPct, 0));
    const pnlUsd = closed.map(t => this.#num(t.performance?.realizedPnlUsd, 0));
    const wins = pnls.filter(x => x > 0).length;

    return {
      ok: true,
      totalTrades: this.state.trades.length,
      closedTrades: closed.length,
      winRate: wins / closed.length,
      averagePnlPct: this.#avg(pnls, 0),
      medianPnlPct: this.#median(pnls, 0),
      totalPnlUsd: pnlUsd.reduce((a, b) => a + b, 0)
    };
  }

  async getOpenTrades() {
    return this.state.trades.filter(t => !t.lifecycle?.closed);
  }

  async getTradeById(tradeId) {
    return this.#findTrade(tradeId) || null;
  }

  #findTrade(tradeId) {
    return this.state.trades.find(t => t.tradeId === tradeId);
  }

  async #trimAndSave() {
    this.state.trades = this.state.trades.slice(0, 5000);
    await this.#save();
  }

  async #save() {
    this.state.updatedAt = new Date().toISOString();
    await fs.promises.mkdir(this.baseDir, { recursive: true });
    await fs.promises.writeFile(
      this.filePath,
      JSON.stringify(this.state, null, 2),
      "utf8"
    );
  }

  #avg(arr, fallback = 0) {
    if (!Array.isArray(arr) || !arr.length) return fallback;
    return arr.reduce((a, b) => a + this.#num(b, 0), 0) / arr.length;
  }

  #median(arr, fallback = 0) {
    if (!Array.isArray(arr) || !arr.length) return fallback;
    const sorted = [...arr].map(x => this.#num(x, 0)).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  #num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
}
