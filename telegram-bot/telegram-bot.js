
import TelegramBot from "node-telegram-bot-api";

import CopytradeManager from "./copytrade/copytrade-manager.js";
import GMGNLeaderIntelService from "./gmgn/gmgn-leader-intel-service.js";

import TradingKernel from "./core/trading-kernel.js";
import BotRouter from "./core/bot-router.js";
import RuntimePersistence from "./core/runtime-persistence.js";
import WebhookServer from "./core/webhook-server.js";
import XPublicFeed from "./core/x-public-feed.js";
import { applyAccumulationScanHotfix } from "./core/accumulation-scan-hotfix.js";

import GMGNWalletService from "./gmgn/gmgn-wallet-service.js";
import GMGNOrderStateStore from "./gmgn/gmgn-order-state-store.js";
import GMGNExecutionService from "./gmgn/gmgn-execution-service.js";

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chiikawa_secret";
const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;

if (!TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

const copytradeManager = new CopytradeManager({ logger: console });
const gmgnLeaderIntel = new GMGNLeaderIntelService({ logger: console });

const persistence = new RuntimePersistence({
  logger: console
});

const gmgnWalletService = new GMGNWalletService({
  logger: console
});

const gmgnOrderStore = new GMGNOrderStateStore({
  logger: console
});

const gmgnExecutionService = new GMGNExecutionService({
  logger: console,
  walletService: gmgnWalletService,
  orderStore: gmgnOrderStore,
  defaultMode: process.env.GMGN_EXECUTION_MODE || "dry_run",
  defaultSlippagePct: Number(process.env.GMGN_DEFAULT_SLIPPAGE_PCT || 1)
});

const xPublicFeed = new XPublicFeed({ logger: console });

const kernel = new TradingKernel({
  walletRouter: null,
  copytradeManager,
  gmgnLeaderIntel,
  persistence,
  gmgnWalletService,
  gmgnOrderStore,
  gmgnExecutionService,
  logger: console,
  initialConfig: {
    language: "ru",
    dryRun: true,
    startBalanceSol: 10,
    strategyBudget: {
      scalp: 0.2,
      reversal: 0.2,
      runner: 0.2,
      copytrade: 0.2,
      migration_survivor: 0.2
    },
    wallets: {
      wallet_scalp_main: {
        label: "GMGN Scalp Main",
        role: "trader",
        enabled: true,
        executionBackend: "gmgn",
        executionMode: process.env.GMGN_EXECUTION_MODE || "dry_run",
        allowedStrategies: ["scalp"],
        gmgnWalletId: process.env.GMGN_WALLET_SCALP_ID || "",
        gmgnAccountId: process.env.GMGN_ACCOUNT_ID || "",
        publicKey: process.env.GMGN_WALLET_SCALP_PUBLIC_KEY || "",
        secretRef: ""
      },
      wallet_reversal_main: {
        label: "GMGN Reversal Main",
        role: "trader",
        enabled: true,
        executionBackend: "gmgn",
        executionMode: process.env.GMGN_EXECUTION_MODE || "dry_run",
        allowedStrategies: ["reversal"],
        gmgnWalletId: process.env.GMGN_WALLET_REVERSAL_ID || "",
        gmgnAccountId: process.env.GMGN_ACCOUNT_ID || "",
        publicKey: process.env.GMGN_WALLET_REVERSAL_PUBLIC_KEY || "",
        secretRef: ""
      },
      wallet_runner_main: {
        label: "GMGN Runner Main",
        role: "trader",
        enabled: true,
        executionBackend: "gmgn",
        executionMode: process.env.GMGN_EXECUTION_MODE || "dry_run",
        allowedStrategies: ["runner"],
        gmgnWalletId: process.env.GMGN_WALLET_RUNNER_ID || "",
        gmgnAccountId: process.env.GMGN_ACCOUNT_ID || "",
        publicKey: process.env.GMGN_WALLET_RUNNER_PUBLIC_KEY || "",
        secretRef: ""
      },
      wallet_copytrade_main: {
        label: "GMGN Copytrade Main",
        role: "follower",
        enabled: true,
        executionBackend: "gmgn",
        executionMode: process.env.GMGN_EXECUTION_MODE || "dry_run",
        allowedStrategies: ["copytrade"],
        gmgnWalletId: process.env.GMGN_WALLET_COPYTRADE_ID || "",
        gmgnAccountId: process.env.GMGN_ACCOUNT_ID || "",
        publicKey: process.env.GMGN_WALLET_COPYTRADE_PUBLIC_KEY || "",
        secretRef: ""
      },
      wallet_migration_main: {
        label: "GMGN Migration Main",
        role: "trader",
        enabled: true,
        executionBackend: "gmgn",
        executionMode: process.env.GMGN_EXECUTION_MODE || "dry_run",
        allowedStrategies: ["migration_survivor"],
        gmgnWalletId: process.env.GMGN_WALLET_MIGRATION_ID || "",
        gmgnAccountId: process.env.GMGN_ACCOUNT_ID || "",
        publicKey: process.env.GMGN_WALLET_MIGRATION_PUBLIC_KEY || "",
        secretRef: ""
      }
    },
    strategyRouting: {
      scalp: ["wallet_scalp_main"],
      reversal: ["wallet_reversal_main"],
      runner: ["wallet_runner_main"],
      copytrade: ["wallet_copytrade_main"],
      migration_survivor: ["wallet_migration_main"]
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

applyAccumulationScanHotfix(router, kernel);

const webhookServer = new WebhookServer({
  bot,
  port: PORT,
  webhookSecret: WEBHOOK_SECRET,
  webhookPath: WEBHOOK_PATH,
  logger: console
});

function shortErrorMessage(error) {
  const message = error?.stack || error?.message || String(error);
  return String(message).slice(0, 700);
}

async function safeReplyError(chatId, error) {
  try {
    await bot.sendMessage(
      chatId,
      `❌ Bot handler error\n\n<code>${shortErrorMessage(error)}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (sendError) {
    console.log("failed to send error to chat:", sendError.message);
  }
}

async function main() {
  try {
    await xPublicFeed.load();

    if (typeof kernel.initialize === "function") {
      await kernel.initialize();
    } else {
      console.log("kernel.initialize not found, skipping bootstrap init");
    }

    bot.on("message", async (msg) => {
      try {
        await router.handleMessage(msg);
      } catch (err) {
        console.log("message error:", err);
        await safeReplyError(msg.chat.id, err);
      }
    });

    if (typeof webhookServer.start === "function") {
      webhookServer.start();
    } else {
      console.log("webhookServer.start not found");
    }

    console.log("Chiikawa trading bot bootstrap initialized");
    console.log(`Webhook path: ${WEBHOOK_PATH}`);
    console.log(`Port: ${PORT}`);
    console.log(`GMGN execution mode: ${process.env.GMGN_EXECUTION_MODE || "dry_run"}`);
  } catch (error) {
    console.error("Bootstrap failed:", error);
    process.exit(1);
  }
}

main();

export {
  bot,
  router,
  kernel,
  xPublicFeed
};
