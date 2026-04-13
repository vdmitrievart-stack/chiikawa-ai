import fetch from "node-fetch";
import {
  getWebsiteUrl,
  getWebsiteInvite,
  getRandomCommunityNudge,
  shouldSendCommunityNudge,
  getRandomMission,
  shouldSendMission
} from "./community-engine.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let offset = 0;
let botUsername = null;
let botId = null;
let botFirstName = "Chiikawa";

const ACTIVE_CONVERSATION_MS = 8 * 60 * 1000;
const TOKEN_CA = "2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu";

const greetedChats = new Set();
const userLastSeen = new Map();
const activeChatUntil = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    const err = new Error(`Telegram API error in ${method}: ${JSON.stringify(data)}`);
    err.telegram = data;
    throw err;
  }

  return data.result;
}

async function sendTelegramMessage(chatId, text, replyToMessageId = null, extra = {}) {
  const payload = {
    chat_id: chatId,
    text,
    allow_sending_without_reply: true,
    ...extra
  };

  if (replyToMessageId) {
    payload.reply_parameters = {
      message_id: replyToMessageId
    };
  }

  return tg("sendMessage", payload);
}

async function sendTyping(chatId) {
  return tg("sendChatAction", {
    chat_id: chatId,
    action: "typing"
  });
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
    throw new Error(`Chiikawa backend error: ${JSON.stringify(data)}`);
  }

  return data.reply || "Chiikawa got quiet... 🥺";
}

function buildSessionId(chatId, userId) {
  return `telegram_${chatId}_${userId || "anon"}`;
}

function isPrivateChat(message) {
  return message.chat?.type === "private";
}

function normalizeText(text) {
  return String(text || "").trim();
}

function cleanLower(text) {
  return normalizeText(text).toLowerCase();
}

function mentionsBotUsername(text) {
  if (!botUsername) return false;
  return cleanLower(text).includes(`@${botUsername.toLowerCase()}`);
}

function isReplyToBot(message) {
  return message?.reply_to_message?.from?.id === botId;
}

function getNameTriggers() {
  const triggers = [
    "chiikawa",
    "chiikawa ai",
    "chiikawa bot",
    "чикикава",
    "чики"
  ];

  if (botUsername) {
    triggers.push(botUsername.toLowerCase());
    triggers.push(botUsername.toLowerCase().replace(/^@/, ""));
  }

  if (botFirstName) {
    triggers.push(botFirstName.toLowerCase());
  }

  return [...new Set(triggers)];
}

function mentionsBotByName(text) {
  const lower = cleanLower(text);
  const triggers = getNameTriggers();
  return triggers.some(name => lower.includes(name));
}

function markChatActive(chatId) {
  activeChatUntil.set(chatId, Date.now() + ACTIVE_CONVERSATION_MS);
}

function isChatActive(chatId) {
  const until = activeChatUntil.get(chatId) || 0;
  return Date.now() < until;
}

function getDisplayName(user) {
  if (!user) return "friend";
  return user.first_name || user.username || "friend";
}

function shouldSendSoftCheckIn(userId) {
  if (!userId) return false;

  const now = Date.now();
  const last = userLastSeen.get(userId) || 0;
  userLastSeen.set(userId, now);

  if (now - last < 4 * 60 * 60 * 1000) return false;

  return Math.random() < 0.08;
}

function maybeAddTelegramPrefix(text, user, message) {
  const name = getDisplayName(user);
  const chatType = message.chat?.type || "unknown";
  return `Telegram message from ${name} in a ${chatType} chat: ${text}`;
}

function isCARequest(text) {
  const lower = cleanLower(text);

  return (
    lower === "ca" ||
    lower === "ca?" ||
    lower === "contract" ||
    lower === "contract?" ||
    lower === "token address" ||
    lower === "address" ||
    lower === "контракт" ||
    lower === "контракт?" ||
    lower === "адрес токена" ||
    lower === "ca plz" ||
    lower === "send ca" ||
    lower.includes("give ca") ||
    lower.includes("send contract") ||
    lower.includes("drop ca") ||
    lower.includes("кинь ca") ||
    lower.includes("дай ca") ||
    lower.includes("дай контракт") ||
    lower.includes("скинь ca") ||
    lower.includes("скинь контракт")
  );
}

function isWebsiteRequest(text) {
  const lower = cleanLower(text);

  return (
    lower === "website" ||
    lower === "site" ||
    lower === "link" ||
    lower === "web" ||
    lower === "website?" ||
    lower === "site?" ||
    lower === "link?" ||
    lower === "сайт" ||
    lower === "ссылка" ||
    lower === "сайт?" ||
    lower === "ссылка?" ||
    lower === "вебсайт" ||
    lower === "web site" ||
    lower.includes("website") ||
    lower.includes("site link") ||
    lower.includes("send website") ||
    lower.includes("send link") ||
    lower.includes("drop link") ||
    lower.includes("дай сайт") ||
    lower.includes("дай ссылку") ||
    lower.includes("скинь сайт") ||
    lower.includes("скинь ссылку") ||
    lower.includes("ссылка на сайт") ||
    lower.includes("где сайт")
  );
}

function buildCAMessage() {
  return `CA
${TOKEN_CA}

Token type: CASHBACK

$Chiikawa belongs to the community.

Website
${getWebsiteUrl()}`;
}

function buildCAKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Copy CA",
          copy_text: {
            text: TOKEN_CA
          }
        }
      ],
      [
        {
          text: "Website",
          url: getWebsiteUrl()
        }
      ]
    ]
  };
}

async function sendCAMessage(chatId, replyToMessageId = null) {
  return sendTelegramMessage(chatId, buildCAMessage(), replyToMessageId, {
    reply_markup: buildCAKeyboard()
  });
}

function shouldRespond(message) {
  const text = normalizeText(message.text);

  if (!text) return false;

  if (text.startsWith("/start")) return true;
  if (text.startsWith("/help")) return true;
  if (text.startsWith("/ca")) return true;
  if (text.startsWith("/mood")) return true;
  if (text.startsWith("/website")) return true;
  if (text.startsWith("/mission")) return true;

  if (isCARequest(text)) return true;
  if (isWebsiteRequest(text)) return true;

  if (isPrivateChat(message)) return true;

  if (mentionsBotUsername(text)) return true;
  if (mentionsBotByName(text)) return true;
  if (isReplyToBot(message)) return true;
  if (message.chat?.id && isChatActive(message.chat.id)) return true;

  return false;
}

async function handleCommand(message) {
  const text = normalizeText(message.text);
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const messageId = message.message_id;
  const sessionId = buildSessionId(chatId, userId);

  if (text.startsWith("/start")) {
    const reply = await askChiikawa("Hi", sessionId, "greeting");
    greetedChats.add(chatId);
    markChatActive(chatId);
    await sendTelegramMessage(chatId, reply, messageId);
    return true;
  }

  if (text.startsWith("/help")) {
    await sendTelegramMessage(
      chatId,
      `Hi ✨ I’m Chiikawa.

Commands:
/start
/help
/ca
/mood
/website
/mission

You can also just talk to me normally 🥺
You can call me by name too, not only with @mention.`,
      messageId
    );
    return true;
  }

  if (text.startsWith("/ca")) {
    await sendCAMessage(chatId, messageId);
    return true;
  }

  if (text.startsWith("/website")) {
    await sendTelegramMessage(chatId, getWebsiteInvite(), messageId);
    return true;
  }

  if (text.startsWith("/mission")) {
    await sendTelegramMessage(chatId, getRandomMission(), messageId);
    return true;
  }

  if (text.startsWith("/mood")) {
    const reply = await askChiikawa(
      "Tell me your current mood in one warm message and maybe ask me something back.",
      sessionId,
      "normal"
    );
    markChatActive(chatId);
    await sendTelegramMessage(chatId, reply, messageId);
    return true;
  }

  return false;
}

async function maybeSendGreeting(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const sessionId = buildSessionId(chatId, userId);

  if (!greetedChats.has(chatId)) {
    const greeting = await askChiikawa("Hi", sessionId, "greeting");
    greetedChats.add(chatId);
    markChatActive(chatId);
    await sendTelegramMessage(chatId, greeting);
  }
}

async function handleRegularMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const messageId = message.message_id;
  const text = normalizeText(message.text);
  const sessionId = buildSessionId(chatId, userId);

  if (!text) return;
  if (!shouldRespond(message)) return;

  if (isCARequest(text)) {
    markChatActive(chatId);
    await sendCAMessage(chatId, messageId);
    return;
  }

  if (isWebsiteRequest(text)) {
    markChatActive(chatId);
    await sendTelegramMessage(chatId, getWebsiteInvite(), messageId);
    return;
  }

  await maybeSendGreeting(message);
  await sendTyping(chatId);

  markChatActive(chatId);

  let prompt = maybeAddTelegramPrefix(text, message.from, message);

  if (!isPrivateChat(message) && isChatActive(chatId)) {
    prompt += `
The group conversation with you is currently active. Even if the user did not mention you with @username this time, you should treat this as a direct continuation of the ongoing dialogue.`;
  }

  if (shouldSendSoftCheckIn(userId)) {
    prompt += `
Also, if it feels natural, you may gently continue the conversation with one soft, engaging follow-up question. Keep it warm and not pushy.`;
  }

  if (shouldSendCommunityNudge()) {
    prompt += `
You may also naturally include this gentle community reminder if it fits:
"${getRandomCommunityNudge()}"`;
  }

  if (shouldSendMission()) {
    prompt += `
If it feels natural, you may also end with a tiny community mission:
"${getRandomMission()}"`;
  }

  const reply = await askChiikawa(prompt, sessionId, "normal");
  await sendTelegramMessage(chatId, reply, messageId);
}

async function handleMessage(message) {
  if (!message || message.text == null) return;

  try {
    const wasCommandHandled = await handleCommand(message);
    if (wasCommandHandled) return;

    await handleRegularMessage(message);
  } catch (error) {
    console.error("handleMessage error:", error);

    try {
      await sendTelegramMessage(
        message.chat.id,
        "Chiikawa stumbled a little... 🥺 Please try again.",
        message.message_id
      );
    } catch (e) {
      console.error("Failed to send fallback message:", e);
    }
  }
}

async function bootstrap() {
  try {
    await tg("deleteWebhook", { drop_pending_updates: false });
  } catch (error) {
    const code = error?.telegram?.error_code;
    if (code !== 404) {
      throw error;
    }
  }

  const me = await tg("getMe");
  botUsername = me.username || null;
  botId = me.id || null;
  botFirstName = me.first_name || "Chiikawa";

  console.log(`Telegram bot started as @${botUsername || "unknown_bot"}`);
  console.log(`Using backend: ${CHIIKAWA_AI_URL}`);
  console.log(`Website: ${getWebsiteUrl()}`);
  console.log(`Bot first name: ${botFirstName}`);
}

async function pollLoop() {
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
      const code = error?.telegram?.error_code;

      if (code === 409) {
        console.log("Another bot instance is polling. Waiting 15 seconds...");
        await sleep(15000);
        continue;
      }

      console.error("Polling error:", error);
      await sleep(3000);
    }
  }
}

(async () => {
  try {
    await bootstrap();
    await pollLoop();
  } catch (error) {
    console.error("Fatal bot error:", error);
    process.exit(1);
  }
})();
