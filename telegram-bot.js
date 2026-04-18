// telegram-bot.js

import fetch from "node-fetch";
import { startXWatcher } from "./x-watcher.js";
import { initTradingAdmin, simulateTradeFlow } from "./trading-admin.js";

// ==============================
// SINGLE INSTANCE PROTECTION
// ==============================

if (global.__BOT_RUNNING__) {
  console.log("⚠️ Bot already running, killing duplicate");
  process.exit(0);
}
global.__BOT_RUNNING__ = true;

// ==============================
// CRASH PROTECTION
// ==============================

process.on("uncaughtException", err => {
  console.log("💥 Uncaught:", err.message);
});

process.on("unhandledRejection", err => {
  console.log("💥 Rejection:", err);
});

// ==============================
// ENV
// ==============================

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;

// ==============================
// TELEGRAM CORE
// ==============================

async function tg(method, body = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }

  return data.result;
}

async function sendMessage(chatId, text, replyTo = null) {
  return tg("sendMessage", {
    chat_id: chatId,
    text: String(text || "").slice(0, 4096),
    parse_mode: "HTML",
    ...(replyTo ? { reply_to_message_id: replyTo } : {})
  });
}

async function sendGif(chatId, gif, caption = "", replyTo = null) {
  return tg("sendAnimation", {
    chat_id: chatId,
    animation: gif,
    caption: String(caption || "").slice(0, 1024),
    parse_mode: "HTML",
    ...(replyTo ? { reply_to_message_id: replyTo } : {})
  });
}

function createTradeSender(chatId, replyTo = null) {
  return async ({ text, gif }) => {
    if (gif) {
      await sendGif(chatId, gif, text, replyTo);
    } else {
      await sendMessage(chatId, text, replyTo);
    }
  };
}

// ==============================
// COMMANDS
// ==============================

async function handleCommand(msg) {
  const text = String(msg.text || "").trim();
  const chatId = msg.chat.id;
  const replyTo = msg.message_id;

  if (text === "/start") {
    await sendMessage(chatId, "🐹 Chiikawa bot ready", replyTo);
    return true;
  }

  if (text === "/test_trade") {
    const sender = createTradeSender(chatId, replyTo);
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
      const updates = await tg("getUpdates", {
        offset,
        timeout: 30
      });

      for (const upd of updates) {
        offset = upd.update_id + 1;

        if (upd.message) {
          await handleCommand(upd.message);
        }
      }
    } catch (err) {
      console.log("❌ polling error:", err.message);

      // ⚡ ФИКС 409 — пауза
      if (err.message.includes("409")) {
        console.log("⚠️ 409 detected → waiting 5s...");
        await new Promise(r => setTimeout(r, 5000));
      } else {
        await new Promise(r => setTimeout(r, 2000));
      }
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
