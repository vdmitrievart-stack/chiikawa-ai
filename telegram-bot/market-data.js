const DEX_API = "https://api.dexscreener.com/latest/dex/tokens";

function safeNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function pickBestPair(pairs = []) {
  if (!pairs.length) return null;

  return pairs
    .sort((a, b) => {
      const liqA = safeNum(a.liquidity?.usd);
      const liqB = safeNum(b.liquidity?.usd);

      const volA = safeNum(a.volume?.m5);
      const volB = safeNum(b.volume?.m5);

      return (liqB + volB) - (liqA + volA);
    })[0];
}

export async function fetchDexData(ca) {
  try {
    const res = await fetch(`${DEX_API}/${ca}`);

    if (!res.ok) {
      throw new Error(`Dex error ${res.status}`);
    }

    const json = await res.json();
    const pairs = json?.pairs || [];

    const best = pickBestPair(pairs);

    if (!best) {
      return null;
    }

    return {
      priceUsd: safeNum(best.priceUsd),
      liquidityUsd: safeNum(best.liquidity?.usd),
      volume1mUsd: safeNum(best.volume?.m5),
      fdv: safeNum(best.fdv),
      marketCap: safeNum(best.marketCap),
      symbol: best.baseToken?.symbol,
      name: best.baseToken?.name
    };
  } catch (e) {
    console.log("DEX fetch error:", e.message);
    return null;
  }
}
