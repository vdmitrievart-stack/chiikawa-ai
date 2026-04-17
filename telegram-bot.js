import fetch from "node-fetch";
import {
  getTradingRuntime,
  buildTradingAdminKeyboard,
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

// private admin state
const pendingAdminActions = new Map(); // userId -> { type: "scan_ca" }
const latestScans = new Map(); // userId -> { dossier, createdAt }

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

function isProbablySolanaAddress(value) {
  const a = String(value || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
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
  latestScans.set(String(userId), {
    dossier,
    createdAt: Date.now()
  });
}

function getLatestScan(userId) {
  return latestScans.get(String(userId)) || null;
}

function clearLatestScan(userId) {
  latestScans.delete(String(userId));
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
          url: WEBSITE_URL
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
        { text: "Status", callback_data: "menu:status" },
        { text: "Admin", callback_data: "menu:admin" }
      ]
    ]
  };
}

function buildTradingPanelKeyboard() {
  const trading = getTradingRuntime();

  return {
    inline_keyboard: [
      [
        { text: "🔍 Scan CA", callback_data: "scan:start" }
      ],
      [
        { text: "📊 Trade Status", callback_data: "trade:show_status" },
        { text: "👛 Wallets", callback_data: "trade:show_wallets" }
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
        { text: "❎ Close", callback_data: "tradepanel:close" }
      ]
    ]
  };
}

function buildAdminKeyboard(config) {
  const trading = getTradingRuntime();

  return {
    inline_keyboard: [
      [
        { text: "🎛 Trading Panel", callback_data: "tradepanel:open" }
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
      ]
    ]
  };
}

function buildProposalKeyboard(proposalId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `proposal:approve:${proposalId}` },
        { text: "❌ Reject", callback_data: `proposal:reject:${proposalId}` }
      ]
    ]
  };
}

function buildScanResultKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Create proposal", callback_data: "scan:create_proposal" },
        { text: "❌ Cancel", callback_data: "scan:cancel" }
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
• Status`,
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

async function sendTradingPanel(chatId, replyToMessageId = null) {
  const trading = getTradingRuntime();

  return sendTelegramMessage(
    chatId,
    `🎛 Trading Panel

enabled: ${trading.enabled}
mode: ${trading.mode}
killSwitch: ${trading.killSwitch}
buybotAlertMinUsd: ${trading.buybotAlertMinUsd}
trackedWallets: ${Array.isArray(trading.trackedWallets) ? trading.trackedWallets.length : 0}`,
    replyToMessageId,
    { reply_markup: buildTradingPanelKeyboard() }
  );
}

function shouldRespond(message) {
  const text = normalizeText(message.text);
  if (!text) return false;

  if (text.startsWith("/start")) return true;
  if (text.startsWith("/help")) return true;
  if (text.startsWith("/menu")) return true;
  if (text.startsWith("/admin")) return true;
  if (text.startsWith("/tradepanel")) return true;
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
  if (text.startsWith("/propose")) return true;
  if (text.startsWith("/scan_ca")) return true;
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

function isTradingCommand(text) {
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
    "/setbuy",
    "/propose",
    "/scan_ca",
    "/tradepanel"
  ];

  return tradingPrefixes.some(cmd => lower.startsWith(cmd));
}

async function maybeRejectTradingCommandInGroup(message) {
  const text = normalizeText(message.text);
  if (!text.startsWith("/")) return false;

  if (!isTradingCommand(text)) return false;
  if (isPrivateChat(message)) return false;

  await sendTelegramMessage(
    message.chat.id,
    "Trading tools are available only in private chat with the bot.",
    message.message_id
  );
  return true;
}

function parseProposeCommand(text) {
  const parts = String(text || "").trim().split(/\s+/);

  if (parts.length < 3) {
    return {
      ok: false,
      error: "Usage: /propose <token_name> <solana_ca>"
    };
  }

  return {
    ok: true,
    tokenName: parts[1],
    ca: parts[2]
  };
}

async function handleScanByCA(chatId, userId, messageId, tokenNameHint, ca) {
  await sendTyping(chatId);

  const dossierResult = await buildTokenDossier(ca, tokenNameHint || "");

  if (!dossierResult.ok) {
    await sendTelegramMessage(
      chatId,
      `Failed to build dossier:
${dossierResult.error}`,
      messageId
    );
    return;
  }

  const dossier = dossierResult.dossier;
  setLatestScan(userId, dossier);
  clearPendingAdminAction(userId);

  await sendTelegramMessage(
    chatId,
    `🧾 Scan Result

${formatDossierForAdmin(dossier)}`,
    messageId,
    { reply_markup: buildScanResultKeyboard() }
  );
}

async function handleProposalApprove(callbackQuery, proposalId) {
  const proposal = getProposal(proposalId);

  if (!proposal) {
    await answerCallbackQuery(callbackQuery.id, "Proposal not found");
    return true;
  }

  if (proposal.status !== "pending") {
    await answerCallbackQuery(callbackQuery.id, "Already processed");
    return true;
  }

  const execution = await executeTradeMock(proposal);

  if (!execution.ok) {
    updateProposal(proposalId, {
      status: "failed",
      execution
    });

    await answerCallbackQuery(callbackQuery.id, "Execution failed");
    await sendTelegramMessage(
      callbackQuery.message.chat.id,
      `Execution failed for proposal ${proposalId}`,
      callbackQuery.message.message_id
    );
    return true;
  }

  updateProposal(proposalId, {
    status: "approved",
    execution
  });

  await answerCallbackQuery(callbackQuery.id, "Trade executed");

  const publicPost = formatPublicBuyPost(proposal, execution);

  const sent = await sendTelegramMessage(
    FORCED_GROUP_CHAT_ID,
    publicPost
  );

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
    `✅ Proposal approved

Token: ${proposal.token}
CA: ${proposal.ca}
TX: ${execution.tx}

Public buy post sent to the group.`,
    callbackQuery.message.message_id
  );

  return true;
}

async function handleProposalReject(callbackQuery, proposalId) {
  const proposal = getProposal(proposalId);

  if (!proposal) {
    await answerCallbackQuery(callbackQuery.id, "Proposal not found");
    return true;
  }

  updateProposal(proposalId, {
    status: "rejected"
  });

  await answerCallbackQuery(callbackQuery.id, "Rejected");
  await sendTelegramMessage(
    callbackQuery.message.chat.id,
    `❌ Proposal rejected

Token: ${proposal.token}
CA: ${proposal.ca}`,
    callbackQuery.message.message_id
  );

  return true;
}

async function handleTradePanelCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId) return false;
  if (!data.startsWith("tradepanel:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, "Private chat only");
    return true;
  }

  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, "Admins only");
    return true;
  }

  if (data === "tradepanel:open") {
    await answerCallbackQuery(callbackQuery.id, "Opening trading panel");
    await sendTradingPanel(chatId, messageId);
    return true;
  }

  if (data === "tradepanel:close") {
    await answerCallbackQuery(callbackQuery.id, "Closed");
    await sendTelegramMessage(chatId, "Trading panel closed.", messageId);
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

  if (!chatId) return false;
  if (!data.startsWith("scan:")) return false;

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, "Private chat only");
    return true;
  }

  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, "Admins only");
    return true;
  }

  if (data === "scan:start") {
    setPendingAdminAction(userId, { type: "scan_ca" });
    await answerCallbackQuery(callbackQuery.id, "Waiting for CA");
    await sendTelegramMessage(
      chatId,
      `Send me the Solana CA you want to scan.

Example:
7xKXtg2CWd3xgRzx...`,
      messageId
    );
    return true;
  }

  if (data === "scan:cancel") {
    clearPendingAdminAction(userId);
    clearLatestScan(userId);
    await answerCallbackQuery(callbackQuery.id, "Cancelled");
    await sendTelegramMessage(chatId, "Scan cancelled.", messageId);
    return true;
  }

  if (data === "scan:create_proposal") {
    const latest = getLatestScan(userId);

    if (!latest?.dossier) {
      await answerCallbackQuery(callbackQuery.id, "No scan data");
      await sendTelegramMessage(
        chatId,
        "No scan data found. Please scan a CA first.",
        messageId
      );
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
      `🚀 Trade Proposal

${formatDossierForAdmin(dossier)}

Proposal ID:
${proposal.id}`,
      messageId,
      { reply_markup: buildProposalKeyboard(proposal.id) }
    );

    return true;
  }

  return false;
}

async function handleAdminAndTradingCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId) return false;

  const handledTradePanel = await handleTradePanelCallback(callbackQuery);
  if (handledTradePanel) return true;

  const handledScan = await handleScanCallback(callbackQuery);
  if (handledScan) return true;

  if (data.startsWith("proposal:")) {
    if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
      await answerCallbackQuery(callbackQuery.id, "Private chat only");
      return true;
    }

    if (!isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id, "Admins only");
      return true;
    }

    const parts = data.split(":");
    const action = parts[1];
    const proposalId = parts[2];

    if (action === "approve") {
      return handleProposalApprove(callbackQuery, proposalId);
    }

    if (action === "reject") {
      return handleProposalReject(callbackQuery, proposalId);
    }

    return true;
  }

  if (data.startsWith("trade:")) {
    if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
      await answerCallbackQuery(callbackQuery.id, "Private chat only");
      return true;
    }

    if (!isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id, "Admins only");
      return true;
    }

    const result = handleTradingAdminCallback(data);
    if (!result.ok) {
      await answerCallbackQuery(callbackQuery.id, "Failed");
      return true;
    }

    const isTradingPanelAction =
      data === "trade:show_status" ||
      data === "trade:show_wallets" ||
      data === "trade:toggle_enabled" ||
      data === "trade:toggle_kill" ||
      data === "trade:cycle_mode" ||
      data === "trade:buymin_up";

    await answerCallbackQuery(callbackQuery.id, "Updated");

    if (isTradingPanelAction) {
      await sendTradingPanel(chatId, messageId);
    } else {
      const config = await getRuntimeConfig();
      await sendTelegramMessage(
        chatId,
        result.message,
        messageId,
        { reply_markup: buildAdminKeyboard(config) }
      );
    }

    return true;
  }

  if (!data.startsWith("admin:")) {
    return false;
  }

  if (!isPrivateChat(callbackQuery.message || { chat: { type: "unknown" } })) {
    await answerCallbackQuery(callbackQuery.id, "Private chat only");
    return true;
  }

  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, "Admins only");
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
      if (!payload?.ok) {
        throw new Error(payload?.error || "runtime update failed");
      }
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

async function handlePendingAdminInput(message) {
  const userId = String(message.from?.id || "");
  const pending = getPendingAdminAction(userId);

  if (!pending) return false;
  if (!isPrivateChat(message)) return false;
  if (!isAdmin(userId)) return false;

  const text = normalizeText(message.text);

  if (pending.type === "scan_ca") {
    if (!isProbablySolanaAddress(text)) {
      await sendTelegramMessage(
        message.chat.id,
        `That doesn't look like a Solana CA.

Please send a valid Solana mint address.`,
        message.message_id
      );
      return true;
    }

    await handleScanByCA(
      message.chat.id,
      userId,
      message.message_id,
      "",
      text
    );
    return true;
  }

  return false;
}

async function handleCommand(message) {
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
      { reply_markup: buildTradingPanelKeyboard() }
    );
    return true;
  }

  if (text.startsWith("/tradepanel")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(
        chatId,
        "Trading panel is available only in private chat with the bot.",
        messageId
      );
      return true;
    }

    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, "Admins only 🥺", messageId);
      return true;
    }

    await sendTradingPanel(chatId, messageId);
    return true;
  }

  if (text.startsWith("/scan_ca")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(
        chatId,
        "CA scan is available only in private chat with the bot.",
        messageId
      );
      return true;
    }

    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, "Admins only 🥺", messageId);
      return true;
    }

    setPendingAdminAction(userId, { type: "scan_ca" });

    await sendTelegramMessage(
      chatId,
      `Send me the Solana CA you want to scan.`,
      messageId
    );
    return true;
  }

  if (text.startsWith("/propose")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(
        chatId,
        "Trading proposals are available only in private chat with the bot.",
        messageId
      );
      return true;
    }

    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, "Admins only 🥺", messageId);
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
/tradepanel
/status
/trade_status
/scan_ca
/propose <token_name> <solana_ca>
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

  if (text.startsWith("/trade_status")) {
    if (!isPrivateChat(message)) {
      await sendTelegramMessage(
        chatId,
        "Trading status is available only in private chat with the bot.",
        messageId
      );
      return true;
    }

    if (!isAdmin(userId)) {
      await sendTelegramMessage(chatId, "Admins only 🥺", messageId);
      return true;
    }

    await sendTelegramMessage(chatId, formatTradingStatus(), messageId, {
      reply_markup: buildTradingPanelKeyboard()
    });
    return true;
  }

  if (text.startsWith("/ca") || isCARequest(text)) {
    await sendTelegramMessage(
      chatId,
      `CA
${TOKEN_CA}

Website
${WEBSITE_URL}`,
      messageId,
      { reply_markup: buildCAKeyboard() }
    );
    return true;
  }

  if (text.startsWith("/website") || isWebsiteRequest(text)) {
    await sendTelegramMessage(chatId, WEBSITE_URL, messageId);
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
    const pendingHandled = await handlePendingAdminInput(message);
    if (pendingHandled) return;

    const tradingRejectedInGroup = await maybeRejectTradingCommandInGroup(message);
    if (tradingRejectedInGroup) return;

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
