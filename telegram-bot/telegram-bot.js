import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import {
  initTradingAdmin,
  getTradingRuntime,
  getLevel6Summary,
  getLevel6OpenTrades,
  handleTradingCommand,
  simulateTradeFlow
} from "./trading-admin.js";
import {
  scanTokenCandidate,
  buildScanProposal,
  dryRunEntryFromScan,
  buildCompactScanSummary
} from "./scan-engine.js";

const TOKEN =
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  "";

const CHAT_ID =
  process.env.CHAT_ID ||
  process.env.FORCED_GROUP_CHAT_ID ||
  process.env.TELEGRAM_ALERT_CHAT_ID ||
  "";

const PORT = Number(process.env.PORT || 3000);

const TELEGRAM_WEBHOOK_BASE_URL =
  (process.env.TELEGRAM_WEBHOOK_BASE_URL || "").replace(/\/+$/, "");

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET ||
  process.env.ADMIN_SECRET ||
  "chiikawa_webhook_secret_2026";

const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;
const WEBHOOK_URL = `${TELEGRAM_WEBHOOK_BASE_URL}${WEBHOOK_PATH}`;

const TWITTER_BEARER_TOKEN =
  process.env.TWITTER_BEARER_TOKEN ||
  "";

const X_SEARCH_QUERIES = getEnvList("X_SEARCH_QUERIES").length
  ? getEnvList("X_SEARCH_QUERIES")
  : ["Chiikawa", "ちいかわ", "ハチワレ", "うさぎ", "ナガノ"];

const X_GIF_FILE_IDS = getEnvList("X_GIF_FILE_IDS");
const X_LOOP_INTERVAL_MS = Number(process.env.X_LOOP_INTERVAL_MS || 60000);
const X_MAX_RESULTS = Number(process.env.X_MAX_RESULTS || 15);
const X_MAX_STORED_IDS = Number(process.env.X_MAX_STORED_IDS || 800);
const X_MIN_FOLLOWERS = Number(process.env.X_MIN_FOLLOWERS || 1000);
const X_POST_SCORE_MIN = Number(process.env.X_POST_SCORE_MIN || 42);
const X_CTA_SCORE = Number(process.env.X_CTA_SCORE || 78);
const X_POST_COOLDOWN_MS = Number(process.env.X_POST_COOLDOWN_MS || 20000);
const X_WATCH_HEARTBEAT_TIMEOUT_MS = Number(
  process.env.X_WATCH_HEARTBEAT_TIMEOUT_MS || 180000
);
const X_MAX_POSTS_PER_CYCLE = Number(process.env.X_MAX_POSTS_PER_CYCLE || 2);
const MARKET_MODE = (process.env.MARKET_MODE || "neutral").toLowerCase();

const STATE_FILE = path.resolve("/tmp/chiikawa_x_search_state.json");

if (!TOKEN) {
  console.error("❌ BOT_TOKEN missing");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("❌ CHAT_ID / TELEGRAM_ALERT_CHAT_ID missing");
  process.exit(1);
}

if (!TELEGRAM_WEBHOOK_BASE_URL) {
  console.error("❌ TELEGRAM_WEBHOOK_BASE_URL missing");
  process.exit(1);
}

if (!TWITTER_BEARER_TOKEN) {
  console.error("❌ TWITTER_BEARER_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });
const userSettings = new Map();
const authorCache = new Map();
const userFlows = new Map();
const scanStore = new Map();

const xState = {
  started: false,
  timer: null,
  guardTimer: null,
  firstSyncDone: false,
  seenIds: new Set(),
  lastHeartbeat: Date.now(),
  lastPostAt: 0,
  gifCursor: 0,
  gifLastIndex: -1,
  lastPublishedTexts: []
};

const I18N = {
  en: {
    botAlive: "🚀 Bot is alive",
    center: "🧠 Chiikawa Control Center",
    statusTitle: "📊 System Status",
    trading: "Trading",
    mode: "Mode",
    killSwitch: "Kill switch",
    buyMin: "Buy min",
    dryRun: "Dry run",
    level6: "Level 6",
    winRate: "Win rate",
    trades: "Trades",
    pnl: "PnL",
    score: "Score",
    avgEntryScore: "Avg entry score",
    openTrades: "Open trades",
    online: "ONLINE",
    offline: "OFFLINE",
    watcher: "X scanner",
    heartbeat: "Heartbeat",
    accounts: "Queries",
    chooseLang: "🌍 Choose language",
    langSet: "🌍 Language set",
    noOpenTrades: "No open trades",
    entryStarted: "🚀 Test trade launched",
    awaitingCA: "⌛ Waiting for CA. Send contract address in next message.",
    scanStarted: "🔎 Level 6 scan started",
    scanReady: "✅ Scan ready",
    noScan: "No scan found. Send a CA first.",
    dryRunRejected: "⛔ Dry-run entry rejected",
    dryRunAccepted: "✅ Dry-run entry accepted"
  },
  ru: {
    botAlive: "🚀 Бот жив",
    center: "🧠 Центр управления Chiikawa",
    statusTitle: "📊 Статус системы",
    trading: "Торговля",
    mode: "Режим",
    killSwitch: "Kill switch",
    buyMin: "Мин. покупка",
    dryRun: "Dry run",
    level6: "Level 6",
    winRate: "Винрейт",
    trades: "Сделки",
    pnl: "PnL",
    score: "Оценка",
    avgEntryScore: "Средняя оценка входа",
    openTrades: "Открытые сделки",
    online: "ОНЛАЙН",
    offline: "ОФЛАЙН",
    watcher: "X scanner",
    heartbeat: "Пульс",
    accounts: "Запросы",
    chooseLang: "🌍 Выбери язык",
    langSet: "🌍 Язык установлен",
    noOpenTrades: "Открытых сделок нет",
    entryStarted: "🚀 Тестовая сделка запущена",
    awaitingCA: "⌛ Жду CA. Отправь контракт следующим сообщением.",
    scanStarted: "🔎 Level 6 скан запущен",
    scanReady: "✅ Скан готов",
    noScan: "Нет данных скана. Сначала отправь CA.",
    dryRunRejected: "⛔ Dry-run вход отклонён",
    dryRunAccepted: "✅ Dry-run вход одобрен"
  }
};

function getEnvList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text) {
  return stripHtml(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#][\p{L}\p{N}_]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeText(text)
    .split(" ")
    .filter(token => token.length >= 2);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));

  if (!setA.size || !setB.size) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }

  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function getUserLang(userId) {
  return userSettings.get(userId)?.lang || "ru";
}

function setUserLang(userId, lang) {
  const current = userSettings.get(userId) || {};
  userSettings.set(userId, { ...current, lang });
}

function t(userId, key) {
  const lang = getUserLang(userId);
  return (I18N[lang] && I18N[lang][key]) || I18N.ru[key] || key;
}

function setUserFlow(userId, flow) {
  userFlows.set(userId, flow);
}

function clearUserFlow(userId) {
  userFlows.delete(userId);
}

function getUserFlow(userId) {
  return userFlows.get(userId) || null;
}

function pickNaturalGif() {
  const list = X_GIF_FILE_IDS;
  if (!Array.isArray(list) || !list.length) return null;

  if (list.length === 1) {
    xState.gifCursor = 0;
    xState.gifLastIndex = 0;
    return list[0];
  }

  let idx = xState.gifCursor % list.length;
  if (idx === xState.gifLastIndex) {
    idx = (idx + 1) % list.length;
  }

  xState.gifLastIndex = idx;
  xState.gifCursor = (idx + 1) % list.length;

  return list[idx];
}

async function sendText(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options
  });
}

async function sendAnimation(chatId, animation, options = {}) {
  return bot.sendAnimation(chatId, animation, options);
}

async function sendTradePayload(chatId, payload, replyToMessageId = undefined) {
  if (!payload) return;

  const text = String(payload.text || "").trim();
  const gif = payload.gif || null;

  try {
    if (gif && /^https?:\/\//i.test(gif)) {
      await sendText(chatId, `${text}\n\n${gif}`.trim(), {
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
      });
      return;
    }

    if (gif && !/^https?:\/\//i.test(gif)) {
      await sendAnimation(chatId, gif, {
        caption: text.slice(0, 1024),
        parse_mode: "HTML",
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
      });
      return;
    }

    await sendText(chatId, text, {
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  } catch (error) {
    console.log(`sendTradePayload error: ${error.message}`);
    await sendText(chatId, text, {
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  }
}

function buildMainMenuText(userId) {
  const runtime = getTradingRuntime();
  const summary = getLevel6Summary();

  return `${t(userId, "center")}

<b>${t(userId, "trading")}:</b> ${runtime.enabled ? "ON" : "OFF"}
<b>${t(userId, "mode")}:</b> ${runtime.mode}
<b>${t(userId, "killSwitch")}:</b> ${runtime.killSwitch ? "ON" : "OFF"}
<b>${t(userId, "buyMin")}:</b> $${runtime.buybotAlertMinUsd}
<b>${t(userId, "dryRun")}:</b> ${runtime.dryRun ? "ON" : "OFF"}

<b>${t(userId, "level6")}:</b>
• ${t(userId, "winRate")}: ${(summary.winRate * 100).toFixed(1)}%
• ${t(userId, "trades")}: ${summary.totalTrades}
• ${t(userId, "pnl")}: ${summary.pnl}%
• ${t(userId, "score")}: ${summary.avgEntryScore}`;
}

function buildStatusText(userId) {
  const runtime = getTradingRuntime();
  const summary = getLevel6Summary();
  const openTrades = getLevel6OpenTrades();

  return `${t(userId, "statusTitle")}

<b>Bot:</b> ${t(userId, "online")}
<b>${t(userId, "watcher")}:</b> ${xState.started ? t(userId, "online") : t(userId, "offline")}
<b>${t(userId, "heartbeat")}:</b> ${new Date(xState.lastHeartbeat).toLocaleString()}
<b>${t(userId, "accounts")}:</b> ${X_SEARCH_QUERIES.join(" | ")}

<b>${t(userId, "trading")}:</b> ${runtime.enabled ? "ON" : "OFF"}
<b>${t(userId, "mode")}:</b> ${runtime.mode}
<b>${t(userId, "killSwitch")}:</b> ${runtime.killSwitch ? "ON" : "OFF"}
<b>${t(userId, "buyMin")}:</b> $${runtime.buybotAlertMinUsd}
<b>${t(userId, "dryRun")}:</b> ${runtime.dryRun ? "ON" : "OFF"}

<b>${t(userId, "level6")}:</b>
• ${t(userId, "winRate")}: ${(summary.winRate * 100).toFixed(1)}%
• ${t(userId, "trades")}: ${summary.totalTrades}
• ${t(userId, "pnl")}: ${summary.pnl}%
• ${t(userId, "avgEntryScore")}: ${summary.avgEntryScore}
• ${t(userId, "openTrades")}: ${openTrades.length}`;
}

function buildLevel6Text(userId) {
  const summary = getLevel6Summary();
  const openTrades = getLevel6OpenTrades();

  if (!openTrades.length) {
    return `🧠 <b>${t(userId, "level6")}</b>

<b>${t(userId, "winRate")}:</b> ${(summary.winRate * 100).toFixed(1)}%
<b>${t(userId, "trades")}:</b> ${summary.totalTrades}
<b>${t(userId, "pnl")}:</b> ${summary.pnl}%
<b>${t(userId, "score")}:</b> ${summary.avgEntryScore}

${t(userId, "noOpenTrades")}`;
  }

  const open = openTrades
    .map(
      (trade, index) =>
        `${index + 1}. ${trade.token}
Entry: ${trade.entry}
Current: ${trade.current}
PnL: ${Number(trade.pnl || 0).toFixed(2)}%
Score: ${trade.score}`
    )
    .join("\n\n");

  return `🧠 <b>${t(userId, "level6")}</b>

<b>${t(userId, "winRate")}:</b> ${(summary.winRate * 100).toFixed(1)}%
<b>${t(userId, "trades")}:</b> ${summary.totalTrades}
<b>${t(userId, "pnl")}:</b> ${summary.pnl}%
<b>${t(userId, "score")}:</b> ${summary.avgEntryScore}

${open}`;
}

function buildMenuKeyboard() {
  const runtime = getTradingRuntime();

  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "ui:status" },
        { text: "🧠 Level 6", callback_data: "ui:l6" }
      ],
      [
        { text: "🔎 Scan CA", callback_data: "scan:prompt" },
        { text: "📄 Last Scan", callback_data: "scan:last" }
      ],
      [
        {
          text: runtime.enabled ? "⛔ Trading OFF" : "✅ Trading ON",
          callback_data: "cmd:toggle_trading"
        },
        {
          text: runtime.dryRun ? "💸 DryRun OFF" : "🧪 DryRun ON",
          callback_data: "cmd:toggle_dryrun"
        }
      ],
      [
        { text: "⚙️ Mode", callback_data: "cmd:mode" },
        { text: "🛑 Kill Switch", callback_data: "cmd:kill" }
      ],
      [
        { text: "🚀 Test Trade", callback_data: "cmd:test_trade" },
        { text: "🌍 Language", callback_data: "ui:lang" }
      ]
    ]
  };
}

function buildLanguageKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "English", callback_data: "lang:en" }],
      [{ text: "Русский", callback_data: "lang:ru" }]
    ]
  };
}

function buildScanKeyboard(scanId) {
  return {
    inline_keyboard: [
      [
        { text: "📄 Proposal", callback_data: `scan:proposal:${scanId}` },
        { text: "🧠 Decision", callback_data: `scan:decision:${scanId}` }
      ],
      [
        { text: "👛 Wallet Intel", callback_data: `scan:wallet:${scanId}` },
        { text: "🛡 Rug Risk", callback_data: `scan:rug:${scanId}` }
      ],
      [
        { text: "📣 Social", callback_data: `scan:social:${scanId}` },
        { text: "⚠️ Risks", callback_data: `scan:risks:${scanId}` }
      ],
      [
        { text: "🧾 Full Report", callback_data: `scan:full:${scanId}` },
        { text: "🔁 Refresh Scan", callback_data: `scan:refresh:${scanId}` }
      ],
      [
        { text: "🧪 Dry Run Entry", callback_data: `scan:dryrun:${scanId}` }
      ]
    ]
  };
}

async function openMenu(chatId, userId, replyToMessageId) {
  await sendText(chatId, buildMainMenuText(userId), {
    reply_markup: buildMenuKeyboard(),
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
  });
}

async function refreshMenu(chatId, messageId, userId) {
  if (!chatId || !messageId) return;

  try {
    await bot.editMessageText(buildMainMenuText(userId), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMenuKeyboard()
    });
  } catch (error) {
    console.log(`refreshMenu fallback: ${error.message}`);
    await openMenu(chatId, userId);
  }
}

async function loadXState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    xState.firstSyncDone = Boolean(parsed.firstSyncDone);
    xState.lastPostAt = safeNum(parsed.lastPostAt, 0);
    xState.gifCursor = safeNum(parsed.gifCursor, 0);
    xState.gifLastIndex = safeNum(parsed.gifLastIndex, -1);
    xState.seenIds = new Set(
      Array.isArray(parsed.seenIds) ? parsed.seenIds.slice(-X_MAX_STORED_IDS) : []
    );
    xState.lastPublishedTexts = Array.isArray(parsed.lastPublishedTexts)
      ? parsed.lastPublishedTexts.slice(-25)
      : [];

    console.log(`loaded X state: ${xState.seenIds.size} ids`);
  } catch {
    console.log("x state not found, starting fresh");
  }
}

async function saveXState() {
  try {
    const payload = {
      firstSyncDone: xState.firstSyncDone,
      lastPostAt: xState.lastPostAt,
      gifCursor: xState.gifCursor,
      gifLastIndex: xState.gifLastIndex,
      seenIds: Array.from(xState.seenIds).slice(-X_MAX_STORED_IDS),
      lastPublishedTexts: xState.lastPublishedTexts.slice(-25)
    };

    await fs.writeFile(STATE_FILE, JSON.stringify(payload), "utf8");
  } catch (error) {
    console.log(`saveXState error: ${error.message}`);
  }
}

async function twitterGetJson(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitter API ${res.status}: ${text}`);
  }

  return res.json();
}

async function getUsersMapByIds(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const missing = uniqueIds.filter(id => !authorCache.has(id));

  if (missing.length) {
    const url =
      "https://api.twitter.com/2/users" +
      `?ids=${missing.join(",")}` +
      "&user.fields=public_metrics,verified,description,name,profile_image_url,username";

    const data = await twitterGetJson(url);
    const arr = Array.isArray(data?.data) ? data.data : [];

    for (const user of arr) {
      authorCache.set(user.id, user);
    }
  }

  const out = new Map();
  for (const id of uniqueIds) {
    const user = authorCache.get(id);
    if (user) out.set(id, user);
  }
  return out;
}

function buildSearchQuery(keyword) {
  const escaped = keyword.replace(/"/g, "");
  return `"${escaped}" -is:retweet -is:reply lang:ja OR "${escaped}" -is:retweet -is:reply lang:en`;
}

async function searchTweets(keyword) {
  const query = buildSearchQuery(keyword);
  const maxResults = Math.min(Math.max(X_MAX_RESULTS, 10), 50);

  const url =
    "https://api.twitter.com/2/tweets/search/recent" +
    `?query=${encodeURIComponent(query)}` +
    `&max_results=${maxResults}` +
    "&tweet.fields=created_at,public_metrics,lang,entities,author_id,conversation_id" +
    "&expansions=author_id";

  const data = await twitterGetJson(url);

  const tweets = Array.isArray(data?.data) ? data.data : [];
  const includesUsers = Array.isArray(data?.includes?.users) ? data.includes.users : [];

  for (const user of includesUsers) {
    authorCache.set(user.id, user);
  }

  return tweets;
}

function isRaidOrShillPost(text) {
  const value = normalizeText(text);

  const rejectPatterns = [
    /\braid\b/,
    /\bshill\b/,
    /\bairdrop\b/,
    /\bwhitelist\b/,
    /\bgiveaway\b/,
    /\bfollow and retweet\b/,
    /\bretweet to win\b/,
    /\bjoin telegram\b/,
    /\btag friends\b/,
    /\bdrop your wallet\b/,
    /\bbuy now\b/,
    /\bmoon now\b/,
    /\bgem alert\b/,
    /\bgem call\b/,
    /\b100x\b/,
    /\bcto\b/
  ];

  return rejectPatterns.some(re => re.test(value));
}

function isLowValuePost(text) {
  const value = stripHtml(text);
  if (!value) return true;
  if (value.length < 20) return true;
  if (/^(gm|gn|lol|soon|ok|yes|no|hi|hello)[!\.\s]*$/i.test(value)) return true;
  return false;
}

function containsStrongContentSignal(text) {
  const value = normalizeText(text);

  const goodPatterns = [
    /\bepisode\b/,
    /\bvideo\b/,
    /\bpreview\b/,
    /\btrailer\b/,
    /\bteaser\b/,
    /\bupdate\b/,
    /\bnews\b/,
    /\bnotice\b/,
    /\bannouncement\b/,
    /\brelease\b/,
    /\blaunch\b/,
    /\bopen\b/,
    /\bavailable\b/,
    /\bstream\b/,
    /\bchapter\b/,
    /\bmerch\b/,
    /\bcollab\b/,
    /\bevent\b/,
    /\bnew art\b/,
    /\bnew goods\b/,
    /\bnew visual\b/
  ];

  return goodPatterns.some(re => re.test(value));
}

function calcTextTemplatePenalty(text) {
  const value = normalizeText(text);

  let penalty = 0;

  if (
    /(follow and retweet|tag friends|join telegram|giveaway|drop your wallet)/i.test(value)
  ) {
    penalty += 50;
  }

  if (/(buy|pump|moon|100x|gem alert|gem call)/i.test(value)) {
    penalty += 35;
  }

  const words = tokenize(text);
  const uniqueRatio = words.length ? new Set(words).size / words.length : 0;
  if (words.length >= 8 && uniqueRatio < 0.45) {
    penalty += 18;
  }

  return penalty;
}

function calcSimilarityPenalty(text, neighbors) {
  let maxSim = 0;
  for (const other of neighbors) {
    const sim = jaccardSimilarity(text, other.text || "");
    if (sim > maxSim) maxSim = sim;
  }

  if (maxSim >= 0.85) return 35;
  if (maxSim >= 0.7) return 22;
  if (maxSim >= 0.55) return 10;
  return 0;
}

function calcBurstPenalty(candidates, targetAuthorId) {
  const sameMinute = candidates.filter(item => {
    const created = new Date(item.created_at).getTime();
    const now = Date.now();
    return now - created <= 15 * 60 * 1000;
  });

  const youngLowFollowerAuthors = sameMinute.filter(item => {
    const followers = safeNum(item.author?.public_metrics?.followers_count, 0);
    return followers < 2000;
  });

  const sameAuthorCount = sameMinute.filter(item => item.author_id === targetAuthorId).length;

  let penalty = 0;
  if (sameMinute.length >= 8) penalty += 8;
  if (sameMinute.length >= 15) penalty += 12;
  if (sameMinute.length >= 25) penalty += 16;
  if (youngLowFollowerAuthors.length >= 8) penalty += 12;
  if (sameAuthorCount >= 3) penalty += 12;

  return penalty;
}

function calcTweetScore(tweet, allCandidates) {
  const author = tweet.author || null;
  const followerCount = safeNum(author?.public_metrics?.followers_count, 0);
  const metrics = tweet.public_metrics || {};
  const likes = safeNum(metrics.like_count);
  const replies = safeNum(metrics.reply_count);
  const reposts = safeNum(metrics.retweet_count);
  const quotes = safeNum(metrics.quote_count);
  const weighted = likes + replies * 2 + reposts * 2.5 + quotes * 3;
  const engagementRate = followerCount > 0 ? weighted / followerCount : 0;

  let score = 0;

  if (followerCount >= X_MIN_FOLLOWERS) score += 10;
  if (followerCount >= 3000) score += 6;
  if (followerCount >= 10000) score += 8;
  if (followerCount >= 50000) score += 8;

  if (likes >= 5) score += 6;
  if (likes >= 15) score += 8;
  if (likes >= 50) score += 10;

  if (replies >= 2) score += 6;
  if (replies >= 6) score += 8;

  if (quotes >= 1) score += 5;
  if (quotes >= 3) score += 8;

  if (engagementRate >= 0.002) score += 8;
  if (engagementRate >= 0.006) score += 10;
  if (engagementRate >= 0.012) score += 12;

  if (containsStrongContentSignal(tweet.text)) score += 18;
  if (tweet.lang === "ja" || tweet.lang === "en") score += 3;
  if (author?.verified) score += 4;
  if (stripHtml(tweet.text).length >= 60) score += 5;

  if (isLowValuePost(tweet.text)) score -= 35;
  if (isRaidOrShillPost(tweet.text)) score -= 100;

  score -= calcTextTemplatePenalty(tweet.text);
  score -= calcSimilarityPenalty(tweet.text, allCandidates);
  score -= calcBurstPenalty(allCandidates, tweet.author_id);

  return {
    score,
    followerCount,
    likes,
    replies,
    reposts,
    quotes,
    weighted,
    engagementRate: Number((engagementRate * 100).toFixed(3))
  };
}

function chooseMood(postScore) {
  const hour = new Date().getHours();

  if (MARKET_MODE === "bull" && postScore >= 70) return "hyped";
  if (MARKET_MODE === "bear" && postScore < 60) return "careful";
  if (postScore >= 90) return "explosive";
  if (postScore >= 75) return "excited";
  if (postScore >= 60) return "interested";
  if (hour >= 1 && hour <= 8) return "sleepy";
  return "neutral";
}

function buildCommentary(tweet, scorePack) {
  const text = stripHtml(tweet.text);
  const mood = chooseMood(scorePack.score);

  if (/episode|video|preview|trailer|teaser/i.test(text)) {
    if (mood === "explosive" || mood === "excited") {
      return "🎬 Очень сильный контентный сигнал. Это уже выглядит как пост, на который реально пришло живое внимание.";
    }
    return "🎬 Это похоже на контентный апдейт, а не на пустой шум. Такой пост есть смысл выделять.";
  }

  if (/update|notice|announcement|news/i.test(text)) {
    if (mood === "interested") {
      return "🧠 Здесь есть содержание. Похоже на пост, который имеет смысл показать группе.";
    }
    if (mood === "careful") {
      return "🧠 Без лишней эйфории: это выглядит полезнее среднего по ленте.";
    }
    return "🧠 Неплохой информативный пост. Не мусор, не шаблонка, внимание оправдано.";
  }

  if (/release|launch|open|available|event|collab|goods|merch/i.test(text)) {
    return "🚀 Пост выглядит сильным и содержательным. Тут уже чувствуется повод для реакции, а не просто фоновая активность.";
  }

  if (scorePack.engagementRate >= 1) {
    return "📈 Этот пост статистически заметнее многих других. Похоже, его подхватили не только боты.";
  }

  if (mood === "sleepy") {
    return "😴 Даже в сонном режиме Chiikawa считает, что этот пост не стоит пропускать.";
  }

  return "👀 Пойман хороший пост: достаточно содержательный, не шаблонный и не рейдовый.";
}

function shouldPushCTA(tweet, scorePack) {
  const text = stripHtml(tweet.text);

  if (isRaidOrShillPost(text)) return false;
  if (scorePack.score < X_CTA_SCORE) return false;

  if (
    /episode|video|preview|trailer|teaser|update|announcement|release|launch|event|collab|goods|merch/i.test(
      text
    )
  ) {
    return true;
  }

  if (scorePack.weighted >= 40 && scorePack.engagementRate >= 0.6) {
    return true;
  }

  return false;
}

function buildCTA() {
  return "📣 Пост реально сильный. Можно аккуратно зайти в реплаи и напомнить о нас — без спама, без рейда, по-человечески.";
}

function buildTweetUrl(username, tweetId) {
  return `https://x.com/${username}/status/${tweetId}`;
}

function isTooSimilarToRecentPublications(text) {
  for (const prev of xState.lastPublishedTexts) {
    const sim = jaccardSimilarity(text, prev);
    if (sim >= 0.75) return true;
  }
  return false;
}

async function publishXPost(tweet, scorePack) {
  const now = Date.now();

  if (now - xState.lastPostAt < X_POST_COOLDOWN_MS) {
    console.log(`[${nowIso()}] X cooldown active, skip publish`);
    return false;
  }

  const username = tweet.author?.username || "unknown";
  const tweetUrl = buildTweetUrl(username, tweet.id);
  const commentary = buildCommentary(tweet, scorePack);
  const cta = shouldPushCTA(tweet, scorePack) ? `\n\n${buildCTA()}` : "";

  const text = `🚨 <b>Найден сильный X-пост</b>

<b>Автор:</b> @${username}
<b>Подписчики:</b> ${scorePack.followerCount}
<b>Score:</b> ${scorePack.score}
<b>Engagement:</b> ${scorePack.engagementRate}%
<b>Likes / Replies / Reposts:</b> ${scorePack.likes} / ${scorePack.replies} / ${scorePack.reposts}

<b>Пост:</b>
${stripHtml(tweet.text)}

${commentary}${cta}

🔗 ${tweetUrl}`;

  const gif = pickNaturalGif();

  if (gif) {
    await sendAnimation(CHAT_ID, gif, {
      caption: text.slice(0, 1024),
      parse_mode: "HTML"
    });
  } else {
    await sendText(CHAT_ID, text);
  }

  xState.lastPostAt = now;
  xState.lastPublishedTexts.push(tweet.text);
  xState.lastPublishedTexts = xState.lastPublishedTexts.slice(-25);
  await saveXState();
  return true;
}

async function collectCandidates() {
  const all = [];

  for (const keyword of X_SEARCH_QUERIES) {
    try {
      const tweets = await searchTweets(keyword);
      for (const tweet of tweets) {
        all.push({ ...tweet, queryKeyword: keyword });
      }
    } catch (error) {
      console.log(`[${nowIso()}] search error for "${keyword}": ${error.message}`);
    }
  }

  const uniqueMap = new Map();
  for (const tweet of all) {
    if (!tweet?.id) continue;
    if (!uniqueMap.has(tweet.id)) {
      uniqueMap.set(tweet.id, tweet);
    }
  }

  const unique = [...uniqueMap.values()];
  const userMap = await getUsersMapByIds(unique.map(t => t.author_id));

  return unique.map(tweet => ({
    ...tweet,
    author: userMap.get(tweet.author_id) || tweet.author || null
  }));
}

async function xWatcherLoop() {
  xState.lastHeartbeat = Date.now();

  const candidates = await collectCandidates();

  if (!candidates.length) {
    console.log(`[${nowIso()}] no X candidates`);
    return;
  }

  if (!xState.firstSyncDone) {
    candidates.forEach(tweet => xState.seenIds.add(tweet.id));
    xState.firstSyncDone = true;
    await saveXState();
    console.log(`[${nowIso()}] X first sync complete with ${candidates.length} cached tweets`);
    return;
  }

  const fresh = candidates
    .filter(tweet => tweet?.id && !xState.seenIds.has(tweet.id))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (!fresh.length) {
    console.log(`[${nowIso()}] no new X posts`);
    return;
  }

  const scored = [];

  for (const tweet of fresh) {
    xState.seenIds.add(tweet.id);

    if (xState.seenIds.size > X_MAX_STORED_IDS) {
      xState.seenIds = new Set(
        Array.from(xState.seenIds).slice(-X_MAX_STORED_IDS)
      );
    }

    const author = tweet.author;
    const followerCount = safeNum(author?.public_metrics?.followers_count, 0);

    if (followerCount < X_MIN_FOLLOWERS) {
      console.log(
        `[${nowIso()}] filtered ${author?.username || "unknown"} by followers: ${followerCount}`
      );
      continue;
    }

    if (isTooSimilarToRecentPublications(tweet.text)) {
      console.log(`[${nowIso()}] filtered similar to recent publication`);
      continue;
    }

    const scorePack = calcTweetScore(tweet, fresh);

    if (scorePack.score < X_POST_SCORE_MIN) {
      console.log(
        `[${nowIso()}] filtered low-score tweet ${tweet.id}: ${scorePack.score}`
      );
      continue;
    }

    scored.push({ tweet, scorePack });
  }

  await saveXState();

  scored.sort((a, b) => b.scorePack.score - a.scorePack.score);

  let published = 0;

  for (const item of scored) {
    if (published >= X_MAX_POSTS_PER_CYCLE) break;
    const ok = await publishXPost(item.tweet, item.scorePack);
    if (ok) published += 1;
  }

  if (!published) {
    console.log(`[${nowIso()}] no publishable X posts after filtering`);
  }
}

function startXWatcher() {
  if (xState.started) return;

  xState.started = true;
  console.log("🚀 X SEARCH SCANNER STARTED");

  const run = async () => {
    try {
      await xWatcherLoop();
    } catch (error) {
      console.log(`[${nowIso()}] xWatcherLoop error: ${error.message}`);
    }
  };

  run();

  xState.timer = setInterval(run, X_LOOP_INTERVAL_MS);

  xState.guardTimer = setInterval(() => {
    const diff = Date.now() - xState.lastHeartbeat;
    if (diff > X_WATCH_HEARTBEAT_TIMEOUT_MS) {
      console.log(`[${nowIso()}] ♻️ X scanner heartbeat reset`);
      xState.lastHeartbeat = Date.now();
      run();
    }
  }, 30000);
}

async function ensureCommands() {
  await bot.setMyCommands([
    { command: "start", description: "Start bot" },
    { command: "menu", description: "Open menu" },
    { command: "status", description: "System status" },
    { command: "lang", description: "Choose language" },
    { command: "language", description: "Choose language" },
    { command: "scan", description: "Scan CA" },
    { command: "test_trade", description: "Run test trade" },
    { command: "level6_status", description: "Level 6 summary" },
    { command: "level6_open_trades", description: "Open trades" }
  ]);
}

function shortScanId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractCAFromText(text) {
  const value = String(text || "").trim();
  const patterns = [
    /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
    /\b0x[a-fA-F0-9]{40}\b/g
  ];

  for (const re of patterns) {
    const found = value.match(re);
    if (found && found[0]) return found[0];
  }

  return "";
}

async function runScanAndReply({ chatId, userId, replyTo, ca }) {
  await sendText(chatId, `${t(userId, "scanStarted")}\n\nCA: <code>${ca}</code>`, {
    reply_to_message_id: replyTo
  });

  const result = await scanTokenCandidate({ ca });
  const scanId = shortScanId();

  scanStore.set(scanId, {
    id: scanId,
    createdAt: Date.now(),
    ownerUserId: userId,
    ca,
    result
  });

  await sendText(chatId, `${t(userId, "scanReady")}\n\n${buildCompactScanSummary(result)}`, {
    reply_to_message_id: replyTo,
    reply_markup: buildScanKeyboard(scanId)
  });
}

function getScan(scanId) {
  return scanStore.get(scanId) || null;
}

function buildRiskText(result = {}) {
  const decision = result.decision || {};
  const blocked = Array.isArray(decision.blockedReasons) ? decision.blockedReasons : [];
  const cautions = Array.isArray(decision.reasons) ? decision.reasons : [];
  const rugText = result.texts?.rugRisk || "";

  const lines = [
    `<b>Risk Review</b>`,
    `Allowed: ${decision.allowed ? "YES" : "NO"}`,
    `Score: ${safeNum(decision.score, 0)}`,
    `Confidence: ${decision.confidence || "unknown"}`
  ];

  if (blocked.length) {
    lines.push("");
    lines.push("<b>Hard blockers:</b>");
    blocked.forEach(item => lines.push(`• ${item}`));
  }

  if (cautions.length) {
    lines.push("");
    lines.push("<b>Cautions:</b>");
    cautions.forEach(item => lines.push(`• ${item}`));
  }

  if (rugText) {
    lines.push("");
    lines.push(rugText);
  }

  return lines.join("\n");
}

function buildSocialText(result = {}) {
  const social = result?.candidate?.socialIntel || {};

  return [
    `<b>Social Intel</b>`,
    `Unique Authors: ${safeNum(social.uniqueAuthors, 0)}`,
    `Avg Likes: ${safeNum(social.avgLikes, 0)}`,
    `Avg Replies: ${safeNum(social.avgReplies, 0)}`,
    `Bot Pattern Score: ${safeNum(social.botPatternScore, 0)}`,
    `Engagement Diversity: ${safeNum(social.engagementDiversity, 0)}`,
    `Trusted Mentions: ${safeNum(social.trustedMentions, 0)}`,
    `Suspicious Burst: ${social.suspiciousBurst ? "YES" : "NO"}`,
    `Organic Score: ${safeNum(social.organicScore, 0)}`
  ].join("\n");
}

async function handleTextCommand(msg) {
  const text = String(msg.text || "").trim();
  const chatId = msg.chat.id;
  const userId = msg.from?.id || msg.chat.id;
  const replyTo = msg.message_id;

  const activeFlow = getUserFlow(userId);
  if (activeFlow?.type === "await_scan_ca" && !text.startsWith("/")) {
    clearUserFlow(userId);
    const ca = extractCAFromText(text);

    if (!ca) {
      await sendText(chatId, "⚠️ CA not detected in message.", {
        reply_to_message_id: replyTo
      });
      return true;
    }

    await runScanAndReply({ chatId, userId, replyTo, ca });
    return true;
  }

  if (!text.startsWith("/")) {
    const inlineCA = extractCAFromText(text);
    if (inlineCA) {
      await runScanAndReply({ chatId, userId, replyTo, ca: inlineCA });
      return true;
    }
    return false;
  }

  if (text === "/start") {
    await sendText(chatId, t(userId, "botAlive"), {
      reply_to_message_id: replyTo
    });
    await openMenu(chatId, userId, replyTo);
    return true;
  }

  if (text === "/menu") {
    await openMenu(chatId, userId, replyTo);
    return true;
  }

  if (text === "/status") {
    await sendText(chatId, buildStatusText(userId), {
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (text === "/lang" || text === "/language") {
    await sendText(chatId, t(userId, "chooseLang"), {
      reply_to_message_id: replyTo,
      reply_markup: buildLanguageKeyboard()
    });
    return true;
  }

  if (text === "/scan") {
    setUserFlow(userId, { type: "await_scan_ca" });
    await sendText(chatId, t(userId, "awaitingCA"), {
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (text.startsWith("/scan ")) {
    const ca = extractCAFromText(text);
    if (!ca) {
      await sendText(chatId, "⚠️ CA not detected.", {
        reply_to_message_id: replyTo
      });
      return true;
    }

    await runScanAndReply({ chatId, userId, replyTo, ca });
    return true;
  }

  if (text === "/test_trade") {
    await sendText(chatId, t(userId, "entryStarted"), {
      reply_to_message_id: replyTo
    });

    const userSender = async payload => {
      await sendTradePayload(chatId, payload, replyTo);
    };

    const groupSender = async payload => {
      await sendTradePayload(CHAT_ID, payload);
    };

    await simulateTradeFlow(userSender, groupSender);
    return true;
  }

  const tradingResult = await handleTradingCommand(text);

  if (tradingResult?.ok) {
    await sendText(chatId, tradingResult.message, {
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (tradingResult?.error && tradingResult.error !== "Unknown command") {
    await sendText(chatId, `⚠️ ${tradingResult.error}`, {
      reply_to_message_id: replyTo
    });
    return true;
  }

  return false;
}

async function handleScanCallback(query, parts) {
  const chatId = query?.message?.chat?.id;
  const userId = query?.from?.id || 0;
  const scanAction = parts[1];
  const scanId = parts[2];

  if (scanAction === "prompt") {
    setUserFlow(userId, { type: "await_scan_ca" });
    await sendText(chatId, t(userId, "awaitingCA"));
    return;
  }

  if (scanAction === "last") {
    const items = [...scanStore.values()]
      .filter(item => item.ownerUserId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);

    if (!items.length) {
      await sendText(chatId, t(userId, "noScan"));
      return;
    }

    const last = items[0];
    await sendText(chatId, buildCompactScanSummary(last.result), {
      reply_markup: buildScanKeyboard(last.id)
    });
    return;
  }

  const stored = getScan(scanId);
  if (!stored) {
    await sendText(chatId, t(userId, "noScan"));
    return;
  }

  if (scanAction === "proposal") {
    const proposal = await buildScanProposal({ ca: stored.ca });
    await sendText(chatId, proposal.text);
    return;
  }

  if (scanAction === "decision") {
    await sendText(chatId, stored.result.texts?.decision || "No decision text");
    return;
  }

  if (scanAction === "wallet") {
    await sendText(chatId, stored.result.texts?.walletIntel || "No wallet intel");
    return;
  }

  if (scanAction === "rug") {
    await sendText(chatId, stored.result.texts?.rugRisk || "No rug-risk report");
    return;
  }

  if (scanAction === "risks") {
    await sendText(chatId, buildRiskText(stored.result));
    return;
  }

  if (scanAction === "social") {
    await sendText(chatId, buildSocialText(stored.result));
    return;
  }

  if (scanAction === "full") {
    await sendText(chatId, stored.result.texts?.candidate || "No full report");
    return;
  }

  if (scanAction === "refresh") {
    const refreshed = await scanTokenCandidate({ ca: stored.ca });
    scanStore.set(scanId, {
      ...stored,
      createdAt: Date.now(),
      result: refreshed
    });

    await sendText(chatId, `🔁 Scan refreshed\n\n${buildCompactScanSummary(refreshed)}`, {
      reply_markup: buildScanKeyboard(scanId)
    });
    return;
  }

  if (scanAction === "dryrun") {
    const dry = await dryRunEntryFromScan({ ca: stored.ca });

    if (!dry.accepted) {
      await sendText(chatId, `${t(userId, "dryRunRejected")}\n\n${dry.text}`);
      return;
    }

    await sendText(chatId, `${t(userId, "dryRunAccepted")}\n\n${dry.text}`);
    return;
  }
}

async function handleCallbackQuery(query) {
  const data = query?.data || "";
  const userId = query?.from?.id || 0;
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;

  console.log("CALLBACK HIT:", data, "chatId=", chatId, "messageId=", messageId);

  await bot.answerCallbackQuery(query.id);

  if (!chatId) return;

  const parts = data.split(":");

  if (parts[0] === "scan") {
    await handleScanCallback(query, parts);
    return;
  }

  if (data === "ui:status") {
    await sendText(chatId, buildStatusText(userId));
    return;
  }

  if (data === "ui:l6") {
    await sendText(chatId, buildLevel6Text(userId));
    return;
  }

  if (data === "ui:lang") {
    await sendText(chatId, t(userId, "chooseLang"), {
      reply_markup: buildLanguageKeyboard()
    });
    return;
  }

  if (data === "lang:en" || data === "lang:ru") {
    const lang = data.split(":")[1];
    setUserLang(userId, lang);
    await sendText(chatId, `${t(userId, "langSet")}: ${lang.toUpperCase()}`);
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  if (data === "cmd:test_trade") {
    await sendText(chatId, t(userId, "entryStarted"));

    const userSender = async payload => {
      await sendTradePayload(chatId, payload);
    };

    const groupSender = async payload => {
      await sendTradePayload(CHAT_ID, payload);
    };

    await simulateTradeFlow(userSender, groupSender);
    return;
  }

  if (data === "cmd:toggle_trading") {
    const runtime = getTradingRuntime();
    await handleTradingCommand(runtime.enabled ? "/trading_off" : "/trading_on");
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  if (data === "cmd:toggle_dryrun") {
    const runtime = getTradingRuntime();
    await handleTradingCommand(runtime.dryRun ? "/dryrun_off" : "/dryrun_on");
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  if (data === "cmd:mode") {
    await handleTradingCommand("/trade_mode");
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  if (data === "cmd:kill") {
    await handleTradingCommand("/kill_switch");
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  console.log("unknown callback:", data);
}

async function processUpdate(update) {
  try {
    if (update?.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return;
    }

    if (update?.message?.text) {
      await handleTextCommand(update.message);
      return;
    }
  } catch (error) {
    console.log("processUpdate error:", error);
    const chatId =
      update?.message?.chat?.id ||
      update?.callback_query?.message?.chat?.id;

    try {
      if (chatId) {
        await sendText(chatId, `⚠️ Update error: ${error.message}`);
      }
    } catch {}
  }
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "telegram-bot",
          watcherStarted: xState.started,
          heartbeat: xState.lastHeartbeat,
          webhookPath: WEBHOOK_PATH
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const update = body ? JSON.parse(body) : {};
          await processUpdate(update);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          console.log("webhook body error:", error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });

      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });
}

async function ensureWebhook() {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
  } catch (error) {
    console.log("deleteWebHook warn:", error.message);
  }

  const result = await bot.setWebHook(WEBHOOK_URL);
  console.log("Webhook set:", result, WEBHOOK_URL);
}

async function ensureCommandsAndWebhook() {
  await ensureCommands();
  await ensureWebhook();
}

async function bootstrap() {
  console.log("🤖 BOT STARTED");
  await loadXState();
  await initTradingAdmin();

  const server = createServer();

  server.listen(PORT, async () => {
    console.log(`HTTP server listening on ${PORT}`);
    console.log(`Webhook path: ${WEBHOOK_PATH}`);

    await ensureCommandsAndWebhook();
    startXWatcher();
  });

  setInterval(() => {
    console.log("heartbeat alive", new Date().toISOString());
  }, 15000);
}

bootstrap().catch(error => {
  console.error("bootstrap fatal:", error);
  process.exit(1);
});
