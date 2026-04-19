import http from "node:http";
import TelegramBot from "node-telegram-bot-api";

import { getBestTrade } from "./scan-engine.js";
import { enterTrade, exitTrade, getPortfolio } from "./portfolio.js";

// ===== ENV =====

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const PATH = `/telegram/${process.env.WEBHOOK_SECRET}`;

const bot = new TelegramBot(TOKEN, { polling: false });

// ===== STATE =====

let intervalId = null;

// ===== SEND =====

async function send(chatId, text) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML"
  });
}

// ===== CORE LOGIC =====

async function runCycle(chatId) {
  try {
    const best = await getBestTrade();
    if (!best) return;

    const portfolio = getPortfolio();

    await send(chatId, `
🔎 ANALYSIS

Token: ${best.token.name}
Score: ${best.score}

⚠️ Rug: ${best.rug.risk}
🧠 Smart: ${best.wallet.smartMoney}
🤖 Bots: ${best.bots.botActivity}
🐦 Sentiment: ${best.sentiment.sentiment}
`);

    // пропускаем слабые
    if (best.score < 60) {
      await send(chatId, "❌ Skip (low score)");
      return;
    }

    const entry = enterTrade(best.token);

    if (!entry) {
      await send(chatId, "⏳ Already in trade");
      return;
    }

    await send(chatId, `
🚀 ENTRY

${entry.token}
Price: ${entry.entry}
Balance: ${portfolio.balance.toFixed(3)} SOL
`);

    // ===== EXIT =====
    setTimeout(async () => {
      const price =
        best.token.price * (0.95 + Math.random() * 0.1);

      const exit = exitTrade(price);

      if (!exit) return;

      await send(chatId, `
🏁 EXIT

${exit.token}
PnL: ${(exit.pnl * 100).toFixed(2)}%
Balance: ${exit.balance.toFixed(3)} SOL
`);
    }, 30000);

  } catch (e) {
    console.log("cycle error:", e.message);
  }
}

// ===== AUTO START =====

function startAuto(chatId) {
  console.log("🤖 AUTO START");

  if (intervalId) {
    clearInterval(intervalId);
  }

  intervalId = setInterval(() => {
    runCycle(chatId);
  }, 60000);

  // ⏱ авто стоп через 4 часа
  setTimeout(() => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }

    send(chatId, "🛑 AUTO STOPPED (4h finished)");
    console.log("AUTO STOPPED");
  }, 4 * 60 * 60 * 1000);
}

// ===== MESSAGE HANDLER =====

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  console.log("MSG:", text);

  if (text === "/start") {
    await send(chatId, "🚀 Bot started (1 SOL)");
    startAuto(chatId);
    return;
  }

  // 🔴 STOP КОМАНДА
  if (text === "/stop") {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      await send(chatId, "🛑 Bot stopped");
    } else {
      await send(chatId, "ℹ️ Bot already stopped");
    }
    return;
  }

  if (text === "/status") {
    const p = getPortfolio();

    await send(chatId, `
📊 STATUS

Balance: ${p.balance.toFixed(3)} SOL
Position: ${p.position ? p.position.token : "none"}
`);
    return;
  }

  if (text === "/scan") {
    await runCycle(chatId);
    return;
  }
}

// ===== UPDATE PROCESSOR =====

async function processUpdate(update) {
  try {
    if (update?.message?.text) {
      await handleMessage(update.message);
    }
  } catch (e) {
    console.log("update error:", e.message);
  }
}

// ===== SERVER =====

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === PATH) {
    let body = "";

    req.on("data", chunk => (body += chunk));

    req.on("end", async () => {
      res.writeHead(200);
      res.end("OK");

      try {
        const update = JSON.parse(body);
        await processUpdate(update);
      } catch (e) {
        console.log("webhook error:", e.message);
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

// ===== START =====

async function start() {
  server.listen(PORT, async () => {
    console.log("🚀 Server started");

    await bot.setWebHook(
      `https://${process.env.RENDER_EXTERNAL_HOSTNAME}${PATH}`
    );

    console.log("✅ Webhook set");
  });
}

start();
