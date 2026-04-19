import http from "node:http";
import TelegramBot from "node-telegram-bot-api";
import { getBestTrade, getLatestTokenPrice } from "./scan-engine.js";
import {
  enterTrade,
  exitTrade,
  getPortfolio,
  markToMarket,
  shouldExitPosition,
  updatePositionMarket,
  estimateRoundTripCostPct
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
const recentlyTraded = new Map();

async function send(chatId, text) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

function pruneRecentlyTraded() {
  const now = Date.now();
  for (const [ca, ts] of recentlyTraded.entries()) {
    if (now - ts > TRADE_COOLDOWN_MS) {
      recentlyTraded.delete(ca);
    }
  }
}

function stopAutoInternal() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (autoStopId) {
    clearTimeout(autoStopId);
    autoStopId = null;
  }
}

function formatAnalysis(best) {
  return `🔎 <b>ANALYSIS</b>

<b>Token:</b> ${best.token.name}
<b>CA:</b> <code>${best.token.ca}</code>
<b>Score:</b> ${best.score}

<b>Price:</b> ${best.token.price}
<b>Liquidity:</b> ${best.token.liquidity}
<b>Volume 24h:</b> ${best.token.volume}
<b>Txns 24h:</b> ${best.token.txns}
<b>FDV:</b> ${best.token.fdv}

⚠️ <b>Rug:</b> ${best.rug.risk}
🧠 <b>Smart Money:</b> ${best.wallet.smartMoney}
👥 <b>Concentration:</b> ${best.wallet.concentration.toFixed(2)}
🤖 <b>Bot Activity:</b> ${best.bots.botActivity}
🐦 <b>Sentiment:</b> ${best.sentiment.sentiment}

📈 <b>Delta</b>
<b>Price Δ:</b> ${best.delta.priceDeltaPct.toFixed(2)}%
<b>Volume Δ:</b> ${best.delta.volumeDeltaPct.toFixed(2)}%
<b>Txns Δ:</b> ${best.delta.txnsDeltaPct.toFixed(2)}%
<b>Liquidity Δ:</b> ${best.delta.liquidityDeltaPct.toFixed(2)}%
<b>Buy Pressure Δ:</b> ${best.delta.buyPressureDelta.toFixed(3)}

🎯 <b>Strategy</b>
<b>Expected edge:</b> ${best.strategy.expectedEdgePct}%
<b>Round-trip costs:</b> ${estimateRoundTripCostPct()}%
<b>Hold target:</b> ${(best.strategy.intendedHoldMs / 1000).toFixed(0)}s
<b>TP:</b> ${best.strategy.takeProfitPct}%
<b>SL:</b> ${best.strategy.stopLossPct}%
<b>Setup:</b> ${best.strategy.reason}

<b>Reasons:</b>
${best.reasons.map(r => `• ${r}`).join("\n")}`;
}

async function runCycle(chatId) {
  try {
    pruneRecentlyTraded();

    const pf = getPortfolio();

    if (pf.position) {
      const latest = await getLatestTokenPrice(pf.position.ca);
      if (!latest?.price) {
        await send(chatId, `⏳ Open position still active: ${pf.position.token}`);
        return;
      }

      updatePositionMarket(latest.price);
      const mtm = markToMarket(latest.price);
      const exitCheck = shouldExitPosition(latest.price);

      await send(
        chatId,
        `📈 <b>POSITION UPDATE</b>

<b>Token:</b> ${pf.position.token}
<b>CA:</b> <code>${pf.position.ca}</code>
<b>Entry ref:</b> ${pf.position.entryReferencePrice}
<b>Current:</b> ${latest.price}
<b>Gross PnL:</b> ${mtm.grossPnlPct.toFixed(2)}%
<b>Net PnL:</b> ${mtm.netPnlPct.toFixed(2)}%
<b>Age:</b> ${(mtm.ageMs / 1000).toFixed(0)}s
<b>Status:</b> ${exitCheck.reason}`
      );

      if (exitCheck.shouldExit) {
        const closed = exitTrade(latest.price, exitCheck.reason);
        if (closed) {
          recentlyTraded.set(closed.ca, Date.now());

          await send(
            chatId,
            `🏁 <b>EXIT</b>

<b>Token:</b> ${closed.token}
<b>CA:</b> <code>${closed.ca}</code>
<b>Entry ref:</b> ${closed.entryReferencePrice}
<b>Entry effective:</b> ${closed.entryEffectivePrice}
<b>Exit ref:</b> ${closed.exitReferencePrice}

<b>Entry costs:</b> ${closed.entryCosts.totalSol.toFixed(6)} SOL
<b>Exit costs:</b> ${closed.exitCosts.totalSol.toFixed(6)} SOL

<b>Net PnL:</b> ${closed.netPnlPct.toFixed(2)}%
<b>Balance:</b> ${closed.balance.toFixed(4)} SOL
<b>Reason:</b> ${closed.reason}`
          );
        }
      }

      return;
    }

    const excludeCas = [...recentlyTraded.keys()];
    const best = await getBestTrade({ excludeCas });

    if (!best) {
      await send(chatId, "❌ No candidates found");
      return;
    }

    await send(chatId, formatAnalysis(best));

    if (best.score < 75) {
      await send(chatId, "❌ Skip (score below threshold)");
      return;
    }

    if (best.falseBounce.rejected) {
      await send(chatId, `❌ Skip (false bounce): ${best.falseBounce.reasons.join(", ")}`);
      return;
    }

    if (best.strategy.expectedEdgePct < estimateRoundTripCostPct()) {
      await send(
        chatId,
        `❌ Skip (expected edge ${best.strategy.expectedEdgePct}% does not beat costs ${estimateRoundTripCostPct()}%)`
      );
      return;
    }

    const entry = enterTrade({
      token: best.token,
      intendedHoldMs: best.strategy.intendedHoldMs,
      expectedEdgePct: best.strategy.expectedEdgePct,
      stopLossPct: best.strategy.stopLossPct,
      takeProfitPct: best.strategy.takeProfitPct,
      reason: best.strategy.reason,
      signalScore: best.score
    });

    if (!entry) {
      await send(chatId, "⏳ Could not open position");
      return;
    }

    const afterEntry = getPortfolio();

    await send(
      chatId,
      `🚀 <b>ENTRY</b>

<b>Token:</b> ${entry.token}
<b>CA:</b> <code>${entry.ca}</code>
<b>Signal score:</b> ${entry.signalScore}
<b>Setup:</b> ${entry.reason}

<b>Entry ref:</b> ${entry.entryReferencePrice}
<b>Entry effective:</b> ${entry.entryEffectivePrice}
<b>Size:</b> ${entry.amountSol.toFixed(4)} SOL
<b>Expected edge:</b> ${entry.expectedEdgePct}%

<b>Entry costs:</b> ${entry.entryCosts.totalSol.toFixed(6)} SOL
<b>Balance after entry:</b> ${afterEntry.balance.toFixed(4)} SOL`
    );
  } catch (error) {
    console.log("cycle error:", error.message);
    await send(chatId, `⚠️ Cycle error: ${error.message}`);
  }
}

function startAuto(chatId, hours = AUTO_HOURS_DEFAULT) {
  stopAutoInternal();
  activeChatId = chatId;

  intervalId = setInterval(() => {
    runCycle(chatId);
  }, AUTO_INTERVAL_MS);

  autoStopId = setTimeout(async () => {
    stopAutoInternal();
    if (activeChatId) {
      await send(activeChatId, `🛑 AUTO STOPPED (${hours}h finished)`);
    }
  }, hours * 60 * 60 * 1000);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();

  if (text === "/start") {
    await send(chatId, "🤖 Bot ready. Commands: /run4h /stop /status /scan");
    return;
  }

  if (text === "/run4h") {
    await send(chatId, "🚀 Starting 4h simulation from 1 SOL");
    startAuto(chatId, 4);
    return;
  }

  if (text === "/stop") {
    if (intervalId) {
      stopAutoInternal();
      await send(chatId, "🛑 Bot stopped");
    } else {
      await send(chatId, "ℹ️ Bot already stopped");
    }
    return;
  }

  if (text === "/status") {
    const pf = getPortfolio();
    await send(
      chatId,
      `📊 <b>STATUS</b>

<b>Balance:</b> ${pf.balance.toFixed(4)} SOL
<b>Position:</b> ${pf.position ? pf.position.token : "none"}
<b>Auto mode:</b> ${intervalId ? "ON" : "OFF"}
<b>Trades closed:</b> ${pf.tradeHistory.length}
<b>Recently traded cooldown list:</b> ${recentlyTraded.size}`
    );
    return;
  }

  if (text === "/scan") {
    await runCycle(chatId);
  }
}

async function processUpdate(update) {
  try {
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
