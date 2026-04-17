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
import Level5ExecutionEngine from "./Level5ExecutionEngine.js";
import Level5AutoCopyTrader from "./Level5AutoCopyTrader.js";

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

let level5ExecutionEngine = null;
let autoCopyTrader = null;

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
/copy_plan
/autocopy_on
/autocopy_off
/autocopy_status
/execute_copy_now`,
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
killSwitch: ${trading.killSwitch}
autoCopyEnabled: ${trading.autoCopyEnabled}`,
    trading_panel_title: trading => `🎛 Trading Panel

enabled: ${trading.enabled}
mode: ${trading.mode}
killSwitch: ${trading.killSwitch}
autoCopyEnabled: ${trading.autoCopyEnabled}
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
killSwitch: ${trading.killSwitch}
autoCopyEnabled: ${trading.autoCopyEnabled}`,
    stumble: "Chiikawa stumbled a little... 🥺 Please try again.",
    language_prompt: "🌐 Choose your language:",
    language_set: label => `Language set to: ${label}`,
    close_panel: "Closed",
    trading_panel_closed: "Trading panel closed.",
    level4_wallets_empty: "No Level 4 wallets yet.",
    level4_status_error: error => `Level 4 status error: ${error}`,
    level4_wallets_error: error => `Level 4 wallets error: ${error}`,
    level5_init_failed: error => `Level 5 init failed: ${error}`,
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
    btn_exec_copy_now: "⚡ Execute Copy Now",
    btn_autocopy_on: "🤖 AutoCopy ON",
    btn_autocopy_off: "🤖 AutoCopy OFF",
    btn_autocopy_status: "🧾 AutoCopy Status",
    btn_trading_on: "⚙️ Trading ON",
    btn_trading_off: "⚙️ Trading OFF",
    btn_kill_on: "🛑 Kill ON",
    btn_kill_off: "🛑 Kill OFF",
    btn_mode: mode => `🔁 Mode: ${mode}`,
    btn_buy_min: v => `💰 Buy Min: $${v}`,
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
leader_main buy CHII 2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu 120`,
    prompt_execute_copy_now: `Send execute-copy data in one message:

<leaderId> <inputMint> <outputMint> <amountAtomic> <sizeUsd> [slippageBps] [buy|sell]

Example:
leader_main So11111111111111111111111111111111111111112 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 10000000 20 100 buy`
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
/copy_plan
/autocopy_on
/autocopy_off
/autocopy_status
/execute_copy_now`,
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
killSwitch: ${trading.killSwitch}
autoCopyEnabled: ${trading.autoCopyEnabled}`,
    trading_panel_title: trading => `🎛 Торговая панель

enabled: ${trading.enabled}
mode: ${trading.mode}
killSwitch: ${trading.killSwitch}
autoCopyEnabled: ${trading.autoCopyEnabled}
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
killSwitch: ${trading.killSwitch}
autoCopyEnabled: ${trading.autoCopyEnabled}`,
    stumble: "Chiikawa немного споткнулся... 🥺 Попробуй ещё раз.",
    language_prompt: "🌐 Выбери язык:",
    language_set: label => `Язык установлен: ${label}`,
    close_panel: "Закрыто",
    trading_panel_closed: "Торговая панель закрыта.",
    level4_wallets_empty: "В Level 4 пока нет кошельков.",
    level4_status_error: error => `Ошибка статуса Level 4: ${error}`,
    level4_wallets_error: error => `Ошибка кошельков Level 4: ${error}`,
    level5_init_failed: error => `Ошибка инициализации Level 5: ${error}`,
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
    btn_copy_plan: "📋 Copy plan",
    btn_exec_copy_now: "⚡ Execute Copy Now",
    btn_autocopy_on: "🤖 AutoCopy ON",
    btn_autocopy_off: "🤖 AutoCopy OFF",
    btn_autocopy_status: "🧾 Статус AutoCopy",
    btn_trading_on: "⚙️ Торговля ON",
    btn_trading_off: "⚙️ Торговля OFF",
    btn_kill_on: "🛑 Kill ON",
    btn_kill_off: "🛑 Kill OFF",
    btn_mode: mode => `🔁 Режим: ${mode}`,
    btn_buy_min: v => `💰 Мин. buy: $${v}`,
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
leader_main buy CHII 2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu 120`,
    prompt_execute_copy_now: `Отправь данные для execute-copy одним сообщением:

<leaderId> <inputMint> <outputMint> <amountAtomic> <sizeUsd> [slippageBps] [buy|sell]

Пример:
leader_main So11111111111111111111111111111111111111112 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 10000000 20 100 buy`
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

function tradingCommandContext() {
  return { autoCopyTrader };
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
          text: trading.autoCopyEnabled ? t(userId, "btn_autocopy_off") : t(userId, "btn_autocopy_on"),
          callback_data: trading.autoCopyEnabled ? "level5:autocopy_off" : "level5:autocopy_on"
        },
        { text: t(userId, "btn_autocopy_status"), callback_data: "level5:autocopy_status" }
      ],
      [{ text: t(userId, "btn_exec_copy_now"), callback_data: "level5:execute_copy_now_prompt" }],
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
      [{ text: config.buybotEnabled ? "Buybot: ON" : "Buybot: OFF", callback_data: "admin:toggle_buybot" }],
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
    payload.reply_parameters = { message_id: replyToMessageId };
  }

  return tg("sendMessage", payload);
}

async function sendTyping(chatId) {
  return tg("sendChatAction", { chat_id: chatId, action: "typing" });
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

function isCARequest(text) {
  const lower = cleanLower(text);
  return lower === "ca" || lower === "ca?" || lower.includes("contract") || lower.includes("контракт");
}

function isWebsiteRequest(text) {
  const lower = cleanLower(text);
  return lower === "website" || lower.includes("site") || lower.includes("сайт") || lower.includes("ссылка");
}

function shouldRespond(message) {
  const text = normalizeText(message.text);
  if (!text) return false;

  const commands = [
    "/start", "/help", "/menu", "/admin", "/tradepanel", "/status", "/trade_status",
    "/trade_mode", "/watch_wallet", "/unwatch_wallet", "/wallets", "/wallet_score",
    "/kill_switch", "/trading_on", "/trading_off", "/setbuy", "/propose", "/scan_ca",
    "/language", "/ca", "/website", "/add_leader", "/add_follower", "/link_copy",
    "/top_leaders", "/copy_plan", "/autocopy_on", "/autocopy_off", "/autocopy_status",
    "/execute_copy_now"
  ];

  if (commands.some(cmd => text.startsWith(cmd))) return true;
  if (isCARequest(text)) return true;
  if (isWebsiteRequest(text)) return true;
  if (isPrivateChat(message)) return true;
  if (mentionsBotUsername(text)) return true;
  if (mentionsBotByName(text)) return true;
  if (isReplyToBot(message)) return true;
  if (message.chat?.id && isChatActive(message.chat.id)) return true;

  return false;
}

function isTradingCommand(text) {
  const lower = cleanLower(text);
  const prefixes = [
    "/watch_wallet", "/unwatch_wallet", "/wallets", "/wallet_score", "/trade_status",
    "/trade_mode", "/kill_switch", "/trading_on", "/trading_off", "/setbuy",
    "/propose", "/scan_ca", "/tradepanel", "/add_leader", "/add_follower",
    "/link_copy", "/top_leaders", "/copy_plan", "/autocopy_on", "/autocopy_off",
    "/autocopy_status", "/execute_copy_now"
  ];
  return prefixes.some(cmd => lower.startsWith(cmd));
}

async function maybeRejectTradingCommandInGroup(message) {
  const text = normalizeText(message.text);
  if (!text.startsWith("/")) return false;
  if (!isTradingCommand(text)) return false;
  if (isPrivateChat(message)) return false;

  await sendTelegramMessage(
    message.chat.id,
    t(message.from?.id, "private_only_trading"),
    message.message_id
  );
  return true;
}

function parseProposeCommand(text) {
  const parts = String(text || "").trim().split(/\s+/);
  if (parts.length < 3) {
    return { ok: false, error: "Usage: /propose <token_name> <solana_ca>" };
  }
  return { ok: true, tokenName: parts[1], ca: parts[2] };
}

async function handleProposalApprove(callbackQuery, proposalId) {
  const proposal = getProposal(proposalId);
  const userId = callbackQuery.from?.id;

  if (!proposal) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "proposal_not_found"));
    return true;
  }

  if (proposal.status !== "pending") {
    await answerCallbackQuery(callbackQuery.id, t(userId, "proposal_already_processed"));
    return true;
  }

  const execution = await executeTradeMock(proposal);

  if (!execution.ok) {
    updateProposal(proposalId, { status: "failed", execution });
    await answerCallbackQuery(callbackQuery.id, "Execution failed");
    await sendTelegramMessage(
      callbackQuery.message.chat.id,
      t(userId, "execution_failed", proposalId),
      callbackQuery.message.message_id
    );
    return true;
  }

  updateProposal(proposalId, { status: "approved", execution });
  await answerCallbackQuery(callbackQuery.id, "Trade executed");

  const publicPost = formatPublicBuyPost(proposal, execution);
  const sent = await sendTelegramMessage(FORCED_GROUP_CHAT_ID, publicPost);

  try {
    await tg("pinChatMessage", {
      chat_id: FORCED_GROUP_CHAT_ID,
      message_id: sent.message_id,
      disable_notification: true
    });
  } catch (error) {
    console.error("pinChatMessage failed:", error.message);
  }

  await sendTelegramMessage(
    callbackQuery.message.chat.id,
    t(userId, "proposal_approved", proposal, execution),
    callbackQuery.message.message_id,
    { reply_markup: buildProposalKeyboard(proposalId, userId) }
  );

  return true;
}

async function handleProposalReject(callbackQuery, proposalId) {
  const proposal = getProposal(proposalId);
  const userId = callbackQuery.from?.id;

  if (!proposal) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "proposal_not_found"));
    return true;
  }

  updateProposal(proposalId, { status: "rejected" });
  await answerCallbackQuery(callbackQuery.id, "Rejected");

  await sendTelegramMessage(
    callbackQuery.message.chat.id,
    t(userId, "proposal_rejected", proposal),
    callbackQuery.message.message_id,
    { reply_markup: buildMainMenuKeyboard(userId) }
  );

  return true;
}

async function handleLanguageCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId || !data.startsWith("lang:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_chat_only"));
    return true;
  }

  if (data === "lang:open") {
    await answerCallbackQuery(callbackQuery.id, "Language");
    await sendTelegramMessage(chatId, t(userId, "language_prompt"), messageId, {
      reply_markup: buildLanguageKeyboard(userId)
    });
    return true;
  }

  if (data.startsWith("lang:set:")) {
    const langCode = data.split(":")[2];
    if (!SUPPORTED_LANGUAGES.find(x => x.code === langCode)) {
      await answerCallbackQuery(callbackQuery.id, t(userId, "unknown_language"));
      return true;
    }

    setUserLanguage(userId, langCode);
    await answerCallbackQuery(callbackQuery.id, getLanguageLabel(langCode));
    await sendTelegramMessage(
      chatId,
      t(userId, "language_set", getLanguageLabel(langCode)),
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

  if (data === "menu:open") {
    await answerCallbackQuery(callbackQuery.id, "Menu");
    await sendMainMenu(chatId, messageId, userId);
    return true;
  }

  if (data === "menu:ca") {
    await answerCallbackQuery(callbackQuery.id, "CA");
    await sendTelegramMessage(
      chatId,
      `CA
${TOKEN_CA}

Website
${WEBSITE_URL}`,
      messageId,
      { reply_markup: buildCAKeyboard(userId) }
    );
    return true;
  }

  if (data === "menu:website") {
    await answerCallbackQuery(callbackQuery.id, "Website");
    await sendTelegramMessage(chatId, WEBSITE_URL, messageId, {
      reply_markup: buildMainMenuKeyboard(userId)
    });
    return true;
  }

  if (data === "menu:status") {
    const cfg = await getRuntimeConfig();
    const trading = getTradingRuntime();
    await answerCallbackQuery(callbackQuery.id, "Status");
    await sendTelegramMessage(chatId, t(userId, "runtime_status", cfg, trading), messageId, {
      reply_markup: buildMainMenuKeyboard(userId)
    });
    return true;
  }

  if (data === "menu:admin") {
    if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
      await answerCallbackQuery(callbackQuery.id, t(userId, "private_chat_only"));
      return true;
    }
    if (!isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
      return true;
    }

    await answerCallbackQuery(callbackQuery.id, "Admin");
    await sendAdminPanel(chatId, messageId, userId);
    return true;
  }

  return false;
}

async function handleTradePanelCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId || !data.startsWith("tradepanel:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_chat_only"));
    return true;
  }
  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
    return true;
  }

  if (data === "tradepanel:open") {
    await answerCallbackQuery(callbackQuery.id, "Opening trading panel");
    await sendTradingPanel(chatId, messageId, userId);
    return true;
  }

  if (data === "tradepanel:close") {
    clearPendingAdminAction(userId);
    await answerCallbackQuery(callbackQuery.id, t(userId, "close_panel"));
    await sendTelegramMessage(chatId, t(userId, "trading_panel_closed"), messageId, {
      reply_markup: buildMainMenuKeyboard(userId)
    });
    return true;
  }

  return true;
}

async function handleScanCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;
  const userName = getDisplayName(callbackQuery.from);

  if (!chatId || !data.startsWith("scan:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_chat_only"));
    return true;
  }
  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
    return true;
  }

  if (data === "scan:start") {
    setPendingAdminAction(userId, { type: "scan_ca" });
    await answerCallbackQuery(callbackQuery.id, "Waiting for CA");
    await sendTelegramMessage(chatId, t(userId, "waiting_for_ca"), messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (data === "scan:cancel") {
    clearPendingAdminAction(userId);
    clearLatestScan(userId);
    await answerCallbackQuery(callbackQuery.id, "Cancelled");
    await sendTelegramMessage(chatId, t(userId, "scan_cancelled"), messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (data === "scan:create_proposal") {
    const latest = getLatestScan(userId);
    if (!latest?.dossier) {
      await answerCallbackQuery(callbackQuery.id, "No scan data");
      await sendTelegramMessage(chatId, t(userId, "no_scan_data"), messageId);
      return true;
    }

    const dossier = latest.dossier;
    const proposal = createProposal({
      token: dossier.token,
      ca: dossier.ca,
      reason: `Scanned via admin panel. Confidence ${dossier.confidence}/95, liquidity ${Math.round(dossier.liquidityUsd).toLocaleString("en-US")} USD, volume ${Math.round(dossier.volumeH24).toLocaleString("en-US")} USD.`,
      score: dossier.confidence,
      dossier,
      createdBy: userName
    });

    await answerCallbackQuery(callbackQuery.id, "Proposal created");
    await sendTelegramMessage(
      chatId,
      t(userId, "proposal_created", dossier, proposal),
      messageId,
      { reply_markup: buildProposalKeyboard(proposal.id, userId) }
    );
    return true;
  }

  return false;
}

async function formatLevel4StatusText() {
  const health = await level4Kernel.healthCheck();
  return `Level4:
initialized: ${health.initialized}
ok: ${health.ok}
writable: ${health.storage?.writable}
dir: ${health.storage?.dataDir || "n/a"}`;
}

async function formatLevel4WalletsText(userId) {
  const wallets = await level4Kernel.wallets.listWallets();
  if (!wallets.length) return t(userId, "level4_wallets_empty");

  return wallets.map((w, i) => {
    return `${i + 1}. ${w.label || w.walletId}
walletId: ${w.walletId}
address: ${w.address}
role: ${w.role || "n/a"}
ownerUserId: ${w.ownerUserId || "n/a"}
active: ${w.isActive}
chain: ${w.chain || "solana"}`;
  }).join("\n\n");
}

async function sendLevel5InitWarning(chatId, messageId, userId, errorMessage) {
  return sendTelegramMessage(
    chatId,
    t(userId, "level5_init_failed", errorMessage),
    messageId,
    { reply_markup: buildTradingPanelKeyboard(userId) }
  );
}

async function handleLevel4InlineCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;
  const userName = getDisplayName(callbackQuery.from);

  if (!chatId || !data.startsWith("level4:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_chat_only"));
    return true;
  }
  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
    return true;
  }

  if (data === "level4:add_leader_prompt") {
    setPendingAdminAction(userId, { type: "level4_add_leader" });
    await answerCallbackQuery(callbackQuery.id, "Add leader");
    await sendTelegramMessage(chatId, t(userId, "prompt_add_leader"), messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (data === "level4:add_follower_prompt") {
    setPendingAdminAction(userId, { type: "level4_add_follower" });
    await answerCallbackQuery(callbackQuery.id, "Add follower");
    await sendTelegramMessage(chatId, t(userId, "prompt_add_follower"), messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (data === "level4:link_copy_prompt") {
    setPendingAdminAction(userId, { type: "level4_link_copy" });
    await answerCallbackQuery(callbackQuery.id, "Link copy");
    await sendTelegramMessage(chatId, t(userId, "prompt_link_copy"), messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (data === "level4:copy_plan_prompt") {
    setPendingAdminAction(userId, { type: "level4_copy_plan" });
    await answerCallbackQuery(callbackQuery.id, "Copy plan");
    await sendTelegramMessage(chatId, t(userId, "prompt_copy_plan"), messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (data === "level4:top_leaders") {
    const result = await handleTradingCommand("/top_leaders 10", userName, level4Kernel, tradingCommandContext());
    await answerCallbackQuery(callbackQuery.id, result.ok ? "Top leaders" : "Failed");
    await sendTelegramMessage(chatId, result.ok ? result.message : result.error, messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  return false;
}

async function handleLevel5InlineCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;
  const userName = getDisplayName(callbackQuery.from);

  if (!chatId || !data.startsWith("level5:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_chat_only"));
    return true;
  }
  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
    return true;
  }

  if (!autoCopyTrader) {
    await answerCallbackQuery(callbackQuery.id, "Level5 unavailable");
    await sendLevel5InitWarning(chatId, messageId, userId, "autoCopyTrader is not initialized");
    return true;
  }

  if (data === "level5:autocopy_on") {
    const result = await handleTradingCommand("/autocopy_on", userName, level4Kernel, tradingCommandContext());
    await answerCallbackQuery(callbackQuery.id, result.ok ? "AutoCopy ON" : "Failed");
    await sendTelegramMessage(chatId, result.ok ? result.message : result.error, messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (data === "level5:autocopy_off") {
    const result = await handleTradingCommand("/autocopy_off", userName, level4Kernel, tradingCommandContext());
    await answerCallbackQuery(callbackQuery.id, result.ok ? "AutoCopy OFF" : "Failed");
    await sendTelegramMessage(chatId, result.ok ? result.message : result.error, messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (data === "level5:autocopy_status") {
    const result = await handleTradingCommand("/autocopy_status", userName, level4Kernel, tradingCommandContext());
    await answerCallbackQuery(callbackQuery.id, result.ok ? "Status" : "Failed");
    await sendTelegramMessage(chatId, result.ok ? result.message : result.error, messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (data === "level5:execute_copy_now_prompt") {
    setPendingAdminAction(userId, { type: "level5_execute_copy_now" });
    await answerCallbackQuery(callbackQuery.id, "Execute copy now");
    await sendTelegramMessage(chatId, t(userId, "prompt_execute_copy_now"), messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  return false;
}

async function handleProposalCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const userId = callbackQuery.from?.id;

  if (!data.startsWith("proposal:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_chat_only"));
    return true;
  }

  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
    return true;
  }

  const parts = data.split(":");
  const action = parts[1];
  const proposalId = parts[2];

  if (action === "approve") return handleProposalApprove(callbackQuery, proposalId);
  if (action === "reject") return handleProposalReject(callbackQuery, proposalId);
  return true;
}

async function handleTradeCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!data.startsWith("trade:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_chat_only"));
    return true;
  }
  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
    return true;
  }

  if (data === "trade:show_status") {
    try {
      const result = handleTradingAdminCallback(data);
      const level4Text = await formatLevel4StatusText();
      await answerCallbackQuery(callbackQuery.id, "Updated");
      await sendTelegramMessage(chatId, `${result.message}

${level4Text}`, messageId, {
        reply_markup: buildTradingPanelKeyboard(userId)
      });
      return true;
    } catch (error) {
      await answerCallbackQuery(callbackQuery.id, "Failed");
      await sendTelegramMessage(chatId, t(userId, "level4_status_error", error.message), messageId, {
        reply_markup: buildTradingPanelKeyboard(userId)
      });
      return true;
    }
  }

  if (data === "trade:show_wallets") {
    try {
      const text = await formatLevel4WalletsText(userId);
      await answerCallbackQuery(callbackQuery.id, "Updated");
      await sendTelegramMessage(chatId, text, messageId, {
        reply_markup: buildTradingPanelKeyboard(userId)
      });
      return true;
    } catch (error) {
      await answerCallbackQuery(callbackQuery.id, "Failed");
      await sendTelegramMessage(chatId, t(userId, "level4_wallets_error", error.message), messageId, {
        reply_markup: buildTradingPanelKeyboard(userId)
      });
      return true;
    }
  }

  const result = handleTradingAdminCallback(data);
  if (!result.ok) {
    await answerCallbackQuery(callbackQuery.id, "Failed");
    return true;
  }

  await answerCallbackQuery(callbackQuery.id, "Updated");
  await sendTradingPanel(chatId, messageId, userId);
  return true;
}

async function handleAdminCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!data.startsWith("admin:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "private_chat_only"));
    return true;
  }
  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, t(userId, "admins_only"));
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

      const payload = await res.json();
      if (!payload?.ok) throw new Error(payload?.error || "runtime update failed");
    }

    await answerCallbackQuery(callbackQuery.id, "Updated");
    await sendAdminPanel(chatId, messageId, userId);
    return true;
  } catch (error) {
    await answerCallbackQuery(callbackQuery.id, "Update failed");
    return true;
  }
}

async function handleAdminAndTradingCallback(callbackQuery) {
  if (await handleLanguageCallback(callbackQuery)) return true;
  if (await handleMenuCallback(callbackQuery)) return true;
  if (await handleTradePanelCallback(callbackQuery)) return true;
  if (await handleScanCallback(callbackQuery)) return true;
  if (await handleLevel4InlineCallback(callbackQuery)) return true;
  if (await handleLevel5InlineCallback(callbackQuery)) return true;
  if (await handleProposalCallback(callbackQuery)) return true;
  if (await handleTradeCallback(callbackQuery)) return true;
  if (await handleAdminCallback(callbackQuery)) return true;
  return false;
}

async function handleScanByCA(chatId, userId, messageId, tokenNameHint, ca) {
  await sendTyping(chatId);
  const dossierResult = await buildTokenDossier(ca, tokenNameHint || "");

  if (!dossierResult.ok) {
    await sendTelegramMessage(chatId, t(userId, "scan_failed", dossierResult.error), messageId);
    return;
  }

  const dossier = dossierResult.dossier;
  setLatestScan(userId, dossier);
  clearPendingAdminAction(userId);

  await sendTelegramMessage(chatId, t(userId, "scan_result_title", dossier), messageId, {
    reply_markup: buildScanResultKeyboard(userId)
  });
}

async function handlePendingAdminInput(message) {
  const userId = String(message.from?.id || "");
  const pending = getPendingAdminAction(userId);
  const userName = getDisplayName(message.from);

  if (!pending) return false;
  if (!isPrivateChat(message)) return false;
  if (!isAdmin(userId)) return false;

  const text = normalizeText(message.text);

  if (cleanLower(text) === "/cancel") {
    clearPendingAdminAction(userId);
    await sendTelegramMessage(message.chat.id, t(userId, "pending_cancelled"), message.message_id, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (pending.type === "scan_ca") {
    if (!isProbablySolanaAddress(text)) {
      await sendTelegramMessage(message.chat.id, t(userId, "invalid_ca"), message.message_id);
      return true;
    }

    await handleScanByCA(message.chat.id, userId, message.message_id, "", text);
    return true;
  }

  if (pending.type === "level4_add_leader") {
    const result = await handleTradingCommand(`/add_leader ${text}`, userName, level4Kernel, tradingCommandContext());
    clearPendingAdminAction(userId);
    await sendTelegramMessage(message.chat.id, result.ok ? result.message : result.error, message.message_id, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (pending.type === "level4_add_follower") {
    const result = await handleTradingCommand(`/add_follower ${text}`, userName, level4Kernel, tradingCommandContext());
    clearPendingAdminAction(userId);
    await sendTelegramMessage(message.chat.id, result.ok ? result.message : result.error, message.message_id, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (pending.type === "level4_link_copy") {
    const result = await handleTradingCommand(`/link_copy ${text}`, userName, level4Kernel, tradingCommandContext());
    clearPendingAdminAction(userId);
    await sendTelegramMessage(message.chat.id, result.ok ? result.message : result.error, message.message_id, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (pending.type === "level4_copy_plan") {
    const result = await handleTradingCommand(`/copy_plan ${text}`, userName, level4Kernel, tradingCommandContext());
    clearPendingAdminAction(userId);
    await sendTelegramMessage(message.chat.id, result.ok ? result.message : result.error, message.message_id, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (pending.type === "level5_execute_copy_now") {
    if (!autoCopyTrader) {
      clearPendingAdminAction(userId);
      await sendLevel5InitWarning(message.chat.id, message.message_id, userId, "autoCopyTrader is not initialized");
      return true;
    }

    const result = await handleTradingCommand(`/execute_copy_now ${text}`, userName, level4Kernel, tradingCommandContext());
    clearPendingAdminAction(userId);
    await sendTelegramMessage(message.chat.id, result.ok ? result.message : result.error, message.message_id, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  return false;
}

async function handleCommandMessage(message) {
  const text = normalizeText(message.text);
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "anonymous");
  const messageId = message.message_id;
  const userName = getDisplayName(message.from);
  const username = message.from?.username || "";

  if (
    isTradingCommand(text) &&
    !text.startsWith("/propose") &&
    !text.startsWith("/scan_ca") &&
    !text.startsWith("/tradepanel")
  ) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, t(userId, "private_only_trading"), messageId);
      return true;
    }
    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, t(userId, "admins_only"), messageId);
      return true;
    }

    const result = await handleTradingCommand(text, userName, level4Kernel, tradingCommandContext());
    await sendTelegramMessage(chatId, result.ok ? result.message : result.error, messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
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

  if (text.startsWith("/scan_ca")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, t(userId, "private_only_scan"), messageId);
      return true;
    }
    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, t(userId, "admins_only"), messageId);
      return true;
    }

    setPendingAdminAction(userId, { type: "scan_ca" });
    await sendTelegramMessage(chatId, t(userId, "waiting_for_ca"), messageId, {
      reply_markup: buildTradingPanelKeyboard(userId)
    });
    return true;
  }

  if (text.startsWith("/language")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, t(userId, "language_private_only"), messageId);
      return true;
    }

    await sendTelegramMessage(chatId, t(userId, "language_prompt"), messageId, {
      reply_markup: buildLanguageKeyboard(userId)
    });
    return true;
  }

  if (text.startsWith("/propose")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, t(userId, "private_only_proposals"), messageId);
      return true;
    }
    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, t(userId, "admins_only"), messageId);
      return true;
    }

    const parsed = parseProposeCommand(text);
    if (!parsed.ok) {
      await sendTelegramMessage(chatId, parsed.error, messageId);
      return true;
    }

    await handleScanByCA(chatId, userId, messageId, parsed.tokenName, parsed.ca);
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
    await sendMainMenu(chatId, messageId, userId);
    return true;
  }

  if (text.startsWith("/admin")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, t(userId, "private_only_admin"), messageId);
      return true;
    }
    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, t(userId, "admins_only"), messageId);
      return true;
    }

    await sendAdminPanel(chatId, messageId, userId);
    return true;
  }

  if (text.startsWith("/status")) {
    const cfg = await getRuntimeConfig();
    const trading = getTradingRuntime();

    await sendTelegramMessage(chatId, t(userId, "runtime_status", cfg, trading), messageId, {
      reply_markup: buildMainMenuKeyboard(userId)
    });
    return true;
  }

  if (text.startsWith("/trade_status")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, t(userId, "private_only_trade_status"), messageId);
      return true;
    }
    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, t(userId, "admins_only"), messageId);
      return true;
    }

    try {
      const level4Text = await formatLevel4StatusText();
      await sendTelegramMessage(chatId, `${formatTradingStatus()}

${level4Text}`, messageId, {
        reply_markup: buildTradingPanelKeyboard(userId)
      });
      return true;
    } catch (error) {
      await sendTelegramMessage(chatId, t(userId, "level4_status_error", error.message), messageId, {
        reply_markup: buildTradingPanelKeyboard(userId)
      });
      return true;
    }
  }

  if (text.startsWith("/wallets")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(chatId, t(userId, "private_only_trading"), messageId);
      return true;
    }
    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, t(userId, "admins_only"), messageId);
      return true;
    }

    try {
      const walletsText = await formatLevel4WalletsText(userId);
      await sendTelegramMessage(chatId, walletsText, messageId, {
        reply_markup: buildTradingPanelKeyboard(userId)
      });
      return true;
    } catch (error) {
      await sendTelegramMessage(chatId, t(userId, "level4_wallets_error", error.message), messageId, {
        reply_markup: buildTradingPanelKeyboard(userId)
      });
      return true;
    }
  }

  if (text.startsWith("/ca") || isCARequest(text)) {
    await sendTelegramMessage(chatId, `CA
${TOKEN_CA}

Website
${WEBSITE_URL}`, messageId, {
      reply_markup: buildCAKeyboard(userId)
    });
    return true;
  }

  if (text.startsWith("/website") || isWebsiteRequest(text)) {
    await sendTelegramMessage(chatId, WEBSITE_URL, messageId, {
      reply_markup: buildMainMenuKeyboard(userId)
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
- Reply in ${getUserLanguage(userId)}.
- In a group, answer this specific user directly and clearly.
- No unnecessary repeated self-introductions.
`;

  if (!isPrivateChat(message) && isChatActive(chatId)) {
    prompt += `
The group conversation with you is currently active. Treat this as a direct continuation of dialogue with this same user when appropriate.`;
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

  await sendTelegramMessage(chatId, addressReplyForGroup(message, reply), messageId, {
    reply_markup: buildMainMenuKeyboard(userId)
  });
}

async function handleMessage(message) {
  if (!message || message.text == null) return;

  try {
    const pendingHandled = await handlePendingAdminInput(message);
    if (pendingHandled) return;

    const tradingRejectedInGroup = await maybeRejectTradingCommandInGroup(message);
    if (tradingRejectedInGroup) return;

    const wasCommandHandled = await handleCommandMessage(message);
    if (wasCommandHandled) return;

    await handleRegularMessage(message);
  } catch (error) {
    console.error("handleMessage error:", error);
    try {
      await sendTelegramMessage(
        message.chat.id,
        t(message.from?.id, "stumble"),
        message.message_id,
        { reply_markup: buildMainMenuKeyboard(message.from?.id) }
      );
    } catch (e) {
      console.error("Failed to send fallback message:", e);
    }
  }
}

async function bootstrapLevel5() {
  try {
    level5ExecutionEngine = new Level5ExecutionEngine({
      logger: console
    });

    autoCopyTrader = new Level5AutoCopyTrader({
      kernel: level4Kernel,
      executionEngine: level5ExecutionEngine,
      logger: console
    });

    console.log("Level5 initialized");
  } catch (error) {
    level5ExecutionEngine = null;
    autoCopyTrader = null;
    console.error("Level5 init failed:", error.message);
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

  console.log("Initializing Level 4 Trading Kernel...");
  await level4Kernel.init();
  const level4Health = await level4Kernel.healthCheck();
  console.log("Level4 Health:", level4Health);

  await bootstrapLevel5();
  await setTelegramCommands();

  console.log(`Telegram bot started as @${botUsername || "unknown_bot"}`);
  console.log(`Using backend: ${CHIIKAWA_AI_URL}`);
  console.log(`Forced group scope: ${FORCED_GROUP_CHAT_ID}`);
}

async function setTelegramCommands() {
  const commands = [
    { command: "start", description: "Start talking to Chiikawa" },
    { command: "help", description: "Show help" },
    { command: "menu", description: "Open menu" },
    { command: "admin", description: "Open admin panel (private only)" },
    { command: "tradepanel", description: "Open trading panel (private only)" },
    { command: "status", description: "Show runtime status" },
    { command: "trade_status", description: "Trading status (private only)" },
    { command: "scan_ca", description: "Scan Solana CA (private only)" },
    { command: "propose", description: "Create proposal from token + CA" },
    { command: "language", description: "Choose interface language" },
    { command: "ca", description: "Show contract" },
    { command: "website", description: "Show website" }
  ];

  await tg("setMyCommands", { commands });
  await tg("setMyCommands", { commands, scope: { type: "all_private_chats" } });
  await tg("setMyCommands", { commands, scope: { type: "all_group_chats" } });
  await tg("setMyCommands", { commands, scope: { type: "all_chat_administrators" } });
  await tg("setMyCommands", {
    commands,
    scope: { type: "chat", chat_id: FORCED_GROUP_CHAT_ID }
  });
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
          const handled = await handleAdminAndTradingCallback(update.callback_query);
          if (!handled) {
            await answerCallbackQuery(update.callback_query.id, "");
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
