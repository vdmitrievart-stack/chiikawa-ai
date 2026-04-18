// telegram-bot.js

import fetch from "node-fetch";
import { startXWatcher } from "./x-watcher.js";
import { initTradingAdmin, simulateTradeFlow } from "./trading-admin.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing");
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

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram API error in ${method}: ${JSON.stringify(data)}`);
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

// ==============================
// TRADE REPORT SENDER
// ==============================

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
    await sendMessage(
      chatId,
      `🐹 <b>Chiikawa bot is alive!</b>

Watching X posts 👀
Trade flow test ready 🚀

Commands:
/start
/status
/ping
/test_trade`,
      replyTo
    );
    return true;
  }

  if (text === "/status") {
    await sendMessage(
      chatId,
      `✅ <b>Bot running</b>
👀 X watcher active
🎬 GIF trade reactions enabled`,
      replyTo
    );
    return true;
  }

  if (text === "/ping") {
    await sendMessage(chatId, "pong 🏓", replyTo);
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
// MESSAGE HANDLER
// ==============================

async function handleMessage(message) {
  try {
    if (!message || !message.text) return;

    const handled = await handleCommand(message);
    if (handled) return;
  } catch (err) {
    console.log("❌ handleMessage error:", err.message);

    try {
      await sendMessage(message.chat.id, "Chiikawa stumbled a little... 🥺", message.message_id);
    } catch (sendErr) {
      console.log("❌ fallback send error:", sendErr.message);
    }
  }
}

// ==============================
// LOOP
// ==============================

async function poll() {
  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"]
      });

      for (const upd of updates) {
        offset = upd.update_id + 1;

        if (upd.message) {
          await handleMessage(upd.message);
        }
      }
    } catch (err) {
      console.log("❌ polling error:", err.message);
      await new Promise(r => setTimeout(r, 3000));
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
  console.log("👀 X watcher started");

  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Start bot" },
      { command: "status", description: "Show bot status" },
      { command: "ping", description: "Ping bot" },
      { command: "test_trade", description: "Run test trade with GIF reactions" }
    ]
  });

  await poll();
}

start().catch(err => {
  console.error("❌ startup error:", err.message);
  process.exit(1);
});
