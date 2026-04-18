import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import {
  initTradingAdmin,
  getTradingRuntime,
  getLevel6Runtime,
  handleTradingAdminCallback,
  handleTradingCommand,
  formatTradingStatus,
  getLevel6Summary,
  getLevel6OpenTrades
} from "./trading-admin.js";
import {
  level6t,
  buildLevel6PanelKeyboard,
  formatLevel6OpenTrades
} from "./Level6PanelI18n.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const ADMIN_IDS = [617743971];
const TOKEN_CA = "2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu";
const WEBSITE_URL = "https://chiikawasol.com/";
const LANG_FILE = path.resolve("./bot-language-settings.json");

let offset = 0;
let botUsername = null;
let botId = null;

const DEFAULT_LANG = "en";

const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "tr", label: "Türkçe" },
  { code: "ar", label: "العربية" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" }
];

const I18N = {
  en: {
    commands_help: `Commands:
/start
/help
/menu
/admin
/tradepanel
/status
/trade_status
/language
/ca
/website
/level6_status
/level6_open_trades
/level6_dryrun_on
/level6_dryrun_off`,
    menu_title: `✨ Chiikawa Menu ✨

Choose what you want to explore:

• CA
• Website
• Status`,
    trading_panel_title: (trading, level6) => `🎛 Trading Panel

enabled: ${trading.enabled}
mode: ${trading.mode}
killSwitch: ${trading.killSwitch}
buybotAlertMinUsd: ${trading.buybotAlertMinUsd}
trackedWallets: ${trading.trackedWallets.length}
autoCopyEnabled: ${trading.autoCopyEnabled}
level5DryRun: ${trading.level5DryRun}

🧠 Level 6
enabled: ${level6.enabled}
dryRun: ${level6.dryRun}
autoEntries: ${level6.autoEntries}
autoExits: ${level6.autoExits}
openTrades: ${level6.openTrades}
journalTrades: ${level6.journalTrades}`,
    private_only_trading: "Trading tools are available only in private chat with the bot.",
    private_only_admin: "Admin panel is available only in private chat with the bot.",
    private_only_tradepanel: "Trading panel is available only in private chat with the bot.",
    admins_only: "Admins only 🥺",
    stumble: "Chiikawa stumbled a little... 🥺 Please try again.",
    language_prompt: "🌐 Choose your language:",
    language_set: label => `Language set to: ${label}`,
    btn_ca: "CA",
    btn_website: "Website",
    btn_status: "Status",
    btn_admin: "Admin",
    btn_trading: "🎛 Trading",
    btn_language: "🌐 Language",
    btn_trade_status: "📊 Trade Status",
    btn_wallets: "👛 Wallets",
    btn_level6_panel: "🧠 Level 6",
    btn_level6_status: "📊 Level 6 Status",
    btn_close: "❎ Close"
  },
  ru: {
    commands_help: `Команды:
/start
/help
/menu
/admin
/tradepanel
/status
/trade_status
/language
/ca
/website
/level6_status
/level6_open_trades
/level6_dryrun_on
/level6_dryrun_off`,
    menu_title: `✨ Меню Chiikawa ✨

Выбери, что открыть:

• CA
• Сайт
• Статус`,
    trading_panel_title: (trading, level6) => `🎛 Торговая панель

enabled: ${trading.enabled}
mode: ${trading.mode}
killSwitch: ${trading.killSwitch}
buybotAlertMinUsd: ${trading.buybotAlertMinUsd}
trackedWallets: ${trading.trackedWallets.length}
autoCopyEnabled: ${trading.autoCopyEnabled}
level5DryRun: ${trading.level5DryRun}

🧠 Level 6
enabled: ${level6.enabled}
dryRun: ${level6.dryRun}
autoEntries: ${level6.autoEntries}
autoExits: ${level6.autoExits}
openTrades: ${level6.openTrades}
journalTrades: ${level6.journalTrades}`,
    private_only_trading: "Торговые инструменты доступны только в личном чате с ботом.",
    private_only_admin: "Админ-панель доступна только в личном чате с ботом.",
    private_only_tradepanel: "Торговая панель доступна только в личном чате с ботом.",
    admins_only: "Только для админов 🥺",
    stumble: "Chiikawa немного споткнулся... 🥺 Попробуй ещё раз.",
    language_prompt: "🌐 Выбери язык:",
    language_set: label => `Язык установлен: ${label}`,
    btn_ca: "CA",
    btn_website: "Сайт",
    btn_status: "Статус",
    btn_admin: "Админ",
    btn_trading: "🎛 Торговля",
    btn_language: "🌐 Язык",
    btn_trade_status: "📊 Статус трейда",
    btn_wallets: "👛 Кошельки",
    btn_level6_panel: "🧠 Level 6",
    btn_level6_status: "📊 Статус Level 6",
    btn_close: "❎ Закрыть"
  }
};

function loadLangState() {
  try {
    if (!fs.existsSync(LANG_FILE)) return { users: {} };
    const raw = fs.readFileSync(LANG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { users: parsed?.users || {} };
  } catch {
    return { users: {} };
  }
}

const langState = loadLangState();

function saveLangState() {
  fs.writeFileSync(LANG_FILE, JSON.stringify(langState, null, 2), "utf8");
}

function setUserLanguage(userId, langCode) {
  langState.users[String(userId)] = langCode;
  saveLangState();
}

function getUserLanguage(userId) {
  return langState.users[String(userId)] || DEFAULT_LANG;
}

function t(userId, key, ...args) {
  const lang = getUserLanguage(userId);
  const dict = I18N[lang] || I18N.en;
  const fallback = I18N.en[key];
  const value = dict[key] ?? fallback;
  if (typeof value === "function") return value(...args);
  return value;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function cleanLower(value) {
  return normalizeText(value).toLowerCase();
}

function isPrivateChat(message) {
  return message?.chat?.type === "private";
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function buildLanguageKeyboard() {
  const rows = [];
  for (let i = 0; i < SUPPORTED_LANGUAGES.length; i += 2) {
    rows.push(
      SUPPORTED_LANGUAGES.slice(i, i + 2).map(lang => ({
        text: lang.label,
        callback_data: `lang:set:${lang.code}`
      }))
    );
  }
  return { inline_keyboard: rows };
}

function buildMainMenuKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        { text: t(userId, "btn_ca"), callback_data: "menu:ca" },
        { text: t(userId, "btn_website"), callback_data: "menu:website" }
      ],
      [
        { text: t(userId, "btn_status"), callback_data: "menu:status" },
        { text: t(userId, "btn_admin"), callback_data: "menu:admin" }
      ],
      [
        { text: t(userId, "btn_trading"), callback_data: "tradepanel:open" },
        { text: t(userId, "btn_language"), callback_data: "lang:open" }
      ]
    ]
  };
}

function buildTradingPanelKeyboard(userId) {
  const trading = getTradingRuntime();

  return {
    inline_keyboard: [
      [
        { text: t(userId, "btn_trade_status"), callback_data: "trade:show_status" },
        { text: t(userId, "btn_wallets"), callback_data: "trade:show_wallets" }
      ],
      [
        {
          text: trading.enabled ? "⚙️ Trading ON" : "⚙️ Trading OFF",
          callback_data: "trade:toggle_enabled"
        },
        {
          text: trading.killSwitch ? "🛑 Kill ON" : "🛑 Kill OFF",
          callback_data: "trade:toggle_kill"
        }
      ],
      [
        {
          text: `🔁 Mode: ${trading.mode}`,
          callback_data: "trade:cycle_mode"
        },
        {
          text: `💰 Buy Min: $${trading.buybotAlertMinUsd}`,
          callback_data: "trade:buymin_up"
        }
      ],
      [
        { text: t(userId, "btn_level6_panel"), callback_data: "level6:panel" },
        { text: t(userId, "btn_level6_status"), callback_data: "level6:status" }
      ],
      [
        { text: t(userId, "btn_language"), callback_data: "lang:open" },
        { text: t(userId, "btn_close"), callback_data: "tradepanel:close" }
      ]
    ]
  };
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

async function sendTelegramMessage(chatId, text, replyToMessageId = null, extra = {}) {
  const payload = {
    chat_id: chatId,
    text: String(text || "").slice(0, 4096),
    allow_sending_without_reply: true,
    ...extra
  };

  if (replyToMessageId) {
    payload.reply_parameters = { message_id: replyToMessageId };
  }

  return tg("sendMessage", payload);
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  return tg("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: String(text || "").slice(0, 180)
  });
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      userId,
      userName,
      username,
      chatId,
      chatType,
      source,
      secret: ADMIN_SECRET
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Chiikawa backend error: ${JSON.stringify(data)}`);
  }

  return data.reply || "Chiikawa got quiet... 🥺";
}

async function sendTradingPanel(chatId, replyToMessageId = null, userId = null) {
  const trading = getTradingRuntime();
  const level6 = getLevel6Runtime();

  return sendTelegramMessage(
    chatId,
    t(userId, "trading_panel_title", trading, level6),
    replyToMessageId,
    { reply_markup: buildTradingPanelKeyboard(userId) }
  );
}

async function handleLanguageCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId) return false;
  if (!data.startsWith("lang:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, "Private chat only");
    return true;
  }

  if (data === "lang:open") {
    await answerCallbackQuery(callbackQuery.id, "Language");
    await sendTelegramMessage(chatId, t(userId, "language_prompt"), messageId, {
      reply_markup: buildLanguageKeyboard()
    });
    return true;
  }

  if (data.startsWith("lang:set:")) {
    const langCode = data.split(":")[2];
    if (!SUPPORTED_LANGUAGES.find(x => x.code === langCode)) {
      await answerCallbackQuery(callbackQuery.id, "Unknown language");
      return true;
    }

    setUserLanguage(userId, langCode);
    const label = SUPPORTED_LANGUAGES.find(x => x.code === langCode)?.label || langCode;
    await answerCallbackQuery(callbackQuery.id, label);
    await sendTelegramMessage(
      chatId,
      t(userId, "language_set", label),
      messageId,
      { reply_markup: buildMainMenuKeyboard(userId) }
    );
    return true;
  }

  return false;
}

async function handleMenuCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId || !data.startsWith("menu:")) return false;

  if (data === "menu:ca") {
    await answerCallbackQuery(callbackQuery.id, "CA");
    await sendTelegramMessage(chatId, `CA\n${TOKEN_CA}\n\nWebsite\n${WEBSITE_URL}`, messageId);
    return true;
  }

  if (data === "menu:website") {
    await answerCallbackQuery(callbackQuery.id, "Website");
    await sendTelegramMessage(chatId, WEBSITE_URL, messageId);
    return true;
  }

  if (data === "menu:status") {
    await answerCallbackQuery(callbackQuery.id, "Status");
    await sendTelegramMessage(chatId, formatTradingStatus(), messageId);
    return true;
  }

  if (data === "menu:admin") {
    if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
      await answerCallbackQuery(callbackQuery.id, t(userId, "private_only_admin"));
      return true;
    }
    if (!isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
      return true;
    }
    await answerCallbackQuery(callbackQuery.id, "Admin");
    await sendTradingPanel(chatId, messageId, userId);
    return true;
  }

  return false;
}

async function handleLevel6Callback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;
  const lang = getUserLanguage(userId);

  if (!chatId || !data.startsWith("level6:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, "Private chat only");
    return true;
  }

  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
    return true;
  }

  const action = data.split(":")[1];

  if (action === "panel") {
    await answerCallbackQuery(callbackQuery.id, "Level 6");
    await sendTelegramMessage(
      chatId,
      level6t(lang, "level6_panel_title", getLevel6Runtime()),
      messageId,
      { reply_markup: buildLevel6PanelKeyboard(lang, getLevel6Runtime()) }
    );
    return true;
  }

  if (action === "status") {
    const summary = await getLevel6Summary();
    await answerCallbackQuery(callbackQuery.id, "Level 6 Status");
    await sendTelegramMessage(
      chatId,
      level6t(lang, "level6_status_title", summary),
      messageId,
      { reply_markup: buildLevel6PanelKeyboard(lang, getLevel6Runtime()) }
    );
    return true;
  }

  if (action === "open_trades") {
    const trades = await getLevel6OpenTrades();
    await answerCallbackQuery(callbackQuery.id, "Open trades");
    await sendTelegramMessage(
      chatId,
      formatLevel6OpenTrades(lang, trades),
      messageId,
      { reply_markup: buildLevel6PanelKeyboard(lang, getLevel6Runtime()) }
    );
    return true;
  }

  const result = await handleTradingAdminCallback(data);

  await answerCallbackQuery(callbackQuery.id, result.ok ? "Updated" : "Failed");
  await sendTelegramMessage(
    chatId,
    result.ok ? result.message : result.error,
    messageId,
    { reply_markup: buildLevel6PanelKeyboard(lang, getLevel6Runtime()) }
  );
  return true;
}

async function handleTradingCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId || !data.startsWith("trade:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_only_tradepanel"));
    return true;
  }

  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
    return true;
  }

  const result = await handleTradingAdminCallback(data);
  await answerCallbackQuery(callbackQuery.id, result.ok ? "Updated" : "Failed");
  await sendTradingPanel(chatId, messageId, userId);
  return true;
}

async function handleTradePanelCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId || !data.startsWith("tradepanel:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_only_tradepanel"));
    return true;
  }

  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
    return true;
  }

  if (data === "tradepanel:open") {
    await answerCallbackQuery(callbackQuery.id, "Trading panel");
    await sendTradingPanel(chatId, messageId, userId);
    return true;
  }

  if (data === "tradepanel:close") {
    await answerCallbackQuery(callbackQuery.id, "Closed");
    await sendTelegramMessage(chatId, "Closed", messageId, {
      reply_markup: buildMainMenuKeyboard(userId)
    });
    return true;
  }

  return false;
}

async function handleCallbackQuery(callbackQuery) {
  if (await handleLanguageCallback(callbackQuery)) return true;
  if (await handleMenuCallback(callbackQuery)) return true;
  if (await handleTradePanelCallback(callbackQuery)) return true;
  if (await handleTradingCallback(callbackQuery)) return true;
  if (await handleLevel6Callback(callbackQuery)) return true;
  return false;
}

async function handleCommand(message) {
  const text = normalizeText(message.text);
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "anonymous");
  const messageId = message.message_id;

  if (text.startsWith("/start")) {
    const reply = await askChiikawa({
      message: "Meet a new friend warmly.",
      userId
    });

    await sendTelegramMessage(chatId, reply, messageId, {
      reply_markup: buildMainMenuKeyboard(userId)
    });
    return true;
  }

  if (text.startsWith("/help")) {
    await sendTelegramMessage(chatId, t(userId, "commands_help"), messageId, {
      reply_markup: buildMainMenuKeyboard(userId)
    });
    return true;
  }

  if (text.startsWith("/menu")) {
    await sendTelegramMessage(chatId, t(userId, "menu_title"), messageId, {
      reply_markup: buildMainMenuKeyboard(userId)
    });
    return true;
  }

  if (text.startsWith("/language")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, "Private only", messageId);
      return true;
    }

    await sendTelegramMessage(chatId, t(userId, "language_prompt"), messageId, {
      reply_markup: buildLanguageKeyboard()
    });
    return true;
  }

  if (text.startsWith("/tradepanel")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, t(userId, "private_only_tradepanel"), messageId);
      return true;
    }

    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, t(userId, "admins_only"), messageId);
      return true;
    }

    await sendTradingPanel(chatId, messageId, userId);
    return true;
  }

  if (text.startsWith("/status") || text.startsWith("/trade_status")) {
    await sendTelegramMessage(chatId, formatTradingStatus(), messageId);
    return true;
  }

  if (text.startsWith("/level6_status")) {
    const summary = await getLevel6Summary();
    const lang = getUserLanguage(userId);

    await sendTelegramMessage(
      chatId,
      level6t(lang, "level6_status_title", summary),
      messageId,
      { reply_markup: buildLevel6PanelKeyboard(lang, getLevel6Runtime()) }
    );
    return true;
  }

  if (text.startsWith("/level6_open_trades")) {
    const trades = await getLevel6OpenTrades();
    const lang = getUserLanguage(userId);

    await sendTelegramMessage(
      chatId,
      formatLevel6OpenTrades(lang, trades),
      messageId,
      { reply_markup: buildLevel6PanelKeyboard(lang, getLevel6Runtime()) }
    );
    return true;
  }

  if (
    text.startsWith("/level6_dryrun_on") ||
    text.startsWith("/level6_dryrun_off") ||
    text.startsWith("/wallets") ||
    text.startsWith("/watch_wallet") ||
    text.startsWith("/unwatch_wallet") ||
    text.startsWith("/trading_on") ||
    text.startsWith("/trading_off") ||
    text.startsWith("/kill_switch") ||
    text.startsWith("/trade_mode") ||
    text.startsWith("/setbuy") ||
    text.startsWith("/autocopy_on") ||
    text.startsWith("/autocopy_off") ||
    text.startsWith("/autocopy_status") ||
    text.startsWith("/level5_health") ||
    text.startsWith("/level5_dryrun_on") ||
    text.startsWith("/level5_dryrun_off")
  ) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, t(userId, "private_only_trading"), messageId);
      return true;
    }

    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, t(userId, "admins_only"), messageId);
      return true;
    }

    const result = await handleTradingCommand(text, "admin");
    await sendTelegramMessage(chatId, result.ok ? result.message : result.error, messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (text.startsWith("/ca")) {
    await sendTelegramMessage(chatId, TOKEN_CA, messageId);
    return true;
  }

  if (text.startsWith("/website")) {
    await sendTelegramMessage(chatId, WEBSITE_URL, messageId);
    return true;
  }

  return false;
}

async function handleMessage(message) {
  if (!message || message.text == null) return;

  try {
    const handled = await handleCommand(message);
    if (handled) return;

    const reply = await askChiikawa({
      message: message.text,
      userId: String(message.from?.id || "anonymous"),
      userName: message.from?.first_name || "",
      username: message.from?.username || "",
      chatId: String(message.chat?.id || ""),
      chatType: message.chat?.type || "",
      source: "telegram"
    });

    await sendTelegramMessage(message.chat.id, reply, message.message_id, {
      reply_markup: buildMainMenuKeyboard(message.from?.id)
    });
  } catch (error) {
    console.error("handleMessage error:", error);
    await sendTelegramMessage(
      message.chat.id,
      t(message.from?.id, "stumble"),
      message.message_id
    );
  }
}

async function setTelegramCommands() {
  const commands = [
    { command: "start", description: "Start talking to Chiikawa" },
    { command: "help", description: "Show help" },
    { command: "menu", description: "Open menu" },
    { command: "tradepanel", description: "Open trading panel (private only)" },
    { command: "status", description: "Show runtime status" },
    { command: "trade_status", description: "Trading status" },
    { command: "language", description: "Choose interface language" },
    { command: "ca", description: "Show contract" },
    { command: "website", description: "Show website" },
    { command: "level6_status", description: "Level 6 status" },
    { command: "level6_open_trades", description: "Open Level 6 trades" }
  ];

  await tg("setMyCommands", { commands });
}

async function bootstrap() {
  await initTradingAdmin();

  try {
    await tg("deleteWebhook", { drop_pending_updates: false });
  } catch {}

  const me = await tg("getMe");
  botUsername = me.username || null;
  botId = me.id || null;

  await setTelegramCommands();

  console.log(`Telegram bot started as @${botUsername || "unknown_bot"}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
          const handled = await handleCallbackQuery(update.callback_query);
          if (!handled) {
            await answerCallbackQuery(update.callback_query.id, "");
          }
        }

        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (error) {
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
