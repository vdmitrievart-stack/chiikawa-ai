import http from "node:http";
import TelegramBot from "node-telegram-bot-api";
import {
  initTradingAdmin,
  simulateTradeFlow
} from "./trading-admin.js";

import { getBestToken } from "./scan-engine.js";

// ================= ENV =================

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "secret";
const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;

const bot = new TelegramBot(TOKEN, { polling: false });

// ================= SEND =================

function send(chatId, text) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML"
  });
}

// ================= PROCESS =================

async function processUpdate(update) {
  try {
    if (update.callback_query) {
      await bot.answerCallbackQuery(update.callback_query.id);
      return;
    }

    if (update.message?.text) {
      await handleMessage(update.message);
    }
  } catch (e) {
    console.log("update error:", e);
  }
}

// ================= MESSAGE =================

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  console.log("MSG:", text);

  if (text === "/start") {
    await send(chatId, "🚀 REAL SCAN MODE ON");
    startAuto(chatId);
    return;
  }

  if (text === "/scan") {
    await runScan(chatId);
    return;
  }

  if (text === "/test_trade") {
    await runScan(chatId);
    return;
  }
}

// ================= SCAN =================

async function runScan(chatId) {
  await send(chatId, "🔎 Scanning market...");

  const token = await getBestToken();

  if (!token) {
    await send(chatId, "❌ No candidates");
    return;
  }

  await send(
    chatId,
    `🔥 Candidate найден:

Token: ${token.name}
Score: ${token.score}
Price: ${token.price}
Liquidity: ${token.liquidity}
Volume: ${token.volume}`
  );

  if (token.score < 40) {
    await send(chatId, "❌ Skip (low score)");
    return;
  }

  await simulateTradeFlow(
    async (p) => {
      const txt = p.text
        .replace("TEST_TOKEN", token.name)
        .replace("1.01", token.price.toFixed(6));

      await send(chatId, txt);
    },
    async () => {}
  );
}

// ================= AUTO =================

function startAuto(chatId) {
  console.log("AUTO START");

  setInterval(() => {
    runScan(chatId);
  }, 60000);
}

// ================= SERVER =================

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";

    req.on("data", (c) => (body += c));

    req.on("end", async () => {
      res.writeHead(200);
      res.end("OK");

      const update = JSON.parse(body);
      await processUpdate(update);
    });

    return;
  }

  res.writeHead(200);
  res.end("OK");
});

// ================= START =================

async function start() {
  await initTradingAdmin();

  server.listen(PORT, async () => {
    console.log("STARTED");

    await bot.setWebHook(
      `https://${process.env.RENDER_EXTERNAL_HOSTNAME}${WEBHOOK_PATH}`
    );
  });
}

start();
