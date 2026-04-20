import {
  buildEntryText,
  buildExitText,
  buildPositionUpdateText
} from "./reporting-engine.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default class NotificationService {
  constructor(options = {}) {
    this.send = options.send;
  }

  async sendText(text) {
    await this.send.text(text);
  }

  async sendPhotoOrText(imageUrl, caption) {
    await this.send.photoOrText(imageUrl, caption);
  }

  async sendEntry(heroImage, position) {
    await this.send.photoOrText(heroImage, buildEntryText(position));
  }

  async sendExit(heroImage, trade) {
    await this.send.photoOrText(heroImage, buildExitText(trade));
  }

  async sendPositionUpdate(position, mark, reason) {
    await this.send.text(buildPositionUpdateText(position, mark, reason));
  }

  async sendRunnerPartial(position, partial) {
    await this.send.text(
      `🎯 <b>RUNNER PARTIAL</b>

<b>Token:</b> ${escapeHtml(position.token)}
<b>Target:</b> ${partial.targetPct}%
<b>Sold fraction:</b> ${round(partial.soldFraction * 100, 0)}%
<b>Cash added:</b> ${round(partial.netValueSol, 4)} SOL`
    );
  }
}
