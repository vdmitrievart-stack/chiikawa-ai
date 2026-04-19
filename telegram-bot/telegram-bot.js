import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import * as XLSX from "xlsx";

import { getBestTrade, getLatestTokenPrice, recordTradeOutcomeFromSignalContext } from "./scan-engine.js";
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
  estimateRoundTripCostPct
} from "./portfolio.js";
import { buildStrategyPlans } from "./strategy-engine.js";

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
const tempFiles = new Set();

let activeChatId = null;
let activeUserId = null;
let loopId = null;
let stopTimeoutId = null;
let currentMode = "stopped";
let recentlyTraded = new Map();
let runState = {
  runId: null,
  startedAt: null,
  mode: "stopped"
};

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

function normalizeAction(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return null;

  if (raw.startsWith("/")) {
    return raw.slice(1);
  }

  if (raw.includes("4h") || raw.includes("4ч")) return "run4h";
  if (raw.includes("infinite") || raw.includes("бескон")) return "runinfinite";
  if (raw.includes("stop") || raw.includes("стоп")) return "stop";
  if (raw.includes("status") || raw.includes("статус")) return "status";
  if (raw.includes("scan") || raw.includes("скан")) return "scan";
  if (raw.includes("csv")) return "exportcsv";
  if (raw.includes("json")) return "exportjson";
  if (raw.includes("xlsx")) return "exportxlsx";
  if (raw.includes("start") || raw.includes("старт")) return "start";

  return null;
}

function keyboard() {
  return {
    keyboard: [
      ["▶️ Run 4h", "♾️ Run Infinite"],
      ["🛑 Stop", "📊 Status"],
      ["🔎 Scan", "📈 Export CSV"],
      ["📦 Export JSON", "📊 Export XLSX"]
    ],
    resize_keyboard: true,
    persistent: true
  };
}

async function sendMessage(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}

async function sendPhotoOrText(chatId, imageUrl, caption) {
  const safeCaption = caption.slice(0, 1024);
  if (imageUrl) {
    try {
      await bot.sendPhoto(chatId, imageUrl, {
        caption: safeCaption,
        parse_mode: "HTML"
      });
      return;
    } catch (e) {
      console.log("sendPhoto fallback:", e.message);
    }
  }
  await sendMessage(chatId, caption);
}

function pruneRecentlyTraded() {
  const now = Date.now();
  for (const [ca, ts] of recentlyTraded.entries()) {
    if (now - ts > 2 * 60 * 60 * 1000) {
      recentlyTraded.delete(ca);
    }
  }
}

function stopLoop() {
  if (loopId) clearInterval(loopId);
  if (stopTimeoutId) clearTimeout(stopTimeoutId);
  loopId = null;
  stopTimeoutId = null;
  currentMode = "stopped";
  runState.mode = "stopped";
}

function buildDashboard() {
  const pf = getPortfolio();
  const cfg = getStrategyConfig();

  const totalClosed = pf.closedTrades.length;
  const wins = pf.closedTrades.filter(t => t.netPnlPct > 0).length;
  const winrate = totalClosed ? (wins / totalClosed) * 100 : 0;

  const lines = [
    `📊 <b>BOT DASHBOARD</b>`,
    ``,
    `<b>Run ID:</b> ${escapeHtml(runState.runId || "-")}`,
    `<b>Mode:</b> ${escapeHtml(currentMode.toUpperCase())}`,
    `<b>Start balance:</b> ${round(pf.startBalance, 4)} SOL`,
    `<b>Cash:</b> ${round(pf.cash, 4)} SOL`,
    `<b>Equity:</b> ${round(pf.equity, 4)} SOL`,
    `<b>Realized PnL:</b> ${round(pf.realizedPnlSol, 4)} SOL`,
    `<b>Unrealized PnL:</b> ${round(pf.unrealizedPnlSol, 4)} SOL`,
    `<b>Closed trades:</b> ${totalClosed}`,
    `<b>Winrate:</b> ${round(winrate, 2)}%`,
    ``,
    `<b>Strategy buckets</b>`
  ];

  for (const key of Object.keys(cfg)) {
    const row = pf.byStrategy[key];
    lines.push(
      `• <b>${escapeHtml(cfg[key].label)}</b> — alloc ${round(cfg[key].allocationPct * 100, 0)}% | available ${round(row.availableSol, 4)} SOL | open ${row.openPositions} | closed ${row.closedTrades} | pnl ${round(row.realizedPnlSol, 4)} SOL`
    );
  }

  return lines.join("\n");
}

function buildAnalysisText(analyzed, plans) {
  const t = analyzed.token;
  const narrativeSummary = escapeHtml(analyzed.narrative.summary || "");
  const reasons = analyzed.reasons.slice(0, 12).map(r => `• ${escapeHtml(r)}`).join("\n");
  const plansText = plans.length
    ? plans
        .map(
          p =>
            `• <b>${escapeHtml(p.strategyKey.toUpperCase())}</b> | edge ${round(p.expectedEdgePct, 2)}% | hold ${Math.round(p.plannedHoldMs / 60000)}m | SL ${p.stopLossPct}% | TP ${p.takeProfitPct || "runner"}`
        )
        .join("\n")
    : `• none`;

  return `🔎 <b>ANALYSIS</b>

<b>Token:</b> ${escapeHtml(t.name)}
<b>CA:</b> <code>${escapeHtml(t.ca)}</code>
<b>Score:</b> ${round(analyzed.score, 2)}

<b>Price:</b> ${escapeHtml(t.price)}
<b>Liquidity:</b> ${escapeHtml(t.liquidity)}
<b>Volume 24h:</b> ${escapeHtml(t.volume)}
<b>Txns 24h:</b> ${escapeHtml(t.txns)}
<b>FDV:</b> ${escapeHtml(t.fdv)}

⚠️ <b>Rug:</b> ${analyzed.rug.risk}
🧠 <b>Smart Money:</b> ${analyzed.wallet.smartMoney}
👥 <b>Concentration:</b> ${round(analyzed.wallet.concentration, 2)}
🤖 <b>Bot Activity:</b> ${analyzed.bots.botActivity}
🐦 <b>Sentiment:</b> ${analyzed.sentiment.sentiment}
☠️ <b>Corpse Score:</b> ${analyzed.corpse.score}
👨‍💻 <b>Dev Verdict:</b> ${escapeHtml(analyzed.developer.verdict)}
🧾 <b>Narrative:</b> ${escapeHtml(analyzed.narrative.verdict)}
🌐 <b>Socials:</b> ${escapeHtml(analyzed.socials.notes.join(", ") || "none")}

<b>Narrative summary:</b>
${narrativeSummary || "none"}

📈 <b>Delta</b>
<b>Price Δ:</b> ${round(analyzed.delta.priceDeltaPct, 2)}%
<b>Volume Δ:</b> ${round(analyzed.delta.volumeDeltaPct, 2)}%
<b>Txns Δ:</b> ${round(analyzed.delta.txnsDeltaPct, 2)}%
<b>Liquidity Δ:</b> ${round(analyzed.delta.liquidityDeltaPct, 2)}%
<b>Buy Pressure Δ:</b> ${round(analyzed.delta.buyPressureDelta, 3)}

🎯 <b>Available plans</b>
${plansText}

<b>Reasons:</b>
${reasons}`;
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
  return `📈 <b>POSITION UPDATE</b>

<b>Strategy:</b> ${escapeHtml(position.strategy.toUpperCase())}
<b>Token:</b> ${escapeHtml(position.token)}
<b>CA:</b> <code>${escapeHtml(position.ca)}</code>

<b>Entry ref:</b> ${position.entryReferencePrice}
<b>Current:</b> ${mark.currentPrice}
<b>Gross PnL:</b> ${round(mark.grossPnlPct, 2)}%
<b>Net PnL:</b> ${round(mark.netPnlPct, 2)}%
<b>Age:</b> ${Math.round(mark.ageMs / 1000)}s
<b>Status:</b> ${escapeHtml(status)}
`;
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

  const rows = closed.map(t => [
    t.id,
    t.strategy,
    t.token,
    t.ca,
    t.entryReferencePrice,
    t.entryEffectivePrice,
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

  return [header.join(","), ...rows.map(r => r.join(","))].join("\n");
}

function statsToXlsxWorkbook() {
  const pf = getPortfolio();
  const summaryRows = [
    { metric: "runId", value: runState.runId || "" },
    { metric: "mode", value: currentMode },
    { metric: "startBalance", value: pf.startBalance },
    { metric: "cash", value: pf.cash },
    { metric: "equity", value: pf.equity },
    { metric: "realizedPnlSol", value: pf.realizedPnlSol },
    { metric: "unrealizedPnlSol", value: pf.unrealizedPnlSol },
    { metric: "closedTrades", value: pf.closedTrades.length }
  ];

  const tradesRows = pf.closedTrades.map(t => ({
    id: t.id,
    strategy: t.strategy,
    token: t.token,
    ca: t.ca,
    entryReferencePrice: t.entryReferencePrice,
    entryEffectivePrice: t.entryEffectivePrice,
    exitReferencePrice: t.exitReferencePrice,
    amountSol: t.amountSol,
    netPnlPct: t.netPnlPct,
    netPnlSol: t.netPnlSol,
    reason: t.reason,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    durationMs: t.durationMs,
    balanceAfter: t.balanceAfter
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tradesRows), "trades");
  return wb;
}

async function exportJson(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${runState.runId || Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(getPortfolio(), null, 2), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/json"
  });
  await scheduleTempCleanup(filePath);
}

async function exportCsv(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${runState.runId || Date.now()}.csv`);
  await fs.writeFile(filePath, statsToCsv(), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "text/csv"
  });
  await scheduleTempCleanup(filePath);
}

async function exportXlsx(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${runState.runId || Date.now()}.xlsx`);
  XLSX.writeFile(statsToXlsxWorkbook(), filePath);
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  await scheduleTempCleanup(filePath);
}

async function cycle(chatId, userId) {
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
        `🎯 <b>RUNNER PARTIAL</b>\n\n<b>Token:</b> ${escapeHtml(p.token)}\n<b>Target:</b> ${partial.targetPct}%\n<b>Sold fraction:</b> ${round(partial.soldFraction * 100, 0)}%\n<b>Cash added:</b> ${round(partial.netValueSol, 4)} SOL`
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

  const candidate = await getBestTrade({
    excludeCas: [...recentlyTraded.keys(), ...getPositions().map(p => p.ca)]
  });

  if (!candidate) {
    await sendMessage(chatId, "❌ No candidates found");
    return;
  }

  const plans = buildStrategyPlans(candidate);
  await sendPhotoOrText(chatId, candidate.token.imageUrl || null, buildAnalysisText(candidate, plans));

  for (const plan of plans) {
    const alreadyOpenSameStrategy = getPositions().some(p => p.strategy === plan.strategyKey);
    if (alreadyOpenSameStrategy) continue;
    if (candidate.corpse.isCorpse) continue;
    if (candidate.falseBounce.rejected) continue;
    if (candidate.developer.verdict === "Bad") continue;
    if (candidate.score < 85) continue;

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
        imageUrl: candidate.token.imageUrl || null,
        narrative: candidate.narrative,
        socials: candidate.socials,
        developer: candidate.developer,
        reasons: candidate.reasons,
        baseStrategy: candidate.strategy,
        chosenPlan: plan
      }
    });

    if (position) {
      await sendPhotoOrText(chatId, candidate.token.imageUrl || null, buildEntryText(position));
    }
  }
}

function startRun(chatId, userId, mode) {
  stopLoop();

  activeChatId = chatId;
  activeUserId = userId;
  currentMode = mode;
  runState = {
    runId: `run-${Date.now()}`,
    startedAt: Date.now(),
    mode
  };

  if (mode === "4h") {
    resetPortfolio(1);
  }

  loopId = setInterval(() => {
    cycle(chatId, userId).catch(err => {
      console.log("cycle error", err.message);
    });
  }, AUTO_INTERVAL_MS);

  if (mode === "4h") {
    stopTimeoutId = setTimeout(async () => {
      stopLoop();
      await sendMessage(chatId, "🛑 <b>AUTO STOPPED</b> (4h finished)");
      await sendMessage(chatId, buildDashboard(), { reply_markup: keyboard() });
    }, 4 * 60 * 60 * 1000);
  }
}

async function handleAction(chatId, userId, action) {
  if (action === "start") {
    await sendMessage(
      chatId,
      `🤖 <b>Bot ready</b>\n\nCommands: /run4h /runinfinite /stop /status /scan /exportcsv /exportjson /exportxlsx`,
      { reply_markup: keyboard() }
    );
    return;
  }

  if (action === "run4h") {
    await sendMessage(chatId, "🚀 Starting 4h multi-strategy simulation from 1 SOL", {
      reply_markup: keyboard()
    });
    startRun(chatId, userId, "4h");
    return;
  }

  if (action === "runinfinite") {
    if (!getPortfolio().startBalance) resetPortfolio(1);
    await sendMessage(chatId, "♾️ Starting infinite multi-strategy run", {
      reply_markup: keyboard()
    });
    startRun(chatId, userId, "infinite");
    return;
  }

  if (action === "stop") {
    stopLoop();
    await sendMessage(chatId, "🛑 Bot stopped", { reply_markup: keyboard() });
    await sendMessage(chatId, buildDashboard(), { reply_markup: keyboard() });
    return;
  }

  if (action === "status") {
    await sendMessage(chatId, buildDashboard(), { reply_markup: keyboard() });
    return;
  }

  if (action === "scan") {
    await cycle(chatId, userId);
    return;
  }

  if (action === "exportjson") {
    await exportJson(chatId);
    return;
  }

  if (action === "exportcsv") {
    await exportCsv(chatId);
    return;
  }

  if (action === "exportxlsx") {
    await exportXlsx(chatId);
  }
}

async function processMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  const text = msg.text || "";
  const action = normalizeAction(text);

  if (!action) return;
  await handleAction(chatId, userId, action);
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", async () => {
      res.writeHead(200);
      res.end("OK");

      try {
        const update = JSON.parse(body);
        if (update?.message) {
          await processMessage(update.message);
        }
      } catch (err) {
        console.log("webhook parse error", err.message);
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
  await bot.setWebHook(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}${WEBHOOK_PATH}`);
  console.log("✅ Webhook set");
});
