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

export default class NotificationService {
  constructor(options = {}) {
    this.send = options.send || {};
    this.groupFormatter =
      options.groupFormatter || new GroupMessageFormatter();
    this.enableDebugPositionUpdates =
      String(process.env.ENABLE_POSITION_UPDATES || "0") === "1";
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
    return this.sendText(
      `🪜 <b>PARTIAL</b>

<b>Token:</b> ${escapeHtml(position?.token || position?.symbol || "-")}
<b>Strategy:</b> ${escapeHtml(position?.strategy || "-")}
<b>Target:</b> ${safeNum(partial?.targetPct, 0)}%
<b>Sold fraction:</b> ${safeNum(partial?.soldFraction, 0)}
<b>Realized pct:</b> ${pctText(partial?.realizedPct)}`
    );
  }

  async sendPositionUpdate(position, mark, reason) {
    if (!this.enableDebugPositionUpdates) return null;

    return this.sendText(
      `📍 <b>POSITION UPDATE</b>

<b>Token:</b> ${escapeHtml(position?.token || position?.symbol || "-")}
<b>Strategy:</b> ${escapeHtml(position?.strategy || "-")}
<b>PnL:</b> ${pctText(mark?.netPnlPct)}
<b>Reason:</b> ${escapeHtml(reason || "-")}`
    );
  }

  buildControlEntryText(position) {
    const tokenName = position?.token || position?.symbol || "UNKNOWN";
    const tokenCa = position?.ca || "-";
    const planName = position?.planName || position?.strategy || "-";

    return `🧠 <b>ENTRY</b>

<b>Token:</b> ${escapeHtml(tokenName)}
<b>Strategy:</b> ${escapeHtml(position?.strategy || "-")}
<b>Plan:</b> ${escapeHtml(planName)}
<b>CA:</b> <code>${escapeHtml(tokenCa)}</code>
<b>Amount SOL:</b> ${safeNum(position?.amountSol, 0)}
<b>Entry reference:</b> ${safeNum(position?.entryReferencePrice, 0)}
<b>Stop:</b> ${safeNum(position?.stopLossPct, 0)}%
<b>TP:</b> ${safeNum(position?.takeProfitPct, 0)}%`;
  }

  buildControlExitText(closedTrade) {
    const tokenName = closedTrade?.token || closedTrade?.symbol || "UNKNOWN";
    const tokenCa = closedTrade?.ca || "-";

    return `🏁 <b>EXIT</b>

<b>Token:</b> ${escapeHtml(tokenName)}
<b>Strategy:</b> ${escapeHtml(closedTrade?.strategy || "-")}
<b>CA:</b> <code>${escapeHtml(tokenCa)}</code>
<b>PnL:</b> ${pctText(closedTrade?.netPnlPct)}
<b>PnL SOL:</b> ${safeNum(closedTrade?.netPnlSol, 0).toFixed(4)}
<b>Reason:</b> ${escapeHtml(closedTrade?.reason || "-")}
<b>Duration min:</b> ${(safeNum(closedTrade?.durationMs, 0) / 60000).toFixed(1)}`;
  }
}
