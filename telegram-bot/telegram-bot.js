import http from "node:http";
import TelegramBot from "node-telegram-bot-api";

import { getBestTrade } from "./scan-engine.js";
import { enterTrade, exitTrade, getPortfolio } from "./portfolio.js";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

const PATH = `/telegram/${process.env.WEBHOOK_SECRET}`;

async function send(chatId, text) {
  return bot.sendMessage(chatId, text);
}

async function runCycle(chatId) {
  const best = await getBestTrade();
  if (!best) return;

  const p = getPortfolio();

  await send(chatId, `
🔎 ANALYSIS

Token: ${best.token.name}
Score: ${best.score}

⚠️ Rug: ${best.rug.risk}
🧠 Smart: ${best.wallet.smartMoney}
🤖 Bots: ${best.bots.botActivity}
🐦 Sentiment: ${best.sentiment.sentiment}
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

${entry.token}
Price: ${entry.entry}
Balance: ${p.balance.toFixed(2)} SOL
`);

  setTimeout(() => {
    const price =
      best.token.price * (0.95 + Math.random() * 0.1);

    const exit = exitTrade(price);

    send(chatId, `
🏁 EXIT

${exit.token}
PnL: ${(exit.pnl * 100).toFixed(2)}%
Balance: ${exit.balance.toFixed(2)} SOL
`);
  }, 30000);
}

function start(chatId) {
  setInterval(() => runCycle(chatId), 60000);
}

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
