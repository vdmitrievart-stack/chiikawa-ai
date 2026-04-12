import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL ||
  process.env.CHIikAWA_AI_URL || // запасной вариант на случай опечатки
  "https://chiikawa-ai.onrender.com/chat";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let offset = 0;

// Память о том, приветствовали ли мы чат отдельно в Telegram
const greetedChats = new Set();

async function tg(method, body = {}) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(
      `Telegram API error in ${method}: ${JSON.stringify(data)}`
    );
  }

  return data.result;
}

async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  const payload = {
    chat_id: chatId,
    text,
    allow_sending_without_reply: true
  };

  if (replyToMessageId) {
    payload.reply_parameters = {
      message_id: replyToMessageId
    };
  }

  return tg("sendMessage", payload);
}

async function askChiikawa(message, sessionId, mode = "normal") {
  const res = await fetch(CHIIKAWA_AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message,
      sessionId,
      mode
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Chiikawa backend error: ${JSON.stringify(data)}`
    );
  }

  return data.reply || "Chiikawa got quiet... 🥺";
}

function buildSessionId(chatId, userId) {
  return `telegram_${chatId}_${userId || "anon"}`;
}

function shouldIgnoreMessage(message) {
  if (!message) return true;
  if (message.text == null) return true;
  if (message.text.startsWith("/start")) return false;
  if (message.text.startsWith("/help")) return false;
  return false;
}

async function handleMessage(message) {
  if (shouldIgnoreMessage(message)) return;

  const chatId = message.chat?.id;
  const userId = message.from?.id;
  const text = String(message.text || "").trim();
  const messageId = message.message_id;

  if (!chatId || !text) return;

  const sessionId = buildSessionId(chatId, userId);

  try {
    // Команда /start
    if (text === "/start") {
      const reply = await askChiikawa("Hi", sessionId, "greeting");
      greetedChats.add(chatId);
      await sendTelegramMessage(chatId, reply, messageId);
      return;
    }

    // Команда /help
    if (text === "/help") {
      await sendTelegramMessage(
        chatId,
        "Send me a message and I’ll answer as Chiikawa ✨",
        messageId
      );
      return;
    }

    // Если чат еще не приветствовался, сначала приветствие
    if (!greetedChats.has(chatId)) {
      const greeting = await askChiikawa("Hi", sessionId, "greeting");
      greetedChats.add(chatId);
      await sendTelegramMessage(chatId, greeting);
    }

    // Эффект "печатает"
    await tg("sendChatAction", {
      chat_id: chatId,
      action: "typing"
    });

    const reply = await askChiikawa(text, sessionId, "normal");
    await sendTelegramMessage(chatId, reply, messageId);
  } catch (error) {
    console.error("handleMessage error:", error);
    await sendTelegramMessage(
      chatId,
      "Chiikawa stumbled a little... 🥺 Please try again."
    ).catch(() => {});
  }
}

async function poll() {
  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (error) {
      console.error("Polling error:", error);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

async function bootstrap() {
  try {
    // На всякий случай снимаем webhook, чтобы getUpdates точно работал.
    await tg("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    console.log("Telegram bot started with long polling");
    console.log("Using backend:", CHIIKAWA_AI_URL);
    await poll();
  } catch (error) {
    console.error("Bootstrap error:", error);
    process.exit(1);
  }
}

bootstrap();
