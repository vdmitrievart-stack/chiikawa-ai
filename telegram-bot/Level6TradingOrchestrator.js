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

if (!TOKEN) {
  console.error("❌ BOT_TOKEN missing");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("❌ CHAT_ID missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 1500,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0"
  }
});

const userSettings = new Map();

function getEnvList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map(v => v.trim()).filter(Boolean);
}

const X_DETECT_GIFS = getEnvList("GIF_ENTRY");
const WATCH_ACCOUNTS = getEnvList("X_WATCH_ACCOUNTS").length
  ? getEnvList("X_WATCH_ACCOUNTS")
  : ["chiikawa_kouhou"];

const NITTER_HOSTS = getEnvList("X_RSS_HOSTS").length
  ? getEnvList("X_RSS_HOSTS")
  : [
      "https://nitter.poast.org",
      "https://nitter.net",
      "https://nitter.privacydev.net"
    ];

const WATCH_INTERVAL_MS = Number(process.env.X_WATCH_INTERVAL_MS || 60000);
const WATCH_HEARTBEAT_TIMEOUT_MS = Number(
  process.env.X_WATCH_HEARTBEAT_TIMEOUT_MS || 180000
);

const watcherState = {
  started: false,
  timer: null,
  guardTimer: null,
  lastHeartbeat: Date.now(),
  seenIds: new Set(),
  firstSyncDone: false,
  lastDetectedAt: 0,
  lastHostIndex: 0
};

const I18N = {
  en: {
    botAlive: "🚀 Bot is alive",
    controlCenter: "🧠 Chiikawa Control Center",
    trading: "Trading",
    mode: "Mode",
    killSwitch: "Kill switch",
    buyMin: "Buy min",
    dryRun: "Dry run",
    level6: "Level 6",
    winRate: "WinRate",
    trades: "Trades",
    pnl: "PnL",
    score: "Score",
    commands: "Commands",
    statusTitle: "📊 System Status",
    bot: "Bot",
    xWatcher: "X watcher",
    heartbeat: "Watcher heartbeat",
    watchedAccounts: "Watched accounts",
    avgEntryScore: "Avg entry score",
    openTrades: "Open trades",
    online: "ONLINE",
    offline: "OFFLINE",
    noOpenTrades: "No open trades",
    languageSet: "🌍 Language set",
    chooseLanguage: "🌍 Choose language",
    newXPost: "🚨 NEW X POST DETECTED",
    account: "Account",
    stumbled: "Chiikawa stumbled a little... 🥺"
  },
  ru: {
    botAlive: "🚀 Бот жив",
    controlCenter: "🧠 Центр управления Chiikawa",
    trading: "Торговля",
    mode: "Режим",
    killSwitch: "Kill switch",
    buyMin: "Мин. покупка",
    dryRun: "Dry run",
    level6: "Level 6",
    winRate: "WinRate",
    trades: "Сделки",
    pnl: "PnL",
    score: "Оценка",
    commands: "Команды",
    statusTitle: "📊 Статус системы",
    bot: "Бот",
    xWatcher: "X watcher",
    heartbeat: "Пульс watcher",
    watchedAccounts: "Отслеживаемые аккаунты",
    avgEntryScore: "Средняя оценка входа",
    openTrades: "Открытых сделок",
    online: "ОНЛАЙН",
    offline: "ОФЛАЙН",
    noOpenTrades: "Открытых сделок нет",
    languageSet: "🌍 Язык установлен",
    chooseLanguage: "🌍 Выбери язык",
    newXPost: "🚨 ОБНАРУЖЕН НОВЫЙ ПОСТ В X",
    account: "Аккаунт",
    stumbled: "Chiikawa немного споткнулся... 🥺"
  }
};

const LANGUAGE_OPTIONS = [
  ["English", "en"],
  ["Русский", "ru"]
];

function nowIso() {
  return new Date().toISOString();
}

function rand(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function getUserLang(userId) {
  return userSettings.get(userId)?.lang || "en";
}

function setUserLang(userId, lang) {
  const current = userSettings.get(userId) || {};
  userSettings.set(userId, { ...current, lang });
}

function t(userId, key) {
  const lang = getUserLang(userId);
  return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
}

function onOff(value, userId) {
  return value ? "ON" : "OFF";
}

async function sendText(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
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
        parse_mode: "HTML",
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
      });
      return;
    }

    if (gif) {
      await sendAnimation(chatId, gif, {
        caption: text.slice(0, 1024),
        parse_mode: "HTML",
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
      });
      return;
    }

    await sendText(chatId, text, {
      parse_mode: "HTML",
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  } catch (error) {
    console.log(`sendTradePayload error: ${error.message}`);

    await sendText(chatId, text, {
      parse_mode: "HTML",
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  }
}

function buildMainMenuText(userId) {
  const runtime = getTradingRuntime();
  const s = getLevel6Summary();

  return `${t(userId, "controlCenter")}

<b>${t(userId, "trading")}:</b> ${onOff(runtime.enabled, userId)}
<b>${t(userId, "mode")}:</b> ${runtime.mode}
<b>${t(userId, "killSwitch")}:</b> ${onOff(runtime.killSwitch, userId)}
<b>${t(userId, "buyMin")}:</b> $${runtime.buybotAlertMinUsd}
<b>${t(userId, "dryRun")}:</b> ${onOff(runtime.dryRun, userId)}

<b>${t(userId, "level6")}:</b>
• ${t(userId, "winRate")}: ${(s.winRate * 100).toFixed(1)}%
• ${t(userId, "trades")}: ${s.totalTrades}
• ${t(userId, "pnl")}: ${s.pnl}%
• ${t(userId, "score")}: ${s.avgEntryScore}

<b>${t(userId, "commands")}:</b>
/menu
/status
/lang
/test_trade
/trading_on
/trading_off
/kill_switch
/trade_mode
/dryrun_on
/dryrun_off
/setbuy 25
/level6_status
/level6_open_trades`;
}

function buildStatusText(userId) {
  const runtime = getTradingRuntime();
  const s = getLevel6Summary();
  const openTrades = getLevel6OpenTrades();

  return `${t(userId, "statusTitle")}

<b>${t(userId, "bot")}:</b> ${t(userId, "online")}
<b>${t(userId, "xWatcher")}:</b> ${watcherState.started ? t(userId, "online") : t(userId, "offline")}
<b>${t(userId, "heartbeat")}:</b> ${new Date(watcherState.lastHeartbeat).toLocaleString()}
<b>${t(userId, "watchedAccounts")}:</b> ${WATCH_ACCOUNTS.join(", ")}

<b>${t(userId, "trading")}:</b> ${onOff(runtime.enabled, userId)}
<b>${t(userId, "mode")}:</b> ${runtime.mode}
<b>${t(userId, "killSwitch")}:</b> ${onOff(runtime.killSwitch, userId)}
<b>${t(userId, "buyMin")}:</b> $${runtime.buybotAlertMinUsd}
<b>${t(userId, "dryRun")}:</b> ${onOff(runtime.dryRun, userId)}

<b>${t(userId, "level6")}:</b>
• ${t(userId, "winRate")}: ${(s.winRate * 100).toFixed(1)}%
• ${t(userId, "trades")}: ${s.totalTrades}
• ${t(userId, "pnl")}: ${s.pnl}%
• ${t(userId, "avgEntryScore")}: ${s.avgEntryScore}
• ${t(userId, "openTrades")}: ${openTrades.length}`;
}

function normalizeXItem(item) {
  const id = item.id || item.guid || item.link || "";
  const title = String(item.title || "").trim();
  const url = item.link || item.id || "";
  return { id, title, url };
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

async function checkAccount(username) {
  const feed = await parseFeedWithFallback(username);

  if (!feed.items || feed.items.length === 0) {
    console.log(`[${nowIso()}] ⚠️ no posts for ${username}`);
    return;
  }

  const items = feed.items.map(normalizeXItem).filter(item => item.id);
  if (!items.length) {
    console.log(`[${nowIso()}] ⚠️ no valid ids for ${username}`);
    return;
  }

  if (!watcherState.firstSyncDone) {
    items.slice(0, 10).forEach(item => watcherState.seenIds.add(item.id));
    watcherState.firstSyncDone = true;
    console.log(
      `[${nowIso()}] X first sync complete for ${username}, cached ${Math.min(items.length, 10)} posts`
    );
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

  for (const item of fresh.slice(-3)) {
    watcherState.seenIds.add(item.id);
    watcherState.lastDetectedAt = Date.now();

    const text = `🚨 <b>NEW X POST DETECTED</b>

<b>Account:</b> @${username}

${item.title}

${item.url}`;

    console.log(`[${nowIso()}] 🚨 NEW POST: ${item.title}`);

    const gif = rand(X_DETECT_GIFS);
    if (gif) {
      await sendAnimation(CHAT_ID, gif, {
        caption: text.slice(0, 1024),
        parse_mode: "HTML"
      });
    } else {
      await sendText(CHAT_ID, text, { parse_mode: "HTML" });
    }
  }

  if (watcherState.seenIds.size > 500) {
    const trimmed = Array.from(watcherState.seenIds).slice(-250);
    watcherState.seenIds = new Set(trimmed);
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

  watcherState.timer = setInterval(run, WATCH_INTERVAL_MS);

  watcherState.guardTimer = setInterval(() => {
    const diff = Date.now() - watcherState.lastHeartbeat;
    if (diff > WATCH_HEARTBEAT_TIMEOUT_MS) {
      console.log(`[${nowIso()}] ♻️ WATCHER HEARTBEAT RESET`);
      watcherState.lastHeartbeat = Date.now();
      run();
    }
  }, 30000);
}

function buildLangKeyboard() {
  return {
    inline_keyboard: LANGUAGE_OPTIONS.map(([label, code]) => [
      { text: label, callback_data: `lang:${code}` }
    ])
  };
}

async function ensureCommands() {
  await bot.setMyCommands([
    { command: "start", description: "Start bot" },
    { command: "menu", description: "Open control menu" },
    { command: "status", description: "System status" },
    { command: "lang", description: "Choose language" },
    { command: "test_trade", description: "Run test trade flow" },
    { command: "level6_status", description: "Level 6 summary" },
    { command: "level6_open_trades", description: "Show open trades" }
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
    await sendText(chatId, buildMainMenuText(userId), {
      parse_mode: "HTML",
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (text === "/menu") {
    await sendText(chatId, buildMainMenuText(userId), {
      parse_mode: "HTML",
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (text === "/status") {
    await sendText(chatId, buildStatusText(userId), {
      parse_mode: "HTML",
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (text === "/lang") {
    await sendText(chatId, t(userId, "chooseLanguage"), {
      reply_to_message_id: replyTo,
      reply_markup: buildLangKeyboard()
    });
    return true;
  }

  if (text === "/test_trade") {
    const sender = async payload => {
      await sendTradePayload(chatId, payload, replyTo);
    };

    const groupSender = async payload => {
      await sendTradePayload(CHAT_ID, payload);
    };

    await simulateTradeFlow(sender, groupSender);
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

bot.on("callback_query", async query => {
  try {
    const data = query.data || "";
    const userId = query.from?.id;
    const chatId = query.message?.chat?.id;

    if (data.startsWith("lang:")) {
      const code = data.split(":")[1];
      setUserLang(userId, code);

      await bot.answerCallbackQuery(query.id, {
        text: `${t(userId, "languageSet")}: ${code.toUpperCase()}`
      });

      if (chatId) {
        await sendText(chatId, `${t(userId, "languageSet")}: ${code.toUpperCase()}`);
        await sendText(chatId, buildMainMenuText(userId), {
          parse_mode: "HTML"
        });
      }
    }
  } catch (error) {
    console.log(`callback error: ${error.message}`);
  }
});

bot.on("message", async msg => {
  try {
    if (!msg?.text) return;

    const handled = await handleTextCommand(msg);
    if (handled) return;
  } catch (error) {
    console.log(`message handler error: ${error.message}`);
    try {
      await sendText(msg.chat.id, t(msg.from?.id || msg.chat.id, "stumbled"), {
        reply_to_message_id: msg.message_id
      });
    } catch {}
  }
});

bot.on("polling_error", err => {
  console.log("Polling error:", err.message);
});

process.on("unhandledRejection", error => {
  console.log("Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
  console.log("Uncaught exception:", error);
});

async function bootstrap() {
  console.log("🤖 BOT STARTED");
  await initTradingAdmin();
  await ensureCommands();
  startWatcher();
}

bootstrap().catch(error => {
  console.error("bootstrap fatal:", error);
  process.exit(1);
});
