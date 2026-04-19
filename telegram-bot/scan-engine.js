const SEARCH_API = "https://api.dexscreener.com/latest/dex/search";
const TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

function normalizePair(p) {
  return {
    name: p?.baseToken?.symbol || p?.baseToken?.name || "UNKNOWN",
    ca: p?.baseToken?.address || "",
    pairAddress: p?.pairAddress || "",
    chainId: p?.chainId || "",
    dexId: p?.dexId || "",
    price: safeNum(p?.priceUsd),
    liquidity: safeNum(p?.liquidity?.usd),
    volume: safeNum(p?.volume?.h24),
    buys: safeNum(p?.txns?.h24?.buys),
    sells: safeNum(p?.txns?.h24?.sells),
    txns: safeNum(p?.txns?.h24?.buys) + safeNum(p?.txns?.h24?.sells),
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
  const queries = ["solana meme", "solana pump", "solana new", "solana trending"];
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

  return [...dedup.values()].slice(0, 60);
}

export async function analyzeToken(token) {
  const rug = detectRug(token);
  const wallet = analyzeWallets(token);
  const bots = detectBots(token);
  const sentiment = getSentiment(token);

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

  analyzed.sort((a, b) => b.score - a.score);

  const shortlisted = analyzed
    .filter(item => item.score >= 60)
    .sort((a, b) => {
      const volA = a.token.volume / Math.max(a.token.liquidity, 1);
      const volB = b.token.volume / Math.max(b.token.liquidity, 1);

      if (b.score !== a.score) return b.score - a.score;
      if (volB !== volA) return volB - volA;
      return b.token.txns - a.token.txns;
    });

  return shortlisted[0] || analyzed[0] || null;
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
