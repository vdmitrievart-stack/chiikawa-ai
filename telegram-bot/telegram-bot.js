import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import * as XLSX from "xlsx";

import {
  getBestTrade,
  getLatestTokenPrice,
  recordTradeOutcomeFromSignalContext
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
const publishedSignalState = new Map();

const SIGNAL_COOLDOWN_MS = {
  scalp: 8 * 60 * 1000,
  reversal: 30 * 60 * 1000,
  runner: 45 * 60 * 1000,
  watch: 20 * 60 * 1000
};

const UPDATE_COOLDOWN_MS = {
  scalp: 3 * 60 * 1000,
  reversal: 10 * 60 * 1000,
  runner: 15 * 60 * 1000,
  watch: 10 * 60 * 1000
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

function normalizeAction(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return null;

  if (raw === "/start" || raw === "/menu") return "start";
  if (raw === "/run4h") return "run4h";
  if (raw === "/runinfinite") return "runinfinite";
  if (raw === "/stop") return "stop";
  if (raw === "/status") return "status";
  if (raw === "/scan") return "scan";
  if (raw === "/exportcsv") return "exportcsv";
  if (raw === "/exportjson" || raw === "/exportstats") return "exportjson";
  if (raw === "/exportxlsx") return "exportxlsx";

  if (raw.includes("run 4h") || raw.includes("4ч")) return "run4h";
  if (raw.includes("infinite") || raw.includes("бескон")) return "runinfinite";
  if (raw.includes("stop") || raw.includes("стоп")) return "stop";
  if (raw.includes("status") || raw.includes("статус")) return "status";
  if (raw.includes("scan") || raw.includes("скан")) return "scan";
  if (raw.includes("csv")) return "exportcsv";
  if (raw.includes("json")) return "exportjson";
  if (raw.includes("xlsx")) return "exportxlsx";

  return null;
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
    } catch (error) {
      console.log("sendPhoto fallback:", error.message);
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

function getPrimaryPlanKey(plans = []) {
  if (!Array.isArray(plans) || !plans.length) return "watch";
  return plans[0]?.strategyKey || "watch";
}

function getSignalFingerprint(candidate, plans = []) {
  return {
    ca: candidate?.token?.ca || "",
    score: safeNum(candidate?.score),
    price: safeNum(candidate?.token?.price),
    planKey: getPrimaryPlanKey(plans),
    planSet: plans.map(p => p.strategyKey).sort().join(","),
    reversalScore: safeNum(candidate?.reversal?.score ?? 0),
    scalpScore: safeNum(candidate?.scalp?.score ?? 0),
    corpseScore: safeNum(candidate?.corpse?.score ?? 0),
    narrativeVerdict: candidate?.narrative?.verdict || "",
    developerVerdict: candidate?.developer?.verdict || ""
  };
}

function pctMove(from, to) {
  const a = safeNum(from, 0);
  const b = safeNum(to, 0);
  if (!a || !b) return 0;
  return ((b - a) / a) * 100;
}

function hasMeaningfulSignalShift(prev, next) {
  if (!prev) return { changed: true, reason: "first_publish" };

  if (prev.planKey !== next.planKey) return { changed: true, reason: "plan_changed" };
  if (prev.planSet !== next.planSet) return { changed: true, reason: "plan_set_changed" };
  if (Math.abs(next.score - prev.score) >= 8) return { changed: true, reason: "score_shift" };
  if (Math.abs(next.reversalScore - prev.reversalScore) >= 6) return { changed: true, reason: "reversal_shift" };
  if (Math.abs(next.scalpScore - prev.scalpScore) >= 6) return { changed: true, reason: "scalp_shift" };
  if (Math.abs(next.corpseScore - prev.corpseScore) >= 5) return { changed: true, reason: "risk_shift" };
  if (prev.narrativeVerdict !== next.narrativeVerdict) return { changed: true, reason: "narrative_shift" };
  if (prev.developerVerdict !== next.developerVerdict) return { changed: true, reason: "developer_shift" };
  if (Math.abs(pctMove(prev.price, next.price)) >= 6) return { changed: true, reason: "price_move" };

  return { changed: false, reason: "minor_noise" };
}

function shouldPublishCandidate(candidate, plans = []) {
  const fp = getSignalFingerprint(candidate, plans);
  const prev = publishedSignalState.get(fp.ca);
  const now = Date.now();

  if (!prev) {
    return { publish: true, mode: "new", reason: "first_seen", fingerprint: fp };
  }

  const cooldown = SIGNAL_COOLDOWN_MS[fp.planKey] ?? SIGNAL_COOLDOWN_MS.watch;
  const updateCooldown = UPDATE_COOLDOWN_MS[fp.planKey] ?? UPDATE_COOLDOWN_MS.watch;
  const shift = hasMeaningfulSignalShift(prev.fingerprint, fp);

  if (shift.changed && now - prev.lastUpdateAt >= updateCooldown) {
    return { publish: true, mode: "update", reason: shift.reason, fingerprint: fp };
  }

  if (shift.changed && now - prev.lastPublishedAt >= cooldown) {
    return { publish: true, mode: "new", reason: `cooldown_expired:${shift.reason}`, fingerprint: fp };
  }

  return { publish: false, mode: "skip", reason: shift.reason, fingerprint: fp };
}

function markCandidatePublished(candidate, plans = [], mode = "new") {
  const fp = getSignalFingerprint(candidate, plans);
  const prev = publishedSignalState.get(fp.ca);
  const now = Date.now();

  publishedSignalState.set(fp.ca, {
    fingerprint: fp,
    firstPublishedAt: prev?.firstPublishedAt || now,
    lastPublishedAt: mode === "new" ? now : prev?.lastPublishedAt || now,
    lastUpdateAt: now
  });
}

function stopLoop() {
  if (loopId) clearInterval(loopId);
  if (stopTimeoutId) clearTimeout(stopTimeoutId);
  loopId = null;
  stopTimeoutId = null;
  currentMode = "stopped";
  runState.mode = "stopped";
  publishedSignalState.clear();
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
    `<b>Open positions:</b> ${pf.positions.length}`,
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
  const reasons = analyzed.reasons.slice(0, 12).map(r => `• ${escapeHtml(r)}`).join("\n");

  const plansText = plans.length
    ? plans.map(
        p =>
          `• <b>${escapeHtml(p.strategyKey.toUpperCase())}</b> | edge ${round(p.expectedEdgePct, 2)}% | hold ${Math.round(p.plannedHoldMs / 60000)}m | SL ${p.stopLossPct}% | TP ${p.takeProfitPct || "runner"}`
      ).join("\n")
    : "• none";

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
${escapeHtml(analyzed.narrative.summary || "none")}

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

function buildCandidateUpdateText(candidate, plans, reason = "update") {
  const t = candidate.token;

  return `🔁 <b>SIGNAL UPDATE</b>

<b>Token:</b> ${escapeHtml(t.name)}
<b>CA:</b> <code>${escapeHtml(t.ca)}</code>
<b>Reason:</b> ${escapeHtml(reason)}

<b>Score:</b> ${round(candidate.score, 2)}
<b>Price:</b> ${escapeHtml(t.price)}
<b>Liquidity:</b> ${escapeHtml(t.liquidity)}
<b>Volume 24h:</b> ${escapeHtml(t.volume)}
<b>Txns 24h:</b> ${escapeHtml(t.txns)}

<b>Plans:</b> ${escapeHtml(plans.map(p => p.strategyKey).join(", ") || "none")}
<b>Corpse:</b> ${round(candidate.corpse.score, 2)}
<b>Dev:</b> ${escapeHtml(candidate.developer.verdict)}`;
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

  const candidate = await getBestTrade({
    excludeCas: [...recentlyTraded.keys(), ...getPositions().map(p => p.ca)]
  });

  if (!candidate) {
    await sendMessage(chatId, "❌ No candidates found");
    return;
  }

  const plans = buildStrategyPlans(candidate);
  const publishDecision = shouldPublishCandidate(candidate, plans);

  if (publishDecision.publish) {
    if (publishDecision.mode === "new") {
      await sendPhotoOrText(chatId, candidate.token.imageUrl || null, buildAnalysisText(candidate, plans));
    } else {
      await sendMessage(chatId, buildCandidateUpdateText(candidate, plans, publishDecision.reason));
    }

    markCandidatePublished(candidate, plans, publishDecision.mode);
  } else {
    console.log("signal suppressed:", candidate.token.ca, publishDecision.reason);
  }

  const canTradeThisCandidate =
    publishDecision.publish || getPositions().some(p => p.ca === candidate.token.ca);

  if (!canTradeThisCandidate) return;

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

  recentlyTraded.clear();
  publishedSignalState.clear();

  if (mode === "4h") {
    resetPortfolio(1);
  }

  loopId = setInterval(() => {
    cycle(chatId, userId).catch(err => {
      console.log("cycle error:", err.message);
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
      `🤖 <b>Bot ready</b>

Commands:
/run4h
/runinfinite
/stop
/status
/scan
/exportcsv
/exportjson
/exportxlsx`,
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

  await sendMessage(chatId, "Команды:", { reply_markup: keyboard() });
}

async function processMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  const text = msg.text || "";

  const action = normalizeAction(text);
  if (!action) {
    await sendMessage(chatId, "Команды:", { reply_markup: keyboard() });
    return;
  }

  await handleAction(chatId, userId, action);
}

async function processUpdate(update) {
  if (update?.message?.text) {
    await processMessage(update.message);
  }
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
        await processUpdate(update);
      } catch (err) {
        console.log("webhook parse error:", err.message);
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
  console.log(`🚀 Server started on port ${PORT}`);

  try {
    await bot.setWebHook(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}${WEBHOOK_PATH}`);
    console.log("✅ Webhook set");
  } catch (err) {
    console.log("setWebHook error:", err.message);
  }
});
