import fetch from "node-fetch";
import {
  getWebsiteUrl,
  getWebsiteInvite,
  getRandomCommunityNudge,
  shouldSendCommunityNudge,
  getRandomMission,
  shouldSendMission
} from "./community-engine.js";
import {
  analyzeModeration,
  escalateAction,
  getMuteDurationSeconds
} from "./moderation-engine.js";
import {
  getAvailableMoods,
  isMoodSupported,
  getTrackForMood,
  getRandomDJTrack,
  getPlaylistMessage,
  getSpinMessage,
  getRadioIntro,
  getMoodOfTheDay,
  buildMusicKeyboard
} from "./music-engine.js";
import { rememberInteraction } from "./memory-engine.js";
import { getAboutText } from "./personality-engine.js";
import {
  getTradingRuntime,
  buildTradingAdminKeyboard,
  handleTradingAdminCallback,
  handleTradingCommand,
  formatTradingStatus
} from "./trading-admin.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const AI_SERVER_BASE_URL =
  (CHIIKAWA_AI_URL || "").replace(/\/chat$/, "") || "https://chiikawa-ai.onrender.com";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const FORCED_GROUP_CHAT_ID = "-1003953010138";
const ADMIN_IDS = [617743971];
const TOKEN_CA = "2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu";

let offset = 0;
let botUsername = null;
let botId = null;
let botFirstName = "Chiikawa";

const ACTIVE_CONVERSATION_MS = 8 * 60 * 1000;
const greetedChats = new Set();
const userLastSeen = new Map();
const activeChatUntil = new Map();
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

  if (botFirstName) {
    triggers.push(botFirstName.toLowerCase());
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
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

async function setTelegramCommands() {
  const commands = [
    { command: "start", description: "Start talking to Chiikawa" },
    { command: "help", description: "Show help" },
    { command: "menu", description: "Open menu" },
    { command: "admin", description: "Open admin panel (private only)" },
    { command: "status", description: "Show runtime status" },
    { command: "trade_status", description: "Trading status (private only)" },
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
    scope: { type: "all_chat_administrators" }
  });

  await tg("setMyCommands", {
    commands,
    scope: {
      type: "chat",
      chat_id: FORCED_GROUP_CHAT_ID
    }
  });
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

async function answerCallbackQuery(callbackQueryId, text = "") {
  return tg("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text
  });
}

async function deleteTelegramMessage(chatId, messageId) {
  return tg("deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });
}

async function muteTelegramUser(chatId, userId, durationSeconds) {
  const untilDate = Math.floor(Date.now() / 1000) + durationSeconds;

  return tg("restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
      can_manage_topics: false
    },
    until_date: untilDate
  });
}

async function banTelegramUser(chatId, userId) {
  return tg("banChatMember", {
    chat_id: chatId,
    user_id: userId,
    revoke_messages: true
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

async function askChiikawa({
  message,
  userId = "anonymous",
  userName = "",
  username = "",
  chatId = "",
  chatType = "",
  source = "telegram"
}) {
  const res = await fetch(CHIIKAWA_AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message,
      userId,
      userName,
      username,
      chatId,
      chatType,
      source
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Chiikawa backend error: ${JSON.stringify(data)}`);
  }

  return data.reply || "Chiikawa got quiet... 🥺";
}

function isCARequest(text) {
  const lower = cleanLower(text);
  return (
    lower === "ca" ||
    lower === "ca?" ||
    lower.includes("contract") ||
    lower.includes("контракт")
  );
}

function isWebsiteRequest(text) {
  const lower = cleanLower(text);
  return (
    lower === "website" ||
    lower.includes("site") ||
    lower.includes("сайт") ||
    lower.includes("ссылка")
  );
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
          url: getWebsiteUrl()
        }
      ]
    ]
  };
}

function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "CA", callback_data: "menu:ca" },
        { text: "Website", callback_data: "menu:website" }
      ],
      [
        { text: "About", callback_data: "menu:about" },
        { text: "Community", callback_data: "menu:community" }
      ],
      [
        { text: "Mission", callback_data: "menu:mission" },
        { text: "Help", callback_data: "menu:help" }
      ],
      [
        { text: "DJ", callback_data: "music:dj" },
        { text: "Radio", callback_data: "music:radio" }
      ],
      [
        { text: "Playlist", callback_data: "menu:playlist" },
        { text: "Spin", callback_data: "music:spin" }
      ]
    ]
  };
}

function buildAdminKeyboard(config) {
  const trading = getTradingRuntime();

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
        {
          text: trading.enabled ? "Trading: ON" : "Trading: OFF",
          callback_data: "trade:toggle_enabled"
        },
        {
          text: trading.killSwitch ? "Kill switch: ON" : "Kill switch: OFF",
          callback_data: "trade:toggle_kill"
        }
      ],
      [
        {
          text: `Trade mode: ${trading.mode}`,
          callback_data: "trade:cycle_mode"
        }
      ],
      [
        {
          text: "Wallets",
          callback_data: "trade:show_wallets"
        },
        {
          text: "Trade status",
          callback_data: "trade:show_status"
        }
      ]
    ]
  };
}

async function sendMainMenu(chatId, replyToMessageId = null) {
  return sendTelegramMessage(
    chatId,
    `✨ Chiikawa Menu ✨

Choose what you want to explore:

• CA
• Website
• About
• Community
• Mission
• Music`,
    replyToMessageId,
    { reply_markup: buildMainMenuKeyboard() }
  );
}

async function sendAdminPanel(chatId, replyToMessageId = null) {
  const config = await getRuntimeConfig();
  const trading = getTradingRuntime();

  return sendTelegramMessage(
    chatId,
    `🛠 Admin Panel

quietMode: ${config.quietMode}
autoSelfTuning: ${config.autoSelfTuning}
xWatcherEnabled: ${config.xWatcherEnabled}
youtubeWatcherEnabled: ${config.youtubeWatcherEnabled}
buybotEnabled: ${config.buybotEnabled}
buybotAlertMinUsd: ${config.buybotAlertMinUsd}

tradingEnabled: ${trading.enabled}
tradeMode: ${trading.mode}
killSwitch: ${trading.killSwitch}`,
    replyToMessageId,
    { reply_markup: buildAdminKeyboard(config) }
  );
}

function shouldRespond(message) {
  const text = normalizeText(message.text);
  if (!text) return false;

  if (text.startsWith("/start")) return true;
  if (text.startsWith("/help")) return true;
  if (text.startsWith("/menu")) return true;
  if (text.startsWith("/admin")) return true;
  if (text.startsWith("/status")) return true;
  if (text.startsWith("/trade_status")) return true;
  if (text.startsWith("/trade_mode")) return true;
  if (text.startsWith("/watch_wallet")) return true;
  if (text.startsWith("/unwatch_wallet")) return true;
  if (text.startsWith("/wallets")) return true;
  if (text.startsWith("/wallet_score")) return true;
  if (text.startsWith("/kill_switch")) return true;
  if (text.startsWith("/trading_on")) return true;
  if (text.startsWith("/trading_off")) return true;
  if (text.startsWith("/setbuy")) return true;
  if (text.startsWith("/ca")) return true;
  if (text.startsWith("/website")) return true;

  if (isCARequest(text)) return true;
  if (isWebsiteRequest(text)) return true;

  if (isPrivateChat(message)) return true;
  if (mentionsBotUsername(text)) return true;
  if (mentionsBotByName(text)) return true;
  if (isReplyToBot(message)) return true;
  if (message.chat?.id && isChatActive(message.chat.id)) return true;

  return false;
}

async function maybeRejectTradingCommandInGroup(message) {
  const text = normalizeText(message.text);
  if (!text.startsWith("/")) return false;

  const lower = cleanLower(text);
  const tradingPrefixes = [
    "/watch_wallet",
    "/unwatch_wallet",
    "/wallets",
    "/wallet_score",
    "/trade_status",
    "/trade_mode",
    "/kill_switch",
    "/trading_on",
    "/trading_off",
    "/setbuy"
  ];

  if (!tradingPrefixes.some(cmd => lower.startsWith(cmd))) {
    return false;
  }

  if (isPrivateChat(message)) {
    return false;
  }

  await sendTelegramMessage(
    message.chat.id,
    "Trading tools are available only in private chat with the bot.",
    message.message_id
  );
  return true;
}

async function handleAdminAndTradingCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId) return false;
  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } }) && data.startsWith("trade:")) {
    await answerCallbackQuery(callbackQuery.id, "Private chat only");
    return true;
  }

  if (data.startsWith("trade:")) {
    if (!isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id, "Admins only");
      return true;
    }

    const result = handleTradingAdminCallback(data);
    if (!result.ok) {
      await answerCallbackQuery(callbackQuery.id, "Failed");
      return true;
    }

    await answerCallbackQuery(callbackQuery.id, "Updated");
    const config = await getRuntimeConfig();

    await sendTelegramMessage(
      chatId,
      result.message,
      messageId,
      { reply_markup: buildAdminKeyboard(config) }
    );

    return true;
  }

  if (!data.startsWith("admin:")) {
    return false;
  }

  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, "Admins only");
    return true;
  }

  // Public runtime admin kept private-only as well
  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, "Private chat only");
    return true;
  }

  try {
    const current = await getRuntimeConfig();
    let nextPatch = null;

    if (data === "admin:toggle_quiet") {
      nextPatch = { quietMode: !current.quietMode };
    } else if (data === "admin:toggle_self_tuning") {
      nextPatch = { autoSelfTuning: !current.autoSelfTuning };
    } else if (data === "admin:toggle_x") {
      nextPatch = { xWatcherEnabled: !current.xWatcherEnabled };
    } else if (data === "admin:toggle_youtube") {
      nextPatch = { youtubeWatcherEnabled: !current.youtubeWatcherEnabled };
    } else if (data === "admin:toggle_buybot") {
      nextPatch = { buybotEnabled: !current.buybotEnabled };
    }

    if (nextPatch) {
      const res = await fetch(`${AI_SERVER_BASE_URL}/runtime/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: ADMIN_SECRET,
          patch: nextPatch
        })
      });
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || "runtime update failed");
    }

    await answerCallbackQuery(callbackQuery.id, "Updated");
    await sendAdminPanel(chatId, messageId);
    return true;
  } catch (error) {
    console.error("Admin callback error:", error.message);
    await answerCallbackQuery(callbackQuery.id, "Update failed");
    return true;
  }
}

async function handleCommand(message) {
  const text = normalizeText(message.text);
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "anonymous");
  const messageId = message.message_id;
  const userName = getDisplayName(message.from);
  const username = message.from?.username || "";

  // trading/private only commands
  const privateOnlyTradingCommands = [
    "/watch_wallet",
    "/unwatch_wallet",
    "/wallets",
    "/wallet_score",
    "/trade_status",
    "/trade_mode",
    "/kill_switch",
    "/trading_on",
    "/trading_off",
    "/setbuy"
  ];

  if (privateOnlyTradingCommands.some(cmd => cleanLower(text).startsWith(cmd))) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(
        chatId,
        "Trading tools are available only in private chat with the bot.",
        messageId
      );
      return true;
    }

    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, "Admins only 🥺", messageId);
      return true;
    }

    const result = handleTradingCommand(text, userName);
    await sendTelegramMessage(
      chatId,
      result.ok ? result.message : result.error,
      messageId,
      { reply_markup: buildTradingAdminKeyboard(getTradingRuntime()) }
    );
    return true;
  }

  if (text.startsWith("/start")) {
    const reply = await askChiikawa({
      message: "Meet a new friend warmly.",
      userId,
      userName,
      username,
      chatId: String(chatId),
      chatType: message.chat?.type || "",
      source: "telegram"
    });

    greetedChats.add(chatId);
    markChatActive(chatId);

    await sendTelegramMessage(chatId, reply, messageId, {
      reply_markup: buildMainMenuKeyboard()
    });
    return true;
  }

  if (text.startsWith("/help")) {
    await sendTelegramMessage(
      chatId,
      `Commands:
/start
/help
/menu
/admin
/status
/ca
/website`,
      messageId,
      { reply_markup: buildMainMenuKeyboard() }
    );
    return true;
  }

  if (text.startsWith("/menu")) {
    await sendMainMenu(chatId, messageId);
    return true;
  }

  if (text.startsWith("/admin")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(
        chatId,
        "Admin panel is available only in private chat with the bot.",
        messageId
      );
      return true;
    }

    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, "Admins only 🥺", messageId);
      return true;
    }

    await sendAdminPanel(chatId, messageId);
    return true;
  }

  if (text.startsWith("/status")) {
    const cfg = await getRuntimeConfig();
    const trading = getTradingRuntime();

    await sendTelegramMessage(
      chatId,
      `📊 Runtime status

quietMode: ${cfg.quietMode}
autoSelfTuning: ${cfg.autoSelfTuning}
xWatcherEnabled: ${cfg.xWatcherEnabled}
youtubeWatcherEnabled: ${cfg.youtubeWatcherEnabled}
buybotEnabled: ${cfg.buybotEnabled}
buybotAlertMinUsd: ${cfg.buybotAlertMinUsd}

tradingEnabled: ${trading.enabled}
tradeMode: ${trading.mode}
killSwitch: ${trading.killSwitch}`,
      messageId
    );
    return true;
  }

  if (text.startsWith("/ca") || isCARequest(text)) {
    await sendTelegramMessage(
      chatId,
      `CA
${TOKEN_CA}

Website
${getWebsiteUrl()}`,
      messageId,
      { reply_markup: buildCAKeyboard() }
    );
    return true;
  }

  if (text.startsWith("/website") || isWebsiteRequest(text)) {
    await sendTelegramMessage(chatId, getWebsiteInvite(), messageId, {
      reply_markup: buildMainMenuKeyboard()
    });
    return true;
  }

  return false;
}

async function maybeSendGreeting(message) {
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "anonymous");
  const userName = getDisplayName(message.from);
  const username = message.from?.username || "";

  if (!greetedChats.has(chatId)) {
    const greeting = await askChiikawa({
      message: "Meet a new friend warmly.",
      userId,
      userName,
      username,
      chatId: String(chatId),
      chatType: message.chat?.type || "",
      source: "telegram"
    });

    greetedChats.add(chatId);
    markChatActive(chatId);
    await sendTelegramMessage(chatId, greeting, message.message_id);
  }
}

function addressReplyForGroup(message, reply) {
  if (!isGroupChat(message)) return reply;
  const name = getDisplayName(message.from);
  return `${name}, ${reply}`;
}

async function moderateMessageIfNeeded(message) {
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const userId = message.from?.id;
  const text = normalizeText(message.text);

  if (!chatId || !messageId || !userId || !text) return false;
  if (isPrivateChat(message)) return false;

  if (text.startsWith("/")) return false;

  const analysis = analyzeModeration(text);
  if (analysis.action === "none") return false;

  const escalation = escalateAction(userId, analysis.action, analysis.reason);

  try {
    await deleteTelegramMessage(chatId, messageId);
  } catch (err) {
    console.error("Failed to delete suspicious message:", err);
  }

  if (escalation.finalAction === "ban") {
    try {
      await banTelegramUser(chatId, userId);
      await sendTelegramMessage(
        chatId,
        `A suspicious spam/scam account was removed.
Reason: ${analysis.reason}`,
        messageId
      );
    } catch (err) {
      console.error("Failed to ban user:", err);
    }
    return true;
  }

  if (escalation.finalAction === "mute") {
    const muteSeconds = getMuteDurationSeconds(escalation.state.strikes - 1);

    try {
      await muteTelegramUser(chatId, userId, muteSeconds);
      await sendTelegramMessage(
        chatId,
        `A suspicious promotional message was removed.
The user has been muted temporarily.
Reason: ${analysis.reason}`,
        messageId
      );
    } catch (err) {
      console.error("Failed to mute user:", err);
    }
    return true;
  }

  return false;
}

async function handleRegularMessage(message) {
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "anonymous");
  const messageId = message.message_id;
  const text = normalizeText(message.text);
  const userName = getDisplayName(message.from);
  const username = message.from?.username || "";

  if (!text || !shouldRespond(message)) return;

  const runtimeConfig = await getRuntimeConfig();
  const traffic = countTraffic(chatId);

  rememberInteraction({
    userId,
    displayName: userName,
    username,
    chatId: String(chatId),
    chatType: message.chat?.type || "",
    text
  });

  if (runtimeConfig.quietMode) return;

  if (runtimeConfig.autoSelfTuning && isGroupChat(message) && traffic > 18) {
    const directlyAddressed =
      mentionsBotUsername(text) ||
      mentionsBotByName(text) ||
      isReplyToBot(message);

    if (!directlyAddressed) return;
  }

  await maybeSendGreeting(message);

  if (Math.random() < 0.2) {
    await sendTyping(chatId);
  }
  await sendTyping(chatId);

  markChatActive(chatId);

  let prompt = `Telegram message from ${userName} in a ${message.chat?.type || "unknown"} chat: ${text}

Important:
- In a group, answer this specific user directly and clearly.
- No unnecessary repeated self-introductions.
`;

  if (!isPrivateChat(message) && isChatActive(chatId)) {
    prompt += `
The group conversation with you is currently active. Treat this as a direct continuation of dialogue with this same user when appropriate.`;
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

  const reply = await askChiikawa({
    message: prompt,
    userId,
    userName,
    username,
    chatId: String(chatId),
    chatType: message.chat?.type || "",
    source: "telegram"
  });

  await sendTelegramMessage(
    chatId,
    addressReplyForGroup(message, reply),
    messageId,
    { reply_markup: buildMainMenuKeyboard() }
  );
}

async function handleMessage(message) {
  if (!message || message.text == null) return;

  try {
    const tradingRejectedInGroup = await maybeRejectTradingCommandInGroup(message);
    if (tradingRejectedInGroup) return;

    const moderated = await moderateMessageIfNeeded(message);
    if (moderated) return;

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
    if (code !== 404) throw error;
  }

  const me = await tg("getMe");
  botUsername = me.username || null;
  botId = me.id || null;
  botFirstName = me.first_name || "Chiikawa";

  await setTelegramCommands();

  console.log(`Telegram bot started as @${botUsername || "unknown_bot"}`);
  console.log(`Using backend: ${CHIIKAWA_AI_URL}`);
  console.log(`Website: ${getWebsiteUrl()}`);
  console.log(`Bot first name: ${botFirstName}`);
  console.log(`Forced group scope: ${FORCED_GROUP_CHAT_ID}`);
}

async function pollLoop() {
  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.callback_query) {
          const handledAdmin = await handleAdminAndTradingCallback(update.callback_query);
          if (!handledAdmin) {
            // existing menu/music callbacks can be added back here if needed
          }
        }

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
