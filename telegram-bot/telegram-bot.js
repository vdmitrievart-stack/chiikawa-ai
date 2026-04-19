import http from "node:http";
import TelegramBot from "node-telegram-bot-api";
import { getBestTrade, getLatestTokenPrice } from "./scan-engine.js";
import { enterTrade, exitTrade, getPortfolio, markToMarket } from "./portfolio.js";

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chiikawa_secret";
const PATH = `/telegram/${WEBHOOK_SECRET}`;

const AUTO_INTERVAL_MS = Number(process.env.AUTO_INTERVAL_MS || 60000);
const AUTO_HOURS_DEFAULT = Number(process.env.AUTO_HOURS_DEFAULT || 4);
const TRADE_COOLDOWN_MS = Number(process.env.TRADE_COOLDOWN_MS || 90 * 60 * 1000);
const HOLD_MS = Number(process.env.HOLD_MS || 90 * 1000);

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

<b>Reasons:</b>
${best.reasons.map(r => `• ${r}`).join("\n")}`;
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

async function runCycle(chatId) {
  try {
    pruneRecentlyTraded();

    const portfolio = getPortfolio();

    if (portfolio.position) {
      const latest = await getLatestTokenPrice(portfolio.position.ca);
      if (!latest?.price) {
        await send(chatId, `⏳ Open trade still active: ${portfolio.position.token}`);
        return;
      }

      const mtm = markToMarket(latest.price);
      await send(
        chatId,
        `📈 <b>OPEN POSITION UPDATE</b>

<b>Token:</b> ${portfolio.position.token}
<b>CA:</b> <code>${portfolio.position.ca}</code>
<b>Entry:</b> ${portfolio.position.entry}
<b>Current:</b> ${latest.price}
<b>PnL:</b> ${mtm ? mtm.pnlPercent.toFixed(2) : "0.00"}%`
      );
      return;
    }

    const excludeCas = [...recentlyTraded.keys()];
    const best = await getBestTrade({ excludeCas });

    if (!best) {
      await send(chatId, "❌ No candidates found");
      return;
    }

    await send(chatId, formatAnalysis(best));

    if (best.score < 60) {
      await send(chatId, "❌ Skip (score below threshold)");
      return;
    }

    const entry = enterTrade(best.token);
    if (!entry) {
      await send(chatId, "⏳ Could not open position");
      return;
    }

    recentlyTraded.set(entry.ca, Date.now());

    const afterEntry = getPortfolio();

    await send(
      chatId,
      `🚀 <b>ENTRY</b>

<b>Token:</b> ${entry.token}
<b>CA:</b> <code>${entry.ca}</code>
<b>Price:</b> ${entry.entry}
<b>Size:</b> ${entry.amountSol.toFixed(4)} SOL
<b>Balance after entry:</b> ${afterEntry.balance.toFixed(4)} SOL`
    );

    setTimeout(async () => {
      try {
        const latest = await getLatestTokenPrice(entry.ca);
        const exitPrice = latest?.price || entry.entry;

        const exit = exitTrade(exitPrice, "SIM_EXIT");
        if (!exit) return;

        await send(
          chatId,
          `🏁 <b>EXIT</b>

<b>Token:</b> ${exit.token}
<b>Entry:</b> ${exit.entry}
<b>Exit:</b> ${exit.exit}
<b>PnL:</b> ${exit.pnlPercent.toFixed(2)}%
<b>Balance:</b> ${exit.balance.toFixed(4)} SOL`
        );
      } catch (error) {
        console.log("exit error:", error.message);
      }
    }, HOLD_MS);
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
    return;
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
