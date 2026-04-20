function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

export default class GMGNLeaderIntelService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.cache = new Map();
    this.enabled = process.env.GMGN_ENABLED === "true";
    this.mode = process.env.GMGN_MODE || "intel";
    this.autoRefreshSec = safeNum(process.env.GMGN_AUTO_REFRESH_SEC, 90);
    this.minRecentWinrate = safeNum(process.env.GMGN_MIN_LEADER_RECENT_WINRATE, 55);
    this.minRecentPnlPct = safeNum(process.env.GMGN_MIN_LEADER_RECENT_PNL_PCT, 0);
    this.maxLeaderDrawdownPct = safeNum(process.env.GMGN_MAX_LEADER_DRAWDOWN_PCT, 25);
    this.cooldownMin = safeNum(process.env.GMGN_LEADER_COOLDOWN_MIN, 180);
  }

  getHealth() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      autoRefreshSec: this.autoRefreshSec,
      minRecentWinrate: this.minRecentWinrate,
      minRecentPnlPct: this.minRecentPnlPct,
      maxLeaderDrawdownPct: this.maxLeaderDrawdownPct,
      cooldownMin: this.cooldownMin,
      cachedLeaders: this.cache.size
    };
  }

  buildMockIntel(address) {
    const seed = String(address || "").length;
    const recentWinrate = 52 + (seed % 21);
    const recentPnlPct = -2 + (seed % 13);
    const maxDrawdownPct = 8 + (seed % 18);

    let score = 50;
    score += recentWinrate >= this.minRecentWinrate ? 15 : -12;
    score += recentPnlPct >= this.minRecentPnlPct ? 10 : -10;
    score += maxDrawdownPct <= this.maxLeaderDrawdownPct ? 12 : -15;

    let state = "watch";
    if (score >= 82) state = "active";
    else if (score >= 65) state = "watch";
    else if (score >= 45) state = "cooldown";
    else state = "ignored";

    return {
      address,
      score,
      recentWinrate,
      recentPnlPct,
      maxDrawdownPct,
      state,
      source: this.enabled ? "gmgn_ready_mock" : "mock",
      lastSyncAt: nowIso(),
      reasons: [
        `recentWinrate=${recentWinrate}`,
        `recentPnlPct=${recentPnlPct}`,
        `maxDrawdownPct=${maxDrawdownPct}`
      ]
    };
  }

  async getLeaderIntel(address) {
    const key = String(address || "").trim();
    if (!key) {
      return {
        address: "",
        score: 0,
        recentWinrate: 0,
        recentPnlPct: 0,
        maxDrawdownPct: 100,
        state: "ignored",
        source: "empty",
        lastSyncAt: nowIso(),
        reasons: ["empty_address"]
      };
    }

    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && now - safeNum(cached.cachedAt) < this.autoRefreshSec * 1000) {
      return cached.value;
    }

    const intel = this.buildMockIntel(key);

    this.cache.set(key, {
      cachedAt: now,
      value: intel
    });

    return intel;
  }

  async refreshMany(addresses = []) {
    const results = [];
    for (const address of addresses) {
      results.push(await this.getLeaderIntel(address));
    }
    return results;
  }
}
