import http from "node:http";
import TelegramBot from "node-telegram-bot-api";
import {
  initTradingAdmin,
  getTradingRuntime,
  getLevel6Summary,
  handleTradingCommand,
  simulateTradeFlow
} from "./trading-admin.js";

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const WEBHOOK_SECRET = "chiikawa_secret";
const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;

const bot = new TelegramBot(TOKEN, { polling: false });

// ================= SEND =================

function send(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    ...opts
  });
}

// ================= MENU =================

function buildMenu() {
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

// ================= 🔥 FIXED PROCESS UPDATE =================

async function processUpdate(update) {
  try {
    // 🔥 CALLBACK FIX
    if (update?.callback_query) {
      console.log("CALLBACK RECEIVED:", JSON.stringify(update.callback_query));

      try {
        await bot.answerCallbackQuery(update.callback_query.id);
      } catch (e) {
        console.log("answerCallbackQuery error:", e.message);
      }

      await handleCallback(update.callback_query);
      return;
    }

    // TEXT COMMANDS
    if (update?.message?.text) {
      await handleMessage(update.message);
      return;
    }
  } catch (err) {
    console.log("processUpdate error:", err);
  }
}

// ================= HANDLERS =================

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === "/start") {
    await send(chatId, "🚀 Bot ready", {
      reply_markup: buildMenu()
    });
    return;
  }

  if (text === "/status") {
    const rt = getTradingRuntime();
    await send(chatId, `Trading: ${rt.enabled}\nDryRun: ${rt.dryRun}`);
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

async function handleCallback(q) {
  const chatId = q.message.chat.id;
  const data = q.data;

  console.log("CALLBACK:", data);

  if (data === "status") {
    const rt = getTradingRuntime();
    await send(chatId, `Trading: ${rt.enabled}\nDryRun: ${rt.dryRun}`);
    return;
  }

  if (data === "l6") {
    const s = getLevel6Summary();
    await send(chatId, `Trades: ${s.totalTrades}`);
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

// ================= SERVER =================

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";

    req.on("data", chunk => (body += chunk));

    req.on("end", async () => {
      // 🔥 КЛЮЧЕВОЙ ФИКС
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
    console.log("Server started");

    await bot.setWebHook(
      `https://${process.env.RENDER_EXTERNAL_HOSTNAME}${WEBHOOK_PATH}`
    );

    console.log("Webhook set");
  });
}

start();
