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

const X_CREDITS_PAUSE_MS = Number(
  process.env.X_CREDITS_PAUSE_MS || 30 * 60 * 1000
);
const X_ERROR_PAUSE_MS = Number(
  process.env.X_ERROR_PAUSE_MS || 5 * 60 * 1000
);

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

const bot = new TelegramBot(TOKEN, { polling: false });
const userSettings = new Map();
const userFlows = new Map();
const scanStore = new Map();
const authorCache = new Map();

const xState = {
  started: false,
  enabled: Boolean(TWITTER_BEARER_TOKEN),
  timer: null,
  guardTimer: null,
  firstSyncDone: false,
  seenIds: new Set(),
  lastHeartbeat: Date.now(),
  lastPostAt: 0,
  gifCursor: 0,
  gifLastIndex: -1,
  lastPublishedTexts: [],
  creditPauseUntil: 0,
  genericPauseUntil: 0,
  lastCreditsAlertAt: 0,
  lastStatusLogAt: 0,
  lastErrorLogAt: 0
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
  return raw.split(",").map(v => v.trim()).filter(Boolean);
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
  if (idx === xState.gifLastIndex) idx = (idx + 1) % list.length;

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

function buildWatcherStatusText() {
  if (!xState.enabled) return "DISABLED";
  if (xState.creditPauseUntil > Date.now()) return "PAUSED_CREDITS";
  if (xState.genericPauseUntil > Date.now()) return "PAUSED_ERROR";
  return xState.started ? "ONLINE" : "OFFLINE";
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
<b>${t(userId, "watcher")}:</b> ${buildWatcherStatusText()}
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
• ${t(userId, "openTrades")}:</b> ${openTrades.length}`;
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
    xState.creditPauseUntil = safeNum(parsed.creditPauseUntil, 0);
    xState.genericPauseUntil = safeNum(parsed.genericPauseUntil, 0);
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
      creditPauseUntil: xState.creditPauseUntil,
      genericPauseUntil: xState.genericPauseUntil,
      seenIds: Array.from(xState.seenIds).slice(-X_MAX_STORED_IDS),
      lastPublishedTexts: xState.lastPublishedTexts.slice(-25)
    };

    await fs.writeFile(STATE_FILE, JSON.stringify(payload), "utf8");
  } catch (error) {
    console.log(`saveXState error: ${error.message}`);
  }
}

function isCreditsDepletedError(error) {
  const msg = String(error?.message || error || "");
  return msg.includes("CreditsDepleted") || msg.includes("credits");
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

    for (const user of arr) authorCache.set(user.id, user);
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
    "&expansions=author
