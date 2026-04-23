
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function uniqStrings(rows = []) {
  return [...new Set(rows.map((x) => asText(x)).filter(Boolean))];
}

function safeGet(obj, paths = [], fallback = null) {
  for (const path of paths) {
    const parts = String(path).split('.');
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

function looksLikeAddress(v) {
  const s = asText(v);
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s);
}

const DEFAULT_PROXY_CONFIGS = [
  { period: '1h', orderBy: 'smartmoney', direction: 'desc', weight: 1.35 },
  { period: '5m', orderBy: 'swaps', direction: 'desc', weight: 1.05 },
  { period: '1h', orderBy: 'holder_count', direction: 'desc', weight: 0.95 }
];

export default class GMGNSmartWalletFeed {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.enabled = options.enabled !== false;
    this.apiKey = asText(options.apiKey || process.env.GMGN_API_KEY, '');
    this.baseUrl = asText(options.baseUrl || process.env.GMGN_DISCOVERY_BASE_URL, 'https://gmgn.ai');
    this.rankPath = asText(options.rankPath || process.env.GMGN_DISCOVERY_RANK_PATH, '/defi/quotation/v1/rank');
    this.chain = asText(options.chain || process.env.GMGN_DISCOVERY_CHAIN, 'sol');
    this.timeoutMs = Number(options.timeoutMs || process.env.GMGN_DISCOVERY_TIMEOUT_MS || 12000);
    this.maxPerSource = Number(options.maxPerSource || process.env.GMGN_SMART_WALLET_MAX_PER_SOURCE || 40);
    this.proxyConfigs = Array.isArray(options.proxyConfigs) && options.proxyConfigs.length ? options.proxyConfigs : DEFAULT_PROXY_CONFIGS;
    this.feedUrls = uniqStrings(
      asText(options.feedUrls || process.env.GMGN_SMART_WALLET_FEED_URLS || process.env.GMGN_SMART_WALLET_FEED_URL, '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    );
  }

  buildHeaders() {
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': process.env.GMGN_DISCOVERY_USER_AGENT || 'Mozilla/5.0 (ChiikawaSmartWalletRadar)',
      'Referer': `${this.baseUrl}/trade?chain=${this.chain}`
    };
    if (this.apiKey) {
      headers['x-route-key'] = this.apiKey;
      headers['x-api-key'] = this.apiKey;
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async fetchJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { headers: this.buildHeaders(), signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  buildProxyUrl(config = {}) {
    const period = asText(config.period, '1h');
    const orderBy = asText(config.orderBy, 'smartmoney');
    const direction = asText(config.direction, 'desc');
    return `${this.baseUrl}${this.rankPath}/${this.chain}/swaps/${period}?orderby=${encodeURIComponent(orderBy)}&direction=${encodeURIComponent(direction)}&limit=${encodeURIComponent(this.maxPerSource)}`;
  }

  extractArray(json) {
    if (Array.isArray(json)) return json;
    const candidates = [
      json?.data?.list,
      json?.data?.items,
      json?.data?.rows,
      json?.data?.tokens,
      json?.list,
      json?.items,
      json?.rows,
      json?.tokens,
      json?.wallets,
      json?.data?.wallets
    ];
    for (const row of candidates) {
      if (Array.isArray(row)) return row;
    }
    return [];
  }

  normalizeTokenRow(row = {}, source = 'gmgn_smart_wallets', weight = 1) {
    const ca = asText(safeGet(row, ['token_address', 'tokenAddress', 'address', 'ca', 'base_token_info.address', 'token.address']));
    if (!looksLikeAddress(ca)) return null;

    const smartMoney = safeNum(safeGet(row, ['smartmoney', 'smart_money', 'smartMoneyScore']), 0);
    const holderCount = safeNum(safeGet(row, ['holder_count', 'holders', 'holderCount']), 0);
    const swaps = safeNum(safeGet(row, ['swaps', 'swap_count', 'txn_count']), 0);
    const sampleWallets = [];
    for (const candidate of [row?.wallet_address, row?.wallet, row?.trader_address, row?.owner]) {
      const addr = asText(candidate);
      if (looksLikeAddress(addr)) sampleWallets.push(addr);
    }

    return {
      ca,
      walletHits: Math.max(sampleWallets.length, safeNum(safeGet(row, ['wallet_hits', 'walletHits', 'matched_wallets']), 0)),
      smartWalletScore: Math.round((smartMoney * 1.4 + holderCount * 0.1 + swaps * 0.05) * weight),
      source,
      sampleWallets
    };
  }

  aggregate(rows = []) {
    const byCa = new Map();
    for (const row of rows) {
      if (!row?.ca) continue;
      const prev = byCa.get(row.ca) || {
        ca: row.ca,
        walletHits: 0,
        smartWalletScore: 0,
        source: row.source,
        sampleWallets: []
      };
      prev.walletHits = Math.max(prev.walletHits, safeNum(row.walletHits, 0));
      prev.smartWalletScore += safeNum(row.smartWalletScore, 0);
      prev.sampleWallets = uniqStrings([...(prev.sampleWallets || []), ...(row.sampleWallets || [])]).slice(0, 8);
      prev.source = prev.source === row.source ? prev.source : `${prev.source}+${row.source}`;
      byCa.set(row.ca, prev);
    }
    return [...byCa.values()].sort((a, b) => b.smartWalletScore - a.smartWalletScore || b.walletHits - a.walletHits);
  }

  async fetchProxyHints() {
    if (!this.enabled) return [];
    const rows = [];
    for (const config of this.proxyConfigs) {
      try {
        const json = await this.fetchJson(this.buildProxyUrl(config));
        const array = this.extractArray(json);
        for (const row of array) {
          const normalized = this.normalizeTokenRow(row, `gmgn_proxy:${asText(config.orderBy, 'smartmoney')}:${asText(config.period, '1h')}`, safeNum(config.weight, 1));
          if (normalized) rows.push(normalized);
        }
      } catch (error) {
        this.logger.log('smart-wallet proxy fetch failed:', error.message);
      }
    }
    return rows;
  }

  async fetchCustomFeedHints() {
    if (!this.feedUrls.length) return [];
    const rows = [];
    for (const url of this.feedUrls) {
      try {
        const json = await this.fetchJson(url);
        const array = this.extractArray(json);
        for (const row of array) {
          const normalized = this.normalizeTokenRow(row, 'gmgn_smart_wallet_feed', 1.15);
          if (normalized) rows.push(normalized);
        }
      } catch (error) {
        this.logger.log('smart-wallet custom feed failed:', error.message);
      }
    }
    return rows;
  }

  async fetchTokenHints() {
    const proxyRows = await this.fetchProxyHints();
    const customRows = await this.fetchCustomFeedHints();
    const combined = this.aggregate([...proxyRows, ...customRows]);
    return {
      tokens: combined,
      telemetry: {
        rawRecords: proxyRows.length + customRows.length,
        mode: this.feedUrls.length ? 'mixed' : 'proxy_only'
      }
    };
  }
}
