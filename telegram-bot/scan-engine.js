// === SCAN ENGINE FINAL (corpse + narrative + socials) ===

const SEARCH_API = "https://api.dexscreener.com/latest/dex/search";
const TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";
const TOKEN_PROFILES_API = "https://api.dexscreener.com/token-profiles/latest/v1";
const TOKEN_BOOSTS_API = "https://api.dexscreener.com/token-boosts/latest/v1";

const tokenSnapshotStore = new Map();
const mediaCache = new Map();
let mediaCacheLoadedAt = 0;

const corpseBlacklist = new Map();
const CORPSE_BLACKLIST_MS = 6 * 60 * 60 * 1000;

function safeNum(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

// ---------------- MEDIA ----------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function refreshMediaCache() {
  const now = Date.now();
  if (now - mediaCacheLoadedAt < 10 * 60 * 1000 && mediaCache.size) return;

  mediaCache.clear();

  try {
    const profiles = await fetchJson(TOKEN_PROFILES_API);
    for (const item of profiles || []) {
      if (!item?.tokenAddress) continue;

      mediaCache.set(item.tokenAddress, {
        icon: item.icon,
        header: item.header,
        description: item.description || "",
        links: item.links || {}
      });
    }
  } catch {}

  try {
    const boosts = await fetchJson(TOKEN_BOOSTS_API);
    for (const item of boosts || []) {
      if (!item?.tokenAddress) continue;

      const prev = mediaCache.get(item.tokenAddress) || {};

      mediaCache.set(item.tokenAddress, {
        icon: prev.icon || item.icon,
        header: prev.header || item.header,
        description: prev.description || "",
        links: prev.links || {}
      });
    }
  } catch {}

  mediaCacheLoadedAt = now;
}

async function enrichTokenMedia(token) {
  await refreshMediaCache();
  const media = mediaCache.get(token.ca) || {};

  return {
    ...token,
    imageUrl: media.header || media.icon || null,
    description: media.description || "",
    links: media.links || {}
  };
}

// ---------------- CORE ----------------

function normalizePair(p) {
  return {
    name: p.baseToken?.symbol || "UNKNOWN",
    ca: p.baseToken?.address,
    price: safeNum(p.priceUsd),
    liquidity: safeNum(p.liquidity?.usd),
    volume: safeNum(p.volume?.h24),
    txns: safeNum(p.txns?.h24?.buys) + safeNum(p.txns?.h24?.sells),
    buys: safeNum(p.txns?.h24?.buys),
    sells: safeNum(p.txns?.h24?.sells),
    fdv: safeNum(p.fdv),
    url: p.url
  };
}

// ---------------- CORPSE ----------------

function detectCorpse(token) {
  let score = 0;
  const reasons = [];

  if (token.volume > token.fdv * 5 && token.liquidity < 15000) {
    score += 30;
    reasons.push("Volume >> FDV");
  }

  if (token.txns > 1500 && token.liquidity < 10000) {
    score += 25;
    reasons.push("Too many txns on low liquidity");
  }

  if (token.fdv < 30000 && token.volume > 200000) {
    score += 20;
    reasons.push("Low FDV high churn");
  }

  return {
    score,
    reasons,
    isCorpse: score >= 40
  };
}

// ---------------- NARRATIVE ----------------

function analyzeNarrative(token) {
  const t = (token.description || "").toLowerCase();

  let score = 0;
  const flags = [];

  if (!t) {
    score -= 10;
    flags.push("no description");
  }

  if (t.includes("100x")) {
    score -= 20;
    flags.push("100x hype");
  }

  if (t.length > 120) score += 10;
  if (t.includes("ai") || t.includes("tool")) score += 10;

  return {
    score,
    verdict: score > 10 ? "Strong" : score > 0 ? "OK" : "Weak",
    flags
  };
}

function analyzeSocials(token) {
  const links = token.links || {};
  let score = 0;

  if (links.twitter) score += 10;
  if (links.telegram) score += 10;
  if (links.website) score += 10;

  if (!links.twitter && !links.telegram) score -= 15;

  return { score };
}

// ---------------- MAIN ----------------

export async function scanMarket() {
  const json = await fetchJson(`${SEARCH_API}?q=solana`);
  const pairs = json?.pairs || [];

  return pairs.map(normalizePair).slice(0, 50);
}

export async function analyzeToken(token) {
  const corpse = detectCorpse(token);

  const enriched = await enrichTokenMedia(token);

  const narrative = analyzeNarrative(enriched);
  const social = analyzeSocials(enriched);

  let score = 50;

  score += narrative.score;
  score += social.score;
  score -= corpse.score;

  return {
    token: enriched,
    score,
    corpse,
    narrative,
    social,
    reasons: corpse.reasons
  };
}

export async function getBestTrade() {
  const list = await scanMarket();

  const analyzed = [];
  for (const t of list) {
    analyzed.push(await analyzeToken(t));
  }

  analyzed.sort((a, b) => b.score - a.score);

  return analyzed[0];
}
