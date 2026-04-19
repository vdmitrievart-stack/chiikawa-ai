const SEARCH_API = "https://api.dexscreener.com/latest/dex/search";
const TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";

const tokenSnapshotStore = new Map();
const SAFETY_MARGIN_PCT = 1.2;

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

function getSnapshot(ca) {
  return tokenSnapshotStore.get(ca) || null;
}

function putSnapshot(token) {
  tokenSnapshotStore.set(token.ca, {
    price: token.price,
    volume: token.volume,
    liquidity: token.liquidity,
    txns: token.txns,
    buys: token.buys,
    sells: token.sells,
    ts: Date.now()
  });
}

function isStableLike(symbol) {
  const s = String(symbol || "").toUpperCase();
  return ["SOL", "USDC", "USDT", "PUMP", "JUP", "RAY"].includes(s);
}

function computeDelta(token) {
  const prev = getSnapshot(token.ca);

  if (!prev) {
    return {
      hasHistory: false,
      priceDeltaPct: 0,
      volumeDeltaPct: 0,
      txnsDeltaPct: 0,
      liquidityDeltaPct: 0,
      buyPressureDelta: 0
    };
  }

  const prevBuyPressure = prev.sells > 0 ? prev.buys / prev.sells : prev.buys;
  const currBuyPressure = token.sells > 0 ? token.buys / token.sells : token.buys;

  return {
    hasHistory: true,
    priceDeltaPct: prev.price > 0 ? ((token.price - prev.price) / prev.price) * 100 : 0,
    volumeDeltaPct: prev.volume > 0 ? ((token.volume - prev.volume) / prev.volume) * 100 : 0,
    txnsDeltaPct: prev.txns > 0 ? ((token.txns - prev.txns) / prev.txns) * 100 : 0,
    liquidityDeltaPct: prev.liquidity > 0 ? ((token.liquidity - prev.liquidity) / prev.liquidity) * 100 : 0,
    buyPressureDelta: currBuyPressure - prevBuyPressure
  };
}

export function detectRug(token) {
  let risk = 0;
  const reasons = [];

  if (token.liquidity < 12000) {
    risk += 25;
    reasons.push("Low liquidity");
  }

  if (token.volume < 30000) {
    risk += 20;
    reasons.push("Low 24h volume");
  }

  const fdvToLiquidity = token.liquidity > 0 ? token.fdv / token.liquidity : 999999;
  if (fdvToLiquidity > 35) {
    risk += 25;
    reasons.push("FDV/liquidity ratio too high");
  }

  if (token.txns < 180) {
    risk += 15;
    reasons.push("Weak transaction activity");
  }

  if (token.liquidity < 7000 && token.txns > 1500) {
    risk += 20;
    reasons.push("Too much activity for thin liquidity");
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
    token.txns > 600 && token.volume > 150000
      ? 78
      : token.txns > 250 && token.volume > 70000
      ? 62
      : 35;

  let score = 0;
  const reasons = [];

  if (smartMoney > 60) {
    score += 25;
    reasons.push("Smart money proxy looks strong");
  }

  if (concentration < 30) {
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

  if (token.txns > 1200 && token.volume < 40000) {
    botActivity += 45;
    reasons.push("Too many txns for weak volume");
  }

  if (token.volume > 300000 && token.txns < 140) {
    botActivity += 30;
    reasons.push("Volume spike without broad participation");
  }

  if (token.liquidity < 9000 && token.txns > 500) {
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

  if (token.volume > 120000) {
    sentiment += 40;
    reasons.push("Strong 24h volume");
  }

  if (token.txns > 350) {
    sentiment += 30;
    reasons.push("High transaction participation");
  }

  if (token.liquidity > 25000) {
    sentiment += 20;
    reasons.push("Healthy liquidity");
  }

  return {
    sentiment,
    bullish: sentiment > 60,
    reasons
  };
}

function detectAccumulation(token, delta) {
  let score = 0;
  const reasons = [];

  if (delta.hasHistory) {
    if (delta.volumeDeltaPct > 10) {
      score += 20;
      reasons.push("Volume expanding");
    }
    if (delta.txnsDeltaPct > 8) {
      score += 18;
      reasons.push("Participation expanding");
    }
    if (delta.buyPressureDelta > 0.08) {
      score += 18;
      reasons.push("Buy pressure improving");
    }
    if (delta.liquidityDeltaPct >= 0) {
      score += 12;
      reasons.push("Liquidity holding or improving");
    }
    if (delta.priceDeltaPct > 0.8 && delta.priceDeltaPct < 10) {
      score += 14;
      reasons.push("Healthy price lift from base");
    }
  }

  return { score, reasons };
}

function detectDistribution(token, delta) {
  let score = 0;
  const reasons = [];

  if (delta.hasHistory) {
    if (delta.priceDeltaPct <= 0 && delta.volumeDeltaPct > 8) {
      score += 20;
      reasons.push("Heavy volume without price response");
    }
    if (delta.buyPressureDelta < -0.08) {
      score += 18;
      reasons.push("Buy pressure deteriorating");
    }
    if (delta.liquidityDeltaPct < -3) {
      score += 18;
      reasons.push("Liquidity deteriorating");
    }
    if (delta.priceDeltaPct > 0 && delta.txnsDeltaPct < 2) {
      score += 12;
      reasons.push("Weak bounce with poor participation");
    }
  }

  return { score, reasons };
}

function detectAbsorption(token, delta) {
  let score = 0;
  const reasons = [];

  if (delta.hasHistory) {
    if (delta.volumeDeltaPct > 10 && delta.priceDeltaPct > -1.5) {
      score += 18;
      reasons.push("Selling appears absorbed");
    }
    if (delta.txnsDeltaPct > 6 && delta.buyPressureDelta >= 0) {
      score += 16;
      reasons.push("Flow strengthening without breakdown");
    }
    if (delta.liquidityDeltaPct >= -1) {
      score += 10;
      reasons.push("Liquidity not collapsing during activity");
    }
  }

  return { score, reasons };
}

function detectFalseBounce(token, delta, accumulation, distribution) {
  const reasons = [];
  let rejected = false;

  if (delta.hasHistory) {
    if (delta.priceDeltaPct > 0 && delta.volumeDeltaPct < 3 && delta.txnsDeltaPct < 3) {
      rejected = true;
      reasons.push("Price bounce without participation");
    }

    if (delta.priceDeltaPct > 0 && delta.liquidityDeltaPct < -2) {
      rejected = true;
      reasons.push("Bounce while liquidity deteriorates");
    }

    if (delta.priceDeltaPct > 0 && delta.buyPressureDelta < 0) {
      rejected = true;
      reasons.push("Bounce while buy pressure weakens");
    }

    if (distribution.score > accumulation.score + 8) {
      rejected = true;
      reasons.push("Distribution dominates accumulation");
    }
  }

  return { rejected, reasons };
}

function buildExceptionalOverride(token, accumulation, distribution, absorption) {
  let score = 0;
  const reasons = [];

  if (token.liquidity < 15000) {
    if (accumulation.score >= 45) {
      score += 22;
      reasons.push("Low-liquidity override: strong accumulation");
    }
    if (absorption.score >= 28) {
      score += 18;
      reasons.push("Low-liquidity override: strong absorption");
    }
    if (distribution.score <= 10) {
      score += 10;
      reasons.push("Low-liquidity override: weak distribution");
    }
  }

  return {
    score,
    reasons,
    active: score >= 35
  };
}

function buildStrategy(token, delta, accumulation, distribution, absorption, override) {
  const volumeToLiquidity = token.liquidity > 0 ? token.volume / token.liquidity : 0;
  const buyPressure = token.sells > 0 ? token.buys / token.sells : token.buys;

  let expectedEdgePct = 0;
  let intendedHoldMs = 180000;
  let takeProfitPct = 4.5;
  let stopLossPct = 2.4;
  let reason = "BASE_SETUP";

  if (volumeToLiquidity > 8) expectedEdgePct += 0.8;
  if (volumeToLiquidity > 15) expectedEdgePct += 0.8;
  if (buyPressure > 1.15) expectedEdgePct += 0.8;
  if (buyPressure > 1.35) expectedEdgePct += 0.8;

  if (delta.volumeDeltaPct > 12) expectedEdgePct += 1.0;
  if (delta.txnsDeltaPct > 10) expectedEdgePct += 0.8;
  if (delta.priceDeltaPct > 1.5 && delta.priceDeltaPct < 12) expectedEdgePct += 0.8;
  if (delta.liquidityDeltaPct >= 0) expectedEdgePct += 0.4;

  expectedEdgePct += accumulation.score / 60;
  expectedEdgePct += absorption.score / 80;
  expectedEdgePct -= distribution.score / 90;

  if (override.active) {
    expectedEdgePct += 0.8;
    intendedHoldMs = 210000;
    takeProfitPct = 5.2;
    stopLossPct = 2.6;
    reason = "EXCEPTIONAL_ACCUMULATION_OVERRIDE";
  } else if (
    delta.volumeDeltaPct > 20 &&
    delta.txnsDeltaPct > 15 &&
    delta.buyPressureDelta > 0.08
  ) {
    intendedHoldMs = 240000;
    takeProfitPct = 5.5;
    stopLossPct = 2.8;
    reason = "MOMENTUM_EXPANSION";
  }

  return {
    expectedEdgePct: round(expectedEdgePct, 2),
    intendedHoldMs,
    takeProfitPct,
    stopLossPct,
    reason
  };
}

function passesBaseSafety(token) {
  if (!token.ca || !token.name || token.price <= 0) return false;
  if (isStableLike(token.name)) return false;
  if (token.volume < 25000) return false;
  if (token.txns < 120) return false;
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
      if (!passesBaseSafety(token)) continue;

      const prev = dedup.get(token.ca);
      if (!prev || token.volume > prev.volume) {
        dedup.set(token.ca, token);
      }
    }
  }

  return [...dedup.values()].slice(0, 80);
}

export async function analyzeToken(token) {
  const delta = computeDelta(token);
  const rug = detectRug(token);
  const wallet = analyzeWallets(token);
  const bots = detectBots(token);
  const sentiment = getSentiment(token);
  const accumulation = detectAccumulation(token, delta);
  const distribution = detectDistribution(token, delta);
  const absorption = detectAbsorption(token, delta);
  const exceptionalOverride = buildExceptionalOverride(token, accumulation, distribution, absorption);
  const falseBounce = detectFalseBounce(token, delta, accumulation, distribution);
  const strategy = buildStrategy(token, delta, accumulation, distribution, absorption, exceptionalOverride);

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

  if (delta.hasHistory) {
    if (delta.volumeDeltaPct > 12) {
      score += 10;
      reasons.push("Volume is accelerating");
    }
    if (delta.txnsDeltaPct > 10) {
      score += 8;
      reasons.push("Transaction activity is accelerating");
    }
    if (delta.buyPressureDelta > 0.08) {
      score += 8;
      reasons.push("Buy pressure improving");
    }
    if (delta.priceDeltaPct > 1 && delta.priceDeltaPct < 12) {
      score += 6;
      reasons.push("Healthy price expansion");
    }
  } else {
    score -= 15;
    reasons.push("No historical delta yet");
  }

  score += Math.round(accumulation.score / 4);
  score += Math.round(absorption.score / 5);
  score -= Math.round(distribution.score / 4);

  if (exceptionalOverride.active) {
    score += 15;
    reasons.push(...exceptionalOverride.reasons);
  }

  if (falseBounce.rejected) {
    score -= 30;
    reasons.push(...falseBounce.reasons);
  }

  const analyzed = {
    token: { ...token, score },
    rug,
    wallet,
    bots,
    sentiment,
    delta,
    accumulation,
    distribution,
    absorption,
    exceptionalOverride,
    falseBounce,
    strategy,
    score,
    reasons
  };

  putSnapshot(token);
  return analyzed;
}

export async function getBestTrade({ excludeCas = [] } = {}) {
  const exclude = new Set(excludeCas);
  const list = await scanMarket();

  const analyzed = [];
  for (const token of list) {
    if (exclude.has(token.ca)) {
      putSnapshot(token);
      continue;
    }
    analyzed.push(await analyzeToken(token));
  }

  analyzed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.token.volume - a.token.volume;
  });

  const tradable = analyzed.filter(item => {
    if (item.score < 85) return false;
    if (!item.delta.hasHistory) return false;
    if (item.falseBounce.rejected) return false;

    const strictLowLiquidity = item.token.liquidity < 15000;
    if (strictLowLiquidity && !item.exceptionalOverride.active) return false;

    if (item.delta.volumeDeltaPct <= 0) return false;
    if (item.delta.txnsDeltaPct <= 0) return false;
    if (item.delta.buyPressureDelta <= 0) return false;

    if (item.strategy.reason === "BASE_SETUP") return false;
    if (item.strategy.expectedEdgePct < 1.7 + SAFETY_MARGIN_PCT) return false;
    if (item.distribution.score > item.accumulation.score + 10) return false;

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
