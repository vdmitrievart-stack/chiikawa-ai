const userModerationState = new Map();

const SUSPICIOUS_KEYWORDS = [
  "airdrop",
  "claim",
  "claim now",
  "free mint",
  "free token",
  "connect wallet",
  "wallet connect",
  "verify wallet",
  "support team",
  "support admin",
  "dm me",
  "private message me",
  "message me",
  "investment opportunity",
  "100x",
  "1000x",
  "next x100",
  "guaranteed profit",
  "guaranteed",
  "presale",
  "pre-sale",
  "launch now",
  "stealth launch",
  "buy now",
  "ape now",
  "pump soon",
  "moon soon",
  "marketing push",
  "call channel",
  "insider alpha",
  "send sol",
  "double your",
  "recovery phrase",
  "seed phrase",
  "admin support",
  "official support",
  "bonus token",
  "reward claim",
  "urgent claim",
  "limited airdrop",
  "mint now",
  "exclusive drop",
  "foreign project",
  "new coin alert"
];

const SHILL_PHRASES = [
  "check this project",
  "join this project",
  "best project",
  "new token",
  "big gem",
  "moon token",
  "great community",
  "low cap gem",
  "hidden gem",
  "easy 10x",
  "easy 100x",
  "next pepe",
  "next doge",
  "next big meme",
  "ca:",
  "contract address",
  "token address",
  "buy this",
  "join now",
  "launching now",
  "fair launch",
  "massive potential",
  "big opportunity"
];

const SAFE_WORDS = [
  "chiikawa",
  "$chiikawa",
  "2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu",
  "chiikawasol.com"
];

function normalize(text) {
  return String(text || "").toLowerCase().trim();
}

function countLinks(text) {
  const matches = String(text || "").match(/https?:\/\/\S+|t\.me\/\S+|www\.\S+/gi);
  return matches ? matches.length : 0;
}

function countMentions(text) {
  const matches = String(text || "").match(/@\w+/g);
  return matches ? matches.length : 0;
}

function countCaps(text) {
  const raw = String(text || "");
  const letters = raw.replace(/[^A-Za-zА-Яа-я]/g, "");
  if (!letters.length) return 0;
  const caps = letters.replace(/[^A-ZА-Я]/g, "");
  return caps.length / letters.length;
}

function containsForeignCA(text) {
  const lower = normalize(text);

  if (lower.includes("2c1kjiyqow66qfsnctoyu...")) {
    return false;
  }

  const possibleCA = String(text || "").match(/[1-9A-HJ-NP-Za-km-z]{32,48}/g);
  if (!possibleCA) return false;

  return !possibleCA.some(ca => ca === "2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu");
}

function containsSafeWord(text) {
  const lower = normalize(text);
  return SAFE_WORDS.some(word => lower.includes(word.toLowerCase()));
}

function scoreMessage(text) {
  const lower = normalize(text);
  let score = 0;

  const links = countLinks(text);
  const mentions = countMentions(text);
  const capsRatio = countCaps(text);

  if (links >= 1) score += 2;
  if (links >= 2) score += 2;
  if (mentions >= 3) score += 2;
  if (capsRatio > 0.6) score += 1;
  if (containsForeignCA(text)) score += 4;

  for (const word of SUSPICIOUS_KEYWORDS) {
    if (lower.includes(word)) score += 2;
  }

  for (const phrase of SHILL_PHRASES) {
    if (lower.includes(phrase)) score += 1;
  }

  if (containsSafeWord(text)) {
    score -= 3;
  }

  return Math.max(score, 0);
}

export function getUserState(userId) {
  if (!userModerationState.has(userId)) {
    userModerationState.set(userId, {
      strikes: 0,
      lastReason: "",
      lastActionAt: 0
    });
  }
  return userModerationState.get(userId);
}

export function analyzeModeration(messageText) {
  const text = String(messageText || "").trim();
  const lower = normalize(text);

  if (!text) {
    return {
      action: "none",
      reason: "empty",
      score: 0
    };
  }

  // Явный фишинг / скам — сразу бан
  const hardScamSignals = [
    "seed phrase",
    "recovery phrase",
    "connect wallet",
    "verify wallet",
    "admin support",
    "official support",
    "send sol",
    "claim now"
  ];

  const hasHardScam = hardScamSignals.some(x => lower.includes(x));
  if (hasHardScam && countLinks(text) > 0) {
    return {
      action: "ban",
      reason: "hard scam signal",
      score: 999
    };
  }

  const score = scoreMessage(text);

  if (score >= 8) {
    return {
      action: "mute",
      reason: "high confidence shill/spam",
      score
    };
  }

  if (score >= 5) {
    return {
      action: "mute",
      reason: "suspicious promotional spam",
      score
    };
  }

  return {
    action: "none",
    reason: "not suspicious enough",
    score
  };
}

export function getMuteDurationSeconds(strikes) {
  if (strikes <= 0) return 3 * 60 * 60;       // 3 часа
  if (strikes === 1) return 24 * 60 * 60;     // 1 день
  return 3 * 24 * 60 * 60;                    // 3 дня
}

export function escalateAction(userId, baseAction, reason) {
  const state = getUserState(userId);

  if (baseAction === "none") {
    return {
      finalAction: "none",
      state
    };
  }

  if (baseAction === "ban") {
    state.strikes += 1;
    state.lastReason = reason;
    state.lastActionAt = Date.now();

    return {
      finalAction: "ban",
      state
    };
  }

  // baseAction === "mute"
  if (state.strikes >= 2) {
    state.strikes += 1;
    state.lastReason = reason;
    state.lastActionAt = Date.now();

    return {
      finalAction: "ban",
      state
    };
  }

  state.strikes += 1;
  state.lastReason = reason;
  state.lastActionAt = Date.now();

  return {
    finalAction: "mute",
    state
  };
}
