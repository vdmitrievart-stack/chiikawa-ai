function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const out = String(v ?? "").trim();
  return out || fallback;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function decodeHtml(input = "") {
  return String(input)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
}

function normalizeChannel(input = "") {
  const raw = String(input || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .replace(/^s\//, "")
    .replace(/\/$/, "")
    .trim();
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

export default class TelegramChannelSource {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.channels = unique(
      String(
        options.channels ||
          process.env.TELEGRAM_SIGNAL_CHANNELS ||
          "solhousesignal,solwhaletrending,solearlytrending"
      )
        .split(",")
        .map(normalizeChannel)
        .filter(Boolean)
    );

    this.enabled = String(process.env.TELEGRAM_SIGNAL_SOURCE_ENABLED || "true") !== "false";
    this.maxMessagesPerChannel = Number(process.env.TELEGRAM_SIGNAL_MAX_MESSAGES || 20);
    this.maxAgeMinutes = Number(process.env.TELEGRAM_SIGNAL_MAX_AGE_MINUTES || 360);
    this.minChannelHits = Number(process.env.TELEGRAM_SIGNAL_MIN_CHANNEL_HITS || 1);
    this.fetchDelayMs = Number(process.env.TELEGRAM_SIGNAL_FETCH_DELAY_MS || 1200);
    this.cacheTtlMs = Number(process.env.TELEGRAM_SIGNAL_CACHE_TTL_MS || 90_000);
    this.lastFetchAt = 0;
    this.cache = null;
  }

  extractMessageBlocks(html = "") {
    const blocks = [];
    const regex = /<div class="tgme_widget_message[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
      blocks.push(match[0]);
      if (blocks.length >= this.maxMessagesPerChannel) break;
    }

    if (!blocks.length) {
      const fallback = html.match(/<div class="tgme_widget_message_text[^"]*"[\s\S]*?<\/div>/gi) || [];
      return fallback.slice(0, this.maxMessagesPerChannel);
    }

    return blocks;
  }

  extractMessageDate(block = "") {
    const dt =
      block.match(/datetime="([^"]+)"/i)?.[1] ||
      block.match(/data-post="[^"]+".*?<time[^>]*datetime="([^"]+)"/is)?.[1] ||
      "";
    const ts = dt ? Date.parse(dt) : 0;
    return Number.isFinite(ts) ? ts : 0;
  }

  extractContracts(text = "") {
    const clean = String(text || "");

    const explicit = [];
    const explicitRegex = /(?:ca|contract|address|token)\s*[:\-]?\s*([1-9A-HJ-NP-Za-km-z]{32,44}(?:pump)?)/gi;
    let m;

    while ((m = explicitRegex.exec(clean)) !== null) {
      explicit.push(m[1]);
    }

    const linkContracts = [];
    const linkRegex = /(?:dexscreener\.com\/solana\/|gmgn\.ai\/sol\/token\/)([1-9A-HJ-NP-Za-km-z]{32,44}(?:pump)?)/gi;

    while ((m = linkRegex.exec(clean)) !== null) {
      linkContracts.push(m[1]);
    }

    const generic = clean.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}(?:pump)?\b/g) || [];

    return unique([...explicit, ...linkContracts, ...generic])
      .filter((ca) => ca.length >= 32 && ca.length <= 48)
      .filter((ca) => !/^0x/i.test(ca));
  }

  scoreHint({ channels = [], messages = [] }) {
    let score = 0;
    score += Math.min(20, channels.length * 7);
    score += Math.min(12, messages.length * 3);

    const merged = messages.map((x) => x.text || "").join("\n").toLowerCase();

    if (merged.includes("early")) score += 6;
    if (merged.includes("trend")) score += 5;
    if (merged.includes("whale")) score += 7;
    if (merged.includes("migration")) score += 7;
    if (merged.includes("cto")) score += 4;
    if (merged.includes("pump")) score += 3;
    if (merged.includes("rug") || merged.includes("scam")) score -= 10;

    return Math.max(0, Math.min(40, score));
  }

  async fetchChannel(channel) {
    const elapsed = Date.now() - this.lastFetchAt;
    if (elapsed < this.fetchDelayMs) {
      await sleepMs(this.fetchDelayMs - elapsed);
    }

    this.lastFetchAt = Date.now();

    const url = `https://t.me/s/${encodeURIComponent(channel)}`;
    const res = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 ChiikawaSignalScanner/1.0"
      }
    });

    if (!res.ok) {
      throw new Error(`Telegram channel ${channel} HTTP ${res.status}`);
    }

    const html = await res.text();
    const blocks = this.extractMessageBlocks(html);
    const rows = [];

    for (const block of blocks) {
      const messageTs = this.extractMessageDate(block);
      const ageMin = messageTs > 0 ? (Date.now() - messageTs) / 60000 : 999999;

      if (ageMin > this.maxAgeMinutes) continue;

      const text = decodeHtml(block);
      const contracts = this.extractContracts(text);

      for (const ca of contracts) {
        rows.push({
          ca,
          channel,
          text: text.slice(0, 800),
          messageTs,
          ageMin
        });
      }
    }

    return rows;
  }

  async fetchTokenHints() {
    if (!this.enabled) {
      return {
        tokens: [],
        telemetry: {
          mode: "disabled",
          rawSignals: 0,
          uniqueTokens: 0,
          channels: this.channels.length,
          errors: []
        }
      };
    }

    if (this.cache && Date.now() - safeNum(this.cache.ts, 0) < this.cacheTtlMs) {
      return this.cache.value;
    }

    const raw = [];
    const errors = [];

    for (const channel of this.channels) {
      try {
        const rows = await this.fetchChannel(channel);
        raw.push(...rows);
      } catch (error) {
        errors.push(`${channel}: ${error.message}`);
        this.logger.log("telegram signal channel failed:", channel, error.message);
      }
    }

    const byCa = new Map();

    for (const row of raw) {
      const ca = asText(row.ca);
      if (!ca) continue;

      const current = byCa.get(ca) || {
        ca,
        channels: [],
        messages: [],
        source: "telegram_signal_channels"
      };

      current.channels = unique([...current.channels, row.channel]);
      current.messages.push({
        channel: row.channel,
        text: row.text,
        messageTs: row.messageTs,
        ageMin: row.ageMin
      });

      byCa.set(ca, current);
    }

    const tokens = [...byCa.values()]
      .filter((row) => row.channels.length >= this.minChannelHits)
      .map((row) => ({
        ...row,
        channelHits: row.channels.length,
        telegramSignalScore: this.scoreHint(row),
        firstSeenAt: Math.min(...row.messages.map((x) => safeNum(x.messageTs, Date.now()))),
        newestAgeMin: Math.min(...row.messages.map((x) => safeNum(x.ageMin, 999999)))
      }))
      .sort((a, b) =>
        safeNum(b.telegramSignalScore, 0) - safeNum(a.telegramSignalScore, 0) ||
        safeNum(b.channelHits, 0) - safeNum(a.channelHits, 0) ||
        safeNum(a.newestAgeMin, 999999) - safeNum(b.newestAgeMin, 999999)
      );

    const value = {
      tokens,
      telemetry: {
        mode: "telegram_public_channels",
        rawSignals: raw.length,
        uniqueTokens: tokens.length,
        channels: this.channels.length,
        errors
      }
    };

    this.cache = {
      ts: Date.now(),
      value
    };

    return value;
  }
}
