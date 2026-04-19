import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import * as XLSX from "xlsx";

import TradingKernel from "./trading-kernel.js";
import { buildBalanceText } from "./reporting-engine.js";

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chiikawa_secret";
const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;
const AUTO_INTERVAL_MS = Number(process.env.AUTO_INTERVAL_MS || 60000);

if (!TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });
const kernel = new TradingKernel({ logger: console });

let loopId = null;
let stopTimeoutId = null;
const tempFiles = new Set();

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function keyboard() {
  return {
    keyboard: [
      ["▶️ Run Multi", "🎯 Run Strategy"],
      ["💰 Balance", "📊 Status"],
      ["🧮 Budget", "🌐 Language"],
      ["📋 Copytrade", "👛 Wallets"],
      ["🔎 Scan", "🛑 Stop"],
      ["☠️ Kill", "📈 Export CSV"],
      ["📦 Export JSON", "📊 Export XLSX"]
    ],
    resize_keyboard: true,
    persistent: true
  };
}

function normalizeAction(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return null;
  const pairs = [
    [["/start", "/menu"], "start"],
    [["/runmulti", "run multi", "▶️ run multi"], "runmulti"],
    [["/runstrategy", "🎯 run strategy"], "runstrategy"],
    [["/stop", "🛑 stop", "стоп"], "stop"],
    [["/kill", "☠️ kill"], "kill"],
    [["/status", "📊 status", "статус"], "status"],
    [["/scan", "🔎 scan", "скан"], "scan"],
    [["/balance", "💰 balance"], "balance"],
    [["/budget", "🧮 budget"], "budget"],
    [["/language", "🌐 language"], "language"],
    [["/copytrade", "📋 copytrade"], "copytrade"],
    [["/wallets", "👛 wallets"], "wallets"],
    [["/exportcsv"], "exportcsv"],
    [["/exportjson"], "exportjson"],
    [["/exportxlsx"], "exportxlsx"],
    [["scalp", "run scalp"], "run_scalp"],
    [["reversal", "run reversal"], "run_reversal"],
    [["runner", "run runner"], "run_runner"],
    [["copytrade only", "run copytrade"], "run_copytrade"],
    [["budget 25 25 25 25"], "budget_equal"],
    [["lang ru"], "lang_ru"],
    [["lang en"], "lang_en"]
  ];

  for (const [aliases, action] of pairs) {
    if (aliases.some((x) => raw === x || raw.includes(x))) return action;
  }

  return null;
}

async function sendMessage(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}

function stopLoop() {
  if (loopId) clearInterval(loopId);
  if (stopTimeoutId) clearTimeout(stopTimeoutId);
  loopId = null;
  stopTimeoutId = null;
}

async function flushCycle(chatId) {
  const events = await kernel.cycle();
  for (const event of events) {
    const text = kernel.renderEventText(event);
    if (text) await sendMessage(chatId, text);
  }

  const rt = kernel.getRuntime();
  const shouldReport = !rt.lastReportAt || Date.now() - rt.lastReportAt >= rt.activeConfig.reportIntervalMin * 60 * 1000;
  if (shouldReport) {
    rt.lastReportAt = Date.now();
    await sendMessage(chatId, kernel.buildPeriodicReport());
  }

  if (rt.stopRequested && kernel.getPortfolio().positions.length === 0) {
    stopLoop();
    rt.mode = "stopped";
    await sendMessage(chatId, "🛑 <b>STOP COMPLETE</b>\nNo open positions left.");
    await sendMessage(chatId, kernel.buildDashboardText(), { reply_markup: keyboard() });
  }
}

function startRun(chatId, userId, mode, strategyOnly = null) {
  stopLoop();
  const rt = kernel.start({ mode, chatId, userId, startBalance: 1 });
  if (strategyOnly) {
    rt.activeConfig.strategyEnabled = {
      scalp: strategyOnly === "scalp",
      reversal: strategyOnly === "reversal",
      runner: strategyOnly === "runner",
      copytrade: strategyOnly === "copytrade"
    };
  }

  loopId = setInterval(() => {
    flushCycle(chatId).catch((err) => console.log("cycle error:", err.message));
  }, AUTO_INTERVAL_MS);

  if (mode === "4h") {
    stopTimeoutId = setTimeout(async () => {
      kernel.requestStop();
      await sendMessage(chatId, "🛑 <b>AUTO STOP REQUESTED</b>\nWaiting natural exits.");
    }, 4 * 60 * 60 * 1000);
  }
}

function statsToCsv() {
  const closed = kernel.getPortfolio().closedTrades;
  const header = ["id", "strategy", "walletId", "token", "ca", "entryRef", "exitRef", "amountSol", "netPnlPct", "netPnlSol", "reason", "openedAt", "closedAt", "durationMs", "balanceAfter"];
  const rows = closed.map((t) => [t.id, t.strategy, t.walletId, t.token, t.ca, t.entryReferencePrice, t.exitReferencePrice, t.amountSol, t.netPnlPct, t.netPnlSol, t.reason, t.openedAt, t.closedAt, t.durationMs, t.balanceAfter]);
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function statsToXlsxWorkbook() {
  const pf = kernel.getPortfolio();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ metric: "equity", value: pf.equity }, { metric: "cash", value: pf.cash }, { metric: "realized", value: pf.realizedPnlSol }, { metric: "unrealized", value: pf.unrealizedPnlSol }]), "summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pf.closedTrades), "trades");
  return wb;
}

async function scheduleTempCleanup(filePath) {
  tempFiles.add(filePath);
  setTimeout(async () => {
    try { await fs.unlink(filePath); } catch {}
    tempFiles.delete(filePath);
  }, 5 * 60 * 1000);
}

async function exportJson(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(kernel.getPortfolio(), null, 2), "utf8");
  await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath), contentType: "application/json" });
  await scheduleTempCleanup(filePath);
}

async function exportCsv(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${Date.now()}.csv`);
  await fs.writeFile(filePath, statsToCsv(), "utf8");
  await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath), contentType: "text/csv" });
  await scheduleTempCleanup(filePath);
}

async function exportXlsx(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${Date.now()}.xlsx`);
  XLSX.writeFile(statsToXlsxWorkbook(), filePath);
  await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  await scheduleTempCleanup(filePath);
}

async function handleAction(chatId, userId, action) {
  if (action === "start") {
    await sendMessage(chatId, "🤖 <b>Bot ready</b>\n\nUse the menu below.", { reply_markup: keyboard() });
    return;
  }
  if (action === "runmulti") {
    await sendMessage(chatId, "🚀 Starting multi-strategy engine from 1 SOL", { reply_markup: keyboard() });
    startRun(chatId, userId, "infinite");
    return;
  }
  if (action === "runstrategy") {
    await sendMessage(chatId, "🎯 Send one of: scalp / reversal / runner / copytrade only", { reply_markup: keyboard() });
    return;
  }
  if (action.startsWith("run_")) {
    const strategy = action.replace("run_", "");
    await sendMessage(chatId, `🚀 Starting ${strategy} only mode`, { reply_markup: keyboard() });
    startRun(chatId, userId, "infinite", strategy);
    return;
  }
  if (action === "stop") {
    kernel.requestStop();
    await sendMessage(chatId, "🛑 Stop requested. Bot will stop after natural exits.", { reply_markup: keyboard() });
    return;
  }
  if (action === "kill") {
    stopLoop();
    const closed = await kernel.killAllPositions("KILL_SWITCH");
    await sendMessage(chatId, `☠️ <b>KILL EXECUTED</b>\nClosed positions: ${closed.length}`, { reply_markup: keyboard() });
    await sendMessage(chatId, kernel.buildDashboardText(), { reply_markup: keyboard() });
    return;
  }
  if (action === "status") {
    await sendMessage(chatId, kernel.buildDashboardText(), { reply_markup: keyboard() });
    return;
  }
  if (action === "balance") {
    await sendMessage(chatId, buildBalanceText(kernel.getPortfolio()), { reply_markup: keyboard() });
    return;
  }
  if (action === "scan") {
    await flushCycle(chatId);
    return;
  }
  if (action === "budget") {
    const cfg = kernel.getRuntime().activeConfig.strategyBudget;
    await sendMessage(chatId, `🧮 <b>BUDGET</b>\n\nSCALP ${round(cfg.scalp * 100, 0)}%\nREVERSAL ${round(cfg.reversal * 100, 0)}%\nRUNNER ${round(cfg.runner * 100, 0)}%\nCOPYTRADE ${round(cfg.copytrade * 100, 0)}%\n\nSend: budget 25 25 25 25`, { reply_markup: keyboard() });
    return;
  }
  if (action === "budget_equal") {
    kernel.queueConfigPatch({ strategyBudget: { scalp: 0.25, reversal: 0.25, runner: 0.25, copytrade: 0.25 } }, "equal_budget");
    await sendMessage(chatId, "✅ Pending budget set to 25/25/25/25. It will apply after natural exits or Kill.", { reply_markup: keyboard() });
    return;
  }
  if (action === "language") {
    await sendMessage(chatId, "🌐 Language commands: lang ru / lang en", { reply_markup: keyboard() });
    return;
  }
  if (action === "lang_ru" || action === "lang_en") {
    const lang = action === "lang_ru" ? "ru" : "en";
    kernel.queueConfigPatch({ language: lang }, "language_change");
    await sendMessage(chatId, `✅ Pending language set to ${lang}.`, { reply_markup: keyboard() });
    return;
  }
  if (action === "copytrade") {
    const copyCfg = kernel.getRuntime().activeConfig.copytrade;
    await sendMessage(chatId, `📋 <b>COPYTRADE</b>\n\nEnabled: ${copyCfg.enabled}\nGMGN enabled: ${copyCfg.gmgnEnabled}\nMin leader score: ${copyCfg.minLeaderScore}\nCooldown: ${copyCfg.cooldownMinutes}m`, { reply_markup: keyboard() });
    return;
  }
  if (action === "wallets") {
    const wallets = kernel.getRuntime().activeConfig.wallets;
    const text = Object.entries(wallets).map(([id, row]) => `• <b>${id}</b> — ${row.label} | ${row.role} | ${row.executionMode} | enabled=${row.enabled}`).join("\n");
    await sendMessage(chatId, `👛 <b>WALLETS</b>\n\n${text}`, { reply_markup: keyboard() });
    return;
  }
  if (action === "exportcsv") return exportCsv(chatId);
  if (action === "exportjson") return exportJson(chatId);
  if (action === "exportxlsx") return exportXlsx(chatId);
  await sendMessage(chatId, "Команды через меню ниже.", { reply_markup: keyboard() });
}

async function processMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  const text = msg.text || "";

  const budgetMatch = text.trim().match(/^budget\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/i);
  if (budgetMatch) {
    const [_, a, b, c, d] = budgetMatch;
    kernel.queueConfigPatch({ strategyBudget: { scalp: Number(a) / 100, reversal: Number(b) / 100, runner: Number(c) / 100, copytrade: Number(d) / 100 } }, "budget_manual");
    await sendMessage(chatId, "✅ Pending budget updated. It will apply after natural exits or Kill.", { reply_markup: keyboard() });
    return;
  }

  const action = normalizeAction(text);
  if (!action) {
    await sendMessage(chatId, "Команды через меню ниже.", { reply_markup: keyboard() });
    return;
  }
  await handleAction(chatId, userId, action);
}

async function processUpdate(update) {
  if (update.message) return processMessage(update.message);
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Chiikawa Telegram Bot is running");
    return;
  }

  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        const update = JSON.parse(raw);
        await processUpdate(update);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
});

server.listen(PORT, async () => {
  console.log(`Telegram bot listening on ${PORT}`);
  if (process.env.WEBHOOK_URL) {
    await bot.setWebHook(`${process.env.WEBHOOK_URL}${WEBHOOK_PATH}`);
    console.log("Webhook set");
  }
});
