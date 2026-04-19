import fetch from "node-fetch";

const DEX_API = "https://api.dexscreener.com/latest/dex/search";

export async function findCandidates() {
  const queries = ["chiikawa", "solana", "pump"];

  let all = [];

  for (const q of queries) {
    try {
      const res = await fetch(`${DEX_API}?q=${q}`);
      const json = await res.json();

      if (!json.pairs) continue;

      for (const p of json.pairs) {
        if (!p.baseToken?.address) continue;

        all.push({
          ca: p.baseToken.address,
          name: p.baseToken.symbol,
          price: Number(p.priceUsd || 0),
          liquidity: Number(p.liquidity?.usd || 0),
          volume: Number(p.volume?.h24 || 0),
          fdv: Number(p.fdv || 0),
          txns: p.txns?.h24?.buys || 0
        });
      }
    } catch (e) {
      console.log("scan error:", e.message);
    }
  }

  return dedupe(all);
}

function dedupe(arr) {
  const map = new Map();
  arr.forEach(a => map.set(a.ca, a));
  return [...map.values()];
}

// ================= SCORE =================

export function scoreToken(t) {
  let score = 0;

  if (t.liquidity > 10000) score += 20;
  if (t.volume > 50000) score += 20;
  if (t.txns > 200) score += 20;
  if (t.fdv < 2000000) score += 10;

  if (t.price > 0) score += 10;

  return score;
}

// ================= PICK =================

export async function getBestToken() {
  const list = await findCandidates();

  if (!list.length) return null;

  const scored = list.map(t => ({
    ...t,
    score: scoreToken(t)
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored[0];
}
