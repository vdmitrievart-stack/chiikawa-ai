import fs from "node:fs/promises";
import path from "node:path";

const RUNTIME_DIR = path.resolve("./runtime-data");
const DB_FILE = path.join(RUNTIME_DIR, "dev-history.json");

let dbCache = null;
let dbLoaded = false;

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function ensureDbLoaded() {
  if (dbLoaded && dbCache) return dbCache;

  await fs.mkdir(RUNTIME_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    dbCache = JSON.parse(raw);
  } catch {
    dbCache = {
      fingerprints: {},
      knownWallets: {}
    };
  }

  dbLoaded = true;
  return dbCache;
}

async function flushDb() {
  if (!dbCache) return;
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(dbCache, null, 2), "utf8");
}

function normalizeHandle(value) {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^x\.com\//, "")
    .replace(/^twitter\.com\//, "")
    .replace(/^t\.me\//, "")
    .replace(/\/+$/, "")
    .trim();
}

function tryParseUrl(urlLike) {
  try {
    const u = new URL(urlLike);
    return u;
  } catch {
    return null;
  }
}

function extractLinksMap(linksInput = {}) {
  const map = {
    twitter: "",
    telegram: "",
    website: ""
  };

  if (Array.isArray(linksInput)) {
    for (const item of linksInput) {
      const label = String(item?.label || "").toLowerCase();
      const type = String(item?.type || "").toLowerCase();
      const url = item?.url || "";

      if (type.includes("twitter") || label.includes("twitter") || label.includes("x")) {
        map.twitter = url;
      } else if (type.includes("telegram") || label.includes("telegram")) {
        map.telegram = url;
      } else if (type.includes("website") || label.includes("website")) {
        map.website = url;
      } else if (!map.website && url) {
        map.website = url;
      }
    }
  } else if (linksInput && typeof linksInput === "object") {
    map.twitter = linksInput.twitter || linksInput.x || "";
    map.telegram = linksInput.telegram || "";
    map.website = linksInput.website || linksInput.site || "";
  }

  return map;
}

function fingerprintProject(token) {
  const links = extractLinksMap(token.links || {});
  const twitterHandle = normalizeHandle(links.twitter);
  const telegramHandle = normalizeHandle(links.telegram);

  const websiteUrl = tryParseUrl(links.website);
  const websiteHost = websiteUrl?.hostname?.replace(/^www\./, "").toLowerCase() || "";

  const name = String(token.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const caPrefix = String(token.ca || "").slice(0, 8).toLowerCase();

  const parts = [];

  if (twitterHandle) parts.push(`x:${twitterHandle}`);
  if (telegramHandle) parts.push(`tg:${telegramHandle}`);
  if (websiteHost) parts.push(`web:${websiteHost}`);

  // fallback fingerprint if project has zero socials
  if (!parts.length) {
    parts.push(`name:${name || "unknown"}`);
    parts.push(`ca:${caPrefix}`);
  }

  return {
    key: parts.join("|"),
    twitterHandle,
    telegramHandle,
    websiteHost,
    links
  };
}

function getEnvWalletRegistry() {
  try {
    const raw = process.env.DEV_WALLET_REGISTRY_JSON;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function analyzeDeveloper(token) {
  const db = await ensureDbLoaded();
  const fingerprint = fingerprintProject(token);
  const history = db.fingerprints[fingerprint.key] || {
    firstSeenAt: null,
    lastSeenAt: null,
    observations: 0,
    corpseFlags: 0,
    rugFlags: 0,
    trades: 0,
    wins: 0,
    losses: 0
  };

  const envRegistry = getEnvWalletRegistry();
  const walletStats =
    envRegistry[token.ca] ||
    envRegistry[fingerprint.key] ||
    db.knownWallets[token.ca] ||
    db.knownWallets[fingerprint.key] ||
    null;

  let score = 0;
  const notes = [];
  let confidence = 0;

  if (fingerprint.twitterHandle) {
    score += 6;
    notes.push("Twitter/X present");
    confidence += 10;
  } else {
    score -= 8;
    notes.push("No Twitter/X");
  }

  if (fingerprint.telegramHandle) {
    score += 4;
    notes.push("Telegram present");
    confidence += 8;
  } else {
    score -= 4;
    notes.push("No Telegram");
  }

  if (fingerprint.websiteHost) {
    score += 6;
    notes.push("Website present");
    confidence += 8;
  } else {
    score -= 4;
    notes.push("No website");
  }

  if (history.observations >= 2) {
    confidence += 12;
    notes.push(`Seen before (${history.observations}x)`);
  }

  if (history.corpseFlags >= 1) {
    score -= 15;
    notes.push(`Corpse history: ${history.corpseFlags}`);
    confidence += 15;
  }

  if (history.corpseFlags >= 2) {
    score -= 15;
    notes.push("Repeated corpse-like launches");
  }

  if (history.rugFlags >= 1) {
    score -= 20;
    notes.push(`Rug history: ${history.rugFlags}`);
    confidence += 20;
  }

  if (history.rugFlags >= 2) {
    score -= 20;
    notes.push("Repeated rug pattern detected");
  }

  if (history.trades >= 3) {
    confidence += 10;
    if (history.wins > history.losses) {
      score += 6;
      notes.push("Past outcomes slightly positive");
    } else if (history.losses > history.wins) {
      score -= 8;
      notes.push("Past outcomes negative");
    }
  }

  let walletTrackingMode = "fingerprint";
  let wallet = null;

  if (walletStats) {
    walletTrackingMode = "registry";
    wallet = walletStats.wallet || walletStats.address || null;
    confidence += 25;

    const creatorHoldPct = safeNum(walletStats.creatorHoldPct, null);
    const rugCount = safeNum(walletStats.rugCount, 0);
    const winRate = safeNum(walletStats.winRatePct, null);

    if (creatorHoldPct !== null) {
      if (creatorHoldPct > 8) {
        score -= 18;
        notes.push(`Creator hold too high (${creatorHoldPct}%)`);
      } else if (creatorHoldPct < 2) {
        score += 6;
        notes.push(`Creator hold moderate (${creatorHoldPct}%)`);
      }
    }

    if (rugCount > 0) {
      score -= Math.min(30, rugCount * 10);
      notes.push(`Registry rug count: ${rugCount}`);
    }

    if (winRate !== null) {
      if (winRate >= 60) {
        score += 10;
        notes.push(`Registry win rate ${winRate}%`);
      } else if (winRate < 35) {
        score -= 10;
        notes.push(`Registry win rate only ${winRate}%`);
      }
    }
  }

  const verdict =
    score >= 15 ? "Clean"
    : score >= 0 ? "Mixed"
    : score >= -20 ? "Risky"
    : "Bad";

  return {
    score,
    verdict,
    confidence: Math.min(100, confidence),
    walletTrackingMode,
    wallet,
    fingerprintKey: fingerprint.key,
    fingerprint,
    history,
    notes
  };
}

export async function recordProjectRiskEvent(token, flags = {}) {
  const db = await ensureDbLoaded();
  const fingerprint = fingerprintProject(token);

  const row = db.fingerprints[fingerprint.key] || {
    firstSeenAt: null,
    lastSeenAt: null,
    observations: 0,
    corpseFlags: 0,
    rugFlags: 0,
    trades: 0,
    wins: 0,
    losses: 0
  };

  if (!row.firstSeenAt) row.firstSeenAt = Date.now();
  row.lastSeenAt = Date.now();
  row.observations += 1;

  if (flags.corpse) row.corpseFlags += 1;
  if (flags.rug) row.rugFlags += 1;

  db.fingerprints[fingerprint.key] = row;
  await flushDb();
}

export async function recordTradeOutcomeFromSignalContext(signalContext = {}, netPnlPct = 0) {
  const db = await ensureDbLoaded();
  const fingerprintKey = signalContext?.developer?.fingerprintKey;
  if (!fingerprintKey) return;

  const row = db.fingerprints[fingerprintKey] || {
    firstSeenAt: null,
    lastSeenAt: null,
    observations: 0,
    corpseFlags: 0,
    rugFlags: 0,
    trades: 0,
    wins: 0,
    losses: 0
  };

  row.lastSeenAt = Date.now();
  row.trades += 1;

  if (safeNum(netPnlPct) > 0) row.wins += 1;
  else row.losses += 1;

  db.fingerprints[fingerprintKey] = row;
  await flushDb();
}
