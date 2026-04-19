function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default class GMGNLeaderIntelService {
  constructor(options = {}) {
    this.client = options.client;
    this.logger = options.logger || console;
    this.cacheMs = Number.isFinite(options.cacheMs) ? options.cacheMs : 90_000;
    this.map = new Map();
  }

  normalizeLeader(address, payload = {}) {
    const stats = payload?.stats || payload?.data || payload || {};
    const recentWinRate = safeNum(stats.recentWinRate, safeNum(stats.winRate30dPct, 0));
    const recentPnlPct = safeNum(stats.recentPnlPct, safeNum(stats.pnl30dPct, 0));
    const maxDrawdownPct = safeNum(stats.maxDrawdownPct, 0);
    const medianRoi = safeNum(stats.medianRoi, 1);
    const chasePenalty = safeNum(stats.chasePenalty, 0);
    const dumpPenalty = safeNum(stats.dumpPenalty, 0);
    const consistency = safeNum(stats.consistencyScore, 0.5);

    let score = 50;
    if (recentWinRate >= 65) score += 12;
    else if (recentWinRate < 45) score -= 15;

    if (recentPnlPct >= 40) score += 12;
    else if (recentPnlPct < -10) score -= 12;

    if (medianRoi >= 1.5) score += 8;
    else if (medianRoi < 1) score -= 8;

    if (maxDrawdownPct > 18) score -= 15;
    if (chasePenalty > 0.55) score -= 10;
    if (dumpPenalty > 0.45) score -= 10;
    if (consistency >= 0.7) score += 8;

    score = Math.max(0, Math.min(100, Math.round(score)));

    let state = "active";
    if (score < 55 || maxDrawdownPct > 20) state = "cooldown";
    else if (score < 70) state = "watch";

    return {
      address,
      score,
      state,
      recentWinRate,
      recentPnlPct,
      maxDrawdownPct,
      medianRoi,
      chasePenalty,
      dumpPenalty,
      consistency,
      refreshedAt: Date.now(),
      raw: payload
    };
  }

  async getLeaderIntel(address) {
    const key = String(address || "").trim();
    if (!key) return null;

    const cached = this.map.get(key);
    if (cached && Date.now() - cached.refreshedAt < this.cacheMs) {
      return cached;
    }

    if (!this.client) {
      return this.normalizeLeader(key, {});
    }

    const stats = await this.client.fetchLeaderStats(key);
    if (!stats?.ok) {
      return cached || this.normalizeLeader(key, { stats: {} });
    }

    const normalized = this.normalizeLeader(key, stats.data);
    this.map.set(key, normalized);
    return normalized;
  }
}
