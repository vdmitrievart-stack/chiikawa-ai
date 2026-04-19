import fs from "node:fs/promises";
import path from "node:path";

const SEARCH_API = "https://api.dexscreener.com/latest/dex/search";
const TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";
const TOKEN_PROFILES_API = "https://api.dexscreener.com/token-profiles/latest/v1";
const TOKEN_BOOSTS_API = "https://api.dexscreener.com/token-boosts/latest/v1";

const tokenSnapshotStore = new Map();
const mediaCache = new Map();
let mediaCacheLoadedAt = 0;

const corpseBlacklist = new Map();
const CORPSE_BLACKLIST_MS = 6 * 60 * 60 * 1000;
const RUNTIME_DIR = path.resolve("./runtime-data");
const DEV_DB_FILE = path.join(RUNTIME_DIR, "dev-history.json");

let devDbLoaded = false;
let devDb = {
  fingerprints: {}
};

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

async function ensureDevDb() {
  if (devDbLoaded) return;

  await fs.mkdir(RUNTIME_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(DEV_DB_FILE, "utf8");
    devDb = JSON.parse(raw);
  } catch {
    devDb = { fingerprints: {} };
  }

  devDbLoaded = true;
}

async function flushDevDb() {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.writeFile(DEV_DB_FILE, JSON.stringify(devDb, null, 2), "utf8");
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
    fdv: token.fdv,
    ts: Date.now()
  });
}

function isStableLike(symbol) {
  const s = String(symbol || "").toUpperCase();
  return ["SOL", "USDC", "USDT", "JUP", "RAY"].includes(s);
}

function pruneCorpseBlacklist() {
  const now = Date.now();
  for (const [ca, row] of corpseBlacklist.entries()) {
    if (!row?.until || row.until <= now) corpseBlacklist.delete(ca);
  }
}

function getCorpseBlacklistItem(ca) {
  pruneCorpseBlacklist();
  return corpseBlacklist.get(ca) || null;
}

function addToCorpseBlacklist(ca, reason) {
  corpseBlacklist.set(ca, {
    reason,
    until: Date.now() + CORPSE_BLACKLIST_MS
  });
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
      fdvDeltaPct: 0,
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
    fdvDeltaPct: prev.fdv > 0 ? ((token.fdv - prev.fdv) / prev.fdv) * 100 : 0,
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

function analyzeNarrative(token) {
  const text = String(token.description || "").toLowerCase();
  let score = 0;
  const positives = [];
  const flags = [];

  if (!text) {
    score -= 10;
    flags.push("No description");
    return {
      score,
      verdict: "No narrative",
      positives,
      flags,
      summary: "No narrative available."
    };
  }

  if (text.length > 120) {
    score += 10;
    positives.push("Detailed description");
  } else if (text.length < 50) {
    score -= 12;
    flags.push("Too short");
  }

  if (text.includes("100x") || text.includes("next gem")) {
    score -= 20;
    flags.push("Hype wording");
  }

  if (text.includes("ai") || text.includes("bot") || text.includes("tool") || text.includes("game")) {
    score += 8;
    positives.push("Has concept");
  }

  const verdict = score >= 10 ? "Strong" : score > 0 ? "OK" : "Weak";

  return {
    score,
    verdict,
    positives,
    flags,
    summary: text.slice(0, 220)
  };
}

function normalizeHandle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^x\.com\//, "")
    .replace(/^twitter\.com\//, "")
    .replace(/^t\.me\//, "")
    .replace(/\/+$/, "")
    .trim();
}

function extractLinksMap(linksInput = {}) {
  const map = { twitter: "", telegram: "", website: "" };

  if (Array.isArray(linksInput)) {
    for (const item of linksInput) {
      const label = String(item?.label || "").toLowerCase();
      const type = String(item?.type || "").toLowerCase();
      const url = item?.url || "";

      if (type.includes("twitter") || label.includes("twitter") || label === "x") map.twitter = url;
      else if (type.includes("telegram") || label.includes("telegram")) map.telegram = url;
      else if (type.includes("website") || label.includes("website")) map.website = url;
      else if (!map.website && url) map.website = url;
    }
  } else if (typeof linksInput === "object" && linksInput) {
    map.twitter = linksInput.twitter || linksInput.x || "";
    map.telegram = linksInput.telegram || "";
    map.website = linksInput.website || "";
  }

  return map;
}

function analyzeSocials(token) {
  const links = extractLinksMap(token.links || {});
  let score = 0;
  const notes = [];

  if (links.twitter) {
    score += 10;
    notes.push("Twitter/X");
  }
  if (links.telegram) {
    score += 10;
    notes.push("Telegram");
  }
  if (links.website) {
    score += 10;
    notes.push("Website");
  }
  if (!links.twitter && !links.telegram) {
    score -= 15;
    notes.push("No socials");
  }

  return { score, notes, links };
}

function fingerprintProject(token) {
  const links = extractLinksMap(token.links || {});
  const tw = normalizeHandle(links.twitter);
  const tg = normalizeHandle(links.telegram);
  const web = normalizeHandle(links.website);
  const name = String(token.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const caPrefix = String(token.ca || "").slice(0, 8).toLowerCase();

  const parts = [];
  if (tw) parts.push(`x:${tw}`);
  if (tg) parts.push(`tg:${tg}`);
  if (web) parts.push(`web:${web}`);
  if (!parts.length) {
    parts.push(`name:${name || "unknown"}`);
    parts.push(`ca:${caPrefix}`);
  }

  return parts.join("|");
}

async function analyzeDeveloper(token) {
  await ensureDevDb();
  const fingerprint = fingerprintProject(token);
  const row = devDb.fingerprints[fingerprint] || {
    observations: 0,
    corpseFlags: 0,
    rugFlags: 0,
    wins: 0,
    losses: 0
  };

  let score = 0;
  const notes = [];

  const links = extractLinksMap(token.links || {});
  if (links.twitter) {
    score += 6;
    notes.push("Twitter/X present");
  } else {
    score -= 8;
    notes.push("No Twitter/X");
  }

  if (links.telegram) {
    score += 4;
    notes.push("Telegram present");
  } else {
    score -= 4;
    notes.push("No Telegram");
  }

  if (links.website) {
    score += 6;
    notes.push("Website present");
  } else {
    score -= 4;
    notes.push("No website");
  }

  if (row.observations >= 2) {
    notes.push(`Seen before (${row.observations}x)`);
  }

  if (row.corpseFlags >= 1) {
    score -= 15;
    notes.push(`Corpse history: ${row.corpseFlags}`);
  }

  if (row.rugFlags >= 1) {
    score -= 20;
    notes.push(`Rug history: ${row.rugFlags}`);
  }

  if (row.losses > row.wins && row.losses >= 2) {
    score -= 8;
    notes.push("Past outcomes negative");
  } else if (row.wins > row.losses && row.wins >= 2) {
    score += 6;
    notes.push("Past outcomes slightly positive");
  }

  const verdict =
    score >= 15 ? "Clean"
    : score >= 0 ? "Mixed"
    : score >= -20 ? "Risky"
    : "Bad";

  return {
    score,
    verdict,
    fingerprintKey: fingerprint,
    notes
  };
}

export async function recordProjectRiskEvent(token, flags = {}) {
  await ensureDevDb();
  const fp = fingerprintProject(token);
  const row = devDb.fingerprints[fp] || {
    observations: 0,
    corpseFlags: 0,
    rugFlags: 0,
    wins: 0,
    losses: 0
  };

  row.observations += 1;
  if (flags.corpse) row.corpseFlags += 1;
  if (flags.rug) row.rugFlags += 1;

  devDb.fingerprints[fp] = row;
  await flushDevDb();
}

export async function recordTradeOutcomeFromSignalContext(signalContext = {}, netPnlPct = 0) {
  await ensureDevDb();

  const fp = signalContext?.developer?.fingerprintKey;
  if (!fp) return;

  const row = devDb.fingerprints[fp] || {
    observations: 0,
    corpseFlags: 0,
    rugFlags: 0,
    wins: 0,
    losses: 0
  };

  if (safeNum(netPnlPct) > 0) row.wins += 1;
  else row.losses += 1;

  devDb.fingerprints[fp] = row;
  await flushDevDb();
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

function detectCorpse(token, delta) {
  let score = 0;
  const reasons = [];

  const volumeToFdv = token.fdv > 0 ? token.volume / token.fdv : 999999;
  const fdvToLiquidity = token.liquidity > 0 ? token.fdv / token.liquidity : 999999;
  const isPumpAddress = String(token.ca || "").toLowerCase().endsWith("pump");

  if (volumeToFdv > 8 && token.liquidity < 15000) {
    score += 28;
    reasons.push("Volume massively exceeds current FDV on thin structure");
  }

  if (token.txns > 1800 && token.liquidity < 9000) {
    score += 24;
    reasons.push("Corpse-like activity on very thin liquidity");
  }

  if (token.fdv < 25000 && token.volume > 200000) {
    score += 22;
    reasons.push("Very low FDV with oversized churn");
  }

  if (fdvToLiquidity < 3 && token.volume > 120000 && token.liquidity < 15000) {
    score += 16;
    reasons.push("Collapsed structure still farming flow");
  }

  if (delta.hasHistory) {
    if (delta.priceDeltaPct < -12 && delta.liquidityDeltaPct < -6) {
      score += 28;
      reasons.push("Recent structural collapse detected");
    }

    if (delta.priceDeltaPct < -8 && delta.volumeDeltaPct >= 0 && delta.buyPressureDelta <= 0) {
      score += 20;
      reasons.push("Dead bounce / residual selling");
    }

    if (delta.priceDeltaPct <= 0 && delta.txnsDeltaPct > 5 && delta.liquidityDeltaPct < 0) {
      score += 16;
      reasons.push("Activity persists while structure keeps decaying");
    }

    if (delta.fdvDeltaPct < -15 && delta.volumeDeltaPct > -5) {
      score += 18;
      reasons.push("FDV collapse not matched by recovery quality");
    }
  }

  if (isPumpAddress && token.liquidity < 12000 && token.volume > 150000) {
    score += 12;
    reasons.push("Pump tail-risk on low liquidity after churn");
  }

  return {
    score,
    reasons,
    isCorpse: score >= 45
  };
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

function buildBaseStrategy(token, delta, accumulation, distribution, absorption, override, corpse, developer) {
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
  expectedEdgePct -= corpse.score / 50;
  expectedEdgePct += developer.score / 20;

  if (override.active && !corpse.isCorpse) {
    expectedEdgePct += 0.8;
    intendedHoldMs = 210000;
    takeProfitPct = 5.2;
    stopLossPct = 2.6;
    reason = "EXCEPTIONAL_ACCUMULATION_OVERRIDE";
  } else if (
    delta.volumeDeltaPct > 20 &&
    delta.txnsDeltaPct > 15 &&
    delta.buyPressureDelta > 0.08 &&
    !corpse.isCorpse
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

async function refreshMediaCache() {
  const now = Date.now();
  if (now - mediaCacheLoadedAt < 10 * 60 * 1000 && mediaCache.size) return;

  mediaCache.clear();

  try {
    const profiles = await fetchJson(TOKEN_PROFILES_API);
    if (Array.isArray(profiles)) {
      for (const item of profiles) {
        if (!item?.tokenAddress) continue;
        mediaCache.set(item.tokenAddress, {
          icon: item.icon || null,
          header: item.header || null,
          description: item.description || "",
          links: item.links || {}
        });
      }
    }
  } catch {}

  try {
    const boosts = await fetchJson(TOKEN_BOOSTS_API);
    if (Array.isArray(boosts)) {
      for (const item of boosts) {
        if (!item?.tokenAddress) continue;

        const prev = mediaCache.get(item.tokenAddress) || {};
        mediaCache.set(item.tokenAddress, {
          icon: prev.icon || item.icon || null,
          header: prev.header || item.header || null,
          description: prev.description || "",
          links: prev.links || {}
        });
      }
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
    iconUrl: media.icon || null,
    headerUrl: media.header || null,
    description: media.description || "",
    links: media.links || {}
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
  const blacklistItem = getCorpseBlacklistItem(token.ca);

  const delta = computeDelta(token);
  const rug = detectRug(token);
  const wallet = analyzeWallets(token);
  const bots = detectBots(token);
  const sentiment = getSentiment(token);
  const accumulation = detectAccumulation(token, delta);
  const distribution = detectDistribution(token, delta);
  const absorption = detectAbsorption(token, delta);
  const corpse = detectCorpse(token, delta);
  const exceptionalOverride = buildExceptionalOverride(token, accumulation, distribution, absorption);
  const falseBounce = detectFalseBounce(token, delta, accumulation, distribution);

  const enrichedToken = await enrichTokenMedia(token);
  const developer = await analyzeDeveloper(enrichedToken);
  const narrative = analyzeNarrative(enrichedToken);
  const socials = analyzeSocials(enrichedToken);

  const strategy = buildBaseStrategy(
    token,
    delta,
    accumulation,
    distribution,
    absorption,
    exceptionalOverride,
    corpse,
    developer
  );

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

  score += narrative.score;
  score += socials.score;
  score += developer.score;

  if (narrative.positives.length) reasons.push(...narrative.positives.map(v => `Narrative: ${v}`));
  if (narrative.flags.length) reasons.push(...narrative.flags.map(v => `Narrative: ${v}`));
  if (socials.notes.length) reasons.push(...socials.notes.map(v => `Social: ${v}`));
  if (developer.notes.length) reasons.push(...developer.notes.map(v => `Dev: ${v}`));

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
  score -= Math.round(corpse.score / 3);

  if (exceptionalOverride.active) {
    score += 15;
    reasons.push(...exceptionalOverride.reasons);
  }

  if (corpse.isCorpse) {
    reasons.push(...corpse.reasons);
    addToCorpseBlacklist(token.ca, corpse.reasons[0] || "Corpse filter");
    await recordProjectRiskEvent(enrichedToken, { corpse: true, rug: rug.isRug });
  }

  if (rug.isRug) {
    await recordProjectRiskEvent(enrichedToken, { corpse: false, rug: true });
  }

  if (blacklistItem) {
    score -= 100;
    reasons.push(`Corpse blacklist active: ${blacklistItem.reason}`);
  }

  if (falseBounce.rejected) {
    score -= 30;
    reasons.push(...falseBounce.reasons);
  }

  return {
    token: enrichedToken,
    rug,
    wallet,
    bots,
    sentiment,
    delta,
    accumulation,
    distribution,
    absorption,
    corpse,
    developer,
    narrative,
    socials,
    exceptionalOverride,
    falseBounce,
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
    if (exclude.has(token.ca)) {
      putSnapshot(token);
      continue;
    }
    const row = await analyzeToken(token);
    analyzed.push(row);
    putSnapshot(token);
  }

  analyzed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.token.volume - a.token.volume;
  });

  return analyzed[0] || null;
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
