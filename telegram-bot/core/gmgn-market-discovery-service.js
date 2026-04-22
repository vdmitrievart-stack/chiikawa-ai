function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safeGet(obj, paths = [], fallback = null) {
  for (const path of paths) {
    const parts = String(path).split(".");
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur == null || !(part in cur)) {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    if (ok && cur != null) return cur;
  }
  return fallback;
}

function uniqStrings(rows = []) {
  return [...new Set(rows.map((x) => asText(x)).filter(Boolean))];
}

const DEFAULT_FILTERS = ["not_honeypot"];
const DEFAULT_CONFIGS = [
  { period: "5m", orderBy: "volume", direction: "desc", weight: 1.2 },
  { period: "1h", orderBy: "smartmoney", direction: "desc", weight: 1.25 },
  { period: "1h", orderBy: "swaps", direction: "desc", weight: 1.05 },
  { period: "6h", orderBy: "holder_count", direction: "desc", weight: 0.95 },
  { period: "24h", orderBy: "volume", direction: "desc", weight: 0.9 }
];

export default class GMGNMarketDiscoveryService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.chain = options.chain || "sol";
    this.enabled = options.enabled !== false;
    this.baseUrl = asText(options.baseUrl || process.env.GMGN_DISCOVERY_BASE_URL, "https://gmgn.ai");
    this.rankPath = asText(options.rankPath || process.env.GMGN_DISCOVERY_RANK_PATH, "/defi/quotation/v1/rank");
    this.maxPerSource = Number(options.maxPerSource || process.env.GMGN_DISCOVERY_MAX_PER_SOURCE || 40);
    this.timeoutMs = Number(options.timeoutMs || process.env.GMGN_DISCOVERY_TIMEOUT_MS || 12000);
    this.filters = uniqStrings(
      asText(process.env.GMGN_DISCOVERY_FILTERS, "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    );
    this.rankConfigs = Array.isArray(options.rankConfigs) && options.rankConfigs.length
      ? options.rankConfigs
      : DEFAULT_CONFIGS;
  }

  buildRankUrl(config = {}) {
    const period = asText(config.period, "1h");
    const orderBy = asText(config.orderBy, "volume");
    const direction = asText(config.direction, "desc");
    const filters = (this.filters.length ? this.filters : DEFAULT_FILTERS)
      .map((value) => `filters[]=${encodeURIComponent(value)}`)
      .join("&");

    return `${this.baseUrl}${this.rankPath}/${this.chain}/swaps/${period}?orderby=${encodeURIComponent(orderBy)}&direction=${encodeURIComponent(direction)}${filters ? `&${filters}` : ""}`;
  }

  async fetchJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": process.env.GMGN_DISCOVERY_USER_AGENT || "Mozilla/5.0 (ChiikawaDiscoveryBot)",
          "Accept": "application/json, text/plain, */*",
          "Referer": `${this.baseUrl}/trade?chain=${this.chain}`
        },
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  normalizeRow(row = {}, config = {}) {
    const ca = asText(safeGet(row, ["address", "token_address", "base_token_info.address", "token.address", "ca"]));
    if (!ca) return null;

    const period = asText(config.period, "1h");
    const orderBy = asText(config.orderBy, "volume");
    const weight = safeNum(config.weight, 1);

    const liquidityUsd = safeNum(safeGet(row, ["liquidity", "liquidity_usd", "liquidityUsd", "pool_info.liquidity_usd"]), 0);
    const marketCapUsd = safeNum(safeGet(row, ["market_cap", "marketcap", "marketCapUsd", "fdv", "fdv_usd"]), 0);
    const holderCount = safeNum(safeGet(row, ["holder_count", "holders", "holderCount"]), 0);
    const smartMoney = safeNum(safeGet(row, ["smartmoney", "smart_money", "smartMoney", "smart_money_score"]), 0);
    const swaps = safeNum(safeGet(row, ["swaps", "swap_count", "txns", "txn_count"]), 0);
    const volume = safeNum(safeGet(row, ["volume", "volume_usd", `volume_${period}`, "buy_volume", "buy_volume_usd"]), 0);
    const price = safeNum(safeGet(row, ["price", "price_usd", "priceUsd"]), 0);
    const priceChange = safeNum(safeGet(row, ["price_change_percent", `price_change_${period}`, `price_${period}_change_percent`, "priceChangePct"]), 0);
    const openTimestamp = safeNum(safeGet(row, ["open_timestamp", "created_at", "launch_time", "createdAt"]), 0);

    let sourceScore = 0;
    sourceScore += clamp(45 - safeNum(safeGet(row, ["rank", "position", "sort_rank"]), 50), 0, 45);
    sourceScore += Math.min(18, smartMoney / 5) * (orderBy === "smartmoney" ? 1.2 : 0.7);
    sourceScore += Math.min(16, swaps / 80) * (orderBy === "swaps" ? 1.15 : 0.6);
    sourceScore += Math.min(18, volume / 25000) * (orderBy === "volume" ? 1.2 : 0.7);
    sourceScore += Math.min(12, holderCount / 500) * (orderBy === "holder_count" ? 1.15 : 0.55);
    sourceScore += liquidityUsd >= 12000 ? 6 : 0;
    sourceScore += marketCapUsd >= 20000 ? 4 : 0;
    sourceScore -= priceChange > 120 ? 10 : 0;
    sourceScore *= weight;

    return {
      token: {
        name: asText(safeGet(row, ["name", "token_name", "base_token_info.name", "baseToken.name"]), "UNKNOWN"),
        symbol: asText(safeGet(row, ["symbol", "token_symbol", "base_token_info.symbol", "baseToken.symbol"]), ""),
        ca,
        chainId: this.chain === "sol" ? "solana" : this.chain,
        dexId: asText(safeGet(row, ["dex", "dex_name", "pool_info.dex"]), "gmgn"),
        pairAddress: asText(safeGet(row, ["pair_address", "pool_address", "pairAddress"]), ""),
        price,
        liquidity: liquidityUsd,
        fdv: marketCapUsd,
        volume: volume,
        volumeH24: period === "24h" ? volume : 0,
        volumeH6: period === "6h" ? volume : 0,
        volumeH1: period === "1h" ? volume : 0,
        volumeM5: period === "5m" ? volume : 0,
        txns: swaps,
        txnsH24: period === "24h" ? swaps : 0,
        txnsH6: period === "6h" ? swaps : 0,
        txnsH1: period === "1h" ? swaps : 0,
        txnsM5: period === "5m" ? swaps : 0,
        buys: safeNum(safeGet(row, ["buys", `buys_${period}`]), 0),
        sells: safeNum(safeGet(row, ["sells", `sells_${period}`]), 0),
        buysH1: period === "1h" ? safeNum(safeGet(row, ["buys", `buys_${period}`]), 0) : 0,
        sellsH1: period === "1h" ? safeNum(safeGet(row, ["sells", `sells_${period}`]), 0) : 0,
        buysM5: period === "5m" ? safeNum(safeGet(row, ["buys", `buys_${period}`]), 0) : 0,
        sellsM5: period === "5m" ? safeNum(safeGet(row, ["sells", `sells_${period}`]), 0) : 0,
        priceChangeM5: period === "5m" ? priceChange : 0,
        priceChangeH1: period === "1h" ? priceChange : 0,
        priceChangeH6: period === "6h" ? priceChange : 0,
        priceChangeH24: period === "24h" ? priceChange : 0,
        pairCreatedAt: openTimestamp > 0 && openTimestamp < 2_000_000_000 ? openTimestamp * 1000 : openTimestamp,
        imageUrl: asText(safeGet(row, ["logo", "logo_url", "image", "logoUrl"]), "") || null,
        description: asText(safeGet(row, ["description", "narrative", "project_desc"]), ""),
        links: []
      },
      gmgn: {
        source: {
          period,
          orderBy,
          direction: asText(config.direction, "desc")
        },
        rank: safeNum(safeGet(row, ["rank", "position", "sort_rank"]), 0),
        smartMoney,
        holderCount,
        swaps,
        marketCapUsd,
        liquidityUsd,
        volumeUsd: volume,
        priceChangePct: priceChange,
        sourceScore: clamp(Math.round(sourceScore), 0, 99)
      }
    };
  }

  mergeCandidate(acc = {}, next = {}) {
    const accToken = acc.token || {};
    const nextToken = next.token || {};
    const accGmgn = acc.gmgn || {};
    const nextGmgn = next.gmgn || {};

    const merged = {
      token: {
        ...accToken,
        ...nextToken,
        liquidity: Math.max(safeNum(accToken.liquidity, 0), safeNum(nextToken.liquidity, 0)),
        fdv: Math.max(safeNum(accToken.fdv, 0), safeNum(nextToken.fdv, 0)),
        volumeH24: Math.max(safeNum(accToken.volumeH24, 0), safeNum(nextToken.volumeH24, 0)),
        volumeH6: Math.max(safeNum(accToken.volumeH6, 0), safeNum(nextToken.volumeH6, 0)),
        volumeH1: Math.max(safeNum(accToken.volumeH1, 0), safeNum(nextToken.volumeH1, 0)),
        volumeM5: Math.max(safeNum(accToken.volumeM5, 0), safeNum(nextToken.volumeM5, 0)),
        txnsH24: Math.max(safeNum(accToken.txnsH24, 0), safeNum(nextToken.txnsH24, 0)),
        txnsH6: Math.max(safeNum(accToken.txnsH6, 0), safeNum(nextToken.txnsH6, 0)),
        txnsH1: Math.max(safeNum(accToken.txnsH1, 0), safeNum(nextToken.txnsH1, 0)),
        txnsM5: Math.max(safeNum(accToken.txnsM5, 0), safeNum(nextToken.txnsM5, 0)),
        buys: Math.max(safeNum(accToken.buys, 0), safeNum(nextToken.buys, 0)),
        sells: Math.max(safeNum(accToken.sells, 0), safeNum(nextToken.sells, 0)),
        buysH1: Math.max(safeNum(accToken.buysH1, 0), safeNum(nextToken.buysH1, 0)),
        sellsH1: Math.max(safeNum(accToken.sellsH1, 0), safeNum(nextToken.sellsH1, 0)),
        buysM5: Math.max(safeNum(accToken.buysM5, 0), safeNum(nextToken.buysM5, 0)),
        sellsM5: Math.max(safeNum(accToken.sellsM5, 0), safeNum(nextToken.sellsM5, 0)),
        priceChangeM5: Math.abs(safeNum(nextToken.priceChangeM5, 0)) > 0 ? nextToken.priceChangeM5 : safeNum(accToken.priceChangeM5, 0),
        priceChangeH1: Math.abs(safeNum(nextToken.priceChangeH1, 0)) > 0 ? nextToken.priceChangeH1 : safeNum(accToken.priceChangeH1, 0),
        priceChangeH6: Math.abs(safeNum(nextToken.priceChangeH6, 0)) > 0 ? nextToken.priceChangeH6 : safeNum(accToken.priceChangeH6, 0),
        priceChangeH24: Math.abs(safeNum(nextToken.priceChangeH24, 0)) > 0 ? nextToken.priceChangeH24 : safeNum(accToken.priceChangeH24, 0)
      },
      gmgn: {
        rankSources: uniqStrings([...(accGmgn.rankSources || []), `${nextGmgn.source?.period || "?"}:${nextGmgn.source?.orderBy || "?"}`]),
        smartMoney: Math.max(safeNum(accGmgn.smartMoney, 0), safeNum(nextGmgn.smartMoney, 0)),
        holderCount: Math.max(safeNum(accGmgn.holderCount, 0), safeNum(nextGmgn.holderCount, 0)),
        swaps: Math.max(safeNum(accGmgn.swaps, 0), safeNum(nextGmgn.swaps, 0)),
        discoveryScore: Math.max(safeNum(accGmgn.discoveryScore, 0), safeNum(nextGmgn.sourceScore, 0), safeNum(accGmgn.sourceScore, 0)),
        topSource: safeNum(nextGmgn.sourceScore, 0) >= safeNum(accGmgn.discoveryScore, 0)
          ? nextGmgn.source
          : accGmgn.topSource || accGmgn.source || nextGmgn.source
      }
    };

    return merged;
  }

  async fetchRank(config = {}) {
    if (!this.enabled) return [];
    const url = this.buildRankUrl(config);

    try {
      const json = await this.fetchJson(url);
      const rows = Array.isArray(json?.data?.rank)
        ? json.data.rank
        : Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json?.rank)
            ? json.rank
            : [];

      return rows
        .slice(0, this.maxPerSource)
        .map((row) => this.normalizeRow(row, config))
        .filter(Boolean);
    } catch (error) {
      this.logger.log(`gmgn discovery ${config.period || "?"}/${config.orderBy || "?"} failed:`, error.message);
      return [];
    }
  }

  async getDiscoveryCandidates() {
    if (!this.enabled) return [];

    const batches = await Promise.all(this.rankConfigs.map((cfg) => this.fetchRank(cfg)));
    const flat = batches.flat();
    const merged = new Map();

    for (const row of flat) {
      const ca = asText(row?.token?.ca);
      if (!ca) continue;
      const prev = merged.get(ca);
      merged.set(ca, prev ? this.mergeCandidate(prev, row) : row);
    }

    return [...merged.values()]
      .sort((a, b) => safeNum(b?.gmgn?.discoveryScore, 0) - safeNum(a?.gmgn?.discoveryScore, 0))
      .slice(0, 80)
      .map((row) => ({
        ...row,
        discoverySource: "gmgn_first",
        discoveryPrimary: `gmgn:${row?.gmgn?.topSource?.period || "?"}:${row?.gmgn?.topSource?.orderBy || "?"}`
      }));
  }
}
