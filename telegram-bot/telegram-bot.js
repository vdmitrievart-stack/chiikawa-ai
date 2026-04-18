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
    interval: 1200,
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
      "https://nitter.net",
      "https://nitter.privacydev.net",
      "https://nitter.poast.org"
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
    center: "🧠 Chiikawa Control Center",
    status: "📊 System Status",
    trading: "Trading",
    mode: "Mode",
    kill: "Kill switch",
    buyMin: "Buy min",
    dryRun: "Dry run",
    level6: "Level 6",
    winRate: "Win rate",
    trades: "Trades",
    pnl: "PnL",
    score: "Score",
    avgEntry: "Avg entry score",
    openTrades: "Open trades",
    online: "ONLINE",
    offline: "OFFLINE",
    watcher: "X watcher",
    heartbeat: "Heartbeat",
    accounts: "Accounts",
    menu: "📋 Menu",
    actions: "⚡ Actions",
    lang: "🌍 Language",
    chooseLang: "Choose language",
    langSet: "Language set",
    noOpenTrades: "No open trades",
    stumbled: "Chiikawa stumbled a little... 🥺",
    xPost: "🚨 NEW X POST DETECTED",
    account: "Account",
    entryStarted: "🚀 Test trade launched",
    dryRunOn: "🧪 Dry run ON",
    dryRunOff: "💸 Dry run OFF",
    tradingOn: "✅ Trading enabled",
    tradingOff: "⛔ Trading disabled"
  },
  ru: {
    botAlive: "🚀 Бот жив",
    center: "🧠 Центр управления Chiikawa",
    status: "📊 Статус системы",
    trading: "Торговля",
    mode: "Режим",
    kill: "Kill switch",
    buyMin: "Мин. покупка",
    dryRun: "Dry run",
    level6: "Level 6",
    winRate: "Винрейт",
    trades: "Сделки",
    pnl: "PnL",
    score: "Оценка",
    avgEntry: "Средняя оценка входа",
    openTrades: "Открытые сделки",
    online: "ОНЛАЙН",
    offline: "ОФЛАЙН",
    watcher: "X watcher",
    heartbeat: "Пульс",
    accounts: "Аккаунты",
    menu: "📋 Меню",
    actions: "⚡ Действия",
    lang: "🌍 Язык",
    chooseLang: "Выбери язык",
    langSet: "Язык установлен",
    noOpenTrades: "Открытых сделок нет",
    stumbled: "Chiikawa немного споткнулся... 🥺",
    xPost: "🚨 ОБНАРУЖЕН НОВЫЙ ПОСТ В X",
    account: "Аккаунт",
    entryStarted: "🚀 Тестовая сделка запущена",
    dryRunOn: "🧪 Dry run включён",
    dryRunOff: "💸 Dry run выключен",
    tradingOn: "✅ Торговля включена",
    tradingOff: "⛔ Торговля выключена"
  }
};

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

function nowIso() {
  return new Date().toISOString();
}

function rand(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sendText(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
    disable_web_page_preview: true,
    parse_mode: "HTML",
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

    if (gif) {
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
  const s = getLevel6Summary();

  return `${t(userId, "center")}

<b>${t(userId, "trading")}:</b> ${runtime.enabled ? "ON" : "OFF"}
<b>${t(userId, "mode")}:</b> ${runtime.mode}
<b>${t(userId, "kill")}:</b> ${runtime.killSwitch ? "ON" : "OFF"}
<b>${t(userId, "buyMin")}:</b> $${runtime.buybotAlertMinUsd}
<b>${t(userId, "dryRun")}:</b> ${runtime.dryRun ? "ON" : "OFF"}

<b>${t(userId, "level6")}:</b>
• ${t(userId, "winRate")}: ${(s.winRate * 100).toFixed(1)}%
• ${t(userId, "trades")}: ${s.totalTrades}
• ${t(userId, "pnl")}: ${s.pnl}%
• ${t(userId, "score")}: ${s.avgEntryScore}`;
}

function buildStatusText(userId) {
  const runtime = getTradingRuntime();
  const s = getLevel6Summary();
  const openTrades = getLevel6OpenTrades();

  return `${t(userId, "status")}

<b>Bot:</b> ${t(userId, "online")}
<b>${t(userId, "watcher")}:</b> ${watcherState.started ? t(userId, "online") : t(userId, "offline")}
<b>${t(userId, "heartbeat")}:</b> ${new Date(watcherState.lastHeartbeat).toLocaleString()}
<b>${t(userId, "accounts")}:</b> ${WATCH_ACCOUNTS.join(", ")}

<b>${t(userId, "trading")}:</b> ${runtime.enabled ? "ON" : "OFF"}
<b>${t(userId, "mode")}:</b> ${runtime.mode}
<b>${t(userId, "kill")}:</b> ${runtime.killSwitch ? "ON" : "OFF"}
<b>${t(userId, "buyMin")}:</b> $${runtime.buybotAlertMinUsd}
<b>${t(userId, "dryRun")}:</b> ${runtime.dryRun ? "ON" : "OFF"}

<b>${t(userId, "level6")}:</b>
• ${t(userId, "winRate")}: ${(s.winRate * 100).toFixed(1)}%
• ${t(userId, "trades")}: ${s.totalTrades}
• ${t(userId, "pnl")}: ${s.pnl}%
• ${t(userId, "avgEntry")}: ${s.avgEntryScore}
• ${t(userId, "openTrades")}: ${openTrades.length}`;
}

function buildMenuKeyboard(userId) {
  const runtime = getTradingRuntime();

  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "ui:status" },
        { text: "🧠 Level 6", callback_data: "ui:l6" }
      ],
      [
        { text: runtime.enabled ? "⛔ Trading OFF" : "✅ Trading ON", callback_data: "cmd:toggle_trading" },
        { text: runtime.dryRun ? "💸 DryRun OFF" : "🧪 DryRun ON", callback_data: "cmd:toggle_dryrun" }
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
  if (!items.length) return;

  if (!watcherState.firstSyncDone) {
    items.slice(0, 10).forEach(item => watcherState.seenIds.add(item.id));
    watcherState.firstSyncDone = true;
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

  for (const item of fresh.slice(-3)) {
    watcherState.seenIds.add(item.id);
    watcherState.lastDetectedAt = Date.now();

    const text = `🚨 <b>NEW X POST DETECTED</b>

<b>Account:</b> @${username}

${item.title}

${item.url}`;

    const gif = rand(X_DETECT_GIFS);
    if (gif) {
      await sendAnimation(CHAT_ID, gif, {
        caption: text.slice(0, 1024),
        parse_mode: "HTML"
      });
    } else {
      await sendText(CHAT_ID, text);
    }
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

async function ensureCommands() {
  await bot.setMyCommands([
    { command: "start", description: "Start bot" },
    { command: "menu", description: "Open menu" },
    { command: "status", description: "System status" },
    { command: "lang", description: "Choose language" },
    { command: "test_trade", description: "Run test trade" },
    { command: "level6_status", description: "Level 6 summary" },
    { command: "level6_open_trades", description: "Open trades" }
  ]);
}

async function openMenu(chatId, userId, replyToMessageId) {
  await sendText(chatId, buildMainMenuText(userId), {
    reply_markup: buildMenuKeyboard(userId),
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
  });
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

  if (text === "/lang") {
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

bot.on("callback_query", async query => {
  try {
    const data = query.data || "";
    const userId = query.from?.id || 0;
    const chatId = query.message?.chat?.id;

    if (!chatId) return;

    if (data === "ui:status") {
      await bot.answerCallbackQuery(query.id);
      await sendText(chatId, buildStatusText(userId));
      return;
    }

    if (data === "ui:l6") {
      await bot.answerCallbackQuery(query.id);
      const s = getLevel6Summary();
      await sendText(
        chatId,
        `🧠 <b>Level 6</b>

<b>WinRate:</b> ${(s.winRate * 100).toFixed(1)}%
<b>Trades:</b> ${s.totalTrades}
<b>PnL:</b> ${s.pnl}%
<b>Score:</b> ${s.avgEntryScore}`
      );
      return;
    }

    if (data === "ui:lang") {
      await bot.answerCallbackQuery(query.id);
      await sendText(chatId, t(userId, "chooseLang"), {
        reply_markup: buildLanguageKeyboard()
      });
      return;
    }

    if (data === "lang:en" || data === "lang:ru") {
      const lang = data.split(":")[1];
      setUserLang(userId, lang);
      await bot.answerCallbackQuery(query.id, {
        text: `${t(userId, "langSet")}: ${lang.toUpperCase()}`
      });
      await openMenu(chatId, userId);
      return;
    }

    if (data === "cmd:test_trade") {
      await bot.answerCallbackQuery(query.id);
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
      const result = await handleTradingCommand(runtime.enabled ? "/trading_off" : "/trading_on");
      await bot.answerCallbackQuery(query.id, { text: result.message });
      await openMenu(chatId, userId);
      return;
    }

    if (data === "cmd:toggle_dryrun") {
      const runtime = getTradingRuntime();
      const result = await handleTradingCommand(runtime.dryRun ? "/dryrun_off" : "/dryrun_on");
      await bot.answerCallbackQuery(query.id, { text: result.message });
      await openMenu(chatId, userId);
      return;
    }

    if (data === "cmd:mode") {
      const result = await handleTradingCommand("/trade_mode");
      await bot.answerCallbackQuery(query.id, { text: result.message });
      await openMenu(chatId, userId);
      return;
    }

    if (data === "cmd:kill") {
      const result = await handleTradingCommand("/kill_switch");
      await bot.answerCallbackQuery(query.id, { text: result.message });
      await openMenu(chatId, userId);
      return;
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
