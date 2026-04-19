const SEARCH_API = "https://api.dexscreener.com/latest/dex/search";
const TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

function normalizePair(p) {
  const buys = safeNum(p?.txns?.h24?.buys);
  const sells = safeNum(p?.txns?.h24?.sells);

  return {
    name: p?.baseToken?.symbol || p?.baseToken?.name || "UNKNOWN",
    ca: p?.baseToken?.address || "",
    pairAddress: p?.pairAddress || "",
    chainId: p?.chainId || "",
    dexId: p?.dexId || "",
    price: safeNum(p?.priceUsd),
    liquidity: safeNum(p?.liquidity?.usd),
    volume: safeNum(p?.volume?.h24),
    buys,
    sells,
    txns: buys + sells,
    fdv: safeNum(p?.fdv),
    pairCreatedAt: safeNum(p?.pairCreatedAt),
    url: p?.url || ""
  };
}

export function detectRug(token) {
  let risk = 0;
  const reasons = [];

  if (token.liquidity < 8000) {
    risk += 25;
    reasons.push("Low liquidity");
  }

  if (token.volume < 20000) {
    risk += 20;
    reasons.push("Low 24h volume");
  }

  const fdvToLiquidity = token.liquidity > 0 ? token.fdv / token.liquidity : 999999;
  if (fdvToLiquidity > 50) {
    risk += 25;
    reasons.push("FDV/liquidity ratio too high");
  }

  if (token.txns < 120) {
    risk += 15;
    reasons.push("Weak transaction activity");
  }

  return {
    risk,
    reasons,
    isRug: risk >= 60
  };
}

export function analyzeWallets(token) {
  const concentration = token.liquidity > 0
    ? Math.min(100, (token.fdv / token.liquidity) * 10)
    : 100;

  const smartMoney =
    token.txns > 300 && token.volume > 100000
      ? 75
      : token.txns > 180 && token.volume > 50000
      ? 60
      : 35;

  let score = 0;
  const reasons = [];

  if (smartMoney > 60) {
    score += 25;
    reasons.push("Smart money proxy looks strong");
  }

  if (concentration < 40) {
    score += 20;
    reasons.push("Holder concentration proxy acceptable");
  } else {
    reasons.push("Holder concentration proxy elevated");
  }

  return {
    smartMoney,
    concentration,
    score,
    reasons
  };
}

export function detectBots(token) {
  let botActivity = 0;
  const reasons = [];

  if (token.txns > 500 && token.volume < 20000) {
    botActivity += 40;
    reasons.push("Too many txns for weak volume");
  }

  if (token.volume > 200000 && token.txns < 100) {
    botActivity += 30;
    reasons.push("Volume spike without broad activity");
  }

  if (token.liquidity < 5000 && token.txns > 250) {
    botActivity += 20;
    reasons.push("Suspicious activity on thin liquidity");
  }

  return {
    botActivity,
    reasons,
    isBotted: botActivity > 50
  };
}

export function getSentiment(token) {
  let sentiment = 0;
  const reasons = [];

  if (token.volume > 100000) {
    sentiment += 40;
    reasons.push("Strong 24h volume");
  }

  if (token.txns > 300) {
    sentiment += 30;
    reasons.push("High transaction participation");
  }

  if (token.liquidity > 20000) {
    sentiment += 20;
    reasons.push("Healthy liquidity");
  }

  return {
    sentiment,
    bullish: sentiment > 60,
    reasons
  };
}

function buildStrategy(token) {
  const volumeToLiquidity = token.liquidity > 0 ? token.volume / token.liquidity : 0;
  const buyPressure = token.sells > 0 ? token.buys / token.sells : token.buys;

  let expectedEdgePct = 0;
  let intendedHoldMs = 120000;
  let takeProfitPct = 3.2;
  let stopLossPct = 2.2;
  let reason = "BASE_SETUP";

  if (volumeToLiquidity > 25 && buyPressure > 1.2) {
    expectedEdgePct += 2.2;
    takeProfitPct = 4.2;
    stopLossPct = 2.4;
    intendedHoldMs = 180000;
    reason = "MOMENTUM_BREAKOUT";
  }

  if (token.txns > 1200) {
    expectedEdgePct += 1.0;
  }

  if (token.liquidity > 25000) {
    expectedEdgePct += 0.8;
  }

  if (token.fdv > 0 && token.liquidity > 0 && token.fdv / token.liquidity < 20) {
    expectedEdgePct += 0.7;
  }

  return {
    expectedEdgePct: round(expectedEdgePct, 2),
    intendedHoldMs,
    takeProfitPct,
    stopLossPct,
    reason
  };
}

function isEligibleBaseToken(token) {
  if (!token.ca || !token.name || token.price <= 0) return false;

  const upper = token.name.toUpperCase();
  if (upper === "SOL" || upper === "USDC" || upper === "USDT" || upper === "PUMP") {
    return false;
  }

  if (token.liquidity < 3000) return false;
  if (token.volume < 10000) return false;
  if (token.txns < 80) return false;

  return true;
}

export async function scanMarket() {
  const queries = ["solana meme", "solana trending", "solana new", "solana pump"];
  const dedup = new Map();

  for (const query of queries) {
    const json = await fetchJson(`${SEARCH_API}?q=${encodeURIComponent(query)}`);
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];

    for (const pair of pairs) {
      const token = normalizePair(pair);
      if (!isEligibleBaseToken(token)) continue;

      const prev = dedup.get(token.ca);
      if (!prev || token.volume > prev.volume) {
        dedup.set(token.ca, token);
      }
    }
  }

  return [...dedup.values()].slice(0, 80);
}

export async function analyzeToken(token) {
  const rug = detectRug(token);
  const wallet = analyzeWallets(token);
  const bots = detectBots(token);
  const sentiment = getSentiment(token);
  const strategy = buildStrategy(token);

  let score = 0;
  const reasons = [];

  if (!rug.isRug) {
    score += 30;
    reasons.push("Passed rug-risk threshold");
  } else {
    reasons.push(...rug.reasons);
  }

  score += wallet.score;
  reasons.push(...wallet.reasons);

  if (!bots.isBotted) {
    score += 20;
    reasons.push("No strong bot-pattern signal");
  } else {
    reasons.push(...bots.reasons);
  }

  if (sentiment.bullish) {
    score += 20;
    reasons.push(...sentiment.reasons);
  }

  const buySellImbalance = token.sells > 0 ? token.buys / token.sells : token.buys;
  if (buySellImbalance > 1.2) {
    score += 10;
    reasons.push("Buy/sell flow positive");
  }

  const fdvToLiquidity = token.liquidity > 0 ? token.fdv / token.liquidity : 999999;
  if (fdvToLiquidity < 20) {
    score += 10;
    reasons.push("FDV/liquidity ratio acceptable");
  }

  return {
    token: { ...token, score },
    rug,
    wallet,
    bots,
    sentiment,
    strategy,
    score,
    reasons
  };
}

export async function getBestTrade({ excludeCas = [] } = {}) {
  const exclude = new Set(excludeCas);
  const list = await scanMarket();

  const analyzed = [];
  for (const token of list) {
    if (exclude.has(token.ca)) continue;
    analyzed.push(await analyzeToken(token));
  }

  analyzed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.token.volume - a.token.volume;
  });

  const tradable = analyzed.filter(item => {
    if (item.score < 60) return false;
    if (item.strategy.expectedEdgePct < 2.0) return false;
    return true;
  });

  return tradable[0] || analyzed[0] || null;
}

export async function getLatestTokenPrice(ca) {
  const json = await fetchJson(`${TOKEN_API}/${ca}`);
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  if (!pairs.length) return null;

  const bestPair = pairs
    .map(normalizePair)
    .sort((a, b) => b.liquidity - a.liquidity)[0];

  return {
    ca: bestPair.ca,
    name: bestPair.name,
    price: bestPair.price,
    liquidity: bestPair.liquidity,
    volume: bestPair.volume,
    txns: bestPair.txns,
    fdv: bestPair.fdv
  };
}
