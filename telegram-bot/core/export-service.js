import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

export default class ExportService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.tempFiles = new Set();
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

  buildCsvFromClosedTrades(closedTrades = []) {
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

    const rows = closedTrades.map((tr) => [
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

  buildWorkbook(runtime, portfolio) {
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        { metric: "runId", value: runtime?.runId || "" },
        { metric: "mode", value: runtime?.mode || "" },
        { metric: "scope", value: runtime?.strategyScope || "" },
        { metric: "cash", value: portfolio?.cash || 0 },
        { metric: "equity", value: portfolio?.equity || 0 },
        { metric: "realizedPnlSol", value: portfolio?.realizedPnlSol || 0 },
        { metric: "unrealizedPnlSol", value: portfolio?.unrealizedPnlSol || 0 }
      ]),
      "summary"
    );

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(portfolio?.closedTrades || []),
      "trades"
    );

    return wb;
  }

  async exportJson(bot, chatId, runtime, portfolio) {
    const filePath = path.join(
      os.tmpdir(),
      `chiikawa-stats-${runtime?.runId || Date.now()}.json`
    );
    await fs.writeFile(filePath, JSON.stringify(portfolio, null, 2), "utf8");
    await bot.sendDocument(chatId, filePath, {}, {
      filename: path.basename(filePath),
      contentType: "application/json"
    });
    await this.scheduleTempCleanup(filePath);
  }

  async exportCsv(bot, chatId, runtime, portfolio) {
    const filePath = path.join(
      os.tmpdir(),
      `chiikawa-stats-${runtime?.runId || Date.now()}.csv`
    );
    const csv = this.buildCsvFromClosedTrades(portfolio?.closedTrades || []);
    await fs.writeFile(filePath, csv, "utf8");
    await bot.sendDocument(chatId, filePath, {}, {
      filename: path.basename(filePath),
      contentType: "text/csv"
    });
    await this.scheduleTempCleanup(filePath);
  }

  async exportXlsx(bot, chatId, runtime, portfolio) {
    const filePath = path.join(
      os.tmpdir(),
      `chiikawa-stats-${runtime?.runId || Date.now()}.xlsx`
    );
    XLSX.writeFile(this.buildWorkbook(runtime, portfolio), filePath);
    await bot.sendDocument(chatId, filePath, {}, {
      filename: path.basename(filePath),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    await this.scheduleTempCleanup(filePath);
  }
}
