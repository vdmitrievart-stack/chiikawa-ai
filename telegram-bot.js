import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  getTradingRuntime,
  handleTradingAdminCallback,
  handleTradingCommand,
  formatTradingStatus
} from "./trading-admin.js";

import {
  createProposal,
  getProposal,
  updateProposal
} from "./trade-proposal-engine.js";

import {
  buildTokenDossier,
  formatDossierForAdmin,
  formatPublicBuyPost
} from "./token-dossier-engine.js";

import { executeTradeMock } from "./trade-executor.js";
import Level4TradingKernel from "./Level4TradingKernel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const ADMIN_IDS = [617743971];
const FORCED_GROUP_CHAT_ID = "-1003953010138";
const TOKEN_CA = "2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu";
const WEBSITE_URL = "https://chiikawasol.com/";

let offset = 0;
let botId = null;
let botUsername = null;

const ACTIVE_CONVERSATION_MS = 8 * 60 * 1000;
const activeChatUntil = new Map();
const chatTraffic = new Map();
const greetedChats = new Set();

const pendingAdminActions = new Map();
const latestScans = new Map();

const LANG_FILE = path.resolve(__dirname, "./bot-language-settings.json");
const DEFAULT_LANG = "en";

const level4Kernel = new Level4TradingKernel({
  baseDir: path.join(process.cwd(), "data", "trading"),
  logger: console
});

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

function loadLangState() {
  try {
    if (!fs.existsSync(LANG_FILE)) {
      return { users: {} };
    }
    const raw = fs.readFileSync(LANG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: parsed && typeof parsed.users === "object" && parsed.users ? parsed.users : {}
    };
  } catch (error) {
    console.error("language settings load error:", error.message);
    return { users: {} };
  }
}

function saveLangState() {
  try {
    fs.writeFileSync(LANG_FILE, JSON.stringify(langState, null, 2), "utf8");
  } catch (error) {
    console.error("language settings save error:", error.message);
  }
}

const langState = loadLangState();

function setUserLanguage(userId, langCode) {
  langState.users[String(userId)] = langCode;
  saveLangState();
}

function getUserLanguage(userId) {
  return langState.users[String(userId)] || DEFAULT_LANG;
}

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
/scan_ca
/propose <token_name> <solana_ca>
/language
/ca
/website
/add_leader
/add_follower
/link_copy
/top_leaders
/copy_plan`,
    menu_title: `✨ Chiikawa Menu ✨

Choose what you want to explore:

• CA
• Website
• Status`,
    admin_panel_title: (config, trading) => `🛠 Admin Panel

quietMode: ${config.quietMode}
autoSelfTuning: ${config.autoSelfTuning}
xWatcherEnabled: ${config.xWatcherEnabled}
youtubeWatcherEnabled: ${config.youtubeWatcherEnabled}
buybotEnabled: ${config.buybotEnabled}
buybotAlertMinUsd: ${config.buybotAlertMinUsd}

tradingEnabled: ${trading.enabled}
tradeMode: ${trading.mode}
killSwitch: ${trading.killSwitch}`,
    trading_panel_title: trading => `🎛 Trading Panel

enabled: ${trading.enabled}
mode: ${trading.mode}
killSwitch: ${trading.killSwitch}
buybotAlertMinUsd: ${trading.buybotAlertMinUsd}
trackedWallets: ${Array.isArray(trading.trackedWallets) ? trading.trackedWallets.length : 0}`,
    private_only_trading: "Trading tools are available only in private chat with the bot.",
    private_only_admin: "Admin panel is available only in private chat with the bot.",
    private_only_tradepanel: "Trading panel is available only in private chat with the bot.",
    private_only_scan: "CA scan is available only in private chat with the bot.",
    private_only_proposals: "Trading proposals are available only in private chat with the bot.",
    private_only_trade_status: "Trading status is available only in private chat with the bot.",
    language_private_only: "Language settings are available only in private chat with the bot.",
    admins_only: "Admins only 🥺",
    waiting_for_ca: `Send me the Solana CA you want to scan.

Example:
7xKXtg2CWd3xgRzx...`,
    invalid_ca: `That doesn't look like a Solana CA.

Please send a valid Solana mint address.`,
    scan_failed: error => `Failed to build dossier:
${error}`,
    scan_result_title: dossier => `🧾 Scan Result

${formatDossierForAdmin(dossier)}`,
    scan_cancelled: "Scan cancelled.",
    no_scan_data: "No scan data found. Please scan a CA first.",
    proposal_created: (dossier, proposal) => `🚀 Trade Proposal

${formatDossierForAdmin(dossier)}

Proposal ID:
${proposal.id}`,
    proposal_approved: (proposal, execution) => `✅ Proposal approved

Token: ${proposal.token}
CA: ${proposal.ca}
TX: ${execution.tx}

Public buy post sent to the group.`,
    proposal_rejected: proposal => `❌ Proposal rejected

Token: ${proposal.token}
CA: ${proposal.ca}`,
    proposal_not_found: "Proposal not found",
    proposal_already_processed: "Already processed",
    execution_failed: id => `Execution failed for proposal ${id}`,
    runtime_status: (cfg, trading) => `📊 Runtime status

quietMode: ${cfg.quietMode}
autoSelfTuning: ${cfg.autoSelfTuning}
xWatcherEnabled: ${cfg.xWatcherEnabled}
youtubeWatcherEnabled: ${cfg.youtubeWatcherEnabled}
buybotEnabled: ${cfg.buybotEnabled}
buybotAlertMinUsd: ${cfg.buybotAlertMinUsd}

tradingEnabled: ${trading.enabled}
tradeMode: ${trading.mode}
killSwitch: ${trading.killSwitch}`,
    stumble: "Chiikawa stumbled a little... 🥺 Please try again.",
    language_prompt: "🌐 Choose your language:",
    language_set: label => `Language set to: ${label}`,
    close_panel: "Closed",
    trading_panel_closed: "Trading panel closed.",
    level4_wallets_empty: "No Level 4 wallets yet.",
    level4_status_error: error => `Level 4 status error: ${error}`,
    level4_wallets_error: error => `Level 4 wallets error: ${error}`,
    unknown_language: "Unknown language",
    private_chat_only: "Private chat only",
    pending_cancelled: "Pending action cancelled.",

    btn_ca: "CA",
    btn_website: "Website",
    btn_status: "Status",
    btn_admin: "Admin",
    btn_trading: "🎛 Trading",
    btn_language: "🌐 Language",
    btn_scan_ca: "🔍 Scan CA",
    btn_trade_status: "📊 Trade Status",
    btn_wallets: "👛 Wallets",
    btn_add_leader: "🧠 Add Leader",
    btn_add_follower: "🪞 Add Follower",
    btn_link_copy: "🔗 Link Copy",
    btn_top_leaders: "🏆 Top Leaders",
    btn_copy_plan: "📋 Copy Plan",
    btn_trading_on: "⚙️ Trading ON",
    btn_trading_off: "⚙️ Trading OFF",
    btn_kill_on: "🛑 Kill ON",
    btn_kill_off: "🛑 Kill OFF",
    btn_mode: mode => `🔁 Mode: ${mode}`,
    btn_buy_min: value => `💰 Buy Min: $${value}`,
    btn_close: "❎ Close",
    btn_approve: "✅ Approve",
    btn_reject: "❌ Reject",
    btn_create_proposal: "✅ Create proposal",
    btn_cancel: "❌ Cancel",
    btn_back: "⬅️ Back",
    btn_menu: "📋 Menu",

    prompt_add_leader: `Send leader data in one message:

<leaderId> <walletId> <address> [label]

Example:
leader_main wallet_leader_1 So11111111111111111111111111111111111111112 MainLeader`,
    prompt_add_follower: `Send follower data in one message:

<followerId> <walletId> <address> <ownerUserId> [label]

Example:
follower_main wallet_follower_1 So11111111111111111111111111111111111111113 617743971 MainFollower`,
    prompt_link_copy: `Send link data in one message:

<leaderId> <followerId> [multiplier] [maxTradeUsd] [minLeaderScore] [mode]

Example:
leader_main follower_main 0.5 80 20 mirror`,
    prompt_copy_plan: `Send copy-plan data in one message:

<leaderId> <buy|sell> <symbol> <ca> <sizeUsd>

Example:
leader_main buy CHII 2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu 120`
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
/scan_ca
/propose <имя_токена> <solana_ca>
/language
/ca
/website
/add_leader
/add_follower
/link_copy
/top_leaders
/copy_plan`,
    menu_title: `✨ Меню Chiikawa ✨

Выбери, что открыть:

• CA
• Сайт
• Статус`,
    admin_panel_title: (config, trading) => `🛠 Админ-панель

quietMode: ${config.quietMode}
autoSelfTuning: ${config.autoSelfTuning}
xWatcherEnabled: ${config.xWatcherEnabled}
youtubeWatcherEnabled: ${config.youtubeWatcherEnabled}
buybotEnabled: ${config.buybotEnabled}
buybotAlertMinUsd: ${config.buybotAlertMinUsd}

tradingEnabled: ${trading.enabled}
tradeMode: ${trading.mode}
killSwitch: ${trading.killSwitch}`,
    trading_panel_title: trading => `🎛 Торговая панель

enabled: ${trading.enabled}
mode: ${trading.mode}
killSwitch: ${trading.killSwitch}
buybotAlertMinUsd: ${trading.buybotAlertMinUsd}
trackedWallets: ${Array.isArray(trading.trackedWallets) ? trading.trackedWallets.length : 0}`,
    private_only_trading: "Торговые инструменты доступны только в личном чате с ботом.",
    private_only_admin: "Админ-панель доступна только в личном чате с ботом.",
    private_only_tradepanel: "Торговая панель доступна только в личном чате с ботом.",
    private_only_scan: "Сканирование CA доступно только в личном чате с ботом.",
    private_only_proposals: "Торговые предложения доступны только в личном чате с ботом.",
    private_only_trade_status: "Статус торговли доступен только в личном чате с ботом.",
    language_private_only: "Настройки языка доступны только в личном чате с ботом.",
    admins_only: "Только для админов 🥺",
    waiting_for_ca: `Отправь мне Solana CA, который хочешь просканировать.

Пример:
7xKXtg2CWd3xgRzx...`,
    invalid_ca: `Это не похоже на Solana CA.

Пожалуйста, отправь корректный mint address Solana.`,
    scan_failed: error => `Не удалось собрать dossier:
${error}`,
    scan_result_title: dossier => `🧾 Результат сканирования

${formatDossierForAdmin(dossier)}`,
    scan_cancelled: "Сканирование отменено.",
    no_scan_data: "Нет данных сканирования. Сначала просканируй CA.",
    proposal_created: (dossier, proposal) => `🚀 Торговое предложение

${formatDossierForAdmin(dossier)}

ID предложения:
${proposal.id}`,
    proposal_approved: (proposal, execution) => `✅ Предложение одобрено

Токен: ${proposal.token}
CA: ${proposal.ca}
TX: ${execution.tx}

Публичный buy-post отправлен в группу.`,
    proposal_rejected: proposal => `❌ Предложение отклонено

Токен: ${proposal.token}
CA: ${proposal.ca}`,
    proposal_not_found: "Предложение не найдено",
    proposal_already_processed: "Уже обработано",
    execution_failed: id => `Исполнение не удалось для предложения ${id}`,
    runtime_status: (cfg, trading) => `📊 Статус runtime

quietMode: ${cfg.quietMode}
autoSelfTuning: ${cfg.autoSelfTuning}
xWatcherEnabled: ${cfg.xWatcherEnabled}
youtubeWatcherEnabled: ${cfg.youtubeWatcherEnabled}
buybotEnabled: ${cfg.buybotEnabled}
buybotAlertMinUsd: ${cfg.buybotAlertMinUsd}

tradingEnabled: ${trading.enabled}
tradeMode: ${trading.mode}
killSwitch: ${trading.killSwitch}`,
    stumble: "Chiikawa немного споткнулся... 🥺 Попробуй ещё раз.",
    language_prompt: "🌐 Выбери язык:",
    language_set: label => `Язык установлен: ${label}`,
    close_panel: "Закрыто",
    trading_panel_closed: "Торговая панель закрыта.",
    level4_wallets_empty: "В Level 4 пока нет кошельков.",
    level4_status_error: error => `Ошибка статуса Level 4: ${error}`,
    level4_wallets_error: error => `Ошибка кошельков Level 4: ${error}`,
    unknown_language: "Неизвестный язык",
    private_chat_only: "Только в личном чате",
    pending_cancelled: "Ожидающее действие отменено.",

    btn_ca: "CA",
    btn_website: "Сайт",
    btn_status: "Статус",
    btn_admin: "Админ",
    btn_trading: "🎛 Торговля",
    btn_language: "🌐 Язык",
    btn_scan_ca: "🔍 Скан CA",
    btn_trade_status: "📊 Статус трейда",
    btn_wallets: "👛 Кошельки",
    btn_add_leader: "🧠 Добавить лидера",
    btn_add_follower: "🪞 Добавить фолловера",
    btn_link_copy: "🔗 Связать copy",
    btn_top_leaders: "🏆 Топ лидеров",
    btn_copy_plan: "📋 Copy Plan",
    btn_trading_on: "⚙️ Торговля ON",
    btn_trading_off: "⚙️ Торговля OFF",
    btn_kill_on: "🛑 Kill ON",
    btn_kill_off: "🛑 Kill OFF",
    btn_mode: mode => `🔁 Режим: ${mode}`,
    btn_buy_min: value => `💰 Мин. buy: $${value}`,
    btn_close: "❎ Закрыть",
    btn_approve: "✅ Одобрить",
    btn_reject: "❌ Отклонить",
    btn_create_proposal: "✅ Создать proposal",
    btn_cancel: "❌ Отмена",
    btn_back: "⬅️ Назад",
    btn_menu: "📋 Меню",

    prompt_add_leader: `Отправь данные лидера одним сообщением:

<leaderId> <walletId> <address> [label]

Пример:
leader_main wallet_leader_1 So11111111111111111111111111111111111111112 MainLeader`,
    prompt_add_follower: `Отправь данные фолловера одним сообщением:

<followerId> <walletId> <address> <ownerUserId> [label]

Пример:
follower_main wallet_follower_1 So11111111111111111111111111111111111111113 617743971 MainFollower`,
    prompt_link_copy: `Отправь данные связки одним сообщением:

<leaderId> <followerId> [multiplier] [maxTradeUsd] [minLeaderScore] [mode]

Пример:
leader_main follower_main 0.5 80 20 mirror`,
    prompt_copy_plan: `Отправь данные для copy plan одним сообщением:

<leaderId> <buy|sell> <symbol> <ca> <sizeUsd>

Пример:
leader_main buy CHII 2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu 120`
  }
};

function t(userId, key, ...args) {
  const lang = getUserLanguage(userId);
  const dict = I18N[lang] || I18N.en;
  const fallback = I18N.en[key];
  const value = dict[key] ?? fallback;
  if (typeof value === "function") return value(...args);
  return value;
}

function getLanguageLabel(code) {
  return SUPPORTED_LANGUAGES.find(x => x.code === code)?.label || code;
}

function buildLanguageKeyboard(userId) {
  const rows = [];
  for (let i = 0; i < SUPPORTED_LANGUAGES.length; i += 2) {
    rows.push(
      SUPPORTED_LANGUAGES.slice(i, i + 2).map(lang => ({
        text: lang.label,
        callback_data: `lang:set:${lang.code}`
      }))
    );
  }
  rows.push([{ text: t(userId, "btn_back"), callback_data: "menu:open" }]);
  return { inline_keyboard: rows };
}

function buildCAKeyboard(userId) {
  return {
    inline_keyboard: [
      [{ text: "Copy CA", copy_text: { text: TOKEN_CA } }],
      [{ text: t(userId, "btn_website"), url: WEBSITE_URL }],
      [
        { text: t(userId, "btn_language"), callback_data: "lang:open" },
        { text: t(userId, "btn_menu"), callback_data: "menu:open" }
      ]
    ]
  };
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
      [{ text: t(userId, "btn_scan_ca"), callback_data: "scan:start" }],
      [
        { text: t(userId, "btn_trade_status"), callback_data: "trade:show_status" },
        { text: t(userId, "btn_wallets"), callback_data: "trade:show_wallets" }
      ],
      [
        { text: t(userId, "btn_add_leader"), callback_data: "level4:add_leader_prompt" },
        { text: t(userId, "btn_add_follower"), callback_data: "level4:add_follower_prompt" }
      ],
      [
        { text: t(userId, "btn_link_copy"), callback_data: "level4:link_copy_prompt" },
        { text: t(userId, "btn_top_leaders"), callback_data: "level4:top_leaders" }
      ],
      [{ text: t(userId, "btn_copy_plan"), callback_data: "level4:copy_plan_prompt" }],
      [
        {
          text: trading.enabled ? t(userId, "btn_trading_on") : t(userId, "btn_trading_off"),
          callback_data: "trade:toggle_enabled"
        },
        {
          text: trading.killSwitch ? t(userId, "btn_kill_on") : t(userId, "btn_kill_off"),
          callback_data: "trade:toggle_kill"
        }
      ],
      [
        { text: t(userId, "btn_mode", trading.mode), callback_data: "trade:cycle_mode" },
        { text: t(userId, "btn_buy_min", trading.buybotAlertMinUsd), callback_data: "trade:buymin_up" }
      ],
      [
        { text: t(userId, "btn_language"), callback_data: "lang:open" },
        { text: t(userId, "btn_menu"), callback_data: "menu:open" }
      ],
      [{ text: t(userId, "btn_close"), callback_data: "tradepanel:close" }]
    ]
  };
}

function buildAdminKeyboard(config, userId) {
  const trading = getTradingRuntime();

  return {
    inline_keyboard: [
      [
        { text: t(userId, "btn_trading"), callback_data: "tradepanel:open" },
        { text: t(userId, "btn_language"), callback_data: "lang:open" }
      ],
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
      [{ text: t(userId, "btn_menu"), callback_data: "menu:open" }]
    ]
  };
}

function buildProposalKeyboard(proposalId, userId) {
  return {
    inline_keyboard: [
      [
        { text: t(userId, "btn_approve"), callback_data: `proposal:approve:${proposalId}` },
        { text: t(userId, "btn_reject"), callback_data: `proposal:reject:${proposalId}` }
      ],
      [
        { text: t(userId, "btn_language"), callback_data: "lang:open" },
        { text: t(userId, "btn_menu"), callback_data: "menu:open" }
      ]
    ]
  };
}

function buildScanResultKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        { text: t(userId, "btn_create_proposal"), callback_data: "scan:create_proposal" },
        { text: t(userId, "btn_cancel"), callback_data: "scan:cancel" }
      ],
      [
        { text: t(userId, "btn_language"), callback_data: "lang:open" },
        { text: t(userId, "btn_menu"), callback_data: "menu:open" }
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
    text: String(text || "").slice(0, 180)
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
    headers: { "Content-Type": "application/json" },
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

function normalizeText(value) {
  return String(value || "").trim();
}

function cleanLower(value) {
  return normalizeText(value).toLowerCase();
}

function isPrivateChat(message) {
  return message?.chat?.type === "private";
}

function isGroupChat(message) {
  return message?.chat?.type === "group" || message?.chat?.type === "supergroup";
}

function mentionsBotUsername(text) {
  if (!botUsername) return false;
  return cleanLower(text).includes(`@${String(botUsername).toLowerCase()}`);
}

function mentionsBotByName(text) {
  return cleanLower(text).includes("chiikawa");
}

function isReplyToBot(message) {
  return Number(message?.reply_to_message?.from?.id || 0) === Number(botId || 0);
}

function getDisplayName(user) {
  if (!user) return "friend";
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || user.username || "friend";
}

function markChatActive(chatId) {
  activeChatUntil.set(String(chatId), Date.now() + ACTIVE_CONVERSATION_MS);
}

function isChatActive(chatId) {
  const until = activeChatUntil.get(String(chatId)) || 0;
  return until > Date.now();
}

function countTraffic(chatId) {
  const key = String(chatId);
  const now = Date.now();
  const current = chatTraffic.get(key) || [];
  const filtered = current.filter(ts => now - ts < 60_000);
  filtered.push(now);
  chatTraffic.set(key, filtered);
  return filtered.length;
}

function setPendingAdminAction(userId, action) {
  pendingAdminActions.set(String(userId), action);
}

function getPendingAdminAction(userId) {
  return pendingAdminActions.get(String(userId)) || null;
}

function clearPendingAdminAction(userId) {
  pendingAdminActions.delete(String(userId));
}

function setLatestScan(userId, dossier) {
  latestScans.set(String(userId), { dossier, at: Date.now() });
}

function getLatestScan(userId) {
  return latestScans.get(String(userId)) || null;
}

function clearLatestScan(userId) {
  latestScans.delete(String(userId));
}

function isProbablySolanaAddress(value) {
  const text = String(value || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
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

function shouldRespond(message) {
  const text = normalizeText(message.text);
  if (!text) return false;

  const commandPrefixes = [
    "/start", "/help", "/menu", "/admin", "/tradepanel", "/status",
    "/trade_status", "/trade_mode", "/watch_wallet", "/unwatch_wallet",
    "/wallets", "/wallet_score", "/kill_switch", "/trading_on",
    "/trading_off", "/setbuy", "/propose", "/scan_ca", "/language",
    "/ca", "/website", "/add_leader", "/add_follower", "/link_copy",
    "/top_leaders", "/copy_plan"
  ];

  if (commandPrefixes.some(cmd => text.startsWith(cmd))) return true;
  if (isCARequest(text)) return true;
  if (isWebsiteRequest(text)) return true;
  if (isPrivateChat(message)) return true;
  if (mentionsBotUsername(text)) return true;
  if (mentionsBotByName(text)) return true;
  if (isReplyToBot
