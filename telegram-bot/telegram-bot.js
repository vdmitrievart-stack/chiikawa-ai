import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import * as XLSX from "xlsx";

import { getBestTrade, getLatestTokenPrice } from "./scan-engine.js";
import {
  enterTrade,
  exitTrade,
  getPortfolio,
  markToMarket,
  shouldExitPosition,
  updatePositionMarket,
  estimateRoundTripCostPct,
  resetPortfolio
} from "./portfolio.js";

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chiikawa_secret";
const PATH = `/telegram/${WEBHOOK_SECRET}`;

const AUTO_INTERVAL_MS = Number(process.env.AUTO_INTERVAL_MS || 60000);
const AUTO_HOURS_DEFAULT = Number(process.env.AUTO_HOURS_DEFAULT || 4);
const TRADE_COOLDOWN_MS = Number(process.env.TRADE_COOLDOWN_MS || 90 * 60 * 1000);

if (!TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

let intervalId = null;
let autoStopId = null;
let activeChatId = null;
let activeChatUserId = null;
const recentlyTraded = new Map();
const tempFiles = new Set();

let runState = {
  startedAt: null,
  stoppedAt: null,
  runId: null,
  notes: []
};

const userSettings = new Map();

const I18N = {
  en: {
    ready: "🤖 Bot ready.",
    commands: "Commands",
    run4h: "▶️ Run 4h",
    stop: "🛑 Stop",
    status: "📊 Status",
    scan: "🔎 Scan",
    exportCsv: "📈 Export CSV",
    exportJson: "📦 Export JSON",
    exportXlsx: "📊 Export XLSX",
    language: "🌍 Language",
    started: "🚀 Starting 4h simulation from 1 SOL",
    stopped: "🛑 Bot stopped",
    alreadyStopped: "ℹ️ Bot already stopped",
    autoStopped: "🛑 AUTO STOPPED (4h finished)",
    noCandidates: "❌ No candidates found",
    skipScore: "❌ Skip (score below threshold)",
    couldNotOpen: "⏳ Could not open position",
    openActive: "⏳ Open position still active",
    autoMode: "Auto mode",
    balance: "Balance",
    position: "Position",
    tradesClosed: "Trades closed",
    cooldownList: "Recently traded cooldown list",
    none: "none",
    analysis: "ANALYSIS",
    strategy: "Strategy",
    reasons: "Reasons",
    accumulation: "Accumulation",
    distribution: "Distribution",
    absorption: "Absorption",
    corpse: "Corpse Score",
    exceptional: "Exceptional Override",
    expectedEdge: "Expected edge",
    costs: "Round-trip costs",
    holdTarget: "Hold target",
    setup: "Setup",
    positionUpdate: "POSITION UPDATE",
    entry: "ENTRY",
    exit: "EXIT",
    signalScore: "Signal score",
    entryRef: "Entry ref",
    entryEffective: "Entry effective",
    exitRef: "Exit ref",
    size: "Size",
    entryCosts: "Entry costs",
    exitCosts: "Exit costs",
    netPnl: "Net PnL",
    grossPnl: "Gross PnL",
    age: "Age",
    statusWord: "Status",
    reasonWord: "Reason",
    highWater: "High watermark",
    lowWater: "Low watermark",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "s",
    falseBounce: "❌ Skip (false bounce)",
    edgeSkip: "❌ Skip (expected edge does not beat costs + margin)",
    corpseSkip: "❌ Skip (corpse filter)",
    statusTitle: "STATUS",
    chooseLanguage: "Choose language",
    languageSet: "Language set",
    copyHint: "Tap the code block to copy",
    token: "Token",
    ca: "CA",
    score: "Score",
    price: "Price",
    liquidity: "Liquidity",
    volume24h: "Volume 24h",
    txns24h: "Txns 24h",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "Concentration",
    botActivity: "Bot Activity",
    sentiment: "Sentiment",
    delta: "Delta",
    priceDelta: "Price Δ",
    volumeDelta: "Volume Δ",
    txnsDelta: "Txns Δ",
    liquidityDelta: "Liquidity Δ",
    buyPressureDelta: "Buy Pressure Δ",
    current: "Current",
    grossPnlWord: "Gross PnL",
    netPnlWord: "Net PnL",
    runId: "Run ID",
    localeLabel: "Language"
  },
  ru: {
    ready: "🤖 Бот готов.",
    commands: "Команды",
    run4h: "▶️ Запуск 4ч",
    stop: "🛑 Стоп",
    status: "📊 Статус",
    scan: "🔎 Скан",
    exportCsv: "📈 Экспорт CSV",
    exportJson: "📦 Экспорт JSON",
    exportXlsx: "📊 Экспорт XLSX",
    language: "🌍 Язык",
    started: "🚀 Запускаю 4-часовую симуляцию с 1 SOL",
    stopped: "🛑 Бот остановлен",
    alreadyStopped: "ℹ️ Бот уже остановлен",
    autoStopped: "🛑 АВТО ОСТАНОВЛЕН (4ч завершены)",
    noCandidates: "❌ Кандидаты не найдены",
    skipScore: "❌ Пропуск (оценка ниже порога)",
    couldNotOpen: "⏳ Не удалось открыть позицию",
    openActive: "⏳ Позиция все еще активна",
    autoMode: "Авто режим",
    balance: "Баланс",
    position: "Позиция",
    tradesClosed: "Закрытых сделок",
    cooldownList: "Список кулдауна",
    none: "нет",
    analysis: "АНАЛИЗ",
    strategy: "Стратегия",
    reasons: "Причины",
    accumulation: "Накопление",
    distribution: "Распределение",
    absorption: "Поглощение",
    corpse: "Corpse Score",
    exceptional: "Особый override",
    expectedEdge: "Ожидаемое преимущество",
    costs: "Полные издержки",
    holdTarget: "Цель удержания",
    setup: "Сетап",
    positionUpdate: "ОБНОВЛЕНИЕ ПОЗИЦИИ",
    entry: "ВХОД",
    exit: "ВЫХОД",
    signalScore: "Оценка сигнала",
    entryRef: "Базовый вход",
    entryEffective: "Фактический вход",
    exitRef: "Базовый выход",
    size: "Размер",
    entryCosts: "Издержки входа",
    exitCosts: "Издержки выхода",
    netPnl: "Чистый PnL",
    grossPnl: "Грубый PnL",
    age: "Возраст",
    statusWord: "Статус",
    reasonWord: "Причина",
    highWater: "Верхняя отметка",
    lowWater: "Нижняя отметка",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "с",
    falseBounce: "❌ Пропуск (ложный отскок)",
    edgeSkip: "❌ Пропуск (преимущество не бьёт издержки + запас)",
    corpseSkip: "❌ Пропуск (corpse filter)",
    statusTitle: "СТАТУС",
    chooseLanguage: "Выбери язык",
    languageSet: "Язык установлен",
    copyHint: "Нажми на блок кода, чтобы скопировать",
    token: "Токен",
    ca: "CA",
    score: "Оценка",
    price: "Цена",
    liquidity: "Ликвидность",
    volume24h: "Объем 24ч",
    txns24h: "Транзакции 24ч",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "Концентрация",
    botActivity: "Активность ботов",
    sentiment: "Сентимент",
    delta: "Дельта",
    priceDelta: "Цена Δ",
    volumeDelta: "Объем Δ",
    txnsDelta: "Транзакции Δ",
    liquidityDelta: "Ликвидность Δ",
    buyPressureDelta: "Давление покупок Δ",
    current: "Текущая",
    grossPnlWord: "Грубый PnL",
    netPnlWord: "Чистый PnL",
    runId: "ID запуска",
    localeLabel: "Язык"
  }
};

function getLang(userId) {
  return userSettings.get(userId)?.lang || "ru";
}

function setLang(userId, lang) {
  const current = userSettings.get(userId) || {};
  userSettings.set(userId, { ...current, lang });
}

function t(userId, key) {
  const lang = getLang(userId);
  return I18N[lang]?.[key] || I18N.ru[key] || key;
}

function buildReplyKeyboard(userId) {
  return {
    keyboard: [
      [t(userId, "run4h"), t(userId, "stop")],
      [t(userId, "status"), t(userId, "scan")],
      [t(userId, "exportCsv"), t(userId, "exportJson")],
      [t(userId, "exportXlsx"), t(userId, "language")]
    ],
    resize_keyboard: true,
    persistent: true
  };
}

function languageMenu() {
  return {
    inline_keyboard: [
      [
        { text: "English", callback_data: "lang:en" },
        { text: "Русский", callback_data: "lang:ru" }
      ]
    ]
  };
}

function pruneRecentlyTraded() {
  const now = Date.now();
  for (const [ca, ts] of recentlyTraded.entries()) {
    if (now - ts > TRADE_COOLDOWN_MS) {
      recentlyTraded.delete(ca);
    }
  }
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

function normalizeButtonAction(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const slashMap = {
    "/run4h": "run4h",
    "/stop": "stop",
    "/status": "status",
    "/scan": "scan",
    "/exportcsv": "exportcsv",
    "/exportstats": "exportstats",
    "/exportxlsx": "exportxlsx",
    "/language": "language",
    "/start": "start"
  };
  if (slashMap[raw]) return slashMap[raw];

  for (const lang of Object.keys(I18N)) {
    const dict = I18N[lang];
    if (raw === dict.run4h) return "run4h";
    if (raw === dict.stop) return "stop";
    if (raw === dict.status) return "status";
    if (raw === dict.scan) return "scan";
    if (raw === dict.exportCsv) return "exportcsv";
    if (raw === dict.exportJson) return "exportstats";
    if (raw === dict.exportXlsx) return "exportxlsx";
    if (raw === dict.language) return "language";
  }

  return null;
}

function stopAuto() {
  if (intervalId) clearInterval(intervalId);
  if (autoStopId) clearTimeout(autoStopId);
  intervalId = null;
  autoStopId = null;
  runState.stoppedAt = Date.now();
}

function buildStatusText(userId) {
  const pf = getPortfolio();
  return `📊 <b>${t(userId, "statusTitle")}</b>

<b>${t(userId, "balance")}:</b> ${pf.balance.toFixed(4)} SOL
<b>${t(userId, "position")}:</b> ${pf.position ? pf.position.token : t(userId, "none")}
<b>${t(userId, "autoMode")}:</b> ${intervalId ? "ON" : "OFF"}
<b>${t(userId, "tradesClosed")}:</b> ${pf.tradeHistory.length}
<b>${t(userId, "cooldownList")}:</b> ${recentlyTraded.size}
<b>${t(userId, "runId")}:</b> ${runState.runId || "-"}
<b>${t(userId, "localeLabel")}:</b> ${getLang(userId).toUpperCase()}`;
}

function buildRunStats() {
  const pf = getPortfolio();
  const history = pf.tradeHistory || [];
  const wins = history.filter(t => t.netPnlPct > 0);
  const losses = history.filter(t => t.netPnlPct <= 0);
  const avgPnl = history.length ? history.reduce((a, t) => a + t.netPnlPct, 0) / history.length : 0;

  return {
    runId: runState.runId,
    startedAt: runState.startedAt,
    stoppedAt: runState.stoppedAt,
    balance: pf.balance,
    openPosition: pf.position,
    totalTrades: history.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: history.length ? (wins.length / history.length) * 100 : 0,
    avgNetPnlPct: avgPnl,
    tradeHistory: history,
    notes: runState.notes
  };
}

function escapeCsv(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function statsToCsv(stats) {
  const header = [
    "runId", "openedAt", "closedAt", "token", "ca",
    "entryReferencePrice", "entryEffectivePrice", "exitReferencePrice",
    "amountSol", "entryCostsSol", "exitCostsSol", "netPnlPct", "netPnlSol",
    "reason", "signalScore", "expectedEdgePct", "setup", "balanceAfter"
  ];

  const rows = stats.tradeHistory.map(t => [
    stats.runId,
    t.openedAt,
    t.closedAt,
    escapeCsv(t.token),
    t.ca,
    t.entryReferencePrice,
    t.entryEffectivePrice,
    t.exitReferencePrice,
    t.amountSol,
    t.entryCosts?.totalSol ?? "",
    t.exitCosts?.totalSol ?? "",
    t.netPnlPct,
    t.netPnlSol,
    escapeCsv(t.reason),
    t.signalScore,
    t.expectedEdgePct,
    escapeCsv(t.signalContext?.setup || t.signalContext?.reason || ""),
    t.balance
  ]);

  return [header.join(","), ...rows.map(r => r.join(","))].join("\n");
}

function statsToXlsxWorkbook(stats) {
  const summaryRows = [
    { metric: "runId", value: stats.runId || "" },
    { metric: "startedAt", value: stats.startedAt || "" },
    { metric: "stoppedAt", value: stats.stoppedAt || "" },
    { metric: "balance", value: stats.balance ?? "" },
    { metric: "totalTrades", value: stats.totalTrades ?? 0 },
    { metric: "wins", value: stats.wins ?? 0 },
    { metric: "losses", value: stats.losses ?? 0 },
    { metric: "winRatePct", value: stats.winRatePct ?? 0 },
    { metric: "avgNetPnlPct", value: stats.avgNetPnlPct ?? 0 }
  ];

  const tradeRows = (stats.tradeHistory || []).map(t => ({
    runId: stats.runId || "",
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    token: t.token,
    ca: t.ca,
    entryReferencePrice: t.entryReferencePrice,
    entryEffectivePrice: t.entryEffectivePrice,
    exitReferencePrice: t.exitReferencePrice,
    amountSol: t.amountSol,
    entryCostsSol: t.entryCosts?.totalSol ?? "",
    exitCostsSol: t.exitCosts?.totalSol ?? "",
    grossValueSol: t.grossValueSol ?? "",
    netValueSol: t.netValueSol ?? "",
    netPnlPct: t.netPnlPct ?? "",
    netPnlSol: t.netPnlSol ?? "",
    reason: t.reason,
    signalScore: t.signalScore,
    expectedEdgePct: t.expectedEdgePct,
    setup: t.signalContext?.setup || t.signalContext?.reason || "",
    balanceAfter: t.balance
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tradeRows), "trades");
  return wb;
}

async function exportJson(chatId) {
  const stats = buildRunStats();
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${stats.runId || Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(stats, null, 2), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/json"
  });
  await scheduleTempCleanup(filePath);
}

async function exportCsv(chatId) {
  const stats = buildRunStats();
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${stats.runId || Date.now()}.csv`);
  await fs.writeFile(filePath, statsToCsv(stats), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "text/csv"
  });
  await scheduleTempCleanup(filePath);
}

async function exportXlsx(chatId) {
  const stats = buildRunStats();
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${stats.runId || Date.now()}.xlsx`);
  const wb = statsToXlsxWorkbook(stats);
  XLSX.writeFile(wb, filePath);
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  await scheduleTempCleanup(filePath);
}

async function send(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts
  });
}

async function sendSignalMessage(chatId, text, imageUrl = null) {
  if (imageUrl) {
    try {
      await bot.sendPhoto(chatId, imageUrl, {
        caption: text.slice(0, 1024),
        parse_mode: "HTML"
      });
      return;
    } catch (error) {
      console.log("sendPhoto fallback:", error.message);
    }
  }
  await send(chatId, text);
}

function formatAnalysis(best, userId) {
  return `🔎 <b>${t(userId, "analysis")}</b>

<b>${t(userId, "token")}:</b> ${best.token.name}
<b>${t(userId, "ca")}:</b> <code>${best.token.ca}</code>
<b>${t(userId, "copyHint")}:</b> <code>${best.token.ca}</code>
<b>${t(userId, "score")}:</b> ${best.score}

<b>${t(userId, "price")}:</b> ${best.token.price}
<b>${t(userId, "liquidity")}:</b> ${best.token.liquidity}
<b>${t(userId, "volume24h")}:</b> ${best.token.volume}
<b>${t(userId, "txns24h")}:</b> ${best.token.txns}
<b>${t(userId, "fdv")}:</b> ${best.token.fdv}

⚠️ <b>${t(userId, "rug")}:</b> ${best.rug.risk}
🧠 <b>${t(userId, "smartMoney")}:</b> ${best.wallet.smartMoney}
👥 <b>${t(userId, "concentration")}:</b> ${best.wallet.concentration.toFixed(2)}
🤖 <b>${t(userId, "botActivity")}:</b> ${best.bots.botActivity}
🐦 <b>${t(userId, "sentiment")}:</b> ${best.sentiment.sentiment}

📈 <b>${t(userId, "delta")}</b>
<b>${t(userId, "priceDelta")}:</b> ${best.delta.priceDeltaPct.toFixed(2)}%
<b>${t(userId, "volumeDelta")}:</b> ${best.delta.volumeDeltaPct.toFixed(2)}%
<b>${t(userId, "txnsDelta")}:</b> ${best.delta.txnsDeltaPct.toFixed(2)}%
<b>${t(userId, "liquidityDelta")}:</b> ${best.delta.liquidityDeltaPct.toFixed(2)}%
<b>${t(userId, "buyPressureDelta")}:</b> ${best.delta.buyPressureDelta.toFixed(3)}

🧲 <b>${t(userId, "accumulation")}:</b> ${best.accumulation.score}
📤 <b>${t(userId, "distribution")}:</b> ${best.distribution.score}
🧱 <b>${t(userId, "absorption")}:</b> ${best.absorption.score}
☠️ <b>${t(userId, "corpse")}:</b> ${best.corpse.score}
🚨 <b>${t(userId, "exceptional")}:</b> ${best.exceptionalOverride.active ? "ON" : "OFF"}

🎯 <b>${t(userId, "strategy")}</b>
<b>${t(userId, "expectedEdge")}:</b> ${best.strategy.expectedEdgePct}%
<b>${t(userId, "costs")}:</b> ${estimateRoundTripCostPct()}%
<b>${t(userId, "holdTarget")}:</b> ${(best.strategy.intendedHoldMs / 1000).toFixed(0)}${t(userId, "hold")}
<b>${t(userId, "takeProfit")}:</b> ${best.strategy.takeProfitPct}%
<b>${t(userId, "stopLoss")}:</b> ${best.strategy.stopLossPct}%
<b>${t(userId, "setup")}:</b> ${best.strategy.reason}

<b>${t(userId, "reasons")}:</b>
${best.reasons.map(r => `• ${r}`).join("\n")}`;
}

async function runCycle(chatId, userId) {
  try {
    pruneRecentlyTraded();

    const pf = getPortfolio();

    if (pf.position) {
      const latest = await getLatestTokenPrice(pf.position.ca);
      if (!latest?.price) {
        await send(chatId, `⏳ ${t(userId, "openActive")}: ${pf.position.token}`);
        return;
      }

      updatePositionMarket(latest.price);
      const mtm = markToMarket(latest.price);
      const exitCheck = shouldExitPosition(latest.price);

      await send(
        chatId,
        `📈 <b>${t(userId, "positionUpdate")}</b>

<b>${t(userId, "token")}:</b> ${pf.position.token}
<b>${t(userId, "ca")}:</b> <code>${pf.position.ca}</code>
<b>${t(userId, "copyHint")}:</b> <code>${pf.position.ca}</code>
<b>${t(userId, "entryRef")}:</b> ${pf.position.entryReferencePrice}
<b>${t(userId, "current")}:</b> ${latest.price}
<b>${t(userId, "grossPnlWord")}:</b> ${mtm.grossPnlPct.toFixed(2)}%
<b>${t(userId, "netPnlWord")}:</b> ${mtm.netPnlPct.toFixed(2)}%
<b>${t(userId, "age")}:</b> ${(mtm.ageMs / 1000).toFixed(0)}${t(userId, "hold")}
<b>${t(userId, "highWater")}:</b> ${pf.position.highWaterMarkPrice}
<b>${t(userId, "lowWater")}:</b> ${pf.position.lowWaterMarkPrice}
<b>${t(userId, "statusWord")}:</b> ${exitCheck.reason}`
      );

      if (exitCheck.shouldExit) {
        const closed = exitTrade(latest.price, exitCheck.reason);
        if (closed) {
          recentlyTraded.set(closed.ca, Date.now());

          const exitText = `🏁 <b>${t(userId, "exit")}</b>

<b>${t(userId, "token")}:</b> ${closed.token}
<b>${t(userId, "ca")}:</b> <code>${closed.ca}</code>
<b>${t(userId, "copyHint")}:</b> <code>${closed.ca}</code>
<b>${t(userId, "entryRef")}:</b> ${closed.entryReferencePrice}
<b>${t(userId, "entryEffective")}:</b> ${closed.entryEffectivePrice}
<b>${t(userId, "exitRef")}:</b> ${closed.exitReferencePrice}

<b>${t(userId, "entryCosts")}:</b> ${closed.entryCosts.totalSol.toFixed(6)} SOL
<b>${t(userId, "exitCosts")}:</b> ${closed.exitCosts.totalSol.toFixed(6)} SOL

<b>${t(userId, "netPnl")}:</b> ${closed.netPnlPct.toFixed(2)}%
<b>${t(userId, "balance")}:</b> ${closed.balance.toFixed(4)} SOL
<b>${t(userId, "reasonWord")}:</b> ${closed.reason}`;

          await sendSignalMessage(chatId, exitText, pf.position.signalContext?.imageUrl || null);
        }
      }

      return;
    }

    const excludeCas = [...recentlyTraded.keys()];
    const best = await getBestTrade({ excludeCas });

    if (!best) {
      await send(chatId, t(userId, "noCandidates"));
      return;
    }

    await sendSignalMessage(chatId, formatAnalysis(best, userId), best.token.imageUrl || null);

    if (best.score < 85) {
      await send(chatId, t(userId, "skipScore"));
      return;
    }

    if (best.corpse.isCorpse) {
      await send(chatId, `${t(userId, "corpseSkip")}: ${best.corpse.reasons.join(", ")}`);
      return;
    }

    if (best.falseBounce.rejected) {
      await send(chatId, `${t(userId, "falseBounce")}: ${best.falseBounce.reasons.join(", ")}`);
      return;
    }

    const minRequiredEdge = estimateRoundTripCostPct() + 1.2;
    if (best.strategy.expectedEdgePct < minRequiredEdge) {
      await send(chatId, `${t(userId, "edgeSkip")} (${best.strategy.expectedEdgePct}% < ${minRequiredEdge}%)`);
      return;
    }

    const entry = enterTrade({
      token: best.token,
      intendedHoldMs: best.strategy.intendedHoldMs,
      expectedEdgePct: best.strategy.expectedEdgePct,
      stopLossPct: best.strategy.stopLossPct,
      takeProfitPct: best.strategy.takeProfitPct,
      reason: best.strategy.reason,
      signalScore: best.score,
      signalContext: {
        delta: best.delta,
        accumulation: best.accumulation,
        distribution: best.distribution,
        absorption: best.absorption,
        corpse: best.corpse,
        exceptionalOverride: best.exceptionalOverride,
        reasons: best.reasons,
        setup: best.strategy.reason,
        imageUrl: best.token.imageUrl || null
      }
    });

    if (!entry) {
      await send(chatId, t(userId, "couldNotOpen"));
      return;
    }

    const afterEntry = getPortfolio();

    const entryText = `🚀 <b>${t(userId, "entry")}</b>

<b>${t(userId, "token")}:</b> ${entry.token}
<b>${t(userId, "ca")}:</b> <code>${entry.ca}</code>
<b>${t(userId, "copyHint")}:</b> <code>${entry.ca}</code>
<b>${t(userId, "signalScore")}:</b> ${entry.signalScore}
<b>${t(userId, "setup")}:</b> ${entry.reason}

<b>${t(userId, "entryRef")}:</b> ${entry.entryReferencePrice}
<b>${t(userId, "entryEffective")}:</b> ${entry.entryEffectivePrice}
<b>${t(userId, "size")}:</b> ${entry.amountSol.toFixed(4)} SOL
<b>${t(userId, "expectedEdge")}:</b> ${entry.expectedEdgePct}%

<b>${t(userId, "entryCosts")}:</b> ${entry.entryCosts.totalSol.toFixed(6)} SOL
<b>${t(userId, "balance")}:</b> ${afterEntry.balance.toFixed(4)} SOL`;

    await sendSignalMessage(chatId, entryText, best.token.imageUrl || null);
  } catch (error) {
    console.log("cycle error:", error.message);
    await send(chatId, `⚠️ Cycle error: ${error.message}`);
  }
}

function startAuto(chatId, userId, hours = AUTO_HOURS_DEFAULT) {
  stopAuto();
  activeChatId = chatId;
  activeChatUserId = userId;
  recentlyTraded.clear();
  resetPortfolio(1.0);

  runState = {
    startedAt: Date.now(),
    stoppedAt: null,
    runId: `run-${Date.now()}`,
    notes: [`Started ${hours}h simulation with 1 SOL`]
  };

  intervalId = setInterval(() => {
    runCycle(chatId, userId);
  }, AUTO_INTERVAL_MS);

  autoStopId = setTimeout(async () => {
    stopAuto();
    if (activeChatId) {
      await send(activeChatId, t(activeChatUserId || userId, "autoStopped"));
      await send(activeChatId, buildStatusText(activeChatUserId || userId), {
        reply_markup: buildReplyKeyboard(activeChatUserId || userId)
      });
    }
  }, hours * 60 * 60 * 1000);
}

async function handleAction(chatId, userId, action) {
  if (action === "start") {
    await send(
      chatId,
      `${t(userId, "ready")} ${t(userId, "commands")}: /run4h /stop /status /scan /exportcsv /exportstats /exportxlsx /language`,
      { reply_markup: buildReplyKeyboard(userId) }
    );
    return;
  }

  if (action === "run4h") {
    await send(chatId, t(userId, "started"));
    startAuto(chatId, userId, 4);
    return;
  }

  if (action === "stop") {
    if (intervalId) {
      stopAuto();
      await send(chatId, t(userId, "stopped"));
    } else {
      await send(chatId, t(userId, "alreadyStopped"));
    }
    return;
  }

  if (action === "status") {
    await send(chatId, buildStatusText(userId), {
      reply_markup: buildReplyKeyboard(userId)
    });
    return;
  }

  if (action === "scan") {
    await runCycle(chatId, userId);
    return;
  }

  if (action === "exportstats") {
    await exportJson(chatId);
    return;
  }

  if (action === "exportcsv") {
    await exportCsv(chatId);
    return;
  }

  if (action === "exportxlsx") {
    await exportXlsx(chatId);
    return;
  }

  if (action === "language") {
    await send(chatId, t(userId, "chooseLanguage"), {
      reply_markup: languageMenu()
    });
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  const text = String(msg.text || "").trim();

  activeChatUserId = userId;

  const action = normalizeButtonAction(text);
  if (action) {
    await handleAction(chatId, userId, action);
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from?.id || chatId;
  const data = query.data;

  activeChatUserId = userId;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch {}

  if (data === "langmenu") {
    await send(chatId, t(userId, "chooseLanguage"), {
      reply_markup: languageMenu()
    });
    return;
  }

  if (data.startsWith("lang:")) {
    const lang = data.split(":")[1];
    setLang(userId, lang);
    await send(chatId, `${t(userId, "languageSet")}: ${lang.toUpperCase()}`, {
      reply_markup: buildReplyKeyboard(userId)
    });
    return;
  }
}

async function processUpdate(update) {
  try {
    if (update?.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }

    if (update?.message?.text) {
      await handleMessage(update.message);
    }
  } catch (error) {
    console.log("update error:", error.message);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === PATH) {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", async () => {
      res.writeHead(200);
      res.end("OK");

      try {
        const update = JSON.parse(body);
        await processUpdate(update);
      } catch (error) {
        console.log("webhook error:", error.message);
      }
    });

    return;
  }

  if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, async () => {
  console.log("🚀 Server started");
  await bot.setWebHook(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}${PATH}`);
  console.log("✅ Webhook set");
});
