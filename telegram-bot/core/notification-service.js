import GroupMessageFormatter from "./group-message-formatter.js";
import {
  isPublicEntry,
  isPublicExit
} from "./public-group-policy.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pctText(value) {
  const n = safeNum(value, 0);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function isRuLang(lang = "") {
  return String(lang || "").toLowerCase().startsWith("ru");
}

function strategyLabel(value = "", ru = false) {
  const key = String(value || "-").trim();
  if (!ru) return key;
  const map = {
    scalp: "SCALP / быстрый вход",
    reversal: "REVERSAL / разворот",
    runner: "RUNNER / тренд",
    copytrade: "COPYTRADE",
    migration_survivor: "MIGRATION / survivor"
  };
  return map[key] || key;
}

export default class NotificationService {
  constructor(options = {}) {
    this.send = options.send || {};
    this.language = options.language || options.lang || "en";
    this.groupFormatter =
      options.groupFormatter || new GroupMessageFormatter();
    this.enableDebugPositionUpdates =
      String(process.env.ENABLE_POSITION_UPDATES || "0") === "1";
  }

  isRu() {
    return isRuLang(this.language);
  }

  async sendText(text, extra = {}) {
    if (!this.send?.text) return null;
    return this.send.text(text, extra);
  }

  async sendPhotoOrText(imageUrl, caption, extra = {}) {
    if (this.send?.photoOrText) {
      return this.send.photoOrText(imageUrl, caption, extra);
    }
    if (this.send?.text) {
      return this.send.text(caption, extra);
    }
    return null;
  }

  async sendPublicText(text, extra = {}) {
    if (!this.send?.publicText) return null;
    return this.send.publicText(text, extra);
  }

  async sendPublicPhotoOrText(imageUrl, caption, extra = {}) {
    if (this.send?.publicPhotoOrText) {
      return this.send.publicPhotoOrText(imageUrl, caption, extra);
    }
    if (this.send?.publicText) {
      return this.send.publicText(caption, extra);
    }
    return null;
  }

  async sendEntry(heroImage, position) {
    await this.sendPhotoOrText(
      heroImage,
      this.buildControlEntryText(position)
    );

    if (isPublicEntry(position)) {
      const sent = await this.sendPublicPhotoOrText(
        heroImage,
        this.groupFormatter.buildEntryPost(position)
      );

      if (sent && this.send?.pinPublicMessage) {
        await this.send.pinPublicMessage(sent);
      }
    }

    return true;
  }

  async sendExit(imageUrl, closedTrade) {
    await this.sendPhotoOrText(
      imageUrl,
      this.buildControlExitText(closedTrade)
    );

    if (isPublicExit(closedTrade)) {
      const sent = await this.sendPublicPhotoOrText(
        imageUrl,
        this.groupFormatter.buildExitPost(closedTrade)
      );

      if (sent && this.send?.pinPublicMessage) {
        await this.send.pinPublicMessage(sent);
      }
    }

    return true;
  }

  async sendRunnerPartial(position, partial) {
    if (!this.isRu()) {
      return this.sendText(
        `🪜 <b>PARTIAL</b>\n\n<b>Token:</b> ${escapeHtml(position?.token || position?.symbol || "-")}\n<b>Strategy:</b> ${escapeHtml(position?.strategy || "-")}\n<b>Target:</b> ${safeNum(partial?.targetPct, 0)}%\n<b>Sold fraction:</b> ${safeNum(partial?.soldFraction, 0)}\n<b>Realized pct:</b> ${pctText(partial?.realizedPct)}`
      );
    }

    return this.sendText(
      `🪜 <b>ЧАСТИЧНЫЙ ВЫХОД</b>\n\n<b>Токен:</b> ${escapeHtml(position?.token || position?.symbol || "-")}\n<b>Стратегия:</b> ${escapeHtml(strategyLabel(position?.strategy, true))}\n<b>Цель:</b> ${safeNum(partial?.targetPct, 0)}%\n<b>Проданная доля:</b> ${safeNum(partial?.soldFraction, 0)}\n<b>Зафиксировано:</b> ${pctText(partial?.realizedPct)}`
    );
  }

  async sendPositionUpdate(position, mark, reason) {
    if (!this.enableDebugPositionUpdates) return null;

    if (!this.isRu()) {
      return this.sendText(
        `📍 <b>POSITION UPDATE</b>\n\n<b>Token:</b> ${escapeHtml(position?.token || position?.symbol || "-")}\n<b>Strategy:</b> ${escapeHtml(position?.strategy || "-")}\n<b>PnL:</b> ${pctText(mark?.netPnlPct)}\n<b>Reason:</b> ${escapeHtml(reason || "-")}`
      );
    }

    const pnl = safeNum(mark?.netPnlPct, 0);
    const emoji = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
    return this.sendText(
      `📍 <b>ОБНОВЛЕНИЕ ПОЗИЦИИ</b>\n\n<b>Токен:</b> ${escapeHtml(position?.token || position?.symbol || "-")}\n<b>Стратегия:</b> ${escapeHtml(strategyLabel(position?.strategy, true))}\n<b>PnL:</b> ${emoji} <b>${pctText(mark?.netPnlPct)}</b>\n<b>Причина:</b> ${escapeHtml(reason || "-")}`
    );
  }

  buildControlEntryText(position) {
    const tokenName = position?.token || position?.symbol || "UNKNOWN";
    const tokenCa = position?.ca || "-";
    const planName = position?.planName || position?.strategy || "-";

    if (!this.isRu()) {
      return `🧠 <b>ENTRY</b>\n\n<b>Token:</b> ${escapeHtml(tokenName)}\n<b>Strategy:</b> ${escapeHtml(position?.strategy || "-")}\n<b>Plan:</b> ${escapeHtml(planName)}\n<b>CA:</b> <code>${escapeHtml(tokenCa)}</code>\n<b>Amount SOL:</b> ${safeNum(position?.amountSol, 0)}\n<b>Entry reference:</b> ${safeNum(position?.entryReferencePrice, 0)}\n<b>Stop:</b> ${safeNum(position?.stopLossPct, 0)}%\n<b>TP:</b> ${safeNum(position?.takeProfitPct, 0)}%`;
    }

    return `🧠 <b>ВХОД В СДЕЛКУ</b>\n\n<b>Токен:</b> ${escapeHtml(tokenName)}\n<b>Стратегия:</b> ${escapeHtml(strategyLabel(position?.strategy, true))}\n<b>План:</b> ${escapeHtml(planName)}\n<b>CA:</b> <code>${escapeHtml(tokenCa)}</code>\n<b>Размер:</b> <b>${safeNum(position?.amountSol, 0)} SOL</b>\n<b>Цена входа ref:</b> ${safeNum(position?.entryReferencePrice, 0)}\n<b>SL:</b> ${safeNum(position?.stopLossPct, 0)}%\n<b>TP:</b> ${safeNum(position?.takeProfitPct, 0)}%`;
  }

  buildControlExitText(closedTrade) {
    const tokenName = closedTrade?.token || closedTrade?.symbol || "UNKNOWN";
    const tokenCa = closedTrade?.ca || "-";

    if (!this.isRu()) {
      return `🏁 <b>EXIT</b>\n\n<b>Token:</b> ${escapeHtml(tokenName)}\n<b>Strategy:</b> ${escapeHtml(closedTrade?.strategy || "-")}\n<b>CA:</b> <code>${escapeHtml(tokenCa)}</code>\n<b>PnL:</b> ${pctText(closedTrade?.netPnlPct)}\n<b>PnL SOL:</b> ${safeNum(closedTrade?.netPnlSol, 0).toFixed(4)}\n<b>Reason:</b> ${escapeHtml(closedTrade?.reason || "-")}\n<b>Duration min:</b> ${(safeNum(closedTrade?.durationMs, 0) / 60000).toFixed(1)}`;
    }

    const pnl = safeNum(closedTrade?.netPnlPct, 0);
    const emoji = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
    return `🏁 <b>ВЫХОД ИЗ СДЕЛКИ</b>\n\n<b>Токен:</b> ${escapeHtml(tokenName)}\n<b>Стратегия:</b> ${escapeHtml(strategyLabel(closedTrade?.strategy, true))}\n<b>CA:</b> <code>${escapeHtml(tokenCa)}</code>\n<b>PnL:</b> ${emoji} <b>${pctText(closedTrade?.netPnlPct)}</b>\n<b>PnL SOL:</b> ${safeNum(closedTrade?.netPnlSol, 0).toFixed(4)}\n<b>Причина:</b> ${escapeHtml(closedTrade?.reason || "-")}\n<b>Длительность:</b> ${(safeNum(closedTrade?.durationMs, 0) / 60000).toFixed(1)} мин`;
  }
}
