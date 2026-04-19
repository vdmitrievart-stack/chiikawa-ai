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
  analyzeToken,
  scanMarket
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
  maybeTakeRunnerPartial
} from "./portfolio.js";

import { buildStrategyPlans } from "./strategy-engine.js";

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

let loopId = null;
let stopTimeoutId = null;
let currentMode = "stopped";
let activeChatId = null;
let activeUserId = null;

let runState = {
  runId: null,
  startedAt: null,
  mode: "stopped"
};

const recentlyTraded = new Map();
const tempFiles = new Set();
const chatState = new Map();

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
      ["▶️ Run 4h", "♾️ Run Infinite"],
      ["🛑 Stop", "📊 Status"],
      ["🔎 Scan Market", "🧾 Scan CA"],
      ["📈 Export CSV", "📦 Export JSON"],
      ["📊 Export XLSX"]
    ],
    resize_keyboard: true,
    persistent: true
  };
}

function normalizeAction(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return null;

  if (raw === "/start" || raw === "/menu") return "start";
  if (raw === "/run4h") return "run4h";
  if (raw === "/runinfinite") return "runinfinite";
  if (raw === "/stop") return "stop";
  if (raw === "/status") return "status";
  if (raw === "/scanmarket" || raw === "/scan_market") return "scan_market";
  if (raw === "/scanca" || raw === "/scan_ca" || raw === "/ca") return "scan_ca";
  if (raw === "/exportcsv") return "exportcsv";
  if (raw === "/exportjson" || raw === "/exportstats") return "exportjson";
  if (raw === "/exportxlsx") return "exportxlsx";

  if (raw.includes("run 4h") || raw.includes("4ч") || raw.includes("run4h")) return "run4h";
  if (raw.includes("infinite") || raw.includes("бескон")) return "runinfinite";
  if (raw.includes("stop") || raw.includes("стоп")) return "stop";
  if (raw.includes("status") || raw.includes("статус")) return "status";
  if (raw.includes("scan market") || raw.includes("скан рынок")) return "scan_market";
  if (raw.includes("scan ca") || raw.includes("скан ca")) return "scan_ca";
  if (raw.includes("csv")) return "exportcsv";
  if (raw.includes("json")) return "exportjson";
  if (raw.includes("xlsx")) return "exportxlsx";

  return null;
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
  if (links.youtube) rows.push(`▶️ <a href="${escapeHtml(links.youtube)}">YouTube</a>`);
  if (links.discord) rows.push(`💬 <a href="${escapeHtml(links.discord)}">Discord</a>`);
  if (links.tiktok) rows.push(`🎵 <a href="${escapeHtml(links.tiktok)}">TikTok</a>`);

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
  const t = analyzed.token || {};
  const links = analyzed.socials?.links || {};

  return `🧾 <b>Scanning CA</b>

<b>${escapeHtml(t.name || "Unknown")}</b>
<code>${escapeHtml(t.ca || "")}</code>

<b>Links:</b> ${buildLinksText(links)}
<b>Dex:</b> ${buildDexText(t)}`.slice(0, 1024);
}

function buildAnalysisText(analyzed, plans) {
  const t = analyzed.token || {};
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

  const linksText = buildLinksText(analyzed.socials?.links || {});
  const dexText = buildDexText(t);

  return `🔎 <b>ANALYSIS</b>

<b>Token:</b> ${escapeHtml(t.name || "Unknown")}
<b>Symbol:</b> ${escapeHtml(t.symbol || "")}
<b>CA:</b> <code>${escapeHtml(t.ca || "")}</code>

<b>Dex:</b> ${dexText}
<b>Pair:</b> <code>${escapeHtml(t.pairAddress || "n/a")}</code>
<b>DEX Paid:</b> ${escapeHtml(analyzed.dexPaid?.status || "Unknown")}

<b>Price:</b> ${escapeHtml(t.price)}
<b>Liquidity:</b> ${escapeHtml(t.liquidity)}
<b>Volume 24h:</b> ${escapeHtml(t.volume)}
<b>Txns 24h:</b> ${escapeHtml(t.txns)}
<b>FDV:</b> ${escapeHtml(t.fdv)}

⚠️ <b>Rug:</b> ${analyzed.rug?.risk ?? 0}
🧠 <b>Smart Money:</b> ${analyzed.wallet?.smartMoney ?? 0}
👥 <b>Concentration:</b> ${round(analyzed.wallet?.concentration ?? 0, 2)}
🤖 <b>Bot Activity:</b> ${analyzed.bots?.botActivity ?? 0}
🐦 <b>Sentiment:</b> ${analyzed.sentiment?.sentiment ?? 0}
☠️ <b>Corpse Score:</b> ${analyzed.corpse?.score ?? 0}
👨‍💻 <b>Dev Verdict:</b> ${escapeHtml(analyzed.developer?.verdict || "Unknown")}

🏷️ <b>Token Type:</b> ${escapeHtml(analyzed.mechanics?.tokenType || "Unknown")}
🎁 <b>Reward Model:</b> ${escapeHtml(analyzed.mechanics?.rewardModel || "Unknown")}
👤 <b>Beneficiary Signal:</b> ${escapeHtml(analyzed.mechanics?.beneficiarySignal || "Unknown")}
💸 <b>Claim Signal:</b> ${escapeHtml(analyzed.mechanics?.claimSignal || "Unknown")}

🧾 <b>Narrative:</b> ${escapeHtml(analyzed.narrative?.verdict || "Unknown")}
🌐 <b>Links:</b> ${linksText}

<b>Narrative summary:</b>
${escapeHtml(analyzed.narrative?.summary || "none")}

📈 <b>Delta</b>
<b>Price Δ:</b> ${round(analyzed.delta?.priceDeltaPct ?? 0, 2)}%
<b>Volume Δ:</b> ${round(analyzed.delta?.volumeDeltaPct ?? 0, 2)}%
<b>Txns Δ:</b> ${round(analyzed.delta?.txnsDeltaPct ?? 0, 2)}%
<b>Liquidity Δ:</b> ${round(analyzed.delta?.liquidityDeltaPct ?? 0, 2)}%
<b>Buy Pressure Δ:</b> ${round(analyzed.delta?.buyPressureDelta ?? 0, 3)}

🎯 <b>Available plans</b>
${plansText}

<b>Reasons:</b>
${reasons || "• none"}`;
}

function buildDashboard() {
  const pf = getPortfolio();
  const cfg = getStrategyConfig();

  const totalClosed = pf.closedTrades.length;
  const wins = pf.closedTrades.filter((t) => t.netPnlPct > 0).length;
  const winrate = totalClosed ? (wins / totalClosed) * 100 : 0;

  const lines = [
    `📊 <b>ПАНЕЛЬ УПРАВЛЕНИЯ БОТОМ</b>`,
    ``,
    `<b>Идентификатор запуска:</b> ${escapeHtml(runState.runId || "-")}`,
    `<b>Режим:</b> ${escapeHtml(currentMode.toUpperCase())}`,
    `<b>Денежные средства:</b> ${round(pf.cash, 4)} SOL`,
    `<b>Собственный капитал:</b> ${round(pf.equity, 4)} SOL`,
    `<b>Реализованная прибыль:</b> ${round(pf.realizedPnlSol, 4)} SOL`,
    `<b>Нереализованная прибыль:</b> ${round(pf.unrealizedPnlSol, 4)} SOL`,
    `<b>Открытые позиции:</b> ${pf.positions.length}`,
    `<b>Закрытые сделки:</b> ${totalClosed}`,
    `<b>Процент прибыльных сделок:</b> ${round(winrate, 2)}%`,
    ``,
    `<b>Стратегии</b>`
  ];

  for (const key of Object.keys(cfg)) {
    const row = pf.byStrategy[key];
    lines.push(
      `• <b>${escapeHtml(cfg[key].label)}</b> — выделено ${round(
        cfg[key].allocationPct * 100,
        0
      )}% | доступно ${round(row.availableSol, 4)} SOL | открыто ${row.openPositions} | прибыль/убыток ${round(row.realizedPnlSol, 4)} SOL`
    );
  }

  return lines.join("\n");
}

function buildEntryText(position) {
  return `🚀 <b>ENTRY</b>

<b>Strategy:</b> ${escapeHtml(position.strategy.toUpperCase())}
<b>Token:</b> ${escapeHtml(position.token)}
<b>CA:</b> <code>${escapeHtml(position.ca)}</code>

<b>Entry ref:</b> ${position.entryReferencePrice}
<b>Entry effective:</b> ${position.entryEffectivePrice}
<b>Size:</b> ${round(position.amountSol, 4)} SOL
<b>Expected edge:</b> ${round(position.expectedEdgePct, 2)}%

<b>Thesis:</b>
${escapeHtml(position.thesis)}

<b>Entry costs:</b> ${round(position.entryCosts.totalSol, 6)} SOL`;
}

function buildPositionUpdateText(position, mark, status) {
  return `📈 <b>UPDATE</b>

<b>Strategy:</b> ${escapeHtml(position.strategy.toUpperCase())}
<b>Token:</b> ${escapeHtml(position.token)}
<b>CA:</b> <code>${escapeHtml(position.ca)}</code>

<b>Entry ref:</b> ${position.entryReferencePrice}
<b>Current:</b> ${mark.currentPrice}
<b>Gross PnL:</b> ${round(mark.grossPnlPct, 2)}%
<b>Net PnL:</b> ${round(mark.netPnlPct, 2)}%
<b>Age:</b> ${Math.round(mark.ageMs / 1000)}s
<b>Status:</b> ${escapeHtml(status)}`;
}

function buildExitText(trade) {
  return `🏁 <b>EXIT</b>

<b>Strategy:</b> ${escapeHtml(trade.strategy.toUpperCase())}
<b>Token:</b> ${escapeHtml(trade.token)}
<b>CA:</b> <code>${escapeHtml(trade.ca)}</code>

<b>Entry ref:</b> ${trade.entryReferencePrice}
<b>Entry effective:</b> ${trade.entryEffectivePrice}
<b>Exit ref:</b> ${trade.exitReferencePrice}

<b>Net PnL:</b> ${round(trade.netPnlPct, 2)}%
<b>Net PnL SOL:</b> ${round(trade.netPnlSol, 6)}
<b>Reason:</b> ${escapeHtml(trade.reason)}
<b>Balance after:</b> ${round(trade.balanceAfter, 4)} SOL`;
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
    if (mark.netPnlPct <= -Math
