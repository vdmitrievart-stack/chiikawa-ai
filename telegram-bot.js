import fetch from "node-fetch";
import { startXWatcher } from "./x-watcher.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

let offset = 0;

// =======================
// TELEGRAM HELPERS
// =======================

async function tg(method, body = {}) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  return res.json();
}

async function sendMessage(chatId, text, replyTo = null) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_to_message_id: replyTo || undefined
  });
}

// =======================
// BASIC COMMANDS
// =======================

async function handleCommand(message) {
  const text = message.text || "";
  const chatId = message.chat.id;

  if (text.startsWith("/start")) {
    await sendMessage(
      chatId,
      `🐹 Chiikawa bot is alive!

Watching X posts 👀
Ready for chaos 🚀`
    );
    return true;
  }

  if (text.startsWith("/status")) {
    await sendMessage(
      chatId,
      `✅ Bot running
👀 X watcher active
🔥 Ready`
    );
    return true;
  }

  if (text.startsWith("/ping")) {
    await sendMessage(chatId, "pong 🏓");
    return true;
  }

  return false;
}

// =======================
// MESSAGE HANDLER
// =======================

async function handleMessage(message) {
  try {
    if (!message || !message.text) return;

    const handled = await handleCommand(message);
    if (handled) return;

  } catch (err) {
    console.log("❌ handleMessage error:", err.message);
  }
}

// =======================
// POLLING LOOP
// =======================

async function poll() {
  while (true) {
    try {
      const res = await tg("getUpdates", {
        offset,
        timeout: 30
      });

      const updates = res.result || [];

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

// =======================
// BOOTSTRAP
// =======================

async function start() {
  console.log("🚀 Starting bot...");

  try {
    await tg("deleteWebhook");

    // 🔥 запускаем watcher
    startXWatcher();

    console.log("👀 X watcher started");

    await poll();
  } catch (err) {
    console.log("❌ startup error:", err.message);
    process.exit(1);
  }
}

start();
