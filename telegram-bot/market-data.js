/**
 * telegram-bot/market-data.js
 *
 * Market data adapter for Level 6 candidate scan.
 *
 * Primary source:
 * - DexScreener token endpoint
 *
 * Purpose:
 * - fetch token/pair market snapshot by CA
 * - choose best pair
 * - normalize price / liquidity / volume / txns
 * - provide stable structure for candidate-builder
 */

const DEX_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";
const DEX_SEARCH_API = "https://api.dexscreener.com/latest/dex/search";

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripText(text) {
  return String(text || "").trim();
}

function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round((safeNum(value) + Number.EPSILON) * p) / p;
}

function normalizeChainId(chainId = "") {
  const value = stripText(chainId).toLowerCase();

  if (!value) return "";
  if (value === "sol") return "solana";
  if (value === "eth") return "ethereum";
  if (value === "bsc") return "bsc";

  return value;
}

function normalizePair(raw = {}) {
  return {
    chainId: normalizeChainId(raw.chainId),
    dexId: stripText(raw.dexId),
    pairAddress: stripText(raw.pairAddress),
    priceUsd: safeNum(raw.priceUsd, 0),
    liquidityUsd: safeNum(raw.liquidity?.usd, 0),
    liquidityBase: safeNum(raw.liquidity?.base, 0),
    liquidityQuote: safeNum(raw.liquidity?.quote, 0),
    fdvUsd: safeNum(raw.fdv, 0),
    marketCapUsd: safeNum(raw.marketCap, 0),

    volume5mUsd: safeNum(raw.volume?.m5, 0),
    volume1hUsd: safeNum(raw.volume?.h1, 0),
    volume6hUsd: safeNum(raw.volume?.h6, 0),
    volume24hUsd: safeNum(raw.volume?.h24, 0),

    buys5m: safeNum(raw.txns?.m5?.buys, 0),
    sells5m: safeNum(raw.txns?.m5?.sells, 0),
    buys1h: safeNum(raw.txns?.h1?.buys, 0),
    sells1h: safeNum(raw.txns?.h1?.sells, 0),
    buys24h: safeNum(raw.txns?.h24?.buys, 0),
    sells24h: safeNum(raw.txns?.h24?.sells, 0),

    priceChange5mPct: safeNum(raw.priceChange?.m5, 0),
    priceChange1hPct: safeNum(raw.priceChange?.h1, 0),
    priceChange6hPct: safeNum(raw.priceChange?.h6, 0),
    priceChange24hPct: safeNum(raw.priceChange?.h24, 0),

    pairCreatedAt: safeNum(raw.pairCreatedAt, 0),

    url: stripText(raw.url),
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    info: raw.info || {},

    baseToken: {
      address: stripText(raw.baseToken?.address),
      name: stripText(raw.baseToken?.name),
      symbol: stripText(raw.baseToken?.symbol)
    },
    quoteToken: {
      address: stripText(raw.quoteToken?.address),
      name: stripText(raw.quoteToken?.name),
      symbol: stripText(raw.quoteToken?.symbol)
    }
  };
}

function computePairQuality(pair) {
  let score = 0;

  const liquidity = safeNum(pair.liquidityUsd, 0);
  const vol5m = safeNum(pair.volume5mUsd, 0);
  const vol1h = safeNum(pair.volume1hUsd, 0);
  const buys5m = safeNum(pair.buys5m, 0);
  const sells5m = safeNum(pair.sells5m, 0);

  score += Math.min(liquidity / 1000, 80);
  score += Math.min(vol5m / 300, 30);
  score += Math.min(vol1h / 3000, 25);
  score += Math.min((buys5m + sells5m) * 1.2, 20);

  if (liquidity >= 10000) score += 8;
  if (liquidity >= 25000) score += 8;
  if (liquidity >= 100000) score += 8;

  if (pair.dexId === "raydium") score += 5;
  if (pair.dexId === "orca") score += 4;
  if (pair.dexId === "uniswap") score += 4;

  if (pair.priceUsd > 0) score += 3;
  if (pair.marketCapUsd > 0) score += 2;
  if (pair.fdvUsd > 0) score += 2;

  return round(score, 3);
}

function chooseBestPair(pairs = [], preferredChainId = "") {
  if (!Array.isArray(pairs) || !pairs.length) return null;

  const preferred = normalizeChainId(preferredChainId);

  const normalized = pairs.map(normalizePair);

  const filtered = preferred
    ? normalized.filter(pair => pair.chainId === preferred)
    : normalized;

  const working = filtered.length ? filtered : normalized;

  return working
    .map(pair => ({
      ...pair,
      qualityScore: computePairQuality(pair)
    }))
    .sort((a, b) => b.qualityScore - a.qualityScore)[0];
}

async function fetchJson(url) {
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

export async function fetchDexPairsByToken(tokenAddress) {
  const ca = stripText(tokenAddress);
  if (!ca) return [];

  try {
    const json = await fetchJson(`${DEX_TOKEN_API}/${encodeURIComponent(ca)}`);
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    return pairs.map(normalizePair);
  } catch (error) {
    console.log(`fetchDexPairsByToken error: ${error.message}`);
    return [];
  }
}

export async function searchDexPairs(query) {
  const q = stripText(query);
  if (!q) return [];

  try {
    const json = await fetchJson(`${DEX_SEARCH_API}?q=${encodeURIComponent(q)}`);
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    return pairs.map(normalizePair);
  } catch (error) {
    console.log(`searchDexPairs error: ${error.message}`);
    return [];
  }
}

export async function fetchDexMarketSnapshot({
  chainId = "",
  tokenAddress = "",
  fallbackQuery = ""
} = {}) {
  const normalizedChain = normalizeChainId(chainId);
  const tokenPairs = tokenAddress
    ? await fetchDexPairsByToken(tokenAddress)
    : [];

  let bestPair = chooseBestPair(tokenPairs, normalizedChain);

  if (!bestPair && fallbackQuery) {
    const searched = await searchDexPairs(fallbackQuery);
    bestPair = chooseBestPair(searched, normalizedChain);
  }

  if (!bestPair) {
    return null;
  }

  return {
    source: "dexscreener",
    chainId: bestPair.chainId,
    dexId: bestPair.dexId,
    pairAddress: bestPair.pairAddress,

    tokenAddress:
      stripText(tokenAddress) ||
      bestPair.baseToken.address ||
      "",

    symbol: bestPair.baseToken.symbol,
    name: bestPair.baseToken.name,

    priceUsd: round(bestPair.priceUsd, 12),
    liquidityUsd: round(bestPair.liquidityUsd, 2),
    liquidityBase: round(bestPair.liquidityBase, 6),
    liquidityQuote: round(bestPair.liquidityQuote, 6),

    fdvUsd: round(bestPair.fdvUsd, 2),
    marketCapUsd: round(bestPair.marketCapUsd, 2),

    volume5mUsd: round(bestPair.volume5mUsd, 2),
    volume1hUsd: round(bestPair.volume1hUsd, 2),
    volume6hUsd: round(bestPair.volume6hUsd, 2),
    volume24hUsd: round(bestPair.volume24hUsd, 2),

    buys5m: bestPair.buys5m,
    sells5m: bestPair.sells5m,
    buys1h: bestPair.buys1h,
    sells1h: bestPair.sells1h,
    buys24h: bestPair.buys24h,
    sells24h: bestPair.sells24h,

    priceChange5mPct: round(bestPair.priceChange5mPct, 3),
    priceChange1hPct: round(bestPair.priceChange1hPct, 3),
    priceChange6hPct: round(bestPair.priceChange6hPct, 3),
    priceChange24hPct: round(bestPair.priceChange24hPct, 3),

    pairCreatedAt: bestPair.pairCreatedAt,
    qualityScore: bestPair.qualityScore,
    url: bestPair.url,
    labels: bestPair.labels,

    quoteToken: bestPair.quoteToken,
    baseToken: bestPair.baseToken
  };
}

export async function fetchBestPairOnly({
  chainId = "",
  tokenAddress = "",
  fallbackQuery = ""
} = {}) {
  const snapshot = await fetchDexMarketSnapshot({
    chainId,
    tokenAddress,
    fallbackQuery
  });

  if (!snapshot) return null;

  return {
    chainId: snapshot.chainId,
    dexId: snapshot.dexId,
    pairAddress: snapshot.pairAddress,
    symbol: snapshot.symbol,
    name: snapshot.name,
    priceUsd: snapshot.priceUsd,
    liquidityUsd: snapshot.liquidityUsd,
    volume5mUsd: snapshot.volume5mUsd,
    volume1hUsd: snapshot.volume1hUsd,
    fdvUsd: snapshot.fdvUsd,
    marketCapUsd: snapshot.marketCapUsd,
    qualityScore: snapshot.qualityScore
  };
}

export function buildFallbackMarketSnapshot({
  chainId = "",
  tokenAddress = "",
  symbol = "",
  name = ""
} = {}) {
  return {
    source: "fallback",
    chainId: normalizeChainId(chainId),
    dexId: "",
    pairAddress: "",
    tokenAddress: stripText(tokenAddress),
    symbol: stripText(symbol),
    name: stripText(name),
    priceUsd: 0,
    liquidityUsd: 0,
    liquidityBase: 0,
    liquidityQuote: 0,
    fdvUsd: 0,
    marketCapUsd: 0,
    volume5mUsd: 0,
    volume1hUsd: 0,
    volume6hUsd: 0,
    volume24hUsd: 0,
    buys5m: 0,
    sells5m: 0,
    buys1h: 0,
    sells1h: 0,
    buys24h: 0,
    sells24h: 0,
    priceChange5mPct: 0,
    priceChange1hPct: 0,
    priceChange6hPct: 0,
    priceChange24hPct: 0,
    pairCreatedAt: 0,
    qualityScore: 0,
    url: "",
    labels: [],
    quoteToken: {
      address: "",
      name: "",
      symbol: ""
    },
    baseToken: {
      address: stripText(tokenAddress),
      name: stripText(name),
      symbol: stripText(symbol)
    }
  };
}
