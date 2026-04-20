import http from "node:http";
import TelegramBot from "node-telegram-bot-api";

import WalletExecutionRouter from "./wallets/wallet-execution-router.js";
import CopytradeManager from "./copytrade/copytrade-manager.js";
import GMGNLeaderIntelService from "./gmgn/gmgn-leader-intel-service.js";
import TradingKernel from "./core/trading-kernel.js";
import BotRouter from "./core/bot-router.js";

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chiikawa_secret";
const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;

if (!TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

const walletRouter = new WalletExecutionRouter({ logger: console });
const copytradeManager = new CopytradeManager({ logger: console });
const gmgnLeaderIntel = new GMGNLeaderIntelService({ logger: console });

const kernel = new TradingKernel({
  walletRouter,
  copytradeManager,
  gmgnLeaderIntel,
  logger: console,
  initialConfig: {
    language: "ru",
    dryRun: true,
    startBalanceSol: 10,
    strategyBudget: {
      scalp: 0.25,
      reversal: 0.25,
      runner: 0.25,
      copytrade: 0.25
    },
    wallets: {
      wallet_trader_main: {
        label: "Trader Main",
        role: "trader",
        enabled: true,
        executionMode: "dry_run",
        allowedStrategies: ["scalp", "reversal"],
        secretRef: ""
      },
      wallet_runner_main: {
        label: "Runner Main",
        role: "trader",
        enabled: true,
        executionMode: "dry_run",
        allowedStrategies: ["runner"],
        secretRef: ""
      },
      wallet_copy_1: {
        label: "Copy Follower 1",
        role: "follower",
        enabled: true,
        executionMode: "dry_run",
        allowedStrategies: ["copytrade"],
        secretRef: ""
      }
    },
    strategyRouting: {
      scalp: ["wallet_trader_main"],
      reversal: ["wallet_trader_main"],
      runner: ["wallet_runner_main"],
      copytrade: ["wallet_copy_1"]
    },
    copytrade: {
      enabled: true,
      rescoringEnabled: true,
      minLeaderScore: 70,
      cooldownMinutes: 180,
      leaders: []
    }
  }
});

const router = new BotRouter({
  bot,
  kernel,
  logger: console
});

bot.on("message", (msg) => {
  router.handleMessage(msg).catch((err) => {
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
