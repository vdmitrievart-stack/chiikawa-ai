import fetch from "node-fetch";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const AI_SERVER_BASE_URL =
  AI_URL.replace(/\/chat$/, "") || "https://chiikawa-ai.onrender.com";

if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const TG = `https://api.telegram.org/bot${TOKEN}`;

const ADMIN_IDS = [617743971];
const FORCED_GROUP_CHAT_ID = "-1003953010138";
const TOKEN_CA = "2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu";

let offset = 0;
let botId = null;
let botUsername = null;

const activeChatUntil = new Map();
const ACTIVE_CONVERSATION_MS = 8 * 60 * 1000;
const chatTraffic = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function normalizeText(text) {
  return String(text || "").trim();
}

function cleanLower(text) {
  return normalizeText(text).toLowerCase();
}

function getDisplayName(user) {
  if (!user) return "friend";
  return user.first_name || user.username || "friend";
}

function isPrivateChat(message) {
  return message.chat?.type === "private";
}

function isGroupChat(message) {
  const type = message.chat?.type;
  return type === "group" || type === "supergroup";
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

  return [...new Set(triggers)];
}

function mentionsBotByName(text) {
  const lower = cleanLower(text);
  return getNameTriggers().some(name => lower.includes(name));
}

function markChatActive(chatId) {
  activeChatUntil.set(chatId, Date.now() + ACTIVE_CONVERSATION_MS);
}

function isChatActive(chatId) {
  const until = activeChatUntil.get(chatId) || 0;
  return Date.now() < until;
}

function countTraffic(chatId) {
  const now = Date.now();
  const bucket = chatTraffic.get(chatId) || [];
  bucket.push(now);

  const filtered = bucket.filter(ts => now - ts < 60 * 1000);
  chatTraffic.set(chatId, filtered);

  return filtered.length;
}

async function tg(method, body = {}) {
  const res = await fetch(`${TG}/${method}`, {
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

async function send(chatId, text, replyTo = null, extra = {}) {
  const payload = {
    chat_id: chatId,
    text,
    allow_sending_without_reply: true,
    ...extra
  };

  if (replyTo) {
    payload.reply_parameters = {
      message_id: replyTo
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

async function answerCallbackQuery(callbackQueryId, text = "") {
  return tg("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text
  });
}

async function getRuntimeConfig() {
  try {
    const res = await fetch(
      `${AI_SERVER_BASE_URL}/runtime/config?secret=${encodeURIComponent(ADMIN_SECRET)}`
    );
    const data = await res.json();
    if (data?.ok) return data.config;
  } catch (error) {
    console.error("getRuntimeConfig error:", error.message);
  }

  return {
    quietMode: false,
    xWatcherEnabled: true,
    youtubeWatcherEnabled: true,
    buybotEnabled: true,
    buybotAlertMinUsd: 20,
    autoSelfTuning: true
  };
}

async function patchRuntimeConfig(patch) {
  const res = await fetch(`${AI_SERVER_BASE_URL}/runtime/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      secret: ADMIN_SECRET,
      patch
    })
  });

  const data = await res.json();
  if (!data?.ok) {
    throw new Error(data?.error || "runtime config update failed");
  }
  return data.config;
}

async function askAI({
  message,
  userId,
  userName,
  username,
  chatId,
  chatType,
  source = "telegram"
}) {
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message,
      userId: String(userId),
      userName,
      username,
      chatId: String(chatId),
      chatType,
      source
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`AI backend error: ${JSON.stringify(data)}`);
  }

  return data.reply || "🥺";
}

function isCARequest(text) {
  const lower = cleanLower(text);
  return lower === "ca" || lower.includes("contract") || lower.includes("контракт");
}

function isWebsiteRequest(text) {
  const lower = cleanLower(text);
  return lower === "website" || lower.includes("site") || lower.includes("сайт") || lower.includes("ссылка");
}

function buildCAKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Copy CA",
          copy_text: { text: TOKEN_CA }
        }
      ],
      [
        {
          text: "Website",
          url: "https://chiikawasol.com/"
        }
      ]
    ]
  };
}

function buildMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "CA", callback_data: "menu:ca" },
        { text: "Website", callback_data: "menu:website" }
      ],
      [
        { text: "Status", callback_data: "menu:status" },
        { text: "Admin", callback_data: "menu:admin" }
      ]
    ]
  };
}

function buildAdminKeyboard(config) {
  return {
    inline_keyboard: [
      [
        {
          text: config.quietMode ? "Quiet: ON" : "Quiet: OFF",
          callback_data: "admin:toggle_quiet"
        },
        {
          text: config.autoSelfTuning ? "Self-tuning: ON" : "Self-tuning: OFF",
          callback_data: "admin:toggle_self_tuning"
        }
      ],
      [
        {
          text: config.xWatcherEnabled ? "X watcher: ON" : "X watcher: OFF",
          callback_data: "admin:toggle_x"
        },
        {
          text: config.youtubeWatcherEnabled ? "YT watcher: ON" : "YT watcher: OFF",
          callback_data: "admin:toggle_youtube"
        }
      ],
      [
        {
          text: config.buybotEnabled ? "Buybot: ON" : "Buybot: OFF",
          callback_data: "admin:toggle_buybot"
        }
      ],
      [
        { text: "Buy min -10", callback_data: "admin:buymin_down_10" },
        { text: `Buy min ${config.buybotAlertMinUsd}$`, callback_data: "admin:noop" },
        { text: "Buy min +10", callback_data: "admin:buymin_up_10" }
      ]
    ]
  };
}

async function setTelegramCommands() {
  const commands = [
    { command: "start", description: "Start talking to Chiikawa" },
    { command: "help", description: "Show help" },
    { command: "menu", description: "Open menu" },
    { command: "admin", description: "Open admin panel" },
    { command: "status", description: "Show runtime status" },
    { command: "ca", description: "Show contract" },
    { command: "website", description: "Show website" }
  ];

  await tg("setMyCommands", { commands });

  await tg("setMyCommands", {
    commands,
    scope: { type: "all_private_chats" }
  });

  await tg("setMyCommands", {
    commands,
    scope: { type: "all_group_chats" }
  });

  await tg("setMyCommands", {
    commands,
    scope: {
      type: "chat",
      chat_id: FORCED_GROUP_CHAT_ID
    }
  });
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId) return;

  if (data === "menu:ca") {
    await answerCallbackQuery(callbackQuery.id, "Opening CA");
    await send(
      chatId,
      `CA
${TOKEN_CA}

Website
https://chiikawasol.com/`,
      messageId,
      { reply_markup: buildCAKeyboard() }
    );
    return;
  }

  if (data === "menu:website") {
    await answerCallbackQuery(callbackQuery.id, "Opening website");
    await send(chatId, "https://chiikawasol.com/", messageId);
    return;
  }

  if (data === "menu:status") {
    const cfg = await getRuntimeConfig();
    await answerCallbackQuery(callbackQuery.id, "Opening status");
    await send(
      chatId,
      `📊 Runtime status

quietMode: ${cfg.quietMode}
autoSelfTuning: ${cfg.autoSelfTuning}
xWatcherEnabled: ${cfg.xWatcherEnabled}
youtubeWatcherEnabled: ${cfg.youtubeWatcherEnabled}
buybotEnabled: ${cfg.buybotEnabled}
buybotAlertMinUsd: ${cfg.buybotAlertMinUsd}`,
      messageId
    );
    return;
  }

  if (data === "menu:admin") {
    if (!isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id, "Admins only");
      return;
    }
    const cfg = await getRuntimeConfig();
    await answerCallbackQuery(callbackQuery.id, "Opening admin");
    await send(
      chatId,
      `🛠 Admin Panel

quietMode: ${cfg.quietMode}
autoSelfTuning: ${cfg.autoSelfTuning}
xWatcherEnabled: ${cfg.xWatcherEnabled}
youtubeWatcherEnabled: ${cfg.youtubeWatcherEnabled}
buybotEnabled: ${cfg.buybotEnabled}
buybotAlertMinUsd: ${cfg.buybotAlertMinUsd}`,
      messageId,
      { reply_markup: buildAdminKeyboard(cfg) }
    );
    return;
  }

  if (!data.startsWith("admin:")) return;
  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, "Admins only");
    return;
  }

  try {
    const current = await getRuntimeConfig();

    if (data === "admin:toggle_quiet") {
      await patchRuntimeConfig({ quietMode: !current.quietMode });
    } else if (data === "admin:toggle_self_tuning") {
      await patchRuntimeConfig({ autoSelfTuning: !current.autoSelfTuning });
    } else if (data === "admin:toggle_x") {
      await patchRuntimeConfig({ xWatcherEnabled: !current.xWatcherEnabled });
    } else if (data === "admin:toggle_youtube") {
      await patchRuntimeConfig({ youtubeWatcherEnabled: !current.youtubeWatcherEnabled });
    } else if (data === "admin:toggle_buybot") {
      await patchRuntimeConfig({ buybotEnabled: !current.buybotEnabled });
    } else if (data === "admin:buymin_down_10") {
      await patchRuntimeConfig({
        buybotAlertMinUsd: Math.max(0, Number(current.buybotAlertMinUsd || 20) - 10)
      });
    } else if (data === "admin:buymin_up_10") {
      await patchRuntimeConfig({
        buybotAlertMinUsd: Number(current.buybotAlertMinUsd || 20) + 10
      });
    }

    const updated = await getRuntimeConfig();

    await answerCallbackQuery(callbackQuery.id, "Updated");
    await send(
      chatId,
      `🛠 Admin Panel

quietMode: ${updated.quietMode}
autoSelfTuning: ${updated.autoSelfTuning}
xWatcherEnabled: ${updated.xWatcherEnabled}
youtubeWatcherEnabled: ${updated.youtubeWatcherEnabled}
buybotEnabled: ${updated.buybotEnabled}
buybotAlertMinUsd: ${updated.buybotAlertMinUsd}`,
      messageId,
      { reply_markup: buildAdminKeyboard(updated) }
    );
  } catch (error) {
    console.error("Admin callback error:", error.message);
    await answerCallbackQuery(callbackQuery.id, "Update failed");
  }
}

async function handleMessage(msg) {
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = normalizeText(msg.text);
  const lower = cleanLower(text);
  const userId = msg.from.id;
  const userName = getDisplayName(msg.from);
  const username = msg.from?.username || "";
  const chatType = msg.chat?.type || "unknown";

  const traffic = countTraffic(chatId);
  const cfg = await getRuntimeConfig();

  if (text.startsWith("/start")) {
    const reply = await askAI({
      message: "Meet a new friend warmly.",
      userId,
      userName,
      username,
      chatId,
      chatType,
      source: "telegram"
    });

    await send(chatId, reply, msg.message_id, {
      reply_markup: buildMenuKeyboard()
    });
    markChatActive(chatId);
    return;
  }

  if (text.startsWith("/help")) {
    await send(
      chatId,
      `Commands:
/start
/help
/menu
/admin
/status
/ca
/website`,
      msg.message_id,
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  if (text.startsWith("/menu")) {
    await send(chatId, "✨ Chiikawa Menu ✨", msg.message_id, {
      reply_markup: buildMenuKeyboard()
    });
    return;
  }

  if (text.startsWith("/admin")) {
    if (!isAdmin(userId)) {
      await send(chatId, "Admins only 🥺", msg.message_id);
      return;
    }
    const current = await getRuntimeConfig();
    await send(
      chatId,
      `🛠 Admin Panel

quietMode: ${current.quietMode}
autoSelfTuning: ${current.autoSelfTuning}
xWatcherEnabled: ${current.xWatcherEnabled}
youtubeWatcherEnabled: ${current.youtubeWatcherEnabled}
buybotEnabled: ${current.buybotEnabled}
buybotAlertMinUsd: ${current.buybotAlertMinUsd}`,
      msg.message_id,
      { reply_markup: buildAdminKeyboard(current) }
    );
    return;
  }

  if (text.startsWith("/status")) {
    await send(
      chatId,
      `📊 Runtime status

quietMode: ${cfg.quietMode}
autoSelfTuning: ${cfg.autoSelfTuning}
xWatcherEnabled: ${cfg.xWatcherEnabled}
youtubeWatcherEnabled: ${cfg.youtubeWatcherEnabled}
buybotEnabled: ${cfg.buybotEnabled}
buybotAlertMinUsd: ${cfg.buybotAlertMinUsd}`,
      msg.message_id
    );
    return;
  }

  if (text.startsWith("/ca") || isCARequest(text)) {
    await send(
      chatId,
      `CA
${TOKEN_CA}

Website
https://chiikawasol.com/`,
      msg.message_id,
      { reply_markup: buildCAKeyboard() }
    );
    return;
  }

  if (text.startsWith("/website") || isWebsiteRequest(text)) {
    await send(chatId, "https://chiikawasol.com/", msg.message_id);
    return;
  }

  if (cfg.quietMode) {
    return;
  }

  if (isGroupChat(msg)) {
    markChatActive(chatId);
  }

  let shouldReply = false;

  if (isPrivateChat(msg)) shouldReply = true;
  if (mentionsBotUsername(text)) shouldReply = true;
  if (mentionsBotByName(text)) shouldReply = true;
  if (isReplyToBot(msg)) shouldReply = true;
  if (isChatActive(chatId)) shouldReply = true;

  if (!shouldReply) return;

  if (cfg.autoSelfTuning && isGroupChat(msg) && traffic > 18) {
    const directlyAddressed =
      mentionsBotUsername(text) ||
      mentionsBotByName(text) ||
      isReplyToBot(msg);

    if (!directlyAddressed) {
      return;
    }
  }

  if (Math.random() < 0.2) {
    await sendTyping(chatId);
  }
  await sendTyping(chatId);

  let prompt = `Telegram message from ${userName} in a ${chatType} chat: ${text}

Important:
- In a group, answer this specific user directly and clearly.
- No unnecessary repeated self-introductions.
`;

  const reply = await askAI({
    message: prompt,
    userId,
    userName,
    username,
    chatId,
    chatType,
    source: "telegram"
  });

  const finalReply = isGroupChat(msg) ? `${userName}, ${reply}` : reply;

  await send(chatId, finalReply, msg.message_id, {
    reply_markup: buildMenuKeyboard()
  });
}

async function bootstrap() {
  await tg("deleteWebhook", { drop_pending_updates: false });
  const me = await tg("getMe");
  botId = me.id;
  botUsername = me.username || null;
  await setTelegramCommands();
  console.log(`Telegram bot started as @${botUsername || "unknown"}`);
}

async function loop() {
  while (true) {
    try {
      const res = await tg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of res) {
        offset = update.update_id + 1;

        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }

        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (error) {
      console.error("Loop error:", error.message);
      await sleep(3000);
    }
  }
}

(async () => {
  try {
    await bootstrap();
    await loop();
  } catch (error) {
    console.error("Fatal telegram bot error:", error);
    process.exit(1);
  }
})();
