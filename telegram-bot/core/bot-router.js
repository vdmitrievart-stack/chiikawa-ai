import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

import { buildKeyboard, makeTranslator } from "./bot-i18n.js";

function isLikelyCA(text) {
  const value = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(value);
}

function normalizeAction(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/[^\p{L}\p{N}\/\s_:-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized === "/start" || normalized === "/menu") return "start";
  if (normalized === "/runmulti" || normalized.includes("run multi")) return "run_multi";
  if (normalized === "/runscalp" || normalized.includes("run scalp")) return "run_scalp";
  if (normalized === "/runreversal" || normalized.includes("run reversal")) return "run_reversal";
  if (normalized === "/runrunner" || normalized.includes("run runner")) return "run_runner";
  if (normalized === "/runcopytrade" || normalized.includes("run copytrade")) return "run_copytrade";
  if (normalized === "/runmigration" || normalized.includes("run migration")) return "run_migration";

  if (normalized === "/stop" || normalized === "stop" || normalized.includes(" stop")) return "stop";
  if (normalized === "/kill" || normalized === "kill" || normalized.includes(" kill")) return "kill";

  if (normalized === "/status" || normalized.includes("status")) return "status";
  if (normalized === "/intents" || normalized.includes("pending intents")) return "intents";
  if (normalized === "/gmgnexecution" || normalized.includes("gmgn execution")) return "gmgn_execution";
  if (normalized === "/gmgnorders" || normalized.includes("gmgn orders")) return "gmgn_orders";
  if (normalized === "/balance" || normalized.includes("balance")) return "balance";
  if (normalized === "/scanmarket" || normalized.includes("scan market")) return "scan_market";
  if (normalized === "/scanca" || normalized === "/ca" || normalized.includes("scan ca")) return "scan_ca";
  if (normalized === "/language" || normalized.includes("language")) return "language";
  if (normalized === "/wallets" || normalized.includes("wallets")) return "wallets";
  if (normalized === "/copytrade" || normalized.includes("copytrade")) return "copytrade";
  if (normalized === "/budget" || normalized.includes("budget")) return "budget";
  if (normalized === "/gmgnstatus" || normalized.includes("gmgn status")) return "gmgn_status";
  if (normalized === "/leaderhealth" || normalized.includes("leader health")) return "leader_health";
  if (normalized === "/syncleaders" || normalized.includes("sync leaders")) return "sync_leaders";
  if (normalized === "/addleader") return "add_leader";
  if (normalized === "/setsecret") return "set_secret";
  if (normalized === "/applypending") return "apply_pending";
  if (normalized === "/exportcsv") return "exportcsv";
  if (normalized === "/exportjson") return "exportjson";
  if (normalized === "/exportxlsx") return "exportxlsx";
  if (normalized === "lang ru") return "lang_ru";
  if (normalized === "lang en") return "lang_en";

  return null;
}

export default class BotRouter {
  constructor({ bot, kernel, logger = console }) {
    this.bot = bot;
    this.kernel = kernel;
    this.logger = logger;
    this.chatState = new Map();
    this.tempFiles = new Set();
    this.loopId = null;
    this.stopTimeoutId = null;
    this.AUTO_INTERVAL_MS = Number(process.env.AUTO_INTERVAL_MS || 60000);
    this.t = makeTranslator(() => this.kernel.getRuntime().activeConfig.language);
  }

  keyboard() {
    return buildKeyboard(this.t);
  }

  setChatMode(chatId, mode, payload = {}) {
    this.chatState.set(chatId, { mode, ...payload, updatedAt: Date.now() });
  }

  getChatMode(chatId) {
    return this.chatState.get(chatId) || { mode: "idle" };
  }

  clearChatMode(chatId) {
    this.chatState.delete(chatId);
  }

  async sendMessage(chatId, text, extra = {}) {
    return this.bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: false,
      ...extra
    });
  }

  async sendPhotoOrText(chatId, imageUrl, caption, extra = {}) {
    const safeCaption = String(caption || "").slice(0, 1024);
    if (imageUrl) {
      try {
        await this.bot.sendPhoto(chatId, imageUrl, {
          caption: safeCaption,
          parse_mode: "HTML",
          ...extra
        });
        return;
      } catch (error) {
        this.logger.log("sendPhoto fallback:", error.message);
      }
    }
    await this.sendMessage(chatId, caption, extra);
  }

  createSendBridge(chatId) {
    return {
      text: (text, extra = {}) =>
        this.sendMessage(chatId, text, { reply_markup: this.keyboard(), ...extra }),
      photoOrText: (imageUrl, caption, extra = {}) =>
        this.sendPhotoOrText(chatId, imageUrl, caption, {
          reply_markup: this.keyboard(),
          ...extra
        })
    };
  }

  startLoop(chatId, userId) {
    this.stopLoop();

    this.loopId = setInterval(() => {
      this.kernel.tick(this.createSendBridge(chatId)).catch((err) => {
        this.logger.log("tick error:", err.message);
      });
    }, this.AUTO_INTERVAL_MS);
  }

  stopLoop() {
    if (this.loopId) clearInterval(this.loopId);
    if (this.stopTimeoutId) clearTimeout(this.stopTimeoutId);
    this.loopId = null;
    this.stopTimeoutId = null;
  }

  async scheduleTempCleanup(filePath) {
    this.tempFiles.add(filePath);
    setTimeout(async () => {
      try {
        await fs.unlink(filePath);
      } catch {}
      this.tempFiles.delete(filePath);
    }, 5 * 60 * 1000);
  }

  statsToCsv() {
    const closed = this.kernel.getClosedTrades();
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

  statsToXlsxWorkbook() {
    const pf = this.kernel.getPortfolio();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        { metric: "runId", value: this.kernel.getRuntime().runId || "" },
        { metric: "mode", value: this.kernel.getRuntime().mode },
        { metric: "scope", value: this.kernel.getRuntime().strategyScope },
        { metric: "cash", value: pf.cash },
        { metric: "equity", value: pf.equity },
        { metric: "realizedPnlSol", value: pf.realizedPnlSol },
        { metric: "unrealizedPnlSol", value: pf.unrealizedPnlSol }
      ]),
      "summary"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(pf.closedTrades),
      "trades"
    );
    return wb;
  }

  async exportJson(chatId) {
    const filePath = path.join(
      os.tmpdir(),
      `chiikawa-stats-${this.kernel.getRuntime().runId || Date.now()}.json`
    );
    await fs.writeFile(filePath, JSON.stringify(this.kernel.getPortfolio(), null, 2), "utf8");
    await this.bot.sendDocument(chatId, filePath, {}, {
      filename: path.basename(filePath),
      contentType: "application/json"
    });
    await this.scheduleTempCleanup(filePath);
  }

  async exportCsv(chatId) {
    const filePath = path.join(
      os.tmpdir(),
      `chiikawa-stats-${this.kernel.getRuntime().runId || Date.now()}.csv`
    );
    await fs.writeFile(filePath, this.statsToCsv(), "utf8");
    await this.bot.sendDocument(chatId, filePath, {}, {
      filename: path.basename(filePath),
      contentType: "text/csv"
    });
    await this.scheduleTempCleanup(filePath);
  }

  async exportXlsx(chatId) {
    const filePath = path.join(
      os.tmpdir(),
      `chiikawa-stats-${this.kernel.getRuntime().runId || Date.now()}.xlsx`
    );
    XLSX.writeFile(this.statsToXlsxWorkbook(), filePath);
    await this.bot.sendDocument(chatId, filePath, {}, {
      filename: path.basename(filePath),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    await this.scheduleTempCleanup(filePath);
  }

  async processStatefulInput(chatId, text) {
    const mode = this.getChatMode(chatId);

    if (mode.mode === "awaiting_ca") {
      if (!isLikelyCA(text)) {
        await this.sendMessage(chatId, this.t("invalid_ca"), {
          reply_markup: this.keyboard()
        });
        return true;
      }
      this.clearChatMode(chatId);
      await this.kernel.scanCA(text, this.createSendBridge(chatId));
      return true;
    }

    if (mode.mode === "awaiting_leader_address") {
      if (!isLikelyCA(text)) {
        await this.sendMessage(chatId, this.t("invalid_ca"), {
          reply_markup: this.keyboard()
        });
        return true;
      }
      this.kernel.addLeader(text);
      this.clearChatMode(chatId);
      await this.sendMessage(chatId, `${this.t("leader_added")}\n<code>${text}</code>`, {
        reply_markup: this.keyboard()
      });
      return true;
    }

    if (mode.mode === "awaiting_secret_ref") {
      const match = String(text || "")
        .trim()
        .match(/^([A-Za-z0-9_\-]+)\s+(env:[A-Za-z0-9_\-]+)$/);

      if (!match) {
        await this.sendMessage(chatId, this.t("secret_format"), {
          reply_markup: this.keyboard()
        });
        return true;
      }

      const [, walletId, secretRef] = match;
      const ok = this.kernel.setWalletSecretRef(walletId, secretRef);

      if (!ok) {
        await this.sendMessage(chatId, this.t("wallet_not_found"), {
          reply_markup: this.keyboard()
        });
        return true;
      }

      this.clearChatMode(chatId);
      await this.sendMessage(
        chatId,
        `${this.t("secret_saved")}\n<b>${walletId}</b> → <code>${secretRef}</code>`,
        { reply_markup: this.keyboard() }
      );
      return true;
    }

    return false;
  }

  async handleAction(chatId, userId, action) {
    if (action === "start") {
      this.clearChatMode(chatId);
      await this.sendMessage(chatId, this.t("ready"), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "run_multi") {
      this.kernel.start("all", "infinite", chatId, userId);
      this.startLoop(chatId, userId);
      await this.sendMessage(chatId, `${this.t("run_started")}: MULTI (5 STRATEGIES)`, {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "run_scalp") {
      this.kernel.start("scalp", "infinite", chatId, userId);
      this.startLoop(chatId, userId);
      await this.sendMessage(chatId, `${this.t("run_started")}: SCALP`, {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "run_reversal") {
      this.kernel.start("reversal", "infinite", chatId, userId);
      this.startLoop(chatId, userId);
      await this.sendMessage(chatId, `${this.t("run_started")}: REVERSAL`, {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "run_runner") {
      this.kernel.start("runner", "infinite", chatId, userId);
      this.startLoop(chatId, userId);
      await this.sendMessage(chatId, `${this.t("run_started")}: RUNNER`, {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "run_copytrade") {
      this.kernel.start("copytrade", "infinite", chatId, userId);
      this.startLoop(chatId, userId);
      await this.sendMessage(chatId, `${this.t("run_started")}: COPYTRADE`, {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "run_migration") {
      this.kernel.start("migration_survivor", "infinite", chatId, userId);
      this.startLoop(chatId, userId);
      await this.sendMessage(chatId, `${this.t("run_started")}: MIGRATION_SURVIVOR`, {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "stop") {
      this.kernel.requestSoftStop();
      await this.sendMessage(chatId, this.t("soft_stop"), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "kill") {
      const closed = await this.kernel.requestHardKill();
      this.stopLoop();
      await this.sendMessage(
        chatId,
        `${this.t("hard_kill")}\nclosed: ${closed.length}`,
        { reply_markup: this.keyboard() }
      );
      return;
    }

    if (action === "status") {
      await this.sendMessage(chatId, this.kernel.buildStatusText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "gmgn_execution") {
      await this.sendMessage(chatId, this.kernel.buildGMGNExecutionText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "gmgn_orders") {
      await this.sendMessage(chatId, this.kernel.buildGMGNOrdersText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "balance") {
      await this.sendMessage(chatId, this.kernel.buildBalanceText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "scan_market") {
      await this.sendMessage(chatId, "🔎 <b>Market scan started</b>", {
        reply_markup: this.keyboard()
      });
      await this.kernel.tick(this.createSendBridge(chatId));
      return;
    }

    if (action === "scan_ca") {
      this.setChatMode(chatId, "awaiting_ca");
      await this.sendMessage(chatId, this.t("send_ca"), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "language") {
      await this.sendMessage(chatId, this.t("choose_lang"), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "lang_ru") {
      this.kernel.setLanguage("ru");
      await this.sendMessage(chatId, `${this.t("lang_set")}: RU`, {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "lang_en") {
      this.kernel.setLanguage("en");
      await this.sendMessage(chatId, `${this.t("lang_set")}: EN`, {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "wallets") {
      await this.sendMessage(chatId, this.kernel.buildWalletsText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "copytrade") {
      await this.sendMessage(chatId, this.kernel.buildCopytradeText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "budget") {
      await this.sendMessage(chatId, this.kernel.buildBudgetText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "gmgn_status") {
      await this.sendMessage(chatId, this.kernel.buildGmgnStatusText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "leader_health") {
      await this.sendMessage(chatId, await this.kernel.buildLeaderHealthText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "sync_leaders") {
      await this.kernel.syncLeaderScores();
      await this.sendMessage(chatId, this.t("leaders_synced"), {
        reply_markup: this.keyboard()
      });
      await this.sendMessage(chatId, await this.kernel.buildLeaderHealthText(), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "add_leader") {
      this.setChatMode(chatId, "awaiting_leader_address");
      await this.sendMessage(chatId, this.t("add_leader_prompt"), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "set_secret") {
      this.setChatMode(chatId, "awaiting_secret_ref");
      await this.sendMessage(chatId, this.t("add_secret_prompt"), {
        reply_markup: this.keyboard()
      });
      return;
    }

    if (action === "apply_pending") {
      const applied = await this.kernel.applyPendingIfPossible();
      await this.sendMessage(
        chatId,
        applied ? this.t("pending_applied") : this.t("pending_not_ready"),
        { reply_markup: this.keyboard() }
      );
      return;
    }

    if (action === "exportcsv") {
      await this.exportCsv(chatId);
      return;
    }

    if (action === "exportjson") {
      await this.exportJson(chatId);
      return;
    }

    if (action === "exportxlsx") {
      await this.exportXlsx(chatId);
      return;
    }

    await this.sendMessage(chatId, this.t("unknown"), {
      reply_markup: this.keyboard()
    });
  }

  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || chatId;
    const text = String(msg.text || "").trim();
    const action = normalizeAction(text);

    if (await this.processStatefulInput(chatId, text)) return;

    const budgetCmd = text.match(/^budget\s+(.+)$/i);
    if (budgetCmd) {
      const values = String(budgetCmd[1] || "")
        .trim()
        .split(/\s+/)
        .map((x) => Number(x));

      const result = this.kernel.queueBudgetUpdate(values);

      if (!result.ok) {
        await this.sendMessage(chatId, this.t("budget_invalid"), {
          reply_markup: this.keyboard()
        });
        return;
      }

      await this.sendMessage(
        chatId,
        `${this.t("pending_budget_saved")}

<b>Pending</b>
scalp: ${(result.budget.scalp * 100).toFixed(1)}%
reversal: ${(result.budget.reversal * 100).toFixed(1)}%
runner: ${(result.budget.runner * 100).toFixed(1)}%
copytrade: ${(result.budget.copytrade * 100).toFixed(1)}%
migration_survivor: ${(result.budget.migration_survivor * 100).toFixed(1)}%`,
        { reply_markup: this.keyboard() }
      );
      return;
    }

    if (action) {
      await this.handleAction(chatId, userId, action);
      return;
    }

    if (isLikelyCA(text)) {
      await this.sendMessage(chatId, this.t("scan_hint"), {
        reply_markup: this.keyboard()
      });
      return;
    }

    await this.sendMessage(chatId, this.t("unknown"), {
      reply_markup: this.keyboard()
    });
  }
}
