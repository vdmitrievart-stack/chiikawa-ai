/**
 * GMGN wallet intelligence adapter
 *
 * Design:
 * - works with direct env-configured endpoint or proxy
 * - does not break if GMGN endpoint unavailable
 * - converts raw leader/smart-money style data into Level 6 walletIntel
 *
 * Required only if you have working endpoint/proxy:
 * - GMGN_API_BASE_URL
 * Optional:
 * - GMGN_API_KEY
 * - GMGN_SMART_MONEY_PATH
 */

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const GMGN_API_BASE_URL = (process.env.GMGN_API_BASE_URL || "").replace(/\/+$/, "");
const GMGN_API_KEY = process.env.GMGN_API_KEY || "";
const GMGN_SMART_MONEY_PATH =
  process.env.GMGN_SMART_MONEY_PATH || "/smart-money";

function buildFallbackWalletIntel(reason = "gmgn_unavailable") {
  return {
    winRate: 0,
    medianROI: 1,
    averageROI: 1,
    maxDrawdown: 0.5,
    tradesCount: 0,
    earlyEntryScore: 0,
    chasePenalty: 0.5,
    dumpPenalty: 0.5,
    consistencyScore: 0,
    consensusLeaders: 0,
    source: reason,
    leaders: []
  };
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

function normalizeLeader(raw = {}) {
  const winRate = safeNum(
    raw.winRate ?? raw.win_rate ?? raw.successRate ?? raw.success_rate,
    0
  );
  const medianROI = safeNum(
    raw.medianROI ?? raw.median_roi ?? raw.medianPnlMultiple,
    1
  );
  const averageROI = safeNum(
    raw.averageROI ?? raw.average_roi ?? raw.avgROI ?? raw.avg_roi,
    1
  );
  const maxDrawdown = safeNum(
    raw.maxDrawdown ?? raw.max_drawdown,
    0
  );
  const tradesCount = safeNum(
    raw.tradesCount ?? raw.trades_count ?? raw.txCount ?? raw.tx_count,
    0
  );
  const entryLatencyScore = safeNum(
    raw.earlyEntryScore ?? raw.early_entry_score ?? raw.entryLatencyScore,
    0
  );
  const chasePenalty = safeNum(
    raw.chasePenalty ?? raw.chase_penalty,
    0
  );
  const dumpPenalty = safeNum(
    raw.dumpPenalty ?? raw.dump_penalty,
    0
  );
  const consistencyScore = safeNum(
    raw.consistencyScore ?? raw.consistency_score,
    0
  );

  return {
    address: stripText(raw.address || raw.wallet || raw.walletAddress),
    name: stripText(raw.name || raw.label || ""),
    winRate,
    medianROI,
    averageROI,
    maxDrawdown,
    tradesCount,
    earlyEntryScore: entryLatencyScore,
    chasePenalty,
    dumpPenalty,
    consistencyScore
  };
}

function aggregateLeaders(leaders = []) {
  if (!leaders.length) {
    return buildFallbackWalletIntel("gmgn_no_leaders");
  }

  const valid = leaders.filter(item => item.address);

  if (!valid.length) {
    return buildFallbackWalletIntel("gmgn_invalid_leaders");
  }

  const avg = (field, fallback = 0) =>
    valid.reduce((acc, item) => acc + safeNum(item[field], fallback), 0) / valid.length;

  const winRate = avg("winRate");
  const medianROI = avg("medianROI", 1);
  const averageROI = avg("averageROI", 1);
  const maxDrawdown = avg("maxDrawdown");
  const tradesCount = valid.reduce((acc, item) => acc + safeNum(item.tradesCount, 0), 0);
  const earlyEntryScore = avg("earlyEntryScore");
  const chasePenalty = avg("chasePenalty");
  const dumpPenalty = avg("dumpPenalty");
  const consistencyScore = avg("consistencyScore");
  const consensusLeaders = valid.filter(item => safeNum(item.winRate) >= 0.55).length;

  return {
    winRate: round(clamp(winRate, 0, 1), 3),
    medianROI: round(Math.max(1, medianROI), 3),
    averageROI: round(Math.max(1, averageROI), 3),
    maxDrawdown: round(clamp(maxDrawdown, 0, 1), 3),
    tradesCount: round(tradesCount, 0),
    earlyEntryScore: round(clamp(earlyEntryScore, 0, 1), 3),
    chasePenalty: round(clamp(chasePenalty, 0, 1), 3),
    dumpPenalty: round(clamp(dumpPenalty, 0, 1), 3),
    consistencyScore: round(clamp(consistencyScore, 0, 1), 3),
    consensusLeaders,
    source: "gmgn",
    leaders: valid
  };
}

async function fetchGMGNSmartMoney({ ca = "", symbol = "", chainId = "solana" }) {
  if (!GMGN_API_BASE_URL) {
    return null;
  }

  const params = new URLSearchParams();
  if (ca) params.set("ca", ca);
  if (symbol) params.set("symbol", symbol);
  if (chainId) params.set("chain", chainId);

  const url = `${GMGN_API_BASE_URL}${GMGN_SMART_MONEY_PATH}?${params.toString()}`;
  const headers = GMGN_API_KEY ? { Authorization: `Bearer ${GMGN_API_KEY}` } : {};

  return fetchJson(url, headers);
}

function extractLeaderArray(payload = {}) {
  const candidates = [
    payload.data,
    payload.leaders,
    payload.smartMoney,
    payload.smart_money,
    payload.wallets,
    payload.items
  ];

  for (const item of candidates) {
    if (Array.isArray(item)) {
      return item;
    }
  }

  if (payload.data && Array.isArray(payload.data.items)) {
    return payload.data.items;
  }

  return [];
}

export async function buildGMGNWalletIntel({
  ca = "",
  symbol = "",
  chainId = "solana"
} = {}) {
  try {
    const payload = await fetchGMGNSmartMoney({ ca, symbol, chainId });

    if (!payload) {
      return buildFallbackWalletIntel("gmgn_not_configured");
    }

    const leadersRaw = extractLeaderArray(payload);
    const leaders = leadersRaw.map(normalizeLeader);

    return aggregateLeaders(leaders);
  } catch (error) {
    return {
      ...buildFallbackWalletIntel("gmgn_fetch_error"),
      error: error.message
    };
  }
}
