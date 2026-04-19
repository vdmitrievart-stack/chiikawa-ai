import http from "node:http";
import TelegramBot from "node-telegram-bot-api";
import {
  initTradingAdmin,
  getTradingRuntime,
  getLevel6Summary,
  handleTradingCommand,
  simulateTradeFlow
} from "./trading-admin.js";

// ================= ENV =================

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chiikawa_secret";
const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN missing");
  process.exit(1);
}

// ================= BOT =================

const bot = new TelegramBot(TOKEN, { polling: false });

// ================= HELPERS =================

function send(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts
  });
}

function menu() {
  const rt = getTradingRuntime();

  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "status" },
        { text: "🧠 Level 6", callback_data: "l6" }
      ],
      [
        {
          text: rt.enabled ? "⛔ Trading OFF" : "✅ Trading ON",
          callback_data: "toggle_trading"
        },
        {
          text: rt.dryRun ? "💸 DryRun OFF" : "🧪 DryRun ON",
          callback_data: "toggle_dryrun"
        }
      ],
      [
        { text: "🚀 Test Trade", callback_data: "test_trade" }
      ]
    ]
  };
}

// ================= CORE =================

async function processUpdate(update) {
  try {
    // 🔥 CALLBACK FIX
    if (update?.callback_query) {
      console.log("CALLBACK:", update.callback_query.data);

      try {
        await bot.answerCallbackQuery(update.callback_query.id);
      } catch (e) {
        console.log("answerCallback error:", e.message);
      }

      await handleCallback(update.callback_query);
      return;
    }

    if (update?.message?.text) {
      await handleMessage(update.message);
      return;
    }
  } catch (e) {
    console.log("processUpdate error:", e);
  }
}

// ================= MESSAGE =================

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  console.log("MSG:", text);

  if (text === "/start") {
    await send(chatId, "🚀 Bot ready", { reply_markup: menu() });
    return;
  }

  if (text === "/status") {
    const rt = getTradingRuntime();
    await send(chatId, `Trading: ${rt.enabled}\nDryRun: ${rt.dryRun}`);
    return;
  }

  // 🚀 ENTRY
  if (text.startsWith("/entry ")) {
    const ca = text.split(" ")[1];

    await send(chatId, `🔎 Scan CA:\n${ca}`);

    await simulateTradeFlow(
      async (p) => send(chatId, p.text),
      async () => {}
    );

    return;
  }

  if (text === "/test_trade") {
    await simulateTradeFlow(
      async (p) => send(chatId, p.text),
      async () => {}
    );
    return;
  }

  const res = await handleTradingCommand(text);

  if (res?.ok) {
    await send(chatId, res.message);
  }
}

// ================= CALLBACK =================

async function handleCallback(q) {
  const chatId = q.message.chat.id;
  const data = q.data;

  console.log("CLICK:", data);

  if (data === "status") {
    const rt = getTradingRuntime();
    await send(chatId, `Trading: ${rt.enabled}\nDryRun: ${rt.dryRun}`);
    return;
  }

  if (data === "l6") {
    const s = getLevel6Summary();
    await send(chatId, `Trades: ${s.totalTrades}\nPnL: ${s.pnl}`);
    return;
  }

  if (data === "toggle_trading") {
    const rt = getTradingRuntime();
    await handleTradingCommand(rt.enabled ? "/trading_off" : "/trading_on");
    await send(chatId, "Trading toggled");
    return;
  }

  if (data === "toggle_dryrun") {
    const rt = getTradingRuntime();
    await handleTradingCommand(rt.dryRun ? "/dryrun_off" : "/dryrun_on");
    await send(chatId, "DryRun toggled");
    return;
  }

  if (data === "test_trade") {
    await simulateTradeFlow(
      async (p) => send(chatId, p.text),
      async () => {}
    );
    return;
  }
}

// ================= AUTO MODE =================

const AUTO_MODE = true;
const AUTO_INTERVAL = 60000;
const AUTO_DURATION = 4 * 60 * 60 * 1000;

const TEST_CA = [
  "So11111111111111111111111111111111111111112",
  "7dHbWXadF1y5pYz4Y3ZgJ3UczZz7YT1Do1B4ezgm6bJQ"
];

let autoStart = Date.now();

function startAuto() {
  console.log("🤖 AUTO MODE STARTED");

  setInterval(async () => {
    if (!AUTO_MODE) return;

    const elapsed = Date.now() - autoStart;
    if (elapsed > AUTO_DURATION) {
      console.log("🛑 AUTO FINISHED");
      return;
    }

    const ca = TEST_CA[Math.floor(Math.random() * TEST_CA.length)];

    console.log("AUTO:", ca);

    await simulateTradeFlow(
      async (p) => console.log("AUTO TRADE:", p.text),
      async () => {}
    );
  }, AUTO_INTERVAL);
}

// ================= SERVER =================

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";

    req.on("data", (c) => (body += c));

    req.on("end", async () => {
      // 🔥 КРИТИЧЕСКИЙ ФИКС
      res.writeHead(200);
      res.end("OK");

      try {
        const update = JSON.parse(body);
        await processUpdate(update);
      } catch (e) {
        console.log("webhook error:", e);
      }
    });

    return;
  }

  if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
    return;
  }

  res.writeHead(404);
  res.end();
});

// ================= START =================

async function start() {
  await initTradingAdmin();

  server.listen(PORT, async () => {
    console.log("🚀 Server started");

    await bot.setWebHook(
      `https://${process.env.RENDER_EXTERNAL_HOSTNAME}${WEBHOOK_PATH}`
    );

    console.log("✅ Webhook set");
  });

  startAuto();
}

start();
