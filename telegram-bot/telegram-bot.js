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
}

function buildMainMenuText() {
  const runtime = getTradingRuntime();
  const s = getLevel6Summary();

  return `🧠 <b>Chiikawa Control Center</b>

Trading: ${runtime.enabled ? "ON" : "OFF"}
Mode: ${runtime.mode}
Kill switch: ${runtime.killSwitch ? "ON" : "OFF"}
Buy min: $${runtime.buybotAlertMinUsd}

Level 6:
WinRate: ${(s.winRate * 100).toFixed(1)}%
Trades: ${s.totalTrades}
PnL: ${s.pnl}%
Score: ${s.avgEntryScore}

Commands:
/menu
/status
/test_trade
/trading_on
/trading_off
/kill_switch
/trade_mode
/setbuy 25
/level6_status
/level6_open_trades`;
}

function buildStatusText() {
  const runtime = getTradingRuntime();
  const s = getLevel6Summary();
  const openTrades = getLevel6OpenTrades();

  return `📊 <b>System Status</b>

Bot: ONLINE
X watcher: ${watcherState.started ? "ONLINE" : "OFFLINE"}
Watcher heartbeat: ${new Date(watcherState.lastHeartbeat).toLocaleString()}
Watched accounts: ${WATCH_ACCOUNTS.join(", ")}

Trading: ${runtime.enabled ? "ON" : "OFF"}
Mode: ${runtime.mode}
Kill switch: ${runtime.killSwitch ? "ON" : "OFF"}
Buy min: $${runtime.buybotAlertMinUsd}

Level 6:
WinRate: ${(s.winRate * 100).toFixed(1)}%
Trades: ${s.totalTrades}
PnL: ${s.pnl}%
Avg entry score: ${s.avgEntryScore}
Open trades: ${openTrades.length}`;
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
      watcherState.lastHostIndex = (watcherState.lastHostIndex + i) % NITTER_HOSTS.length;
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
    console.log(`[${nowIso()}] X first sync complete for ${username}, cached ${Math.min(items.length, 10)} posts`);
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

Account: @${username}

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

async function ensureCommands() {
  await bot.setMyCommands([
    { command: "start", description: "Start bot" },
    { command: "menu", description: "Open control menu" },
    { command: "status", description: "System status" },
    { command: "test_trade", description: "Run test trade flow" },
    { command: "level6_status", description: "Level 6 summary" },
    { command: "level6_open_trades", description: "Show open trades" }
  ]);
}

async function handleTextCommand(msg) {
  const text = String(msg.text || "").trim();
  const chatId = msg.chat.id;
  const replyTo = msg.message_id;

  if (!text.startsWith("/")) return false;

  if (text === "/start") {
    await sendText(chatId, "🚀 Bot is alive", {
      reply_to_message_id: replyTo
    });
    await sendText(chatId, buildMainMenuText(), {
      parse_mode: "HTML",
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (text === "/menu") {
    await sendText(chatId, buildMainMenuText(), {
      parse_mode: "HTML",
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (text === "/status") {
    await sendText(chatId, buildStatusText(), {
      parse_mode: "HTML",
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (text === "/test_trade") {
    const sender = async payload => {
      await sendTradePayload(chatId, payload, replyTo);
    };

    await simulateTradeFlow(sender);
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

bot.on("message", async msg => {
  try {
    if (!msg?.text) return;

    const handled = await handleTextCommand(msg);
    if (handled) return;
  } catch (error) {
    console.log(`message handler error: ${error.message}`);
    try {
      await sendText(msg.chat.id, "Chiikawa stumbled a little... 🥺", {
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
