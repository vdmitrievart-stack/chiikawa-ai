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

  const rows = closed.map((t) => [
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

  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
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

  const tradesRows = pf.closedTrades.map((t) => ({
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
    excludeCas: [...recentlyTraded.keys(), ...getPositions().map((p) => p.ca)]
  });

  if (!candidate) {
    await sendMessage(chatId, "❌ No candidates found");
    return;
  }

  const plans = buildStrategyPlans(candidate);
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
        imageUrl: heroImage,
        narrative: candidate.narrative,
        socials: candidate.socials,
        developer: candidate.developer,
        mechanics: candidate.mechanics,
        dexPaid: candidate.dexPaid,
        reasons: candidate.reasons,
        baseStrategy: candidate.strategy,
        chosenPlan: plan
      }
    });

    if (position) {
      await sendPhotoOrText(chatId, heroImage, buildEntryText(position));
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
    cycle(chatId, userId).catch((err) => {
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

async function fetchTokenByCA(ca) {
  const res = await fetch(`${DEX_TOKEN_API}/${encodeURIComponent(ca)}`);
  if (!res.ok) {
    throw new Error(`DexScreener HTTP ${res.status}`);
  }

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
  const plans = buildStrategyPlans(analyzed);
  const heroImage =
    analyzed.token.headerUrl ||
    analyzed.token.imageUrl ||
    analyzed.token.iconUrl ||
    null;

  await sendPhotoOrText(chatId, heroImage, buildHeroCaption(analyzed));
  await sendMessage(chatId, buildAnalysisText(analyzed, plans), {
    reply_markup: keyboard()
  });
}

async function handleAction(chatId, userId, action) {
  if (action === "start") {
    clearChatMode(chatId);
    await sendMessage(chatId, "🤖 <b>Bot ready</b>", { reply_markup: keyboard() });
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

  if (action === "scan_market") {
    clearChatMode(chatId);
    await sendMessage(chatId, "🔎 <b>Market scan started</b>", { reply_markup: keyboard() });
    await cycle(chatId, userId);
    return;
  }

  if (action === "scan_ca") {
    setChatMode(chatId, "awaiting_ca");
    await sendMessage(chatId, "🧾 <b>Send CA</b>\n\nОтправь контракт следующим сообщением.", {
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

  await sendMessage(chatId, "Используйте меню ниже.", { reply_markup: keyboard() });
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

  if (isLikelyCA(text)) {
    await sendMessage(chatId, "Сначала нажми <b>🧾 Scan CA</b>, потом отправь адрес.", {
      reply_markup: keyboard()
    });
    return;
  }

  await sendMessage(chatId, "Используйте меню ниже.", { reply_markup: keyboard() });
}

bot.on("message", (msg) => {
  processMessage(msg).catch((err) => {
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
