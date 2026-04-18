// telegram-bot.js

import fetch from "node-fetch";
import { startXWatcher } from "./x-watcher.js";
import { initTradingAdmin, simulateTradeFlow } from "./trading-admin.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("NO TOKEN");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;

// ==============================
// TG CORE
// ==============================

async function tg(method, body = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function sendMessage(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  });
}

async function sendGif(chatId, gif, caption) {
  return tg("sendAnimation", {
    chat_id: chatId,
    animation: gif,
    caption,
    parse_mode: "HTML"
  });
}

// ==============================
// TRADE REPORT SENDER
// ==============================

function createTradeSender(chatId) {
  return async ({ text, gif }) => {
    if (gif) {
      await sendGif(chatId, gif, text);
    } else {
      await sendMessage(chatId, text);
    }
  };
}

// ==============================
// COMMANDS
// ==============================

async function handleCommand(msg) {
  const text = msg.text || "";
  const chatId = msg.chat.id;

  if (text === "/start") {
    await sendMessage(chatId, "🐹 Chiikawa bot ready");
    return true;
  }

  if (text === "/test_trade") {
    const sender = createTradeSender(chatId);

    await simulateTradeFlow(sender);
    return true;
  }

  return false;
}

// ==============================
// LOOP
// ==============================

async function poll() {
  while (true) {
    try {
      const res = await tg("getUpdates", {
        offset,
        timeout: 30
      });

      for (const upd of res.result || []) {
        offset = upd.update_id + 1;

        if (upd.message) {
          await handleCommand(upd.message);
        }
      }
    } catch (err) {
      console.log("poll error", err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ==============================
// START
// ==============================

async function start() {
  console.log("🚀 bot start");

  await tg("deleteWebhook");

  await initTradingAdmin();

  startXWatcher();

  console.log("👀 watcher started");

  await poll();
}

start();
