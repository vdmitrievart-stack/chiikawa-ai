import fetch from "node-fetch";
import { detectRug } from "./rug-detector.js";
import { analyzeWallets } from "./wallet-intel.js";
import { detectBots } from "./bot-filter.js";
import { getSentiment } from "./sentiment.js";

const API = "https://api.dexscreener.com/latest/dex/search";

export async function scanMarket() {
  const res = await fetch(`${API}?q=solana`);
  const json = await res.json();

  if (!json.pairs) return [];

  return json.pairs.slice(0, 10).map(p => ({
    name: p.baseToken.symbol,
    ca: p.baseToken.address,
    price: Number(p.priceUsd || 0),
    liquidity: Number(p.liquidity?.usd || 0),
    volume: Number(p.volume?.h24 || 0),
    txns: p.txns?.h24?.buys || 0,
    fdv: Number(p.fdv || 0)
  }));
}

export async function analyzeToken(token) {
  const rug = detectRug(token);
  const wallet = analyzeWallets(token);
  const bots = detectBots(token);
  const sentiment = getSentiment(token);

  let score = 0;

  if (!rug.isRug) score += 30;
  score += wallet.score;
  if (!bots.isBotted) score += 20;
  if (sentiment.bullish) score += 20;

  return {
    token,
    rug,
    wallet,
    bots,
    sentiment,
    score
  };
}

export async function getBestTrade() {
  const list = await scanMarket();

  let best = null;

  for (const t of list) {
    const a = await analyzeToken(t);

    if (!best || a.score > best.score) {
      best = a;
    }
  }

  return best;
}
