import http from "node:http";
import TelegramBot from "node-telegram-bot-api";

import { getBestTrade } from "./scan-engine.js";
import { enterTrade, exitTrade, getPortfolio } from "./portfolio.js";

// ===== ENV =====

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

const PATH = `/telegram/${process.env.WEBHOOK_SECRET}`;

// ===== SEND =====

function send(chatId, text) {
  return bot.sendMessage(chatId, text);
}

// ===== MAIN =====

async function runCycle(chatId) {
  const best = await getBestTrade();

  if (!best) return;

  const p = getPortfolio();

  await send(chatId, `
🔎 ANALYSIS

Token: ${best.token.name}
Score: ${best.score}

⚠️ Rug Risk: ${best.rug.risk}
🧠 Smart Money: ${best.wallet.smartMoney.toFixed(1)}
👥 Concentration: ${best.wallet.concentration.toFixed(1)}
🤖 Bot Activity: ${best.bots.botActivity.toFixed(1)}
🐦 Sentiment: ${best.sentiment.sentiment.toFixed(1)}
`);

  if (best.score < 60) {
    await send(chatId, "❌ Skip");
    return;
  }

  const entry = enterTrade(best.token);

  if (!entry) {
    await send(chatId, "⏳ Already in trade");
    return;
  }

  await send(chatId, `
🚀 ENTRY

Token: ${entry.token}
Price: ${entry.entry}
Balance: ${p.balance.toFixed(2)} SOL
`);

  // simulate exit
  setTimeout(() => {
    const exit = exitTrade(best.token.price * (0.95 + Math.random() * 0.1));

    send(chatId, `
🏁 EXIT

Token: ${exit.token}
PnL: ${(exit.pnl * 100).toFixed(2)}%
Balance: ${exit.balance.toFixed(2)} SOL
`);
  }, 20000);
}

// ===== AUTO =====

function start(chatId) {
  setInterval(() => runCycle(chatId), 60000);
}

// ===== SERVER =====

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === PATH) {
    let body = "";

    req.on("data", c => (body += c));

    req.on("end", async () => {
      res.writeHead(200);
      res.end();

      const update = JSON.parse(body);

      if (update.message?.text === "/start") {
        await send(update.message.chat.id, "🤖 STARTED (1 SOL)");
        start(update.message.chat.id);
      }
    });

    return;
  }

  res.end("OK");
});

server.listen(process.env.PORT, async () => {
  await bot.setWebHook(
    `https://${process.env.RENDER_EXTERNAL_HOSTNAME}${PATH}`
  );
});
