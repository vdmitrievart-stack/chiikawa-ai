import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import Parser from "rss-parser";
import {
  initTradingAdmin,
  getTradingRuntime,
  getLevel6Summary,
  getLevel6OpenTrades,
  handleTradingCommand,
  simulateTradeFlow
} from "./trading-admin.js";

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
  "chiikawa_webhook_secret_2026";

const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;
const WEBHOOK_URL = `${TELEGRAM_WEBHOOK_BASE_URL}${WEBHOOK_PATH}`;

const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN || "";
const X_MIN_FOLLOWERS = Number(process.env.X_MIN_FOLLOWERS || 1000);
const X_MAX_STORED_IDS = Number(process.env.X_MAX_STORED_IDS || 500);
const X_POST_COOLDOWN_MS = Number(process.env.X_POST_COOLDOWN_MS || 20000);
const X_WATCH_INTERVAL_MS = Number(process.env.X_LOOP_INTERVAL_MS || 60000);
const X_WATCH_HEARTBEAT_TIMEOUT_MS = Number(
  process.env.X_WATCH_HEARTBEAT_TIMEOUT_MS || 180000
);

const STATE_FILE = path.resolve("/tmp/telegram-bot-x-state.json");

if (!TOKEN) {
  console.error("❌ BOT_TOKEN missing");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("❌ TELEGRAM_ALERT_CHAT_ID / CHAT_ID missing");
  process.exit(1);
}

if (!TELEGRAM_WEBHOOK_BASE_URL) {
  console.error("❌ TELEGRAM_WEBHOOK_BASE_URL missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0"
  }
});

const userSettings = new Map();
const followerCache = new Map();

const watcherState = {
  started: false,
  timer: null,
  guardTimer: null,
  lastHeartbeat: Date.now(),
  lastPostedAt: 0,
  lastHostIndex: 0,
  firstSyncDone: false,
  seenIds: new Set()
};

function getEnvList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

function getEnvJson(name, fallback = {}) {
  try {
    const raw = process.env[name];
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const WATCH_ACCOUNTS = getEnvList("X_WATCH_ACCOUNTS").length
  ? getEnvList("X_WATCH_ACCOUNTS")
  : [process.env.X_USERNAME || "chiikawa_kouhou"];

const X_GIF_FILE_IDS = getEnvList("X_GIF_FILE_IDS");
const X_ACCOUNT_FOLLOWERS_JSON = getEnvJson("X_ACCOUNT_FOLLOWERS_JSON", {});
const NITTER_HOSTS = getEnvList("X_RSS_HOSTS").length
  ? getEnvList("X_RSS_HOSTS")
  : [
      "https://nitter.net",
      "https://nitter.privacydev.net",
      "https://nitter.poast.org"
    ];

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
    watcher: "X watcher",
    heartbeat: "Heartbeat",
    accounts: "Accounts",
    chooseLang: "🌍 Choose language",
    langSet: "🌍 Language set",
    noOpenTrades: "No open trades",
    stumbled: "Chiikawa stumbled a little... 🥺",
    entryStarted: "🚀 Test trade launched"
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
    watcher: "X watcher",
    heartbeat: "Пульс",
    accounts: "Аккаунты",
    chooseLang: "🌍 Выбери язык",
    langSet: "🌍 Язык установлен",
    noOpenTrades: "Открытых сделок нет",
    stumbled: "Chiikawa немного споткнулся... 🥺",
    entryStarted: "🚀 Тестовая сделка запущена"
  }
};

function nowIso() {
  return new Date().toISOString();
}

function rand(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
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
<b>${t(userId, "watcher")}:</b> ${watcherState.started ? t(userId, "online") : t(userId, "offline")}
<b>${t(userId, "heartbeat")}:</b> ${new Date(watcherState.lastHeartbeat).toLocaleString()}
<b>${t(userId, "accounts")}:</b> ${WATCH_ACCOUNTS.join(", ")}

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

function normalizeXItem(item, username) {
  return {
    id: item.id || item.guid || item.link || "",
    title: String(item.title || "").trim(),
    url: item.link || item.id || "",
    username
  };
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRaidOrShillPost(text) {
  const value = stripHtml(text).toLowerCase();

  const rejectPatterns = [
    /\braid\b/,
    /\bshill\b/,
    /\bca\b/,
    /\bcontract\b/,
    /\b0x[a-f0-9]{6,}\b/i,
    /\bairdrop\b/,
    /\bwhitelist\b/,
    /\bjoin\b.{0,20}\btelegram\b/,
    /\bcomment\b.{0,20}\bbelow\b/,
    /\btag\b.{0,20}\bfriends\b/,
    /\bfollow\b.{0,20}\bretweet\b/,
    /\bgiveaway\b/,
    /\bpromo\b/,
    /\bpartnership\b/,
    /\bbuy now\b/,
    /\bcall\b/
  ];

  return rejectPatterns.some(re => re.test(value));
}

function isLowValuePost(text) {
  const value = stripHtml(text).toLowerCase();

  if (!value) return true;
  if (value.length < 18) return true;
  if (/^(gm|gn|lol|ok|yes|no|hi|hello|soon)[!\.\s]*$/i.test(value)) return true;

  return false;
}

function buildXCommentary(title) {
  const text = stripHtml(title);

  if (/episode|video|trailer|preview|teaser/i.test(text)) {
    return "🎬 Похоже на контентный апдейт, а не шум.";
  }

  if (/release|launch|start|open|available/i.test(text)) {
    return "🚀 Похоже на реальный апдейт/запуск.";
  }

  if (/update|notice|important|news|announcement/i.test(text)) {
    return "🧠 Выглядит как полезное объявление.";
  }

  return "👀 Пойман новый содержательный пост.";
}

async function loadWatcherState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    watcherState.firstSyncDone = Boolean(parsed.firstSyncDone);
    watcherState.lastPostedAt = Number(parsed.lastPostedAt || 0);
    watcherState.seenIds = new Set(
      Array.isArray(parsed.seenIds) ? parsed.seenIds.slice(-X_MAX_STORED_IDS) : []
    );

    console.log(`loaded watcher state: ${watcherState.seenIds.size} ids`);
  } catch {
    console.log("watcher state not found, starting fresh");
  }
}

async function saveWatcherState() {
  try {
    const payload = {
      firstSyncDone: watcherState.firstSyncDone,
      lastPostedAt: watcherState.lastPostedAt,
      seenIds: Array.from(watcherState.seenIds).slice(-X_MAX_STORED_IDS)
    };

    await fs.writeFile(STATE_FILE, JSON.stringify(payload), "utf8");
  } catch (error) {
    console.log(`saveWatcherState error: ${error.message}`);
  }
}

async function getFollowerCount(username) {
  if (followerCache.has(username)) {
    return followerCache.get(username);
  }

  if (typeof X_ACCOUNT_FOLLOWERS_JSON[username] === "number") {
    const val = Number(X_ACCOUNT_FOLLOWERS_JSON[username]);
    followerCache.set(username, val);
    return val;
  }

  if (!TWITTER_BEARER_TOKEN) {
    followerCache.set(username, null);
    return null;
  }

  try {
    const res = await fetch(
      `https://api.twitter.com/2/users/by/username/${encodeURIComponent(
        username
      )}?user.fields=public_metrics`,
      {
        headers: {
          Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`
        }
      }
    );

    const data = await res.json();

    const count = Number(
      data?.data?.public_metrics?.followers_count ?? null
    );

    followerCache.set(username, Number.isFinite(count) ? count : null);
    return Number.isFinite(count) ? count : null;
  } catch (error) {
    console.log(`getFollowerCount error for ${username}: ${error.message}`);
    followerCache.set(username, null);
    return null;
  }
}

async function parseFeedWithFallback(username) {
  let lastError = null;

  for (let i = 0; i < NITTER_HOSTS.length; i += 1) {
    const host = NITTER_HOSTS[(watcherState.lastHostIndex + i) % NITTER_HOSTS.length];
    const url = `${host.replace(/\/$/, "")}/${username}/rss`;

    try {
      const feed = await parser.parseURL(url);
      watcherState.lastHostIndex =
        (watcherState.lastHostIndex + i) % NITTER_HOSTS.length;
      return feed;
    } catch (error) {
      lastError = error;
      console.log(`[${nowIso()}] X watcher host failed: ${host} -> ${error.message}`);
    }
  }

  throw lastError || new Error("All RSS hosts failed");
}

async function shouldForwardXPost(item) {
  const followers = await getFollowerCount(item.username);

  if (followers !== null && followers < X_MIN_FOLLOWERS) {
    console.log(
      `[${nowIso()}] skip ${item.username}: followers ${followers} < ${X_MIN_FOLLOWERS}`
    );
    return false;
  }

  if (isRaidOrShillPost(item.title)) {
    console.log(`[${nowIso()}] skip ${item.username}: raid/shill filter`);
    return false;
  }

  if (isLowValuePost(item.title)) {
    console.log(`[${nowIso()}] skip ${item.username}: low value`);
    return false;
  }

  return true;
}

async function postXAlert(item) {
  const now = Date.now();
  if (now - watcherState.lastPostedAt < X_POST_COOLDOWN_MS) {
    console.log(`[${nowIso()}] cooldown skip for ${item.username}`);
    return;
  }

  const commentary = buildXCommentary(item.title);
  const followers = await getFollowerCount(item.username);

  const text = `🚨 <b>NEW X POST DETECTED</b>

<b>Account:</b> @${item.username}
${followers !== null ? `<b>Followers:</b> ${followers}\n` : ""}<b>Post:</b> ${item.title}

${commentary}

${item.url}`;

  const gif = rand(X_GIF_FILE_IDS);

  try {
    if (gif) {
      await sendAnimation(CHAT_ID, gif, {
        caption: text.slice(0, 1024),
        parse_mode: "HTML"
      });
    } else {
      await sendText(CHAT_ID, text);
    }

    watcherState.lastPostedAt = now;
    await saveWatcherState();
  } catch (error) {
    console.log(`postXAlert error: ${error.message}`);
  }
}

async function checkAccount(username) {
  const feed = await parseFeedWithFallback(username);

  if (!feed.items || feed.items.length === 0) {
    console.log(`[${nowIso()}] ⚠️ no posts for ${username}`);
    return;
  }

  const items = feed.items
    .map(item => normalizeXItem(item, username))
    .filter(item => item.id);

  if (!items.length) return;

  if (!watcherState.firstSyncDone) {
    items.slice(0, 20).forEach(item => watcherState.seenIds.add(item.id));
    watcherState.firstSyncDone = true;
    await saveWatcherState();
    console.log(`[${nowIso()}] X first sync complete for ${username}`);
    return;
  }

  const fresh = [];
  for (const item of items.reverse()) {
    if (watcherState.seenIds.has(item.id)) continue;
    fresh.push(item);
  }

  if (!fresh.length) {
    console.log(`[${nowIso()}] no new X posts for ${username}`);
    return;
  }

  for (const item of fresh) {
    watcherState.seenIds.add(item.id);

    if (watcherState.seenIds.size > X_MAX_STORED_IDS) {
      watcherState.seenIds = new Set(
        Array.from(watcherState.seenIds).slice(-X_MAX_STORED_IDS)
      );
    }

    const okToPost = await shouldForwardXPost(item);
    await saveWatcherState();

    if (!okToPost) continue;

    await postXAlert(item);
  }
}

async function watcherLoop() {
  watcherState.lastHeartbeat = Date.now();

  for (const account of WATCH_ACCOUNTS) {
    await checkAccount(account);
  }
}

function startWatcher() {
  if (watcherState.started) return;

  watcherState.started = true;
  console.log("🚀 X WATCHER STARTED");

  const run = async () => {
    try {
      await watcherLoop();
    } catch (error) {
      console.log(`[${nowIso()}] watcher error: ${error.message}`);
    }
  };

  run();

  watcherState.timer = setInterval(run, X_WATCH_INTERVAL_MS);

  watcherState.guardTimer = setInterval(() => {
    const diff = Date.now() - watcherState.lastHeartbeat;
    if (diff > X_WATCH_HEARTBEAT_TIMEOUT_MS) {
      console.log(`[${nowIso()}] ♻️ WATCHER HEARTBEAT RESET`);
      watcherState.lastHeartbeat = Date.now();
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
    { command: "test_trade", description: "Run test trade" },
    { command: "level6_status", description: "Level 6 summary" },
    { command: "level6_open_trades", description: "Open trades" }
  ]);
}

async function handleTextCommand(msg) {
  const text = String(msg.text || "").trim();
  const chatId = msg.chat.id;
  const userId = msg.from?.id || msg.chat.id;
  const replyTo = msg.message_id;

  if (!text.startsWith("/")) return false;

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

async function handleCallbackQuery(query) {
  const data = query?.data || "";
  const userId = query?.from?.id || 0;
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;

  console.log("CALLBACK HIT:", data, "chatId=", chatId, "messageId=", messageId);

  await bot.answerCallbackQuery(query.id);

  if (!chatId) return;

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
          watcherStarted: watcherState.started,
          heartbeat: watcherState.lastHeartbeat
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
  await loadWatcherState();
  await initTradingAdmin();

  const server = createServer();

  server.listen(PORT, async () => {
    console.log(`HTTP server listening on ${PORT}`);
    console.log(`Webhook path: ${WEBHOOK_PATH}`);

    await ensureCommandsAndWebhook();
    startWatcher();
  });

  setInterval(() => {
    console.log("heartbeat alive", new Date().toISOString());
  }, 15000);
}

bootstrap().catch(error => {
  console.error("bootstrap fatal:", error);
  process.exit(1);
});
