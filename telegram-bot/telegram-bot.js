import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import * as XLSX from "xlsx";

import WalletExecutionRouter from "./wallets/wallet-execution-router.js";
import CopytradeManager from "./copytrade/copytrade-manager.js";
import GMGNLeaderIntelService from "./gmgn/gmgn-leader-intel-service.js";
import TradingKernel from "./core/trading-kernel.js";

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

const walletRouter = new WalletExecutionRouter({ logger: console });
const copytradeManager = new CopytradeManager({ logger: console });
const gmgnLeaderIntel = new GMGNLeaderIntelService({ logger: console });

const kernel = new TradingKernel({
  walletRouter,
  copytradeManager,
  gmgnLeaderIntel,
  logger: console
});

let loopId = null;
let stopTimeoutId = null;
const tempFiles = new Set();
const chatState = new Map();

const I18N = {
  ru: {
    menu_run_multi: "🚀 Run Multi",
    menu_run_scalp: "⚡ Run Scalp",
    menu_run_reversal: "↩️ Run Reversal",
    menu_run_runner: "🏃 Run Runner",
    menu_run_copy: "📋 Run Copytrade",
    menu_stop: "🛑 Stop",
    menu_kill: "☠️ Kill",
    menu_status: "📊 Status",
    menu_scan_market: "🔎 Scan Market",
    menu_scan_ca: "🧾 Scan CA",
    menu_balance: "💰 Balance",
    menu_wallets: "👛 Wallets",
    menu_copytrade: "📋 Copytrade",
    menu_budget: "🧮 Budget",
    menu_gmgn_status: "🛰 GMGN Status",
    menu_leader_health: "🫀 Leader Health",
    menu_sync_leaders: "🔄 Sync Leaders",
    menu_language: "🌐 Language",
    menu_export_csv: "📈 Export CSV",
    menu_export_json: "📦 Export JSON",
    menu_export_xlsx: "📊 Export XLSX",
    ready: "🤖 <b>Бот готов</b>",
    send_ca: "🧾 <b>Send CA</b>\n\nОтправь контракт следующим сообщением.",
    invalid_ca: "❌ Это не похоже на валидный CA.",
    scan_hint: "Сначала нажми <b>🧾 Scan CA</b>, потом отправь адрес.",
    soft_stop: "🛑 Мягкая остановка включена. Новые входы запрещены, открытые позиции будут сопровождаться до выхода.",
    hard_kill: "☠️ Жесткая остановка выполнена.",
    choose_lang: "🌐 Выбери язык:\n<code>lang ru</code> или <code>lang en</code>",
    lang_set: "🌐 Язык переключен",
    add_leader_prompt: "✍️ Отправь address лидера следующим сообщением.",
    add_secret_prompt: "🔐 Отправь в следующем сообщении строку вида:\n<code>wallet_id env:SECRET_NAME</code>",
    pending_budget_saved: "✅ Pending budget сохранен",
    leader_added: "✅ Лидер добавлен",
    secret_saved: "✅ Secret ref сохранен",
    leaders_synced: "✅ Лидеры синхронизированы",
    run_started: "✅ Запуск выполнен",
    pending_applied: "✅ Pending config применен",
    unknown: "Используйте меню ниже."
  },
  en: {
    menu_run_multi: "🚀 Run Multi",
    menu_run_scalp: "⚡ Run Scalp",
    menu_run_reversal: "↩️ Run Reversal",
    menu_run_runner: "🏃 Run Runner",
    menu_run_copy: "📋 Run Copytrade",
    menu_stop: "🛑 Stop",
    menu_kill: "☠️ Kill",
    menu_status: "📊 Status",
    menu_scan_market: "🔎 Scan Market",
    menu_scan_ca: "🧾 Scan CA",
    menu_balance: "💰 Balance",
    menu_wallets: "👛 Wallets",
    menu_copytrade: "📋 Copytrade",
    menu_budget: "🧮 Budget",
    menu_gmgn_status: "🛰 GMGN Status",
    menu_leader_health: "🫀 Leader Health",
    menu_sync_leaders: "🔄 Sync Leaders",
    menu_language: "🌐 Language",
    menu_export_csv: "📈 Export CSV",
    menu_export_json: "📦 Export JSON",
    menu_export_xlsx: "📊 Export XLSX",
    ready: "🤖 <b>Bot ready</b>",
    send_ca: "🧾 <b>Send CA</b>\n\nSend the token contract in the next message.",
    invalid_ca: "❌ This does not look like a valid CA.",
    scan_hint: "First press <b>🧾 Scan CA</b>, then send the address.",
    soft_stop: "🛑 Soft stop enabled. No new entries, existing positions will be managed until exit.",
    hard_kill: "☠️ Hard stop executed.",
    choose_lang: "🌐 Choose language:\n<code>lang ru</code> or <code>lang en</code>",
    lang_set: "🌐 Language switched",
    add_leader_prompt: "✍️ Send leader address in the next message.",
    add_secret_prompt: "🔐 Send a line in the next message like:\n<code>wallet_id env:SECRET_NAME</code>",
    pending_budget_saved: "✅ Pending budget saved",
    leader_added: "✅ Leader added",
    secret_saved: "✅ Secret ref saved",
    leaders_synced: "✅ Leaders synced",
    run_started: "✅ Run started",
    pending_applied: "✅ Pending config applied",
    unknown: "Use the menu below."
  }
};

function t(key) {
  const lang = kernel.getRuntime().activeConfig.language || "ru";
  return I18N[lang]?.[key] || I18N.ru[key] || key;
}

function keyboard() {
  return {
    keyboard: [
      [t("menu_run_multi"), t("menu_run_scalp")],
      [t("menu_run_reversal"), t("menu_run_runner")],
      [t("menu_run_copy"), t("menu_stop")],
      [t("menu_kill"), t("menu_status")],
      [t("menu_scan_market"), t("menu_scan_ca")],
      [t("menu_balance"), t("menu_budget")],
      [t("menu_wallets"), t("menu_copytrade")],
      [t("menu_gmgn_status"), t("menu_leader_health")],
      [t("menu_sync_leaders"), t("menu_language")],
      [t("menu_export_csv"), t("menu_export_json")],
      [t("menu_export_xlsx")]
    ],
    resize_keyboard: true,
    persistent: true
  };
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

function normalizeAction(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return null;

  if (raw === "/start" || raw === "/menu") return "start";
  if (raw === "/runmulti" || raw.includes("run multi")) return "run_multi";
  if (raw === "/runscalp" || raw.includes("run scalp")) return "run_scalp";
  if (raw === "/runreversal" || raw.includes("run reversal")) return "run_reversal";
  if (raw === "/runrunner" || raw.includes("run runner")) return "run_runner";
  if (raw === "/runcopytrade" || raw.includes("run copytrade")) return "run_copytrade";
  if (raw === "/stop" || raw.includes("stop")) return "stop";
  if (raw === "/kill" || raw.includes("kill")) return "kill";
  if (raw === "/status" || raw.includes("status")) return "status";
  if (raw === "/balance" || raw.includes("balance")) return "balance";
  if (raw === "/scanmarket" || raw.includes("scan market")) return "scan_market";
  if (raw === "/scanca" || raw === "/ca" || raw.includes("scan ca")) return "scan_ca";
  if (raw === "/language" || raw.includes("language")) return "language";
  if (raw === "/wallets" || raw.includes("wallets")) return "wallets";
  if (raw === "/copytrade" || raw.includes("copytrade")) return "copytrade";
  if (raw === "/budget" || raw.includes("budget")) return "budget";
  if (raw === "/gmgnstatus" || raw.includes("gmgn status")) return "gmgn_status";
  if (raw === "/leaderhealth" || raw.includes("leader health")) return "leader_health";
  if (raw === "/syncleaders" || raw.includes("sync leaders")) return "sync_leaders";
  if (raw === "/addleader") return "add_leader";
  if (raw === "/setsecret") return "set_secret";
  if (raw === "/applypending") return "apply_pending";
  if (raw === "/exportcsv") return "exportcsv";
  if (raw === "/exportjson") return "exportjson";
  if (raw === "/exportxlsx") return "exportxlsx";
  if (raw === "lang ru") return "lang_ru";
  if (raw === "lang en") return "lang_en";

  return null;
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

function createSendBridge(chatId) {
  return {
    text: (text, extra = {}) => sendMessage(chatId, text, { reply_markup: keyboard(), ...extra }),
    photoOrText: (imageUrl, caption, extra = {}) =>
      sendPhotoOrText(chatId, imageUrl, caption, { reply_markup: keyboard(), ...extra })
  };
}

function startLoop(chatId, userId) {
  stopLoop();

  loopId = setInterval(() => {
    kernel.tick(createSendBridge(chatId)).catch((err) => {
      console.log("tick error:", err.message);
    });
  }, AUTO_INTERVAL_MS);

  if (kernel.getRuntime().mode === "4h") {
    stopTimeoutId = setTimeout(async () => {
      kernel.requestSoftStop();
      await sendMessage(chatId, t("soft_stop"), { reply_markup: keyboard() });
    }, 4 * 60 * 60 * 1000);
  }
}

function stopLoop() {
  if (loopId) clearInterval(loopId);
  if (stopTimeoutId) clearTimeout(stopTimeoutId);
  loopId = null;
  stopTimeoutId = null;
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
  const closed = kernel.getClosedTrades();
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

  const rows = closed.map((tr) => [
    tr.id,
    tr.strategy,
    tr.token,
    tr.ca,
    tr.entryReferencePrice,
    tr.entryEffectivePrice,
    tr.exitReferencePrice,
    tr.amountSol,
    tr.netPnlPct,
    tr.netPnlSol,
    tr.reason,
    tr.openedAt,
    tr.closedAt,
    tr.durationMs,
    tr.balanceAfter
  ]);

  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function statsToXlsxWorkbook() {
  const pf = kernel.getPortfolio();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { metric: "runId", value: kernel.getRuntime().runId || "" },
      { metric: "mode", value: kernel.getRuntime().mode },
      { metric: "scope", value: kernel.getRuntime().strategyScope },
      { metric: "cash", value: pf.cash },
      { metric: "equity", value: pf.equity },
      { metric: "realizedPnlSol", value: pf.realizedPnlSol },
      { metric: "unrealizedPnlSol", value: pf.unrealizedPnlSol }
    ]),
    "summary"
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pf.closedTrades), "trades");
  return wb;
}

async function exportJson(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${kernel.getRuntime().runId || Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(kernel.getPortfolio(), null, 2), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/json"
  });
  await scheduleTempCleanup(filePath);
}

async function exportCsv(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${kernel.getRuntime().runId || Date.now()}.csv`);
  await fs.writeFile(filePath, statsToCsv(), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "text/csv"
  });
  await scheduleTempCleanup(filePath);
}

async function exportXlsx(chatId) {
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${kernel.getRuntime().runId || Date.now()}.xlsx`);
  XLSX.writeFile(statsToXlsxWorkbook(), filePath);
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  await scheduleTempCleanup(filePath);
}

async function handleAction(chatId, userId, action) {
  if (action === "start") {
    clearChatMode(chatId);
    await sendMessage(chatId, t("ready"), { reply_markup: keyboard() });
    return;
  }

  if (action === "run_multi") {
    kernel.start("all", "infinite", chatId, userId);
    startLoop(chatId, userId);
    await sendMessage(chatId, `${t("run_started")}: MULTI`, { reply_markup: keyboard() });
    return;
  }

  if (action === "run_scalp") {
    kernel.start("scalp", "infinite", chatId, userId);
    startLoop(chatId, userId);
    await sendMessage(chatId, `${t("run_started")}: SCALP`, { reply_markup: keyboard() });
    return;
  }

  if (action === "run_reversal") {
    kernel.start("reversal", "infinite", chatId, userId);
    startLoop(chatId, userId);
    await sendMessage(chatId, `${t("run_started")}: REVERSAL`, { reply_markup: keyboard() });
    return;
  }

  if (action === "run_runner") {
    kernel.start("runner", "infinite", chatId, userId);
    startLoop(chatId, userId);
    await sendMessage(chatId, `${t("run_started")}: RUNNER`, { reply_markup: keyboard() });
    return;
  }

  if (action === "run_copytrade") {
    kernel.start("copytrade", "infinite", chatId, userId);
    startLoop(chatId, userId);
    await sendMessage(chatId, `${t("run_started")}: COPYTRADE`, { reply_markup: keyboard() });
    return;
  }

  if (action === "stop") {
    kernel.requestSoftStop();
    await sendMessage(chatId, t("soft_stop"), { reply_markup: keyboard() });
    return;
  }

  if (action === "kill") {
    const closed = await kernel.requestHardKill();
    stopLoop();
    await sendMessage(chatId, `${t("hard_kill")}\nclosed: ${closed.length}`, {
      reply_markup: keyboard()
    });
    return;
  }

  if (action === "status") {
    await sendMessage(chatId, kernel.buildStatusText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "balance") {
    await sendMessage(chatId, kernel.buildBalanceText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "scan_market") {
    await sendMessage(chatId, "🔎 <b>Market scan started</b>", { reply_markup: keyboard() });
    await kernel.tick(createSendBridge(chatId));
    return;
  }

  if (action === "scan_ca") {
    setChatMode(chatId, "awaiting_ca");
    await sendMessage(chatId, t("send_ca"), { reply_markup: keyboard() });
    return;
  }

  if (action === "language") {
    await sendMessage(chatId, t("choose_lang"), { reply_markup: keyboard() });
    return;
  }

  if (action === "lang_ru") {
    kernel.setLanguage("ru");
    await sendMessage(chatId, `${t("lang_set")}: RU`, { reply_markup: keyboard() });
    return;
  }

  if (action === "lang_en") {
    kernel.setLanguage("en");
    await sendMessage(chatId, `${t("lang_set")}: EN`, { reply_markup: keyboard() });
    return;
  }

  if (action === "wallets") {
    await sendMessage(chatId, kernel.buildWalletsText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "copytrade") {
    await sendMessage(chatId, kernel.buildCopytradeText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "budget") {
    await sendMessage(chatId, kernel.buildBudgetText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "gmgn_status") {
    await sendMessage(chatId, kernel.buildGmgnStatusText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "leader_health") {
    await sendMessage(chatId, await kernel.buildLeaderHealthText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "sync_leaders") {
    await kernel.syncLeaderScores();
    await sendMessage(chatId, t("leaders_synced"), { reply_markup: keyboard() });
    await sendMessage(chatId, await kernel.buildLeaderHealthText(), { reply_markup: keyboard() });
    return;
  }

  if (action === "add_leader") {
    setChatMode(chatId, "awaiting_leader_address");
    await sendMessage(chatId, t("add_leader_prompt"), { reply_markup: keyboard() });
    return;
  }

  if (action === "set_secret") {
    setChatMode(chatId, "awaiting_secret_ref");
    await sendMessage(chatId, t("add_secret_prompt"), { reply_markup: keyboard() });
    return;
  }

  if (action === "apply_pending") {
    const applied = await kernel.applyPendingIfPossible();
    await sendMessage(
      chatId,
      applied ? t("pending_applied") : "Pending config not applied yet. Stop the bot and close positions first.",
      { reply_markup: keyboard() }
    );
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

  await sendMessage(chatId, t("unknown"), { reply_markup: keyboard() });
}

async function processStatefulInput(chatId, text) {
  const mode = getChatMode(chatId);

  if (mode.mode === "awaiting_ca") {
    if (!isLikelyCA(text)) {
      await sendMessage(chatId, t("invalid_ca"), { reply_markup: keyboard() });
      return true;
    }
    clearChatMode(chatId);
    await kernel.scanCA(text, createSendBridge(chatId));
    return true;
  }

  if (mode.mode === "awaiting_leader_address") {
    if (!isLikelyCA(text)) {
      await sendMessage(chatId, t("invalid_ca"), { reply_markup: keyboard() });
      return true;
    }
    kernel.addLeader(text);
    clearChatMode(chatId);
    await sendMessage(chatId, `${t("leader_added")}\n<code>${text}</code>`, {
      reply_markup: keyboard()
    });
    return true;
  }

  if (mode.mode === "awaiting_secret_ref") {
    const match = String(text || "").trim().match(/^([A-Za-z0-9_\-]+)\s+(env:[A-Za-z0-9_\-]+)$/);
    if (!match) {
      await sendMessage(chatId, "❌ Format: <code>wallet_id env:SECRET_NAME</code>", {
        reply_markup: keyboard()
      });
      return true;
    }

    const [, walletId, secretRef] = match;
    const ok = kernel.setWalletSecretRef(walletId, secretRef);
    if (!ok) {
      await sendMessage(chatId, "❌ Wallet not found", { reply_markup: keyboard() });
      return true;
    }

    clearChatMode(chatId);
    await sendMessage(chatId, `${t("secret_saved")}\n<b>${walletId}</b> → <code>${secretRef}</code>`, {
      reply_markup: keyboard()
    });
    return true;
  }

  return false;
}

bot.on("message", (msg) => {
  (async () => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || chatId;
    const text = String(msg.text || "").trim();
    const action = normalizeAction(text);

    if (await processStatefulInput(chatId, text)) return;

    const budgetMatch = text.match(/^budget\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/i);
    if (budgetMatch) {
      const values = budgetMatch.slice(1).map(Number);
      const result = kernel.queueBudgetUpdate(values);

      if (!result.ok) {
        await sendMessage(chatId, "❌ Budget invalid. Sum must be 100.", {
          reply_markup: keyboard()
        });
        return;
      }

      await sendMessage(chatId, `${t("pending_budget_saved")}

<b>Pending</b>
${result.budget ? `${Math.round(result.budget.scalp * 100)} / ${Math.round(result.budget.reversal * 100)} / ${Math.round(result.budget.runner * 100)} / ${Math.round(result.budget.copytrade * 100)}` : "-"}`, {
        reply_markup: keyboard()
      });
      return;
    }

    if (action) {
      await handleAction(chatId, userId, action);
      return;
    }

    if (isLikelyCA(text)) {
      await sendMessage(chatId, t("scan_hint"), { reply_markup: keyboard() });
      return;
    }

    await sendMessage(chatId, t("unknown"), { reply_markup: keyboard() });
  })().catch((err) => {
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
