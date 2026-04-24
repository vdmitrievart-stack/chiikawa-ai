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

function safeText(v) {
  return String(v || "").trim();
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

function detectLinkKey(label = "", type = "", url = "") {
  const l = String(label || "").toLowerCase();
  const t = String(type || "").toLowerCase();
  const u = String(url || "").toLowerCase();

  if (
    t.includes("twitter") ||
    l.includes("twitter") ||
    l === "x" ||
    u.includes("x.com/") ||
    u.includes("twitter.com/")
  ) return "twitter";

  if (t.includes("telegram") || l.includes("telegram") || u.includes("t.me/")) {
    return "telegram";
  }

  if (t.includes("instagram") || l.includes("instagram") || u.includes("instagram.com/")) {
    return "instagram";
  }

  if (t.includes("facebook") || l.includes("facebook") || u.includes("facebook.com/")) {
    return "facebook";
  }

  if (
    t.includes("youtube") ||
    l.includes("youtube") ||
    u.includes("youtube.com/") ||
    u.includes("youtu.be/")
  ) {
    return "youtube";
  }

  if (
    t.includes("discord") ||
    l.includes("discord") ||
    u.includes("discord.gg/") ||
    u.includes("discord.com/")
  ) {
    return "discord";
  }

  if (t.includes("tiktok") || l.includes("tiktok") || u.includes("tiktok.com/")) {
    return "tiktok";
  }

  if (t.includes("website") || l.includes("website")) return "website";
  return null;
}

function extractLinksMap(linksInput = {}) {
  const map = {
    twitter: "",
    telegram: "",
    website: "",
    instagram: "",
    facebook: "",
    youtube: "",
    discord: "",
    tiktok: ""
  };

  const setIfEmpty = (key, value) => {
    const url = String(value || "").trim();
    if (url && !map[key]) map[key] = url;
  };

  if (Array.isArray(linksInput)) {
    for (const item of linksInput) {
      const url = item?.url || "";
      const key = detectLinkKey(item?.label, item?.type, url);
      if (key) setIfEmpty(key, url);
      else if (url && !map.website) setIfEmpty("website", url);
    }
  } else if (typeof linksInput === "object" && linksInput) {
    setIfEmpty("twitter", linksInput.twitter || linksInput.x);
    setIfEmpty("telegram", linksInput.telegram);
    setIfEmpty("website", linksInput.website);
    setIfEmpty("instagram", linksInput.instagram);
    setIfEmpty("facebook", linksInput.facebook);
    setIfEmpty("youtube", linksInput.youtube);
    setIfEmpty("discord", linksInput.discord);
    setIfEmpty("tiktok", linksInput.tiktok);

    for (const [key, value] of Object.entries(linksInput)) {
      const detected = detectLinkKey(key, key, value);
      if (detected) setIfEmpty(detected, value);
      else if (String(value || "").startsWith("http") && !map.website) {
        setIfEmpty("website", value);
      }
    }
  }

  return map;
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

function normalizePair(p) {
  const buys = safeNum(p?.txns?.h24?.buys);
  const sells = safeNum(p?.txns?.h24?.sells);

  const socials = Array.isArray(p?.info?.socials) ? p.info.socials : [];
  const websites = Array.isArray(p?.info?.websites) ? p.info.websites : [];

  const links = [
    ...socials.map((x) => ({
      type: x?.type || "",
      label: x?.type || "",
      url: x?.url || ""
    })),
    ...websites.map((x) => ({
      type: "website",
      label: "website",
      url: x?.url || ""
    }))
  ];

  return {
    name: p?.baseToken?.name || p?.baseToken?.symbol || "UNKNOWN",
    symbol: p?.baseToken?.symbol || "",
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
    url: p?.url || "",
    imageUrl: p?.info?.imageUrl || null,
    description: p?.info?.description || p?.info?.header || "",
    links
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
  if (links.instagram) {
    score += 6;
    notes.push("Instagram");
  }
  if (links.facebook) {
    score += 4;
    notes.push("Facebook");
  }
  if (links.youtube) {
    score += 5;
    notes.push("YouTube");
  }
  if (links.discord) {
    score += 6;
    notes.push("Discord");
  }
  if (links.tiktok) {
    score += 5;
    notes.push("TikTok");
  }

  const socialCount = Object.values(links).filter(Boolean).length;

  if (socialCount === 0) {
    score -= 15;
    notes.push("No socials");
  } else if (!links.twitter && !links.telegram && socialCount >= 2) {
    notes.push("Alt socials present");
  }

  return { score, notes, links, socialCount };
}

function analyzeNarrative(token) {
  const links = extractLinksMap(token.links || {});
  const rawDescription = String(token.description || "").trim();
  const tokenName = String(token.name || "").trim();
  const symbol = String(token.symbol || token.name || "").trim();

  const combinedText = [
    rawDescription,
    tokenName,
    symbol,
    links.website ? "website present" : "",
    links.twitter ? "twitter present" : "",
    links.instagram ? "instagram present" : "",
    links.facebook ? "facebook present" : ""
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  const positives = [];
  const flags = [];

  if (!rawDescription) {
    if (tokenName && Object.values(links).some(Boolean)) {
      score += 2;
      positives.push("Basic project identity present");
      return {
        score,
        verdict: "Basic",
        positives,
        flags,
        summary: `${tokenName}${links.website ? " | website" : ""}${links.twitter ? " | x" : ""}${links.instagram ? " | instagram" : ""}${links.facebook ? " | facebook" : ""}`
      };
    }

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

  if (rawDescription.length > 120) {
    score += 10;
    positives.push("Detailed description");
  } else if (rawDescription.length >= 40) {
    score += 4;
    positives.push("Usable description");
  } else {
    score -= 6;
    flags.push("Too short");
  }

  if (combinedText.includes("100x") || combinedText.includes("next gem")) {
    score -= 20;
    flags.push("Hype wording");
  }

  if (
    combinedText.includes("ai") ||
    combinedText.includes("bot") ||
    combinedText.includes("tool") ||
    combinedText.includes("game") ||
    combinedText.includes("meme") ||
    combinedText.includes("community") ||
    combinedText.includes("parrot") ||
    combinedText.includes("pet")
  ) {
    score += 8;
    positives.push("Has concept");
  }

  const verdict =
    score >= 10 ? "Strong"
    : score > 2 ? "OK"
    : score >= 0 ? "Basic"
    : "Weak";

  return {
    score,
    verdict,
    positives,
    flags,
    summary: rawDescription.slice(0, 220)
  };
}

function classifyTokenMechanics(token) {
  const text = [
    safeText(token.name),
    safeText(token.symbol),
    safeText(token.description),
    safeText(token.profileHeader),
    safeText(token.profileDescription)
  ]
    .join(" ")
    .toLowerCase();

  let tokenType = "Standard";
  let rewardModel = "None";
  let beneficiarySignal = "Unknown";
  let claimSignal = "Unknown";
  const notes = [];
  let score = 0;

  if (text.includes("meme")) {
    tokenType = "Meme";
    notes.push("Meme branding");
  }

  if (text.includes("game") || text.includes("play")) {
    tokenType = tokenType === "Standard" ? "Game" : `${tokenType} / Game`;
    notes.push("Game wording");
  }

  if (text.includes("ai") || text.includes("bot")) {
    tokenType = tokenType === "Standard" ? "AI/Bot" : `${tokenType} / AI/Bot`;
    notes.push("AI/Bot wording");
  }

  if (
    text.includes("reward") ||
    text.includes("redistribution") ||
    text.includes("reflections") ||
    text.includes("reflection")
  ) {
    rewardModel = "Reward / Redistribution";
    notes.push("Reward-style mechanics mentioned");
    score += 4;
  }

  if (text.includes("cashback") || text.includes("cash back")) {
    rewardModel = rewardModel === "None" ? "Cashback" : `${rewardModel} + Cashback`;
    notes.push("Cashback wording");
    score += 4;
  }

  if (
    text.includes("buyback") ||
    text.includes("buy back") ||
    text.includes("buy-back")
  ) {
    rewardModel = rewardModel === "None" ? "Buyback" : `${rewardModel} + Buyback`;
    notes.push("Buyback wording");
    score += 5;
  }

  if (text.includes("burn") || text.includes("burning")) {
    rewardModel = rewardModel === "None" ? "Burn" : `${rewardModel} + Burn`;
    notes.push("Burn wording");
    score += 5;
  }

  if (text.includes("dev reward") || text.includes("reward to dev")) {
    beneficiarySignal = "Dev-beneficiary";
    notes.push("Dev reward mentioned");
    score -= 4;
  }

  if (
    text.includes("community wallet") ||
    text.includes("marketing wallet") ||
    text.includes("treasury") ||
    text.includes("backer wallet") ||
    text.includes("support wallet")
  ) {
    beneficiarySignal = "External aligned beneficiary";
    notes.push("External beneficiary wording");
    score += 5;
  }

  if (
    text.includes("renounced in favor") ||
    text.includes("renounced to") ||
    text.includes("in favor of") ||
    text.includes("transferred to community") ||
    text.includes("sent to community wallet")
  ) {
    beneficiarySignal = "Renounced / redirected beneficiary";
    notes.push("Renounced or redirected beneficiary wording");
    score += 7;
  }

  if (
    text.includes("claim rewards") ||
    text.includes("claiming rewards") ||
    text.includes("claimer") ||
    text.includes("claim wallet")
  ) {
    claimSignal = "Claim activity mentioned";
    notes.push("Claim behavior wording");
    score += 3;
  }

  if (
    text.includes("active claimer") ||
    text.includes("supporter claiming") ||
    text.includes("community claims") ||
    text.includes("backer claims")
  ) {
    claimSignal = "Positive aligned claimer";
    notes.push("Aligned external claimer wording");
    score += 6;
  }

  if (
    text.includes("dump rewards") ||
    text.includes("farm rewards") ||
    text.includes("extract rewards")
  ) {
    claimSignal = "Extraction risk";
    notes.push("Potential extraction wording");
    score -= 7;
  }

  return {
    tokenType,
    rewardModel,
    beneficiarySignal,
    claimSignal,
    notes,
    score
  };
}

function analyzeDexPaid(token) {
  const amount = safeNum(token.boostAmount);
  const totalAmount = safeNum(token.boostTotalAmount);
  const hasBoost = amount > 0 || totalAmount > 0;
  const hasProfile =
    Boolean(token.profileHeader) ||
    Boolean(token.profileDescription) ||
    Object.values(extractLinksMap(token.links || {})).some(Boolean);

  let status = "Unknown";
  let notes = [];
  let score = 0;

  if (hasBoost) {
    status = "Yes / Boosted";
    notes.push(`Boost amount: ${amount || totalAmount}`);
    score += 6;
  } else if (hasProfile) {
    status = "Profile present / no active boost seen";
    notes.push("Token profile exists");
    score += 2;
  } else {
    status = "No boost/profile detected";
    notes.push("No active paid boost found in profile cache");
    score -= 2;
  }

  return {
    status,
    notes,
    score,
    hasBoost,
    amount,
    totalAmount
  };
}

function fingerprintProject(token) {
  const links = extractLinksMap(token.links || {});
  const tw = normalizeHandle(links.twitter);
  const tg = normalizeHandle(links.telegram);
  const web = normalizeHandle(links.website);
  const ig = normalizeHandle(links.instagram);
  const fb = normalizeHandle(links.facebook);
  const name = String(token.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const caPrefix = String(token.ca || "").slice(0, 8).toLowerCase();

  const parts = [];
  if (tw) parts.push(`x:${tw}`);
  if (tg) parts.push(`tg:${tg}`);
  if (web) parts.push(`web:${web}`);
  if (ig) parts.push(`ig:${ig}`);
  if (fb) parts.push(`fb:${fb}`);

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

  if (links.instagram) {
    score += 3;
    notes.push("Instagram present");
  }

  if (links.facebook) {
    score += 2;
    notes.push("Facebook present");
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

  if (delta.hasHistory && delta.volumeDeltaPct < -35 && delta.priceDeltaPct < -15) {
    score += 22;
    reasons.push("Strong decay after prior activity");
  }

  if (fdvToLiquidity > 45) {
    score += 14;
    reasons.push("Extreme FDV/liquidity mismatch");
  }

  if (isPumpAddress && token.liquidity < 10000 && token.volume > 120000) {
    score += 14;
    reasons.push("Pump-style contract with weak surviving structure");
  }

  return {
    score,
    reasons,
    isCorpse: score >= 45
  };
}

function buildExceptionalOverride(token, accumulation, distribution, absorption) {
  const reasons = [];
  let active = false;

  if (
    token.liquidity >= 20000 &&
    token.volume >= 120000 &&
    accumulation.score >= 25 &&
    absorption.score >= 20 &&
    distribution.score <= 10
  ) {
    active = true;
    reasons.push("Exceptional flow override");
  }

  return { active, reasons };
}

function buildBaseStrategy(
  token,
  delta,
  accumulation,
  distribution,
  absorption,
  exceptionalOverride,
  corpse,
  developer,
  mechanics,
  dexPaid
) {
  let expectedEdgePct = 0;
  const reasons = [];

  if (delta.hasHistory) {
    if (delta.volumeDeltaPct > 12) {
      expectedEdgePct += 4;
      reasons.push("Volume is accelerating");
    }
    if (delta.txnsDeltaPct > 10) {
      expectedEdgePct += 3;
      reasons.push("Transaction activity is accelerating");
    }
    if (delta.buyPressureDelta > 0.08) {
      expectedEdgePct += 3;
      reasons.push("Buy pressure improving");
    }
    if (delta.priceDeltaPct > 1 && delta.priceDeltaPct < 12) {
      expectedEdgePct += 2;
      reasons.push("Healthy price expansion");
    }
  } else {
    expectedEdgePct -= 2;
    reasons.push("No historical delta yet");
  }

  expectedEdgePct += Math.round(accumulation.score / 6);
  expectedEdgePct += Math.round(absorption.score / 7);
  expectedEdgePct -= Math.round(distribution.score / 7);
  expectedEdgePct -= Math.round(corpse.score / 10);

  if (developer.verdict === "Clean") expectedEdgePct += 2;
  if (developer.verdict === "Bad") expectedEdgePct -= 6;

  expectedEdgePct += Math.round(mechanics.score / 3);
  expectedEdgePct += Math.round(dexPaid.score / 4);

  if (exceptionalOverride.active) expectedEdgePct += 4;

  return {
    expectedEdgePct: Math.max(0, expectedEdgePct),
    reasons
  };
}

async function refreshMediaCache() {
  const now = Date.now();
  if (now - mediaCacheLoadedAt < 60 * 1000 && mediaCache.size > 0) return;

  mediaCache.clear();

  try {
    const profiles = await fetchJson(TOKEN_PROFILES_API);
    if (Array.isArray(profiles)) {
      for (const item of profiles) {
        if (!item?.tokenAddress) continue;
        mediaCache.set(item.tokenAddress, {
          icon: item.icon || null,
          header: item.header || null,
          description: item.description || item.header || "",
          profileHeader: item.header || "",
          profileDescription: item.description || "",
          links: item.links || {},
          profileSource: "profile",
          boostAmount: 0,
          boostTotalAmount: 0
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
          description: prev.description || item.description || "",
          profileHeader: prev.profileHeader || item.header || "",
          profileDescription: prev.profileDescription || item.description || "",
          links: { ...(prev.links || {}), ...(item.links || {}) },
          profileSource: prev.profileSource || "boost",
          boostAmount: safeNum(item.amount),
          boostTotalAmount: safeNum(item.totalAmount)
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
    imageUrl: token.imageUrl || media.header || media.icon || null,
    iconUrl: token.iconUrl || media.icon || null,
    headerUrl: token.headerUrl || media.header || null,
    description: token.description || media.description || "",
    profileHeader: media.profileHeader || "",
    profileDescription: media.profileDescription || "",
    boostAmount: safeNum(media.boostAmount),
    boostTotalAmount: safeNum(media.boostTotalAmount),
    links: Array.isArray(token.links)
      ? [...token.links, ...(Array.isArray(media.links) ? media.links : [])]
      : { ...(token.links || {}), ...(media.links || {}) }
  };
}

function passesBaseSafety(token) {
  if (!token.ca || !token.name || token.price <= 0) return false;
  if (isStableLike(token.symbol || token.name)) return false;
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
  const mechanics = classifyTokenMechanics(enrichedToken);
  const dexPaid = analyzeDexPaid(enrichedToken);

  const strategy = buildBaseStrategy(
    enrichedToken,
    delta,
    accumulation,
    distribution,
    absorption,
    exceptionalOverride,
    corpse,
    developer,
    mechanics,
    dexPaid
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
  score += mechanics.score;
  score += dexPaid.score;

  if (narrative.positives.length) reasons.push(...narrative.positives.map((v) => `Narrative: ${v}`));
  if (narrative.flags.length) reasons.push(...narrative.flags.map((v) => `Narrative: ${v}`));
  if (socials.notes.length) reasons.push(...socials.notes.map((v) => `Social: ${v}`));
  if (developer.notes.length) reasons.push(...developer.notes.map((v) => `Dev: ${v}`));
  if (mechanics.notes.length) reasons.push(...mechanics.notes.map((v) => `Mechanics: ${v}`));
  if (dexPaid.notes.length) reasons.push(...dexPaid.notes.map((v) => `Dex: ${v}`));

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
    mechanics,
    dexPaid,
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
