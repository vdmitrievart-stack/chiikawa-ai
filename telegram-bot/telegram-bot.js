import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import * as XLSX from "xlsx";

import TradingKernel from "./core/trading-kernel.js";
import { buildBalanceText } from "./core/reporting-engine.js";
import { buildStrategyPlans } from "./strategy-engine.js";
import { analyzeToken, scanMarket } from "./scan-engine.js";

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
const kernel = new TradingKernel({ logger: console });

let loopId = null;
let stopTimeoutId = null;
const tempFiles = new Set();
const chatState = new Map();

function keyboard() {
  return {
    keyboard: [
      ["▶️ Run Multi", "🎯 Run Strategy"],
      ["💰 Balance", "📊 Status"],
      ["🔎 Scan Market", "🧾 Scan CA"],
      ["🧮 Budget", "🌐 Language"],
      ["📋 Copytrade", "👛 Wallets"],
      ["🛑 Stop", "☠️ Kill"],
      ["📈 Export CSV", "📦 Export JSON"],
      ["📊 Export XLSX"]
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

  const pairs = [
    [["/start", "/menu"], "start"],
    [["/runmulti", "run multi", "▶️ run multi"], "runmulti"],
    [["/runstrategy", "🎯 run strategy"], "runstrategy"],
    [["/stop", "🛑 stop", "стоп"], "stop"],
    [["/kill", "☠️ kill"], "kill"],
    [["/status", "📊 status", "статус"], "status"],
    [["/scanmarket", "scan market", "🔎 scan market"], "scan_market"],
    [["/scanca", "/ca", "scan ca", "🧾 scan ca"], "scan_ca"],
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

function isLikelyCA(text) {
  const value = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(value);
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

function buildAnalysisText(analyzed, plans) {
  const t = analyzed.token || {};
  const reasons = (analyzed.reasons || [])
    .slice(0, 12)
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

<b>Token:</b> ${escapeHtml(t.name || "Unknown")}
<b>CA:</b> <code>${escapeHtml(t.ca || "")}</code>
<b>Score:</b> ${round(analyzed.score, 2)}

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
🧾 <b>Narrative:</b> ${escapeHtml(analyzed.narrative?.verdict || "Unknown")}
🌐 <b>Socials:</b> ${escapeHtml((analyzed.socials?.notes || []).join(", ") || "none")}

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

async function fetchTokenByCA(ca) {
  const res = await fetch(`${DEX_TOKEN_API}/${encodeURIComponent(ca)}`);
  if (!res.ok) {
    throw new Error(`DexScreener HTTP ${res.status}`);
  }

  const json = await res.json();
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  if (!pairs.length) return null;

  const pair = pairs
    .map((p) => ({
      name: p?.baseToken?.symbol || p?.baseToken?.name || "UNKNOWN",
      ca: p?.baseToken?.address || "",
      pairAddress: p?.pairAddress || "",
      chainId: p?.chainId || "",
      dexId: p?.dexId || "",
      price: safeNum(p?.priceUsd),
      liquidity: safeNum(p?.liquidity?.usd),
      volume: safeNum(p?.volume?.h24),
      buys: safeNum(p?.txns?.h24?.buys),
      sells: safeNum(p?.txns?.h24?.sells),
      txns: safeNum(p?.txns?.h24?.buys) + safeNum(p?.txns?.h24?.sells),
      fdv: safeNum(p?.fdv),
      pairCreatedAt: safeNum(p?.pairCreatedAt),
      url: p?.url || ""
    }))
    .sort((a, b) => b.volume - a.volume)[0];

  return pair || null;
}

async function analyzeCA(chatId, ca) {
  await sendMessage(chatId, `🧾 <b>Scanning CA</b>\n<code>${escapeHtml(ca)}</code>`);

  const token = await fetchTokenByCA(ca);
  if (!token) {
    await sendMessage(chatId, "❌ Token not found by CA.", { reply_markup: keyboard() });
    return;
  }

  const analyzed = await analyzeToken(token);
  const plans = buildStrategyPlans(analyzed, {
    enabledStrategies: kernel.getRuntime().activeConfig.strategyEnabled
  });

  await sendMessage(chatId, buildAnalysisText(analyzed, plans), {
    reply_markup: keyboard()
  });
}

async function runMarketScan(chatId) {
  await sendMessage(chatId, "🔎 <b>Market scan started</b>", {
    reply_markup: keyboard()
  });

  const market = await scanMarket();
  if (!market.length) {
    await sendMessage(chatId, "❌ No market candidates found.", { reply_markup: keyboard() });
    return;
  }

  await flushCycle(chatId);
}

async function flushCycle(chatId) {
  const events = await kernel.cycle();
  for (const event of events) {
    const text = kernel.renderEventText(event);
    if (text) await sendMessage(chatId, text);
  }

  const rt = kernel.getRuntime();
  const shouldReport =
    !rt.lastReportAt ||
    Date.now() - rt.lastReportAt >= rt.activeConfig.reportIntervalMin * 60 * 1000;

  if (shouldReport) {
    rt.lastReportAt = Date.now();
    await sendMessage(chatId, kernel.buildPeriodicReport());
  }

  if (rt.stopRequested && kernel.getPortfolio().positions.length === 0) {
    stopLoop();
    rt.mode = "stopped";
    await sendMessage(chatId, "🛑 <b>ОСТАНОВКА ЗАВЕРШЕНА</b>\nБольше нет открытых позиций.", {
      reply_markup: keyboard()
    });
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
  const header = [
    "id",
    "strategy",
    "walletId",
    "token",
    "ca",
    "entryRef",
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

  const rows = closed.map((t) => [
    t.id,
    t.strategy,
    t.walletId,
    t.token,
    t.ca,
    t.entryReferencePrice,
    t.exitReferencePrice,
    t.amountSol,
    t.netPnlPct,
    t.netPnlSol,
    t.reason,
    t.openedAt,
    t.closedAt,
    t.durationMs,
    t.balanceAfter
  ]);

  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function statsToXlsxWorkbook() {
  const pf = kernel.getPortfolio();
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { metric: "equity", value: pf.equity },
      { metric: "cash", value: pf.cash },
      { metric: "realized", value: pf.realizedPnlSol },
      { metric: "unrealized", value: pf.unrealizedPnlSol }
    ]),
    "summary"
  );

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pf.closedTrades), "trades");
  return wb;
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

async function exportJson(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(kernel.getPortfolio(), null, 2), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/json"
  });
  await scheduleTempCleanup(filePath);
}

async function exportCsv(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${Date.now()}.csv`);
  await fs.writeFile(filePath, statsToCsv(), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "text/csv"
  });
  await scheduleTempCleanup(filePath);
}

async function exportXlsx(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${Date.now()}.xlsx`);
  XLSX.writeFile(statsToXlsxWorkbook(), filePath);
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  await scheduleTempCleanup(filePath);
}

async function handleAction(chatId, userId, action) {
  if (action === "start") {
    clearChatMode(chatId);
    await sendMessage(chatId, "🤖 <b>Bot ready</b>\n\nUse the menu below.", {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "runmulti") {
    await sendMessage(chatId, "🚀 Starting multi-strategy engine from 1 SOL", {
      reply_markup: keyboard()
    });
    startRun(chatId, userId, "infinite");
    return;
  }

  if (action === "runstrategy") {
    await sendMessage(chatId, "🎯 Send one of: scalp / reversal / runner / copytrade only", {
      reply_markup: keyboard()
    });
    return;
  }

  if (action.startsWith("run_")) {
    const strategy = action.replace("run_", "");
    await sendMessage(chatId, `🚀 Starting ${strategy} only mode`, {
      reply_markup: keyboard()
    });
    startRun(chatId, userId, "infinite", strategy);
    return;
  }

  if (action === "stop") {
    kernel.requestStop();
    await sendMessage(chatId, "🛑 Stop requested. Bot will stop after natural exits.", {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "kill") {
    stopLoop();
    const closed = await kernel.killAllPositions("KILL_SWITCH");
    await sendMessage(chatId, `☠️ <b>KILL EXECUTED</b>\nClosed positions: ${closed.length}`, {
      reply_markup: keyboard()
    });
    await sendMessage(chatId, kernel.buildDashboardText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "status") {
    await sendMessage(chatId, kernel.buildDashboardText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "balance") {
    await sendMessage(chatId, buildBalanceText(kernel.getPortfolio()), {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "scan_market") {
    clearChatMode(chatId);
    await runMarketScan(chatId);
    return;
  }

  if (action === "scan_ca") {
    setChatMode(chatId, "awaiting_ca");
    await sendMessage(chatId, "🧾 <b>Send CA</b>\n\nОтправь контракт токена следующим сообщением.", {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "budget") {
    const cfg = kernel.getRuntime().activeConfig.strategyBudget;
    await sendMessage(
      chatId,
      `<b>Current budget</b>\nscalp: ${Math.round(cfg.scalp * 100)}%\nreversal: ${Math.round(
        cfg.reversal * 100
      )}%\nrunner: ${Math.round(cfg.runner * 100)}%\ncopytrade: ${Math.round(
        cfg.copytrade * 100
      )}%\n\nSend: <code>budget 25 25 25 25</code>`,
      { reply_markup: keyboard() }
    );
    return;
  }

  if (action === "budget_equal") {
    kernel.queueConfigPatch(
      {
        strategyBudget: {
          scalp: 0.25,
          reversal: 0.25,
          runner: 0.25,
          copytrade: 0.25
        }
      },
      "budget_equal"
    );
    await sendMessage(chatId, "🧮 Pending budget queued: 25 / 25 / 25 / 25", {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "language") {
    await sendMessage(chatId, "🌐 Send: <code>lang ru</code> or <code>lang en</code>", {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "lang_ru" || action === "lang_en") {
    const lang = action === "lang_ru" ? "ru" : "en";
    kernel.queueConfigPatch({ language: lang }, `lang_${lang}`);
    kernel.getRuntime().activeConfig.language = lang;
    await sendMessage(chatId, `🌐 Language set: ${lang.toUpperCase()}`, {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "copytrade") {
    const copyCfg = kernel.getRuntime().activeConfig.copytrade;
    await sendMessage(
      chatId,
      `<b>Copytrade</b>\nEnabled: ${copyCfg.enabled}\nRescoring: ${copyCfg.rescoringEnabled}\nMin leader score: ${copyCfg.minLeaderScore}\nCooldown min: ${copyCfg.cooldownMinutes}`,
      { reply_markup: keyboard() }
    );
    return;
  }

  if (action === "wallets") {
    const wallets = kernel.getRuntime().activeConfig.wallets;
    const text = Object.entries(wallets)
      .map(
        ([id, w]) =>
          `• <b>${id}</b>\nlabel: ${w.label}\nrole: ${w.role}\nenabled: ${w.enabled}\nmode: ${w.executionMode}\nstrategies: ${(w.allowedStrategies || []).join(", ")}`
      )
      .join("\n\n");

    await sendMessage(chatId, `<b>Wallets</b>\n${text}`, { reply_markup: keyboard() });
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

  await sendMessage(chatId, "Use the menu below.", { reply_markup: keyboard() });
}

async function processMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  const text = String(msg.text || "").trim();
  const mode = getChatMode(chatId);
  const action = normalizeAction(text);

  if (action) {
    await handleAction(chatId, userId, action);
    return;
  }

  if (mode.mode === "awaiting_ca") {
    if (!isLikelyCA(text)) {
      await sendMessage(chatId, "❌ Это не похоже на валидный CA. Отправь адрес токена целиком.", {
        reply_markup: keyboard()
      });
      return;
    }

    clearChatMode(chatId);
    await analyzeCA(chatId, text);
    return;
  }

  const budgetMatch = text.match(/^budget\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/i);
  if (budgetMatch) {
    const [_, a, b, c, d] = budgetMatch;
    const total = Number(a) + Number(b) + Number(c) + Number(d);
    if (total !== 100) {
      await sendMessage(chatId, "Budget must sum to 100.");
      return;
    }

    kernel.queueConfigPatch(
      {
        strategyBudget: {
          scalp: Number(a) / 100,
          reversal: Number(b) / 100,
          runner: Number(c) / 100,
          copytrade: Number(d) / 100
        }
      },
      "manual_budget_update"
    );

    await sendMessage(chatId, "🧮 Pending budget update queued.", { reply_markup: keyboard() });
    return;
  }

  if (isLikelyCA(text)) {
    await sendMessage(
      chatId,
      "Чтобы проанализировать контракт, сначала нажми <b>🧾 Scan CA</b>, а потом отправь адрес.",
      { reply_markup: keyboard() }
    );
    return;
  }

  await sendMessage(chatId, "Use the menu below.", { reply_markup: keyboard() });
}

bot.on("message", (msg) => {
  processMessage(msg).catch((err) => {
    console.log("message error:", err.message);
  });
});

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
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
