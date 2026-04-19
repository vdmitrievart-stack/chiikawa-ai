import { detectRug } from "./rug-detector.js";
import { analyzeWallets } from "./wallet-intel.js";
import { detectBots } from "./bot-filter.js";
import { getSentiment } from "./sentiment.js";

const API = "https://api.dexscreener.com/latest/dex/search";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function scanMarket() {
  const queries = ["solana", "pump", "meme"];
  const seen = new Map();

  for (const query of queries) {
    const res = await fetch(`${API}?q=${encodeURIComponent(query)}`);
    const json = await res.json();

    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    for (const p of pairs) {
      const ca = p?.baseToken?.address;
      const name = p?.baseToken?.symbol || p?.baseToken?.name;
      if (!ca || !name) continue;

      seen.set(ca, {
        name: p.baseToken.symbol || p.baseToken.name,
        ca,
        price: safeNum(p.priceUsd),
        liquidity: safeNum(p.liquidity?.usd),
        volume: safeNum(p.volume?.h24),
        txns: safeNum(p.txns?.h24?.buys) + safeNum(p.txns?.h24?.sells),
        fdv: safeNum(p.fdv)
      });
    }
  }

  return [...seen.values()]
    .filter(t => t.price > 0 && t.ca)
    .slice(0, 40);
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
    reasons.push("Failed rug-risk threshold");
  }

  score += wallet.score;
  if (wallet.score > 0) reasons.push(...wallet.reasons);

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

  return {
    token: {
      ...token,
      score
    },
    rug,
    wallet,
    bots,
    sentiment,
    score,
    reasons
  };
}

export async function getBestTrade() {
  const list = await scanMarket();
  if (!list.length) return null;

  let best = null;

  for (const token of list) {
    const analyzed = await analyzeToken(token);
    if (!best || analyzed.score > best.score) {
      best = analyzed;
    }
  }

  return best;
}
