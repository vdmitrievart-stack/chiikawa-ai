import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import * as XLSX from "xlsx";

import {
  getBestTrade,
  getLatestTokenPrice,
  recordTradeOutcomeFromSignalContext,
  analyzeToken
} from "./scan-engine.js";

import {
  getPortfolio,
  getPositions,
  getClosedTrades,
  getStrategyConfig,
  resetPortfolio,
  openPosition,
  closePosition,
  markPosition,
  maybeTakeRunnerPartial,
  setStrategyConfig
} from "./portfolio.js";

import { buildStrategyPlans } from "./strategy-engine.js";
import {
  buildDashboard,
  buildBalanceText,
  buildEntryText,
  buildExitText,
  buildPositionUpdateText,
  buildPeriodicReport
} from "./core/reporting-engine.js";

import {
  DEFAULT_STRATEGY_BUDGET,
  validateBudgetPercents,
  formatBudgetLines
} from "./core/budget-manager.js";

import {
  buildDefaultRuntimeConfig,
  createTradingRuntime,
  startRuntime,
  requestStop,
  requestKill,
  finishRuntime,
  queuePendingConfig,
  canApplyPendingConfig,
  applyPendingConfig,
  isStrategyAllowed,
  canOpenNewPositions
} from "./core/trading-runtime.js";

import WalletExecutionRouter from "./wallets/wallet-execution-router.js";
import CopytradeManager from "./copytrade/copytrade-manager.js";
import GMGNLeaderIntelService from "./gmgn/gmgn-leader-intel-service.js";

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chiikawa_secret";
const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;
const AUTO_INTERVAL_MS = Number(process.env.AUTO_INTERVAL_MS || 60000);
const DEX_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";

if (!TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

const walletRouter = new WalletExecutionRouter({ logger: console });
const copytradeManager = new CopytradeManager({ logger: console });
const gmgnLeaderIntel = new GMGNLeaderIntelService({ logger: console });

const runtime = createTradingRuntime(
  buildDefaultRuntimeConfig({
    language: "ru",
    dryRun: true,
    strategyBudget: { ...DEFAULT_STRATEGY_BUDGET },
    wallets: {
      wallet_trader_main: {
        label: "Trader Main",
        role: "trader",
        enabled: true,
        executionMode: "dry_run",
        allowedStrategies: ["scalp", "reversal"],
        secretRef: ""
      },
      wallet_runner_main: {
        label: "Runner Main",
        role: "trader",
        enabled: true,
        executionMode: "dry_run",
        allowedStrategies: ["runner"],
        secretRef: ""
      },
      wallet_copy_1: {
        label: "Copy Follower 1",
        role: "follower",
        enabled: true,
        executionMode: "dry_run",
        allowedStrategies: ["copytrade"],
        secretRef: ""
      }
    },
    strategyRouting: {
      scalp: ["wallet_trader_main"],
      reversal: ["wallet_trader_main"],
      runner: ["wallet_runner_main"],
      copytrade: ["wallet_copy_1"]
    },
    copytrade: {
      enabled: true,
      rescoringEnabled: true,
      minLeaderScore: 70,
      cooldownMinutes: 180,
      leaders: []
    }
  })
);

let loopId = null;
let stopTimeoutId = null;
let previousReportEquity = null;

const recentlyTraded = new Map();
const tempFiles = new Set();
const chatState = new Map();

const I18N = {
  ru: {
    menu_run_multi: "🚀 Run Multi",
    menu_run_scalp: "⚡ Run Scalp",
    menu_run_reversal: "↩️ Run Reversal",
    menu_run_runner: "🏃 Run Runner",
    menu_run_copy: "📋 Run Copytrade",
    menu_stop: "🛑 Stop",
    menu_kill: "☠️ Kill",
    menu_status: "📊 Status",
    menu_scan_market: "🔎 Scan Market",
    menu_scan_ca: "🧾 Scan CA",
    menu_balance: "💰 Balance",
    menu_wallets: "👛 Wallets",
    menu_copytrade: "📋 Copytrade",
    menu_budget: "🧮 Budget",
    menu_gmgn_status: "🛰 GMGN Status",
    menu_leader_health: "🫀 Leader Health",
    menu_sync_leaders: "🔄 Sync Leaders",
    menu_language: "🌐 Language",
    menu_export_csv: "📈 Export CSV",
    menu_export_json: "📦 Export JSON",
    menu_export_xlsx: "📊 Export XLSX",
    ready: "🤖 <b>Бот готов</b>",
    send_ca: "🧾 <b>Send CA</b>\n\nОтправь контракт следующим сообщением.",
    invalid_ca: "❌ Это не похоже на валидный CA.",
    scan_hint: "Сначала нажми <b>🧾 Scan CA</b>, потом отправь адрес.",
    bot_stopped: "🛑 Мягкая остановка включена. Новые входы запрещены, открытые позиции будут сопровождаться до выхода.",
    bot_killed: "☠️ Жесткая остановка выполнена. Все позиции закрыты.",
    market_scan_started: "🔎 <b>Скан рынка запущен</b>",
    choose_lang: "🌐 Выбери язык:\n<code>lang ru</code> или <code>lang en</code>",
    lang_set: "🌐 Язык переключен",
    wallets_title: "👛 <b>Кошельки</b>",
    copytrade_title: "📋 <b>Copytrade</b>",
    budget_title: "🧮 <b>Budget</b>",
    gmgn_title: "🛰 <b>GMGN Status</b>",
    leader_title: "🫀 <b>Leader Health</b>",
    add_leader_prompt: "✍️ Отправь address лидера следующим сообщением.",
    add_secret_prompt: "🔐 Отправь в следующем сообщении строку вида:\n<code>wallet_id env:SECRET_NAME</code>",
    budget_prompt: "Отправь: <code>budget 25 25 25 25</code>",
    pending_budget_saved: "✅ Pending budget сохранен",
    pending_applied: "✅ Pending config применен",
    leader_added: "✅ Лидер добавлен",
    secret_saved: "✅ Secret ref сохранен",
    leaders_synced: "✅ Лидеры синхронизированы",
    run_started: "✅ Запуск выполнен",
    stop_complete: "✅ Stop завершен. Открытых позиций больше нет.",
    unknown: "Используйте меню ниже."
  },
  en: {
    menu_run_multi: "🚀 Run Multi",
    menu_run_scalp: "⚡ Run Scalp",
    menu_run_reversal: "↩️ Run Reversal",
    menu_run_runner: "🏃 Run Runner",
    menu_run_copy: "📋 Run Copytrade",
    menu_stop: "🛑 Stop",
    menu_kill: "☠️ Kill",
    menu_status: "📊 Status",
    menu_scan_market: "🔎 Scan Market",
    menu_scan_ca: "🧾 Scan CA",
    menu_balance: "💰 Balance",
    menu_wallets: "👛 Wallets",
    menu_copytrade: "📋 Copytrade",
    menu_budget: "🧮 Budget",
    menu_gmgn_status: "🛰 GMGN Status",
    menu_leader_health: "🫀 Leader Health",
    menu_sync_leaders: "🔄 Sync Leaders",
    menu_language: "🌐 Language",
    menu_export_csv: "📈 Export CSV",
    menu_export_json: "📦 Export JSON",
    menu_export_xlsx: "📊 Export XLSX",
    ready: "🤖 <b>Bot ready</b>",
    send_ca: "🧾 <b>Send CA</b>\n\nSend the token contract in the next message.",
    invalid_ca: "❌ This does not look like a valid CA.",
    scan_hint: "First press <b>🧾 Scan CA</b>, then send the address.",
    bot_stopped: "🛑 Soft stop enabled. No new entries, existing positions will be managed until exit.",
    bot_killed: "☠️ Hard stop executed. All positions closed.",
    market_scan_started: "🔎 <b>Market scan started</b>",
    choose_lang: "🌐 Choose language:\n<code>lang ru</code> or <code>lang en</code>",
    lang_set: "🌐 Language switched",
    wallets_title: "👛 <b>Wallets</b>",
    copytrade_title: "📋 <b>Copytrade</b>",
    budget_title: "🧮 <b>Budget</b>",
    gmgn_title: "🛰 <b>GMGN Status</b>",
    leader_title: "🫀 <b>Leader Health</b>",
    add_leader_prompt: "✍️ Send leader address in the next message.",
    add_secret_prompt: "🔐 Send a line in the next message like:\n<code>wallet_id env:SECRET_NAME</code>",
    budget_prompt: "Send: <code>budget 25 25 25 25</code>",
    pending_budget_saved: "✅ Pending budget saved",
    pending_applied: "✅ Pending config applied",
    leader_added: "✅ Leader added",
    secret_saved: "✅ Secret ref saved",
    leaders_synced: "✅ Leaders synced",
    run_started: "✅ Run started",
    stop_complete: "✅ Stop completed. No open positions left.",
    unknown: "Use the menu below."
  }
};

function t(key) {
  const lang = runtime.activeConfig.language || "ru";
  return I18N[lang]?.[key] || I18N.ru[key] || key;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function keyboard() {
  return {
    keyboard: [
      [t("menu_run_multi"), t("menu_run_scalp")],
      [t("menu_run_reversal"), t("menu_run_runner")],
      [t("menu_run_copy"), t("menu_stop")],
      [t("menu_kill"), t("menu_status")],
      [t("menu_scan_market"), t("menu_scan_ca")],
      [t("menu_balance"), t("menu_budget")],
      [t("menu_wallets"), t("menu_copytrade")],
      [t("menu_gmgn_status"), t("menu_leader_health")],
      [t("menu_sync_leaders"), t("menu_language")],
      [t("menu_export_csv"), t("menu_export_json")],
      [t("menu_export_xlsx")]
    ],
    resize_keyboard: true,
    persistent: true
  };
}

function setChatMode(chatId, mode, payload = {}) {
  chatState.set(chatId, { mode, ...payload, updatedAt: Date.now() });
}

function getChatMode(chatId) {
  return chatState.get(chatId) || { mode: "idle" };
}

function clearChatMode(chatId) {
  chatState.delete(chatId);
}

function normalizeAction(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return null;

  if (raw === "/start" || raw === "/menu") return "start";
  if (raw === "/runmulti" || raw.includes("run multi")) return "run_multi";
  if (raw === "/runscalp" || raw.includes("run scalp")) return "run_scalp";
  if (raw === "/runreversal" || raw.includes("run reversal")) return "run_reversal";
  if (raw === "/runrunner" || raw.includes("run runner")) return "run_runner";
  if (raw === "/runcopytrade" || raw.includes("run copytrade")) return "run_copytrade";
  if (raw === "/stop" || raw.includes("stop")) return "stop";
  if (raw === "/kill" || raw.includes("kill")) return "kill";
  if (raw === "/status" || raw.includes("status")) return "status";
  if (raw === "/balance" || raw.includes("balance")) return "balance";
  if (raw === "/scanmarket" || raw.includes("scan market")) return "scan_market";
  if (raw === "/scanca" || raw === "/ca" || raw.includes("scan ca")) return "scan_ca";
  if (raw === "/language" || raw.includes("language")) return "language";
  if (raw === "/wallets" || raw.includes("wallets")) return "wallets";
  if (raw === "/copytrade" || raw.includes("copytrade")) return "copytrade";
  if (raw === "/budget" || raw.includes("budget")) return "budget";
  if (raw === "/gmgnstatus" || raw.includes("gmgn status")) return "gmgn_status";
  if (raw === "/leaderhealth" || raw.includes("leader health")) return "leader_health";
  if (raw === "/syncleaders" || raw.includes("sync leaders")) return "sync_leaders";
  if (raw === "/addleader") return "add_leader";
  if (raw === "/setsecret") return "set_secret";
  if (raw === "/applypending") return "apply_pending";
  if (raw === "/exportcsv") return "exportcsv";
  if (raw === "/exportjson") return "exportjson";
  if (raw === "/exportxlsx") return "exportxlsx";
  if (raw === "lang ru") return "lang_ru";
  if (raw === "lang en") return "lang_en";

  return null;
}

function isLikelyCA(text) {
  const value = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(value);
}

async function sendMessage(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: false,
    ...extra
  });
}

async function sendPhotoOrText(chatId, imageUrl, caption, extra = {}) {
  const safeCaption = String(caption || "").slice(0, 1024);
  if (imageUrl) {
    try {
      await bot.sendPhoto(chatId, imageUrl, {
        caption: safeCaption,
        parse_mode: "HTML",
        ...extra
      });
      return;
    } catch (error) {
      console.log("sendPhoto fallback:", error.message);
    }
  }
  await sendMessage(chatId, caption, extra);
}

function buildLinksText(links = {}) {
  const rows = [];
  if (links.website) rows.push(`🌐 <a href="${escapeHtml(links.website)}">Website</a>`);
  if (links.twitter) rows.push(`🐦 <a href="${escapeHtml(links.twitter)}">Twitter/X</a>`);
  if (links.telegram) rows.push(`✈️ <a href="${escapeHtml(links.telegram)}">Telegram</a>`);
  if (links.instagram) rows.push(`📸 <a href="${escapeHtml(links.instagram)}">Instagram</a>`);
  if (links.facebook) rows.push(`📘 <a href="${escapeHtml(links.facebook)}">Facebook</a>`);
  return rows.length ? rows.join(" | ") : "none";
}

function buildDexText(token) {
  const rows = [];
  if (token?.url) rows.push(`📊 <a href="${escapeHtml(token.url)}">DexScreener</a>`);
  if (token?.chainId) rows.push(`Chain: ${escapeHtml(token.chainId)}`);
  if (token?.dexId) rows.push(`DEX: ${escapeHtml(token.dexId)}`);
  return rows.join(" | ") || "n/a";
}

function buildHeroCaption(analyzed) {
  const tkn = analyzed.token || {};
  const links = analyzed.socials?.links || {};
  return `🧾 <b>Scanning CA</b>

<b>${escapeHtml(tkn.name || "Unknown")}</b>
<code>${escapeHtml(tkn.ca || "")}</code>

<b>Links:</b> ${buildLinksText(links)}
<b>Dex:</b> ${buildDexText(tkn)}`.slice(0, 1024);
}

function buildAnalysisText(analyzed, plans) {
  const tkn = analyzed.token || {};
  const reasons = (analyzed.reasons || [])
    .slice(0, 14)
    .map((r) => `• ${escapeHtml(r)}`)
    .join("\n");

  const plansText = plans.length
    ? plans
        .map(
          (p) =>
            `• <b>${escapeHtml(p.strategyKey.toUpperCase())}</b> | edge ${round(
              p.expectedEdgePct,
              2
            )}% | hold ${Math.round(p.plannedHoldMs / 60000)}m | SL ${p.stopLossPct}% | TP ${
              p.takeProfitPct || "runner"
            }`
        )
        .join("\n")
    : "• none";

  return `🔎 <b>ANALYSIS</b>

<b>Token:</b> ${escapeHtml(tkn.name || "Unknown")}
<b>Symbol:</b> ${escapeHtml(tkn.symbol || "")}
<b>CA:</b> <code>${escapeHtml(tkn.ca || "")}</code>

<b>Dex:</b> ${buildDexText(tkn)}
<b>DEX Paid:</b> ${escapeHtml(analyzed.dexPaid?.status || "Unknown")}
<b>Token Type:</b> ${escapeHtml(analyzed.mechanics?.tokenType || "Unknown")}
<b>Reward Model:</b> ${escapeHtml(analyzed.mechanics?.rewardModel || "Unknown")}
<b>Beneficiary Signal:</b> ${escapeHtml(analyzed.mechanics?.beneficiarySignal || "Unknown")}
<b>Claim Signal:</b> ${escapeHtml(analyzed.mechanics?.claimSignal || "Unknown")}

<b>Price:</b> ${escapeHtml(tkn.price)}
<b>Liquidity:</b> ${escapeHtml(tkn.liquidity)}
<b>Volume 24h:</b> ${escapeHtml(tkn.volume)}
<b>Txns 24h:</b> ${escapeHtml(tkn.txns)}
<b>FDV:</b> ${escapeHtml(tkn.fdv)}

<b>Narrative:</b> ${escapeHtml(analyzed.narrative?.verdict || "Unknown")}
<b>Links:</b> ${buildLinksText(analyzed.socials?.links || {})}

<b>Available plans</b>
${plansText}

<b>Reasons:</b>
${reasons || "• none"}`;
}

function buildWalletsText() {
  const lines = [t("wallets_title"), ""];
  for (const [walletId, w] of Object.entries(runtime.activeConfig.wallets || {})) {
    const validation = walletRouter.validateWalletForAnyUse(runtime.activeConfig, walletId);
    lines.push(
      `• <b>${escapeHtml(walletId)}</b>
label: ${escapeHtml(w.label || "-")}
role: ${escapeHtml(w.role || "-")}
enabled: ${w.enabled ? "yes" : "no"}
mode: ${escapeHtml(w.executionMode || "dry_run")}
strategies: ${escapeHtml((w.allowedStrategies || []).join(", ") || "-")}
secretRef: ${escapeHtml(w.secretRef || "-")}
ready: ${validation.ok ? "yes" : "no"} (${escapeHtml(validation.reason || "ok")})`
    );
    lines.push("");
  }
  lines.push(`<code>/setsecret</code>`);
  return lines.join("\n");
}

function buildCopytradeText() {
  const leaders = copytradeManager.listLeaders(runtime.activeConfig);
  const lines = [t("copytrade_title"), ""];
  lines.push(`enabled: ${runtime.activeConfig.copytrade.enabled ? "yes" : "no"}`);
  lines.push(`rescoring: ${runtime.activeConfig.copytrade.rescoringEnabled ? "yes" : "no"}`);
  lines.push(`min score: ${runtime.activeConfig.copytrade.minLeaderScore}`);
  lines.push(`cooldown min: ${runtime.activeConfig.copytrade.cooldownMinutes}`);
  lines.push("");

  if (!leaders.length) {
    lines.push("leaders: none");
  } else {
    for (const leader of leaders) {
      lines.push(
        `• <b>${escapeHtml(leader.address)}</b>
state: ${escapeHtml(leader.state)}
score: ${safeNum(leader.score)}
source: ${escapeHtml(leader.source || "manual")}
last sync: ${escapeHtml(leader.lastSyncAt || "-")}`
      );
      lines.push("");
    }
  }

  lines.push(`<code>/addleader</code>`);
  return lines.join("\n");
}

function buildBudgetText() {
  const current = runtime.activeConfig.strategyBudget || DEFAULT_STRATEGY_BUDGET;
  const pending = runtime.pendingConfig?.strategyBudget || null;

  return `${t("budget_title")}

<b>Current</b>
${formatBudgetLines(current)}

<b>Pending</b>
${pending ? formatBudgetLines(pending) : "none"}

${t("budget_prompt")}`;
}

function buildGmgnStatusText() {
  const h = gmgnLeaderIntel.getHealth();
  return `${t("gmgn_title")}

enabled: ${h.enabled ? "yes" : "no"}
mode: ${escapeHtml(h.mode)}
auto refresh sec: ${h.autoRefreshSec}
min recent winrate: ${h.minRecentWinrate}
min recent pnl pct: ${h.minRecentPnlPct}
max drawdown pct: ${h.maxLeaderDrawdownPct}
cooldown min: ${h.cooldownMin}
cached leaders: ${h.cachedLeaders}`;
}

async function buildLeaderHealthText() {
  const leaders = copytradeManager.listLeaders(runtime.activeConfig);
  if (!leaders.length) {
    return `${t("leader_title")}

leaders: none`;
  }

  const intel = await gmgnLeaderIntel.refreshMany(leaders.map((x) => x.address));

  const lines = [t("leader_title"), ""];
  for (const row of intel) {
    lines.push(
      `• <b>${escapeHtml(row.address)}</b>
state: ${escapeHtml(row.state)}
score: ${safeNum(row.score)}
recent winrate: ${safeNum(row.recentWinrate)}%
recent pnl: ${safeNum(row.recentPnlPct)}%
max drawdown: ${safeNum(row.maxDrawdownPct)}%
source: ${escapeHtml(row.source)}
last sync: ${escapeHtml(row.lastSyncAt)}`
    );
    lines.push("");
  }

  return lines.join("\n");
}

function shouldClosePosition(position, analyzedNow) {
  const mark = position.lastMark;
  if (!mark) return { close: false, reason: "NO_MARK" };

  const ageMs = mark.ageMs;

  if (position.strategy === "scalp") {
    if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) return { close: true, reason: "SCALP_STOP" };
    if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) return { close: true, reason: "SCALP_TP" };
    if (ageMs >= position.plannedHoldMs) return { close: true, reason: "SCALP_TIME_EXIT" };
    return { close: false, reason: "SCALP_HOLD" };
  }

  if (position.strategy === "reversal") {
    if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) return { close: true, reason: "REVERSAL_STOP" };
    if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) return { close: true, reason: "REVERSAL_TP" };
    if (ageMs >= position.plannedHoldMs && mark.netPnlPct < 8) return { close: true, reason: "REVERSAL_TIME_EXIT" };
    if (analyzedNow?.corpse?.isCorpse) return { close: true, reason: "REVERSAL_CORPSE_EXIT" };
    return { close: false, reason: "REVERSAL_HOLD" };
  }

  if (position.strategy === "runner") {
    if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) return { close: true, reason: "RUNNER_STOP" };
    const pullbackFromHighPct =
      position.highestPrice > 0
        ? ((position.highestPrice - mark.currentPrice) / position.highestPrice) * 100
        : 0;
    if (mark.grossPnlPct > 25 && pullbackFromHighPct > 12) {
      return { close: true, reason: "RUNNER_TRAIL_EXIT" };
    }
    if (analyzedNow?.corpse?.isCorpse) return { close: true, reason: "RUNNER_CORPSE_EXIT" };
    return { close: false, reason: "RUNNER_HOLD" };
  }

  if (position.strategy === "copytrade") {
    if (mark.netPnlPct <= -Math.abs(position.stopLossPct)) return { close: true, reason: "COPY_STOP" };
    if (mark.netPnlPct >= Math.abs(position.takeProfitPct)) return { close: true, reason: "COPY_TP" };
    if (ageMs >= position.plannedHoldMs) return { close: true, reason: "COPY_TIME_EXIT" };
    return { close: false, reason: "COPY_HOLD" };
  }

  return { close: false, reason: "HOLD" };
}

async function scheduleTempCleanup(filePath) {
  tempFiles.add(filePath);
  setTimeout(async () => {
    try {
      await fs.unlink(filePath);
    } catch {}
    tempFiles.delete(filePath);
  }, 5 * 60 * 1000);
}

function statsToCsv() {
  const closed = getClosedTrades();
  const header = [
    "id",
    "strategy",
    "token",
    "ca",
    "entryRef",
    "entryEffective",
    "exitRef",
    "amountSol",
    "netPnlPct",
    "netPnlSol",
    "reason",
    "openedAt",
    "closedAt",
    "durationMs",
    "balanceAfter"
  ];

  const rows = closed.map((tr) => [
    tr.id,
    tr.strategy,
    tr.token,
    tr.ca,
    tr.entryReferencePrice,
    tr.entryEffectivePrice,
    tr.exitReferencePrice,
    tr.amountSol,
    tr.netPnlPct,
    tr.netPnlSol,
    tr.reason,
    tr.openedAt,
    tr.closedAt,
    tr.durationMs,
    tr.balanceAfter
  ]);

  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function statsToXlsxWorkbook() {
  const pf = getPortfolio();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { metric: "runId", value: runtime.runId || "" },
      { metric: "mode", value: runtime.mode },
      { metric: "scope", value: runtime.strategyScope },
      { metric: "cash", value: pf.cash },
      { metric: "equity", value: pf.equity },
      { metric: "realizedPnlSol", value: pf.realizedPnlSol },
      { metric: "unrealizedPnlSol", value: pf.unrealizedPnlSol }
    ]),
    "summary"
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pf.closedTrades), "trades");
  return wb;
}

async function exportJson(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${runtime.runId || Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(getPortfolio(), null, 2), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/json"
  });
  await scheduleTempCleanup(filePath);
}

async function exportCsv(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${runtime.runId || Date.now()}.csv`);
  await fs.writeFile(filePath, statsToCsv(), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "text/csv"
  });
  await scheduleTempCleanup(filePath);
}

async function exportXlsx(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${runtime.runId || Date.now()}.xlsx`);
  XLSX.writeFile(statsToXlsxWorkbook(), filePath);
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  await scheduleTempCleanup(filePath);
}

function pruneRecentlyTraded() {
  const now = Date.now();
  for (const [ca, ts] of recentlyTraded.entries()) {
    if (now - ts > 2 * 60 * 60 * 1000) recentlyTraded.delete(ca);
  }
}

async function syncLeaderScores() {
  const leaders = copytradeManager.listLeaders(runtime.activeConfig);
  if (!leaders.length) return [];

  const intel = await gmgnLeaderIntel.refreshMany(leaders.map((x) => x.address));
  for (const row of intel) {
    copytradeManager.setLeaderScore(runtime.activeConfig, row.address, row.score);
  }
  copytradeManager.refreshLeaderStates(runtime.activeConfig);
  return intel;
}

function syncPortfolioStrategyBudget() {
  const cfg = getStrategyConfig();
  const nextCfg = {
    ...cfg,
    scalp: { ...(cfg.scalp || {}), allocationPct: runtime.activeConfig.strategyBudget.scalp },
    reversal: { ...(cfg.reversal || {}), allocationPct: runtime.activeConfig.strategyBudget.reversal },
    runner: { ...(cfg.runner || {}), allocationPct: runtime.activeConfig.strategyBudget.runner },
    copytrade: { ...(cfg.copytrade || {}), allocationPct: runtime.activeConfig.strategyBudget.copytrade }
  };
  setStrategyConfig(nextCfg);
}

async function applyPendingIfPossible(chatId = null) {
  if (!canApplyPendingConfig(runtime, getPositions().length)) return false;
  applyPendingConfig(runtime);
  syncPortfolioStrategyBudget();
  if (chatId) {
    await sendMessage(chatId, t("pending_applied"), { reply_markup: keyboard() });
  }
  return true;
}

function stopLoop() {
  if (loopId) clearInterval(loopId);
  if (stopTimeoutId) clearTimeout(stopTimeoutId);
  loopId = null;
  stopTimeoutId = null;
  finishRuntime(runtime);
}

async function forceCloseAllPositions(reason = "KILL_SWITCH") {
  const closed = [];
  for (const p of [...getPositions()]) {
    const price = p.lastPrice || p.entryReferencePrice;
    const row = closePosition(p.id, price, reason);
    if (row) {
      recentlyTraded.set(row.ca, Date.now());
      await recordTradeOutcomeFromSignalContext(row.signalContext, row.netPnlPct);
      closed.push(row);
    }
  }
  return closed;
}

async function cycle(chatId, userId) {
  runtime.cycleCount += 1;
  runtime.lastCycleAt = Date.now();
  pruneRecentlyTraded();

  const positions = getPositions();

  for (const p of positions) {
    const latest = await getLatestTokenPrice(p.ca);
    if (!latest?.price) continue;

    const mark = markPosition(p, latest.price);
    if (!mark) continue;

    const partial = maybeTakeRunnerPartial(p, latest.price);
    if (partial) {
      await sendMessage(
        chatId,
        `🎯 <b>RUNNER PARTIAL</b>

<b>Token:</b> ${escapeHtml(p.token)}
<b>Target:</b> ${partial.targetPct}%
<b>Sold fraction:</b> ${round(partial.soldFraction * 100, 0)}%
<b>Cash added:</b> ${round(partial.netValueSol, 4)} SOL`
      );
    }

    const analyzedNow = await getBestTrade({ excludeCas: [] }).catch(() => null);
    const verdict = shouldClosePosition(p, analyzedNow?.token?.ca === p.ca ? analyzedNow : null);

    await sendMessage(chatId, buildPositionUpdateText(p, mark, verdict.reason));

    if (verdict.close) {
      const closed = closePosition(p.id, latest.price, verdict.reason);
      if (closed) {
        recentlyTraded.set(closed.ca, Date.now());
        await recordTradeOutcomeFromSignalContext(closed.signalContext, closed.netPnlPct);
        await sendPhotoOrText(chatId, closed.signalContext?.imageUrl || null, buildExitText(closed));
      }
    }
  }

  if (runtime.stopRequested && getPositions().length === 0) {
    await applyPendingIfPossible(chatId);
    stopLoop();
    await sendMessage(chatId, t("stop_complete"), { reply_markup: keyboard() });
    return;
  }

  if (!canOpenNewPositions(runtime)) {
    const portfolio = getPortfolio();
    const shouldReport =
      !runtime.lastStatusAt || Date.now() - runtime.lastStatusAt >= 15 * 60 * 1000;

    if (shouldReport) {
      runtime.lastStatusAt = Date.now();
      const report = buildPeriodicReport(runtime, portfolio, previousReportEquity);
      previousReportEquity = portfolio.equity;
      await sendMessage(chatId, report, { reply_markup: keyboard() });
    }
    return;
  }

  const candidate = await getBestTrade({
    excludeCas: [...recentlyTraded.keys(), ...getPositions().map((p) => p.ca)]
  });

  if (!candidate) {
    await sendMessage(chatId, "❌ No candidates found");
    return;
  }

  const allPlans = buildStrategyPlans(candidate);
  const plans = allPlans.filter((plan) => isStrategyAllowed(runtime, plan.strategyKey));

  const heroImage =
    candidate.token.headerUrl ||
    candidate.token.imageUrl ||
    candidate.token.iconUrl ||
    null;

  await sendPhotoOrText(chatId, heroImage, buildHeroCaption(candidate));
  await sendMessage(chatId, buildAnalysisText(candidate, plans));

  for (const plan of plans) {
    const alreadyOpenSameStrategy = getPositions().some((p) => p.strategy === plan.strategyKey);
    if (alreadyOpenSameStrategy) continue;
    if (candidate.corpse.isCorpse) continue;
    if (candidate.falseBounce.rejected) continue;
    if (candidate.developer.verdict === "Bad") continue;
    if (candidate.score < 85 && plan.strategyKey !== "copytrade") continue;

    if (plan.strategyKey === "copytrade") {
      const leaderEval = copytradeManager.pickBestLeader(runtime.activeConfig);
      if (!leaderEval) continue;
      if (!copytradeManager.isLeaderTradable(runtime.activeConfig, leaderEval.address)) continue;
    }

    const walletId = walletRouter.getPrimaryWalletId(runtime.activeConfig, plan.strategyKey);
    const walletCheck = walletRouter.validateWalletForStrategy(runtime.activeConfig, walletId, plan.strategyKey);
    if (!walletCheck.ok) continue;

    const position = openPosition({
      strategy: plan.strategyKey,
      token: candidate.token,
      thesis: plan.thesis,
      plannedHoldMs: plan.plannedHoldMs,
      stopLossPct: plan.stopLossPct,
      takeProfitPct: plan.takeProfitPct,
      runnerTargetsPct: plan.runnerTargetsPct,
      signalScore: candidate.score,
      expectedEdgePct: plan.expectedEdgePct,
      signalContext: {
        imageUrl: heroImage,
        narrative: candidate.narrative,
        socials: candidate.socials,
        developer: candidate.developer,
        mechanics: candidate.mechanics,
        dexPaid: candidate.dexPaid,
        reasons: candidate.reasons,
        baseStrategy: candidate.strategy,
        chosenPlan: plan
      },
      walletId,
      entryMode: plan.entryMode,
      planName: plan.planName,
      planObjective: plan.objective
    });

    if (position) {
      await sendPhotoOrText(chatId, heroImage, buildEntryText(position));
    }
  }

  const portfolio = getPortfolio();
  const shouldReport =
    !runtime.lastStatusAt || Date.now() - runtime.lastStatusAt >= 15 * 60 * 1000;

  if (shouldReport) {
    runtime.lastStatusAt = Date.now();
    const report = buildPeriodicReport(runtime, portfolio, previousReportEquity);
    previousReportEquity = portfolio.equity;
    await sendMessage(chatId, report, { reply_markup: keyboard() });
  }
}

function resetRunStateIfNeeded() {
  previousReportEquity = null;
  syncPortfolioStrategyBudget();
}

function startStrategyRun(chatId, userId, strategyScope = "all", mode = "infinite") {
  stopLoop();
  startRuntime(runtime, { mode, strategyScope, chatId, userId });
  activeChatId = chatId;
  activeUserId = userId;
  resetRunStateIfNeeded();

  loopId = setInterval(() => {
    cycle(chatId, userId).catch((err) => {
      console.log("cycle error:", err.message);
    });
  }, AUTO_INTERVAL_MS);

  if (mode === "4h") {
    stopTimeoutId = setTimeout(async () => {
      requestStop(runtime);
      if (chatId) {
        await sendMessage(chatId, t("bot_stopped"), { reply_markup: keyboard() });
      }
    }, 4 * 60 * 60 * 1000);
  }
}

async function fetchTokenByCA(ca) {
  const res = await fetch(`${DEX_TOKEN_API}/${encodeURIComponent(ca)}`);
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);

  const json = await res.json();
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  if (!pairs.length) return null;

  const bestRaw = pairs.sort(
    (a, b) =>
      safeNum(b?.liquidity?.usd) - safeNum(a?.liquidity?.usd) ||
      safeNum(b?.volume?.h24) - safeNum(a?.volume?.h24)
  )[0];

  const socials = Array.isArray(bestRaw?.info?.socials) ? bestRaw.info.socials : [];
  const websites = Array.isArray(bestRaw?.info?.websites) ? bestRaw.info.websites : [];

  const links = [
    ...socials.map((x) => ({
      type: x?.type || "",
      label: x?.type || "",
      url: x?.url || ""
    })),
    ...websites.map((x) => ({
      type: "website",
      label: "website",
      url: x?.url || ""
    }))
  ];

  return {
    name: bestRaw?.baseToken?.name || bestRaw?.baseToken?.symbol || "UNKNOWN",
    symbol: bestRaw?.baseToken?.symbol || "",
    ca: bestRaw?.baseToken?.address || "",
    pairAddress: bestRaw?.pairAddress || "",
    chainId: bestRaw?.chainId || "",
    dexId: bestRaw?.dexId || "",
    price: safeNum(bestRaw?.priceUsd),
    liquidity: safeNum(bestRaw?.liquidity?.usd),
    volume: safeNum(bestRaw?.volume?.h24),
    buys: safeNum(bestRaw?.txns?.h24?.buys),
    sells: safeNum(bestRaw?.txns?.h24?.sells),
    txns: safeNum(bestRaw?.txns?.h24?.buys) + safeNum(bestRaw?.txns?.h24?.sells),
    fdv: safeNum(bestRaw?.fdv),
    pairCreatedAt: safeNum(bestRaw?.pairCreatedAt),
    url: bestRaw?.url || "",
    imageUrl: bestRaw?.info?.imageUrl || null,
    description: bestRaw?.info?.description || bestRaw?.info?.header || "",
    links
  };
}

async function analyzeCA(chatId, ca) {
  await sendMessage(chatId, `🧾 <b>Scanning CA</b>\n<code>${escapeHtml(ca)}</code>`);

  const token = await fetchTokenByCA(ca);
  if (!token) {
    await sendMessage(chatId, "❌ Token not found by CA.", { reply_markup: keyboard() });
    return;
  }

  const analyzed = await analyzeToken(token);
  const plans = buildStrategyPlans(analyzed).filter((plan) => isStrategyAllowed(runtime, plan.strategyKey));
  const heroImage = analyzed.token.headerUrl || analyzed.token.imageUrl || analyzed.token.iconUrl || null;

  await sendPhotoOrText(chatId, heroImage, buildHeroCaption(analyzed));
  await sendMessage(chatId, buildAnalysisText(analyzed, plans), {
    reply_markup: keyboard()
  });
}

async function handleAction(chatId, userId, action) {
  if (action === "start") {
    clearChatMode(chatId);
    await sendMessage(chatId, t("ready"), { reply_markup: keyboard() });
    return;
  }

  if (action === "run_multi") {
    startStrategyRun(chatId, userId, "all", "infinite");
    await sendMessage(chatId, `${t("run_started")}: MULTI`, { reply_markup: keyboard() });
    return;
  }

  if (action === "run_scalp") {
    startStrategyRun(chatId, userId, "scalp", "infinite");
    await sendMessage(chatId, `${t("run_started")}: SCALP`, { reply_markup: keyboard() });
    return;
  }

  if (action === "run_reversal") {
    startStrategyRun(chatId, userId, "reversal", "infinite");
    await sendMessage(chatId, `${t("run_started")}: REVERSAL`, { reply_markup: keyboard() });
    return;
  }

  if (action === "run_runner") {
    startStrategyRun(chatId, userId, "runner", "infinite");
    await sendMessage(chatId, `${t("run_started")}: RUNNER`, { reply_markup: keyboard() });
    return;
  }

  if (action === "run_copytrade") {
    startStrategyRun(chatId, userId, "copytrade", "infinite");
    await sendMessage(chatId, `${t("run_started")}: COPYTRADE`, { reply_markup: keyboard() });
    return;
  }

  if (action === "stop") {
    requestStop(runtime);
    await sendMessage(chatId, t("bot_stopped"), { reply_markup: keyboard() });
    return;
  }

  if (action === "kill") {
    requestKill(runtime);
    const closed = await forceCloseAllPositions("KILL_SWITCH");
    await applyPendingIfPossible(chatId);
    stopLoop();
    await sendMessage(chatId, `${t("bot_killed")}\nclosed: ${closed.length}`, {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "status") {
    await sendMessage(
      chatId,
      buildDashboard(runtime, getPortfolio()),
      { reply_markup: keyboard() }
    );
    return;
  }

  if (action === "balance") {
    await sendMessage(chatId, buildBalanceText(getPortfolio()), { reply_markup: keyboard() });
    return;
  }

  if (action === "scan_market") {
    clearChatMode(chatId);
    await sendMessage(chatId, t("market_scan_started"), { reply_markup: keyboard() });
    await cycle(chatId, userId);
    return;
  }

  if (action === "scan_ca") {
    setChatMode(chatId, "awaiting_ca");
    await sendMessage(chatId, t("send_ca"), { reply_markup: keyboard() });
    return;
  }

  if (action === "language") {
    await sendMessage(chatId, t("choose_lang"), { reply_markup: keyboard() });
    return;
  }

  if (action === "lang_ru") {
    runtime.activeConfig.language = "ru";
    await sendMessage(chatId, `${t("lang_set")}: RU`, { reply_markup: keyboard() });
    return;
  }

  if (action === "lang_en") {
    runtime.activeConfig.language = "en";
    await sendMessage(chatId, `${t("lang_set")}: EN`, { reply_markup: keyboard() });
    return;
  }

  if (action === "wallets") {
    await sendMessage(chatId, buildWalletsText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "copytrade") {
    copytradeManager.refreshLeaderStates(runtime.activeConfig);
    await sendMessage(chatId, buildCopytradeText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "budget") {
    await sendMessage(chatId, buildBudgetText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "gmgn_status") {
    await sendMessage(chatId, buildGmgnStatusText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "leader_health") {
    await sendMessage(chatId, await buildLeaderHealthText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "sync_leaders") {
    await syncLeaderScores();
    await sendMessage(chatId, t("leaders_synced"), { reply_markup: keyboard() });
    await sendMessage(chatId, await buildLeaderHealthText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "add_leader") {
    setChatMode(chatId, "awaiting_leader_address");
    await sendMessage(chatId, t("add_leader_prompt"), { reply_markup: keyboard() });
    return;
  }

  if (action === "set_secret") {
    setChatMode(chatId, "awaiting_secret_ref");
    await sendMessage(chatId, t("add_secret_prompt"), { reply_markup: keyboard() });
    return;
  }

  if (action === "apply_pending") {
    if (await applyPendingIfPossible(chatId)) {
      return;
    }
    await sendMessage(chatId, "Pending config not applied yet. Stop the bot and close positions first.", {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "exportcsv") {
    await exportCsv(chatId);
    return;
  }

  if (action === "exportjson") {
    await exportJson(chatId);
    return;
  }

  if (action === "exportxlsx") {
    await exportXlsx(chatId);
    return;
  }

  await sendMessage(chatId, t("unknown"), { reply_markup: keyboard() });
}

async function processStatefulInput(chatId, text) {
  const mode = getChatMode(chatId);

  if (mode.mode === "awaiting_ca") {
    if (!isLikelyCA(text)) {
      await sendMessage(chatId, t("invalid_ca"), { reply_markup: keyboard() });
      return true;
    }
    clearChatMode(chatId);
    await analyzeCA(chatId, text);
    return true;
  }

  if (mode.mode === "awaiting_leader_address") {
    if (!isLikelyCA(text)) {
      await sendMessage(chatId, t("invalid_ca"), { reply_markup: keyboard() });
      return true;
    }
    copytradeManager.addLeader(runtime.activeConfig, text, "manual");
    clearChatMode(chatId);
    await sendMessage(chatId, `${t("leader_added")}\n<code>${escapeHtml(text)}</code>`, {
      reply_markup: keyboard()
    });
    return true;
  }

  if (mode.mode === "awaiting_secret_ref") {
    const match = String(text || "").trim().match(/^([A-Za-z0-9_\-]+)\s+(env:[A-Za-z0-9_\-]+)$/);
    if (!match) {
      await sendMessage(chatId, "❌ Format: <code>wallet_id env:SECRET_NAME</code>", {
        reply_markup: keyboard()
      });
      return true;
    }

    const [, walletId, secretRef] = match;
    if (!runtime.activeConfig.wallets[walletId]) {
      await sendMessage(chatId, "❌ Wallet not found", { reply_markup: keyboard() });
      return true;
    }

    runtime.activeConfig.wallets[walletId].secretRef = secretRef;
    clearChatMode(chatId);
    await sendMessage(chatId, `${t("secret_saved")}\n<b>${escapeHtml(walletId)}</b> → <code>${escapeHtml(secretRef)}</code>`, {
      reply_markup: keyboard()
    });
    return true;
  }

  return false;
}

bot.on("message", (msg) => {
  (async () => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || chatId;
    const text = String(msg.text || "").trim();
    const action = normalizeAction(text);

    if (await processStatefulInput(chatId, text)) return;

    const budgetMatch = text.match(/^budget\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/i);
    if (budgetMatch) {
      const values = budgetMatch.slice(1).map(Number);
      const validated = validateBudgetPercents(values);

      if (!validated.ok) {
        await sendMessage(chatId, "❌ Budget invalid. Sum must be 100.", {
          reply_markup: keyboard()
        });
        return;
      }

      queuePendingConfig(runtime, { strategyBudget: validated.budget }, "budget_update");

      await sendMessage(chatId, `${t("pending_budget_saved")}

<b>Pending</b>
${formatBudgetLines(validated.budget)}`, {
        reply_markup: keyboard()
      });
      return;
    }

    if (action) {
      await handleAction(chatId, userId, action);
      return;
    }

    if (isLikelyCA(text)) {
      await sendMessage(chatId, t("scan_hint"), { reply_markup: keyboard() });
      return;
    }

    await sendMessage(chatId, t("unknown"), { reply_markup: keyboard() });
  })().catch((err) => {
    console.log("message error:", err.message);
  });
});

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        bot.processUpdate(update);
        res.writeHead(200);
        res.end("ok");
      } catch (error) {
        res.writeHead(500);
        res.end(error.message);
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, async () => {
  console.log(`Telegram bot server listening on port ${PORT}`);
});
