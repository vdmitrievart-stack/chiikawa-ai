import fetch from "node-fetch";

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function truncate(text, max = 120) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function fetchDexSearch(query) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Dex search failed: ${JSON.stringify(data)}`);
  }

  return Array.isArray(data.pairs) ? data.pairs : [];
}

function chooseBestPair(pairs, ca, tokenHint = "") {
  const caLower = String(ca || "").toLowerCase();
  const hintLower = String(tokenHint || "").toLowerCase();

  const scored = pairs.map(pair => {
    const baseAddress = String(pair?.baseToken?.address || "").toLowerCase();
    const baseSymbol = String(pair?.baseToken?.symbol || "").toLowerCase();
    const baseName = String(pair?.baseToken?.name || "").toLowerCase();

    let score = 0;

    if (baseAddress === caLower) score += 100;
    if (hintLower && baseSymbol.includes(hintLower)) score += 20;
    if (hintLower && baseName.includes(hintLower)) score += 20;

    score += Math.min(40, Math.floor(toNum(pair?.liquidity?.usd) / 5000));
    score += Math.min(40, Math.floor(toNum(pair?.volume?.h24) / 20000));

    return { pair, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.pair || null;
}

function extractSocials(pair) {
  const info = pair?.info || {};
  const websites = Array.isArray(info.websites) ? info.websites : [];
  const socials = Array.isArray(info.socials) ? info.socials : [];

  const website = websites[0]?.url || null;
  let telegram = null;
  let twitter = null;

  for (const social of socials) {
    const type = String(social?.type || "").toLowerCase();
    const url = social?.url || null;

    if (type === "telegram" && !telegram) telegram = url;
    if ((type === "twitter" || type === "x") && !twitter) twitter = url;
  }

  return { website, telegram, twitter };
}

function buildRiskFlags(pair, socials) {
  const flags = [];

  const liquidityUsd = toNum(pair?.liquidity?.usd);
  const volumeH24 = toNum(pair?.volume?.h24);
  const buysM5 = toNum(pair?.txns?.m5?.buys);
  const sellsM5 = toNum(pair?.txns?.m5?.sells);

  if (liquidityUsd < 10000) {
    flags.push("Liquidity is thin");
  }

  if (volumeH24 < 15000) {
    flags.push("24h volume is still modest");
  }

  if (sellsM5 > buysM5) {
    flags.push("Short-term sell pressure is higher than buys");
  }

  if (!socials.website && !socials.telegram && !socials.twitter) {
    flags.push("No obvious socials found on Dex Screener");
  }

  if (!flags.length) {
    flags.push("No major basic red flags from this quick screen");
  }

  return flags;
}

function buildConfidence(pair, socials) {
  let score = 50;

  const liquidityUsd = toNum(pair?.liquidity?.usd);
  const volumeH24 = toNum(pair?.volume?.h24);
  const buysM5 = toNum(pair?.txns?.m5?.buys);
  const sellsM5 = toNum(pair?.txns?.m5?.sells);

  if (liquidityUsd >= 10000) score += 8;
  if (liquidityUsd >= 25000) score += 8;
  if (volumeH24 >= 15000) score += 8;
  if (volumeH24 >= 50000) score += 8;
  if (buysM5 >= sellsM5) score += 5;
  if (socials.website) score += 4;
  if (socials.telegram) score += 4;
  if (socials.twitter) score += 5;

  return Math.max(0, Math.min(95, Math.round(score)));
}

export async function buildTokenDossier(ca, tokenHint = "") {
  const pairs = await fetchDexSearch(ca || tokenHint);
  const pair = chooseBestPair(pairs, ca, tokenHint);

  if (!pair) {
    return {
      ok: false,
      error: "No matching pair found on Dex Screener"
    };
  }

  const socials = extractSocials(pair);
  const riskFlags = buildRiskFlags(pair, socials);
  const confidence = buildConfidence(pair, socials);

  const dossier = {
    token: pair?.baseToken?.name || tokenHint || "Unknown",
    symbol: pair?.baseToken?.symbol || "UNKNOWN",
    ca: pair?.baseToken?.address || ca,
    pairAddress: pair?.pairAddress || null,
    pairUrl: pair?.url || null,
    chainId: pair?.chainId || "solana",
    dexId: pair?.dexId || null,

    priceUsd: toNum(pair?.priceUsd),
    liquidityUsd: toNum(pair?.liquidity?.usd),
    volumeH24: toNum(pair?.volume?.h24),
    volumeH6: toNum(pair?.volume?.h6),
    volumeH1: toNum(pair?.volume?.h1),
    buysM5: toNum(pair?.txns?.m5?.buys),
    sellsM5: toNum(pair?.txns?.m5?.sells),
    fdv: toNum(pair?.fdv),
    marketCap: toNum(pair?.marketCap),

    socials,
    riskFlags,
    confidence
  };

  return {
    ok: true,
    dossier
  };
}

export function formatDossierForAdmin(dossier) {
  return `🧾 Token Dossier

Token: ${dossier.token} (${dossier.symbol})
CA: ${dossier.ca}

Confidence: ${dossier.confidence}/95
Price: $${dossier.priceUsd}
Liquidity: $${Math.round(dossier.liquidityUsd).toLocaleString("en-US")}
24h Volume: $${Math.round(dossier.volumeH24).toLocaleString("en-US")}
FDV: $${Math.round(dossier.fdv).toLocaleString("en-US")}
Market Cap: $${Math.round(dossier.marketCap).toLocaleString("en-US")}

M5 Buys/Sells: ${dossier.buysM5}/${dossier.sellsM5}

Website: ${dossier.socials.website || "n/a"}
Telegram: ${dossier.socials.telegram || "n/a"}
X: ${dossier.socials.twitter || "n/a"}

DexScreener:
${dossier.pairUrl || "n/a"}

Risk notes:
- ${dossier.riskFlags.join("\n- ")}`;
}

export function formatPublicBuyPost(proposal, execution) {
  const d = proposal.dossier;

  const socials = [
    d.socials.website ? `Website: ${d.socials.website}` : null,
    d.socials.telegram ? `Telegram: ${d.socials.telegram}` : null,
    d.socials.twitter ? `X: ${d.socials.twitter}` : null
  ].filter(Boolean);

  return `🚀 CHIIKAWA BUY ALERT

Token: ${d.token} (${d.symbol})
CA: ${d.ca}

Entry price: $${execution.price}
Amount: ${execution.amountSol} SOL
Mode: ${execution.mode}

Confidence: ${d.confidence}/95
Liquidity: $${Math.round(d.liquidityUsd).toLocaleString("en-US")}
24h Volume: $${Math.round(d.volumeH24).toLocaleString("en-US")}
FDV: $${Math.round(d.fdv).toLocaleString("en-US")}
Market Cap: $${Math.round(d.marketCap).toLocaleString("en-US")}
M5 Buys/Sells: ${d.buysM5}/${d.sellsM5}

Reason:
${truncate(proposal.reason, 220)}

Quick risk notes:
- ${d.riskFlags.join("\n- ")}

${socials.length ? `Socials:\n${socials.join("\n")}\n` : ""}DexScreener:
${d.pairUrl || "n/a"}

TX:
${execution.tx}`;
}
