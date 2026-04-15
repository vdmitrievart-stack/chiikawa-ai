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
import { getMoodState, buildMoodContext } from "./mood-engine.js";
import {
  rememberInteraction,
  buildMemoryContext
} from "./memory-engine.js";
import { getAboutText } from "./personality-engine.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const FORCED_GROUP_CHAT_ID = "-1003953010138";

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

async function setTelegramCommands() {
  const commands = [
    { command: "start", description: "Start talking to Chiikawa" },
    { command: "help", description: "Show all available commands" },
    { command: "menu", description: "Open the Chiikawa menu" },
    { command: "ca", description: "Show token contract address" },
    { command: "website", description: "Open the official website" },
    { command: "mission", description: "Get a tiny community mission" },
    { command: "about", description: "Learn who Chiikawa is" },
    { command: "community", description: "See the community spirit" },
    { command: "playlist", description: "Show music moods and playlists" },
    { command: "dj", description: "Get a random Chiikawa track" },
    { command: "spin", description: "Spin the tiny DJ wheel" },
    { command: "radio", description: "Play Chiikawa radio mood of the day" },
    { command: "mood", description: "Pick a music mood" }
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

  await tg("setMyCommands", {
    commands,
    scope: {
      type: "chat_administrators",
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

async function askChiikawa({
  message,
  sessionId,
  mode = "chat",
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
      sessionId,
      mode,
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

function buildSessionId(chatId, userId) {
  return `telegram_${chatId}_${userId || "anon"}`;
}

function isPrivateChat(message) {
  return message.chat?.type === "private";
}

function isGroupChat(message) {
  const type = message.chat?.type;
  return type === "group" || type === "supergroup";
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

function buildMenuText() {
  return `✨ Chiikawa Menu ✨

Choose what you want to explore:

• CA
• Website
• About
• Community
• Mission
• Music

You can also use /help to see all commands 🥺`;
}

async function sendMainMenu(chatId, replyToMessageId = null) {
  return sendTelegramMessage(chatId, buildMenuText(), replyToMessageId, {
    reply_markup: buildMainMenuKeyboard()
  });
}

async function sendCAMessage(chatId, replyToMessageId = null) {
  return sendTelegramMessage(chatId, buildCAMessage(), replyToMessageId, {
    reply_markup: buildCAKeyboard()
  });
}

function isSimpleGreeting(text) {
  const lower = cleanLower(text);
  return [
    "hi",
    "hello",
    "hey",
    "gm",
    "gn",
    "yo",
    "sup",
    "привет",
    "хай",
    "здравствуй",
    "здравствуйте",
    "доброе утро",
    "добрый вечер"
  ].includes(lower);
}

function isThanksMessage(text) {
  const lower = cleanLower(text);
  return (
    lower.includes("thank") ||
    lower.includes("thanks") ||
    lower.includes("thx") ||
    lower.includes("спасибо") ||
    lower.includes("благодарю") ||
    lower.includes("good bot") ||
    lower.includes("nice bot") ||
    lower.includes("умница")
  );
}

function parseMoodCommand(text) {
  const lower = cleanLower(text);
  if (!lower.startsWith("/mood")) return null;
  const parts = lower.split(/\s+/);
  return parts[1] || null;
}

function shouldRespond(message) {
  const text = normalizeText(message.text);
  if (!text) return false;

  if (text.startsWith("/start")) return true;
  if (text.startsWith("/help")) return true;
  if (text.startsWith("/menu")) return true;
  if (text.startsWith("/ca")) return true;
  if (text.startsWith("/mood")) return true;
  if (text.startsWith("/website")) return true;
  if (text.startsWith("/mission")) return true;
  if (text.startsWith("/about")) return true;
  if (text.startsWith("/community")) return true;
  if (text.startsWith("/dj")) return true;
  if (text.startsWith("/playlist")) return true;
  if (text.startsWith("/spin")) return true;
  if (text.startsWith("/radio")) return true;

  if (isCARequest(text)) return true;
  if (isWebsiteRequest(text)) return true;

  if (isPrivateChat(message)) return true;
  if (mentionsBotUsername(text)) return true;
  if (mentionsBotByName(text)) return true;
  if (isReplyToBot(message)) return true;
  if (message.chat?.id && isChatActive(message.chat.id)) return true;

  return false;
}

async function moderateMessageIfNeeded(message) {
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const userId = message.from?.id;
  const text = normalizeText(message.text);

  if (!chatId || !messageId || !userId || !text) return false;
  if (isPrivateChat(message)) return false;

  if (
    text.startsWith("/start") ||
    text.startsWith("/help") ||
    text.startsWith("/menu") ||
    text.startsWith("/ca") ||
    text.startsWith("/website") ||
    text.startsWith("/mission") ||
    text.startsWith("/about") ||
    text.startsWith("/community") ||
    text.startsWith("/mood") ||
    text.startsWith("/dj") ||
    text.startsWith("/playlist") ||
    text.startsWith("/spin") ||
    text.startsWith("/radio")
  ) {
    return false;
  }

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

async function handleMenuCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (!chatId) return false;

  if (data === "menu:ca") {
    await answerCallbackQuery(callbackQuery.id, "Opening CA");
    await sendCAMessage(chatId, messageId);
    return true;
  }

  if (data === "menu:website") {
    await answerCallbackQuery(callbackQuery.id, "Opening website");
    await sendTelegramMessage(chatId, getWebsiteInvite(), messageId);
    return true;
  }

  if (data === "menu:about") {
    await answerCallbackQuery(callbackQuery.id, "About Chiikawa");
    await sendTelegramMessage(chatId, getAboutText(), messageId);
    return true;
  }

  if (data === "menu:community") {
    await answerCallbackQuery(callbackQuery.id, "Community spirit");
    await sendTelegramMessage(
      chatId,
      `The heart of Chiikawa is friendship, kindness, and community 🌸

Please stay human, protect your people, and help us find new friends in Telegram and X ✨`,
      messageId
    );
    return true;
  }

  if (data === "menu:mission") {
    await answerCallbackQuery(callbackQuery.id, "Tiny mission");
    await sendTelegramMessage(chatId, getRandomMission(), messageId);
    return true;
  }

  if (data === "menu:help") {
    const moods = getAvailableMoods().join(", ");
    await answerCallbackQuery(callbackQuery.id, "Opening help");
    await sendTelegramMessage(
      chatId,
      `Hi ✨ I’m Chiikawa.

Commands:
/start
/help
/menu
/ca
/website
/mission
/about
/community
/dj
/playlist
/spin
/radio
/mood <${moods}>`,
      messageId,
      { reply_markup: buildMainMenuKeyboard() }
    );
    return true;
  }

  if (data === "menu:playlist") {
    await answerCallbackQuery(callbackQuery.id, "Opening playlist");
    await sendTelegramMessage(chatId, getPlaylistMessage(), messageId, {
      reply_markup: buildMusicKeyboard()
    });
    return true;
  }

  return false;
}

async function handleMusicCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (!chatId) return false;

  if (data === "music:dj") {
    const result = getRandomDJTrack();
    await answerCallbackQuery(callbackQuery.id, "Tiny DJ picked something ✨");
    await sendTelegramMessage(chatId, result.message, messageId);
    return true;
  }

  if (data === "music:radio") {
    const intro = getRadioIntro();
    const dayTrack = getMoodOfTheDay();
    await answerCallbackQuery(callbackQuery.id, "Chiikawa Radio is on 🎧");
    await sendTelegramMessage(
      chatId,
      `${intro}

Mood of the day:
${dayTrack.message}`,
      messageId
    );
    return true;
  }

  if (data === "music:spin") {
    const intro = getSpinMessage();
    const result = getRandomDJTrack();
    await answerCallbackQuery(callbackQuery.id, "Spinning...");
    await sendTelegramMessage(
      chatId,
      `${intro}

${result.message}`,
      messageId
    );
    return true;
  }

  if (data.startsWith("music:mood:")) {
    const mood = data.split(":")[2];
    if (isMoodSupported(mood)) {
      const result = getTrackForMood(mood);
      await answerCallbackQuery(callbackQuery.id, `Mood: ${mood}`);
      await sendTelegramMessage(chatId, result.message, messageId);
      return true;
    }
  }

  return false;
}

async function handleCommand(message) {
  const text = normalizeText(message.text);
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "anonymous");
  const messageId = message.message_id;
  const sessionId = buildSessionId(chatId, userId);
  const userName = getDisplayName(message.from);
  const username = message.from?.username || "";

  if (text.startsWith("/start")) {
    const reply = await askChiikawa({
      message: "Meet a new friend warmly.",
      sessionId,
      mode: "greeting",
      userId,
      userName,
      username,
      chatId: String(chatId),
      chatType: message.chat?.type || "",
      source: "telegram"
    });
    greetedChats.add(chatId);
    markChatActive(chatId);
    await sendTelegramMessage(chatId, reply, messageId);
    return true;
  }

  if (text.startsWith("/help")) {
    const moods = getAvailableMoods().join(", ");

    await sendTelegramMessage(
      chatId,
      `Hi ✨ I’m Chiikawa.

Commands:
/start
/help
/menu
/ca
/website
/mission
/about
/community
/dj
/playlist
/spin
/radio
/mood <${moods}>

You can also just talk to me normally 🥺
You can call me by name too, not only with @mention.`,
      messageId,
      { reply_markup: buildMainMenuKeyboard() }
    );
    return true;
  }

  if (text.startsWith("/menu")) {
    await sendMainMenu(chatId, messageId);
    return true;
  }

  if (text.startsWith("/about")) {
    await sendTelegramMessage(
      chatId,
      getAboutText(),
      messageId,
      { reply_markup: buildMainMenuKeyboard() }
    );
    return true;
  }

  if (text.startsWith("/community")) {
    await sendTelegramMessage(
      chatId,
      `The heart of Chiikawa is friendship, kindness, and community 🌸

Please stay human, protect your people, and help us find new friends in Telegram and X ✨`,
      messageId,
      { reply_markup: buildMainMenuKeyboard() }
    );
    return true;
  }

  if (text.startsWith("/ca")) {
    await sendCAMessage(chatId, messageId);
    return true;
  }

  if (text.startsWith("/website")) {
    await sendTelegramMessage(chatId, getWebsiteInvite(), messageId, {
      reply_markup: buildMainMenuKeyboard()
    });
    return true;
  }

  if (text.startsWith("/mission")) {
    await sendTelegramMessage(chatId, getRandomMission(), messageId, {
      reply_markup: buildMainMenuKeyboard()
    });
    return true;
  }

  if (text.startsWith("/playlist")) {
    await sendTelegramMessage(chatId, getPlaylistMessage(), messageId, {
      reply_markup: buildMusicKeyboard()
    });
    return true;
  }

  if (text.startsWith("/spin")) {
    const intro = getSpinMessage();
    const result = getRandomDJTrack();
    await sendTelegramMessage(
      chatId,
      `${intro}

${result.message}`,
      messageId,
      { reply_markup: buildMusicKeyboard() }
    );
    return true;
  }

  if (text.startsWith("/radio")) {
    const intro = getRadioIntro();
    const dayTrack = getMoodOfTheDay();
    await sendTelegramMessage(
      chatId,
      `${intro}

Mood of the day:
${dayTrack.message}`,
      messageId,
      { reply_markup: buildMusicKeyboard() }
    );
    return true;
  }

  if (text.startsWith("/dj")) {
    const result = getRandomDJTrack();
    await sendTelegramMessage(chatId, result.message, messageId, {
      reply_markup: buildMusicKeyboard()
    });
    return true;
  }

  if (text.startsWith("/mood")) {
    const mood = parseMoodCommand(text);

    if (mood && isMoodSupported(mood)) {
      const result = getTrackForMood(mood);
      await sendTelegramMessage(chatId, result.message, messageId, {
        reply_markup: buildMusicKeyboard()
      });
      return true;
    }

    if (mood && !isMoodSupported(mood)) {
      await sendTelegramMessage(
        chatId,
        `I don’t know that mood yet 🥺

Try:
${getAvailableMoods().map(x => `/mood ${x}`).join("\n")}`,
        messageId,
        { reply_markup: buildMusicKeyboard() }
      );
      return true;
    }

    await sendTelegramMessage(chatId, "Try /mood happy or /mood chill ✨", messageId, {
      reply_markup: buildMusicKeyboard()
    });
    return true;
  }

  return false;
}

async function maybeSendGreeting(message) {
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "anonymous");
  const sessionId = buildSessionId(chatId, userId);
  const userName = getDisplayName(message.from);
  const username = message.from?.username || "";

  if (!greetedChats.has(chatId)) {
    const greeting = await askChiikawa({
      message: "Meet a new friend warmly.",
      sessionId,
      mode: "greeting",
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

async function handleRegularMessage(message) {
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "anonymous");
  const messageId = message.message_id;
  const text = normalizeText(message.text);
  const sessionId = buildSessionId(chatId, userId);
  const userName = getDisplayName(message.from);
  const username = message.from?.username || "";

  if (!text || !shouldRespond(message)) return;

  rememberInteraction({
    userId,
    displayName: userName,
    username,
    chatId: String(chatId),
    chatType: message.chat?.type || "",
    text
  });

  if (isCARequest(text)) {
    markChatActive(chatId);
    await sendCAMessage(chatId, messageId);
    return;
  }

  if (isWebsiteRequest(text)) {
    markChatActive(chatId);
    await sendTelegramMessage(chatId, getWebsiteInvite(), messageId, {
      reply_markup: buildMainMenuKeyboard()
    });
    return;
  }

  if (isThanksMessage(text)) {
    markChatActive(chatId);
    await sendTelegramMessage(
      chatId,
      addressReplyForGroup(message, "Hehe… I’m happy I could help 🥺✨"),
      messageId
    );
    return;
  }

  if (isSimpleGreeting(text)) {
    markChatActive(chatId);
    await sendTelegramMessage(
      chatId,
      addressReplyForGroup(message, "Hi… I’m here 🥺✨"),
      messageId,
      { reply_markup: buildMainMenuKeyboard() }
    );
    return;
  }

  await maybeSendGreeting(message);

  if (Math.random() < 0.15) {
    await sendTyping(chatId);
  }
  await sendTyping(chatId);

  markChatActive(chatId);

  const moodState = getMoodState({
    source: "chat",
    signal: "normal",
    text,
    now: new Date()
  });
  const moodContext = buildMoodContext(moodState);
  const memoryContext = buildMemoryContext(userId);

  let prompt = maybeAddTelegramPrefix(text, message.from, message);

  if (!isPrivateChat(message) && isChatActive(chatId)) {
    prompt += `
The group conversation with you is currently active. Treat this as a direct continuation of dialogue with this same user when appropriate.`;
  }

  if (shouldSendSoftCheckIn(userId)) {
    prompt += `
You may gently continue the conversation with one soft, engaging follow-up question.`;
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

  prompt += `

${memoryContext}

${moodContext}

Important:
- In a group, answer this specific user directly and clearly.
- No unnecessary repeated self-introductions.
`;

  const reply = await askChiikawa({
    message: prompt,
    sessionId,
    mode: "chat",
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
          const handledMenu = await handleMenuCallback(update.callback_query);
          if (!handledMenu) {
            await handleMusicCallback(update.callback_query);
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
