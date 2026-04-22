function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function toHttps(url) {
  const value = asText(url, "");
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `https://${value.replace(/^\/+/, "")}`;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function uniqueBy(items = [], getKey = (x) => x?.id) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export default class GMGNMarketDiscoveryService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.timeoutMs = safeNum(options.timeoutMs, 8000);
    this.chain = asText(options.chain, process.env.GMGN_DISCOVERY_CHAIN || "sol");
    this.enabled = String(process.env.GMGN_DISCOVERY_ENABLED || "1") !== "0";

    const envEndpoints = asText(process.env.GMGN_DISCOVERY_ENDPOINTS, "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => toHttps(x));

    this.endpoints = envEndpoints.length
      ? envEndpoints
      : [
          `https://gmgn.ai/defi/quotation/v1/rank/${this.chain}/swaps/5m?orderby=volume&direction=desc&limit=50`,
          `https://gmgn.ai/defi/quotation/v1/rank/${this.chain}/swaps/1h?orderby=swaps&direction=desc&limit=50`,
          `https://gmgn.ai/defi/quotation/v1/rank/${this.chain}/swaps/24h?orderby=volume&direction=desc&limit=50`
        ];
  }

  async fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "accept": "application/json, text/plain, */*",
          "user-agent": "Mozilla/5.0 ChiikawaBot/1.0"
        }
      });

      if (!res.ok) {
        this.logger.log(`[GMGN discovery] ${res.status} for ${url}`);
        return null;
      }

      return await res.json().catch(() => null);
    } catch (error) {
      this.logger.log(`[GMGN discovery] request failed for ${url}: ${error.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  normalizeRow(row = {}) {
    const ca = asText(
      pickFirst(
        row?.token_address,
        row?.address,
        row?.ca,
        row?.base_token_address,
        row?.baseToken?.address,
        row?.token?.address
      ),
      ""
    );

    if (!ca) return null;

    const symbol = asText(pickFirst(row?.symbol, row?.token_symbol, row?.baseToken?.symbol), "");
    const name = asText(pickFirst(row?.name, row?.token_name, row?.baseToken?.name, symbol), symbol || "UNKNOWN");
    const pairAddress = asText(pickFirst(row?.pair_address, row?.pairAddress), "");

    const volume5m = safeNum(pickFirst(row?.volume_5m, row?.volume5m, row?.volume?.m5), 0);
    const volume1h = safeNum(pickFirst(row?.volume_1h, row?.volume1h, row?.volume?.h1), 0);
    const volume24h = safeNum(pickFirst(row?.volume_24h, row?.volume24h, row?.volume?.h24), 0);

    const txns5m = safeNum(pickFirst(row?.swap_count_5m, row?.swaps5m, row?.txns?.m5, row?.txns5m), 0);
    const txns1h = safeNum(pickFirst(row?.swap_count_1h, row?.swaps1h, row?.txns?.h1, row?.txns1h), 0);
    const txns24h = safeNum(pickFirst(row?.swap_count_24h, row?.swaps24h, row?.txns?.h24, row?.txns24h), 0);

    return {
      source: "gmgn",
      name,
      symbol,
      ca,
      pairAddress,
      price: safeNum(pickFirst(row?.price, row?.price_usd, row?.priceUsd), 0),
      liquidity: safeNum(pickFirst(row?.liquidity, row?.liquidity_usd, row?.liquidityUsd), 0),
      volumeM5: volume5m,
      volumeH1: volume1h,
      volumeH24: volume24h,
      txnsM5: txns5m,
      txnsH1: txns1h,
      txnsH24: txns24h,
      buysM5: safeNum(pickFirst(row?.buy_count_5m, row?.buys5m, row?.buys?.m5), 0),
      sellsM5: safeNum(pickFirst(row?.sell_count_5m, row?.sells5m, row?.sells?.m5), 0),
      buysH1: safeNum(pickFirst(row?.buy_count_1h, row?.buys1h, row?.buys?.h1), 0),
      sellsH1: safeNum(pickFirst(row?.sell_count_1h, row?.sells1h, row?.sells?.h1), 0),
      buys: safeNum(pickFirst(row?.buy_count_24h, row?.buys24h, row?.buys?.h24), 0),
      sells: safeNum(pickFirst(row?.sell_count_24h, row?.sells24h, row?.sells?.h24), 0),
      fdv: safeNum(pickFirst(row?.fdv, row?.market_cap, row?.marketCap), 0),
      pairCreatedAt: safeNum(pickFirst(row?.created_at, row?.pair_created_at, row?.pairCreatedAt), 0),
      priceChangeM5: safeNum(pickFirst(row?.price_change_5m, row?.priceChange5m, row?.priceChange?.m5), 0),
      priceChangeH1: safeNum(pickFirst(row?.price_change_1h, row?.priceChange1h, row?.priceChange?.h1), 0),
      priceChangeH6: safeNum(pickFirst(row?.price_change_6h, row?.priceChange6h, row?.priceChange?.h6), 0),
      priceChangeH24: safeNum(pickFirst(row?.price_change_24h, row?.priceChange24h, row?.priceChange?.h24), 0),
      url: asText(pickFirst(row?.url, row?.token_url), ""),
      imageUrl: pickFirst(row?.logo, row?.image, row?.imageUrl, null),
      chainId: "solana",
      dexId: asText(pickFirst(row?.dex, row?.dex_id, row?.dexId), "gmgn")
    };
  }

  extractRows(json) {
    const candidates = [
      ...(Array.isArray(json?.data?.rank) ? json.data.rank : []),
      ...(Array.isArray(json?.data?.list) ? json.data.list : []),
      ...(Array.isArray(json?.data) ? json.data : []),
      ...(Array.isArray(json?.pairs) ? json.pairs : []),
      ...(Array.isArray(json?.tokens) ? json.tokens : [])
    ];

    return uniqueBy(
      candidates.map((row) => this.normalizeRow(row)).filter(Boolean),
      (row) => row.ca
    );
  }

  async discoverCandidates() {
    if (!this.enabled) return [];

    const chunks = await Promise.all(this.endpoints.map((url) => this.fetchJson(url)));
    const rows = uniqueBy(
      chunks.flatMap((json) => this.extractRows(json)),
      (row) => row.ca
    );

    return rows;
  }

  async discover() { return this.discoverCandidates(); }
  async fetchCandidates() { return this.discoverCandidates(); }
  async fetchMarketCandidates() { return this.discoverCandidates(); }
  async getCandidates() { return this.discoverCandidates(); }
  async getDiscoveryCandidates() { return this.discoverCandidates(); }
}
