import TelegramBot from "node-telegram-bot-api";

import WalletExecutionRouter from "./wallets/wallet-execution-router.js";
import CopytradeManager from "./copytrade/copytrade-manager.js";
import GMGNLeaderIntelService from "./gmgn/gmgn-leader-intel-service.js";

import TradingKernel from "./core/trading-kernel.js";
import BotRouter from "./core/bot-router.js";
import RuntimePersistence from "./core/runtime-persistence.js";
import TxLifecycleStore from "./core/tx-lifecycle-store.js";
import WebhookServer from "./core/webhook-server.js";

import JupiterQuoteService from "./jupiter/jupiter-quote-service.js";
import ManualApprovalBridge from "./wallets/manual-approval-bridge.js";

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

const persistence = new RuntimePersistence({
  logger: console
});

const txStore = new TxLifecycleStore({
  logger: console
});

const jupiterQuoteService = new JupiterQuoteService({
  logger: console
});

const manualApprovalBridge = new ManualApprovalBridge({
  logger: console,
  txStore,
  jupiterQuoteService
});

const kernel = new TradingKernel({
  walletRouter,
  copytradeManager,
  gmgnLeaderIntel,
  persistence,
  txStore,
  jupiterQuoteService,
  manualApprovalBridge,
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
        secretRef: "",
        publicKey: process.env.WALLET_TRADER_MAIN_PUBLIC_KEY || ""
      },
      wallet_runner_main: {
        label: "Runner Main",
        role: "trader",
        enabled: true,
        executionMode: "manual_approval",
        allowedStrategies: ["runner"],
        secretRef: "",
        publicKey: process.env.WALLET_RUNNER_MAIN_PUBLIC_KEY || ""
      },
      wallet_copy_1: {
        label: "Copy Follower 1",
        role: "follower",
        enabled: true,
        executionMode: "manual_approval",
        allowedStrategies: ["copytrade"],
        secretRef: "",
        publicKey: process.env.WALLET_COPY_1_PUBLIC_KEY || ""
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

const webhookServer = new WebhookServer({
  bot,
  port: PORT,
  webhookSecret: WEBHOOK_SECRET,
  webhookPath: WEBHOOK_PATH,
  logger: console
});

async function main() {
  try {
    await kernel.initialize();

    bot.on("message", (msg) => {
      router.handleMessage(msg).catch((err) => {
        console.log("message error:", err.message);
      });
    });

    webhookServer.start();

    console.log("Chiikawa trading bot bootstrap initialized");
    console.log(`Webhook path: ${WEBHOOK_PATH}`);
    console.log(`Port: ${PORT}`);
  } catch (error) {
    console.error("Bootstrap failed:", error);
    process.exit(1);
  }
}

main();
