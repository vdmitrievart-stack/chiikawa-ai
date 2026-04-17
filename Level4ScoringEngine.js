import Level4StorageKeys from "./Level4StorageKeys.js";

class Level4ScoringEngine {
  /**
   * @param {Object} deps
   * @param {import('./Level4JsonStorage.js').default} deps.storage
   */
  constructor({ storage }) {
    if (!storage) {
      throw new Error("Level4ScoringEngine requires storage");
    }

    this.storage = storage;
    this.collection = Level4StorageKeys.SCORING;
  }

  async init() {
    await this.storage.createIfMissing(
      this.collection,
      {
        leaders: {},
        wallets: {},
        tokens: {},
        snapshots: []
      },
      {
        schema: "scoring-engine"
      }
    );
  }

  async upsertLeaderMetrics(leaderId, metrics = {}) {
    const id = String(leaderId || "").trim();
    if (!id) throw new Error("leaderId is required");

    const envelope = await this.storage.update(
      this.collection,
      current => {
        current.leaders ||= {};
        current.wallets ||= {};
        current.tokens ||= {};
        current.snapshots ||= [];

        const prev = current.leaders[id] || {};
        const updated = {
          leaderId: id,
          pnlUsd: Number(metrics.pnlUsd ?? prev.pnlUsd ?? 0),
          roiPct: Number(metrics.roiPct ?? prev.roiPct ?? 0),
          winRate: Number(metrics.winRate ?? prev.winRate ?? 0),
          avgHoldMinutes: Number(metrics.avgHoldMinutes ?? prev.avgHoldMinutes ?? 0),
          maxDrawdownPct: Number(metrics.maxDrawdownPct ?? prev.maxDrawdownPct ?? 0),
          consistency: Number(metrics.consistency ?? prev.consistency ?? 0),
          tradeCount: Number(metrics.tradeCount ?? prev.tradeCount ?? 0),
          lastTradeAt: metrics.lastTradeAt || prev.lastTradeAt || null,
          updatedAt: new Date().toISOString()
        };

        updated.score = this.computeLeaderScore(updated);
        current.leaders[id] = updated;

        current.snapshots.unshift({
          snapshotId: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          type: "leader_score_update",
          entityId: id,
          score: updated.score,
          createdAt: new Date().toISOString()
        });

        current.snapshots = current.snapshots.slice(0, 2000);

        return current;
      },
      {
        fallbackData: { leaders: {}, wallets: {}, tokens: {}, snapshots: [] },
        meta: { schema: "scoring-engine" }
      }
    );

    return envelope.data.leaders[id];
  }

  async getLeaderScore(leaderId) {
    const data = await this.storage.readData(this.collection, {
      leaders: {},
      wallets: {},
      tokens: {},
      snapshots: []
    });

    return data.leaders?.[leaderId] || null;
  }

  async listTopLeaders(limit = 10) {
    const data = await this.storage.readData(this.collection, {
      leaders: {},
      wallets: {},
      tokens: {},
      snapshots: []
    });

    return Object.values(data.leaders || {})
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, Math.max(1, limit));
  }

  computeLeaderScore(metrics) {
    const pnlFactor = this._clamp(this._normalize(metrics.pnlUsd, 0, 10000), 0, 1);
    const roiFactor = this._clamp(this._normalize(metrics.roiPct, -50, 300), 0, 1);
    const winRateFactor = this._clamp(this._normalize(metrics.winRate, 20, 90), 0, 1);
    const consistencyFactor = this._clamp(this._normalize(metrics.consistency, 0, 100), 0, 1);
    const drawdownPenalty = 1 - this._clamp(this._normalize(metrics.maxDrawdownPct, 0, 60), 0, 1);
    const tradeCountFactor = this._clamp(this._normalize(metrics.tradeCount, 0, 200), 0, 1);

    const raw =
      pnlFactor * 25 +
      roiFactor * 20 +
      winRateFactor * 20 +
      consistencyFactor * 15 +
      drawdownPenalty * 15 +
      tradeCountFactor * 5;

    return Number(raw.toFixed(2));
  }

  _normalize(value, min, max) {
    const num = Number(value || 0);
    if (max <= min) return 0;
    return (num - min) / (max - min);
  }

  _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
}

export default Level4ScoringEngine;
