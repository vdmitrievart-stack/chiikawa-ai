function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

export default class GMGNLeaderIntelService {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.cache = new Map();
    this.tradeEventCache = new Map();

    this.enabled = process.env.GMGN_ENABLED === "true";
    this.mode = process.env.GMGN_MODE || "intel";
    this.autoRefreshSec = safeNum(process.env.GMGN_AUTO_REFRESH_SEC, 90);

    this.minRecentWinrate = safeNum(
      process.env.GMGN_MIN_LEADER_RECENT_WINRATE,
      55
    );
    this.minRecentPnlPct = safeNum(
      process.env.GMGN_MIN_LEADER_RECENT_PNL_PCT,
      0
    );
    this.maxLeaderDrawdownPct = safeNum(
      process.env.GMGN_MAX_LEADER_DRAWDOWN_PCT,
      25
    );
    this.cooldownMin = safeNum(
      process.env.GMGN_LEADER_COOLDOWN_MIN,
      180
    );

    this.tradeEventTtlSec = safeNum(
      process.env.GMGN_TRADE_EVENT_TTL_SEC,
      300
    );
    this.eventMaxAgeSec = safeNum(
      process.env.GMGN_EVENT_MAX_AGE_SEC,
      180
    );
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
      cachedLeaders: this.cache.size,
      cachedTradeEvents: this.tradeEventCache.size
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
      return clone(cached.value);
    }

    const intel = this.buildMockIntel(key);

    this.cache.set(key, {
      cachedAt: now,
      value: clone(intel)
    });

    return clone(intel);
  }

  async refreshMany(addresses = []) {
    const results = [];
    for (const address of addresses) {
      results.push(await this.getLeaderIntel(address));
    }
    return results;
  }

  pruneTradeEventCache() {
    const now = Date.now();
    for (const [leaderAddress, entry] of this.tradeEventCache.entries()) {
      if (!entry?.cachedAt) {
        this.tradeEventCache.delete(leaderAddress);
        continue;
      }

      if (now - safeNum(entry.cachedAt) > this.tradeEventTtlSec * 1000) {
        this.tradeEventCache.delete(leaderAddress);
      }
    }
  }

  normalizeTradeEvent(rawEvent, leaderAddress) {
    if (!rawEvent || typeof rawEvent !== "object") return null;

    const action = String(
      rawEvent.action ||
        rawEvent.side ||
        rawEvent.type ||
        "buy"
    ).toLowerCase();

    const tokenCa = String(
      rawEvent.tokenCa ||
        rawEvent.ca ||
        rawEvent.mint ||
        rawEvent.tokenAddress ||
        ""
    ).trim();

    const tokenSymbol = String(
      rawEvent.tokenSymbol ||
        rawEvent.symbol ||
        ""
    ).trim();

    const tokenName = String(
      rawEvent.tokenName ||
        rawEvent.name ||
        ""
    ).trim();

    const price = safeNum(
      rawEvent.priceUsd ??
        rawEvent.price ??
        rawEvent.entryPriceUsd,
      0
    );

    const timestamp =
      safeNum(rawEvent.timestamp, 0) ||
      safeNum(rawEvent.ts, 0) ||
      safeNum(rawEvent.time, 0) ||
      Date.now();

    const sizeUsd = safeNum(
      rawEvent.sizeUsd ??
        rawEvent.notionalUsd ??
        rawEvent.amountUsd,
      0
    );

    if (!tokenCa) return null;

    return {
      leaderAddress: String(leaderAddress || "").trim(),
      action,
      tokenCa,
      tokenSymbol,
      tokenName,
      priceUsd: price,
      sizeUsd,
      timestamp,
      receivedAt: Date.now(),
      raw: clone(rawEvent)
    };
  }

  async fetchLeaderTradeEvents(leaderAddress) {
    const key = String(leaderAddress || "").trim();
    if (!key) return [];

    const now = Date.now();
    const cached = this.tradeEventCache.get(key);

    if (cached && now - safeNum(cached.cachedAt) < this.autoRefreshSec * 1000) {
      return clone(cached.events || []);
    }

    let events = [];

    try {
      events = await this.fetchLeaderTradeEventsFromBackend(key);
    } catch (error) {
      this.logger.log("leader trade events fetch error:", error.message);
      events = [];
    }

    const normalized = events
      .map((x) => this.normalizeTradeEvent(x, key))
      .filter(Boolean)
      .sort((a, b) => safeNum(b.timestamp) - safeNum(a.timestamp));

    this.tradeEventCache.set(key, {
      cachedAt: now,
      events: clone(normalized)
    });

    this.pruneTradeEventCache();

    return clone(normalized);
  }

  async fetchLeaderTradeEventsFromBackend(leaderAddress) {
    if (!this.enabled) {
      return this.buildMockTradeEvents(leaderAddress);
    }

    if (this.mode === "intel" || this.mode === "mock") {
      return this.buildMockTradeEvents(leaderAddress);
    }

    return this.buildMockTradeEvents(leaderAddress);
  }

  buildMockTradeEvents(leaderAddress) {
    const seed = String(leaderAddress || "").length;
    const now = Date.now();

    return [
      {
        action: "buy",
        tokenCa: `MockTokenCA${seed}A`,
        tokenSymbol: "MOCKA",
        tokenName: "Mock A",
        priceUsd: 0.00012,
        sizeUsd: 180,
        timestamp: now - 35_000
      },
      {
        action: "buy",
        tokenCa: `MockTokenCA${seed}B`,
        tokenSymbol: "MOCKB",
        tokenName: "Mock B",
        priceUsd: 0.00021,
        sizeUsd: 220,
        timestamp: now - 95_000
      },
      {
        action: "sell",
        tokenCa: `MockTokenCA${seed}C`,
        tokenSymbol: "MOCKC",
        tokenName: "Mock C",
        priceUsd: 0.0004,
        sizeUsd: 140,
        timestamp: now - 160_000
      }
    ];
  }

  async findLatestBuyForToken(leaderAddress, tokenCa) {
    const key = String(leaderAddress || "").trim();
    const ca = String(tokenCa || "").trim();
    if (!key || !ca) return null;

    const events = await this.fetchLeaderTradeEvents(key);

    const event = events.find(
      (x) =>
        x.action === "buy" &&
        String(x.tokenCa || "").trim() === ca
    );

    if (!event) return null;

    const ageSec = Math.max(
      0,
      Math.round((Date.now() - safeNum(event.timestamp)) / 1000)
    );

    return {
      leaderAddress: key,
      tokenCa: ca,
      leaderBuyTs: safeNum(event.timestamp, 0),
      followDelaySec: ageSec,
      leaderBuyPriceUsd: safeNum(event.priceUsd, 0),
      leaderBuySizeUsd: safeNum(event.sizeUsd, 0),
      tokenSymbol: event.tokenSymbol || "",
      tokenName: event.tokenName || "",
      source: "leader_trade_event"
    };
  }

  async enrichCandidateWithLeaderTrade(runtimeConfig, candidate) {
    const next = clone(candidate || {});
    const tokenCa = String(next?.token?.ca || "").trim();
    if (!tokenCa) return next;

    const leaders = runtimeConfig?.copytrade?.leaders || [];
    if (!Array.isArray(leaders) || !leaders.length) return next;

    const tradableLeaders = leaders
      .filter((x) => {
        const state = String(x?.state || "").toLowerCase();
        return state === "active" || state === "watch" || !state;
      })
      .sort((a, b) => safeNum(b?.score) - safeNum(a?.score));

    let matched = null;

    for (const leader of tradableLeaders) {
      const row = await this.findLatestBuyForToken(leader.address, tokenCa);
      if (!row) continue;

      if (
        !matched ||
        safeNum(row.leaderBuyTs) > safeNum(matched.leaderBuyTs)
      ) {
        matched = {
          ...row,
          leaderScore: safeNum(leader.score, 0),
          leaderState: leader.state || "watch"
        };
      }
    }

    if (!matched) return next;

    const currentPrice = safeNum(next?.token?.price, 0);
    const leaderBuyPriceUsd = safeNum(matched.leaderBuyPriceUsd, 0);

    let priceExtensionPct = 0;
    if (currentPrice > 0 && leaderBuyPriceUsd > 0) {
      priceExtensionPct =
        ((currentPrice - leaderBuyPriceUsd) / leaderBuyPriceUsd) * 100;
    } else {
      priceExtensionPct = safeNum(next?.delta?.priceDeltaPct, 0);
    }

    next.leaderTrade = {
      address: matched.leaderAddress,
      buyTs: matched.leaderBuyTs,
      buyPriceUsd: leaderBuyPriceUsd,
      sizeUsd: matched.leaderBuySizeUsd,
      leaderScore: matched.leaderScore,
      leaderState: matched.leaderState,
      source: matched.source
    };

    next.copytradeMeta = {
      ...(next.copytradeMeta || {}),
      leaderBuyTs: matched.leaderBuyTs,
      followDelaySec: safeNum(matched.followDelaySec, 0),
      priceExtensionPct,
      source: matched.source,
      hasRealLeaderEvent: true
    };

    return next;
  }
}
