import fs from "node:fs";
import path from "node:path";

const candidatePath = path.resolve("telegram-bot/core/candidate-service.js");
const sourcePath = path.resolve("telegram-bot/core/telegram-channel-source.js");

function fail(msg) {
  console.error("❌ Patch failed:", msg);
  process.exit(1);
}

function read(file) {
  if (!fs.existsSync(file)) fail(`File not found: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function write(file, src) {
  fs.writeFileSync(file, src);
  console.log("✅ wrote:", file);
}

function replaceOnce(src, oldText, newText, label) {
  if (src.includes(newText)) {
    console.log("Already patched:", label);
    return src;
  }
  if (!src.includes(oldText)) fail(`Cannot find block: ${label}`);
  console.log("Patched:", label);
  return src.replace(oldText, newText);
}

if (!fs.existsSync(sourcePath)) {
  fail("telegram-bot/core/telegram-channel-source.js is missing. Upload it together with this patch.");
}

let src = read(candidatePath);

if (!src.includes('import TelegramChannelSource from "./telegram-channel-source.js";')) {
  src = `import TelegramChannelSource from "./telegram-channel-source.js";\n${src}`;
}

src = replaceOnce(
  src,
  `      smartWalletFeedRaw: 0,
      smartWalletTokens: 0,
      smartWalletAccepted: 0,
      smartWalletPublishWorthy: 0,`,
  `      smartWalletFeedRaw: 0,
      smartWalletTokens: 0,
      smartWalletAccepted: 0,
      smartWalletPublishWorthy: 0,
      telegramSignalRaw: 0,
      telegramSignalTokens: 0,
      telegramSignalAccepted: 0,
      telegramSignalPublishWorthy: 0,`,
  "telemetry fields"
);

src = replaceOnce(
  src,
  `        smart_wallets: 0`,
  `        smart_wallets: 0,
        telegram_signals: 0`,
  "telemetry bucket"
);

src = replaceOnce(
  src,
  `    this.smartWalletFeed = options.smartWalletFeed || null;
    this.maxHolderEnrichPerPass = Number(options.maxHolderEnrichPerPass || 8);`,
  `    this.smartWalletFeed = options.smartWalletFeed || null;
    this.telegramChannelSource = options.telegramChannelSource || new TelegramChannelSource({
      logger: this.logger
    });
    this.maxHolderEnrichPerPass = Number(options.maxHolderEnrichPerPass || 8);`,
  "constructor source"
);

src = replaceOnce(
  src,
  `    this.maxSmartWalletCandidates = Number(options.maxSmartWalletCandidates || process.env.GMGN_SMART_WALLET_MAX_CANDIDATES || 30);`,
  `    this.maxSmartWalletCandidates = Number(options.maxSmartWalletCandidates || process.env.GMGN_SMART_WALLET_MAX_CANDIDATES || 30);
    this.maxTelegramSignalCandidates = Number(options.maxTelegramSignalCandidates || process.env.TELEGRAM_SIGNAL_MAX_CANDIDATES || 30);`,
  "constructor max telegram"
);

const telegramMethod = `

async fetchCandidatesFromTelegramChannels() {
  if (!this.telegramChannelSource || typeof this.telegramChannelSource.fetchTokenHints !== "function") {
    return {
      candidates: [],
      telemetry: {
        telegramSignalRaw: 0,
        telegramSignalTokens: 0,
        telegramSignalAccepted: 0,
        telegramSignalPublishWorthy: 0,
        feedEnabled: false,
        feedMode: "disabled"
      }
    };
  }

  let snapshot;
  try {
    snapshot = await this.telegramChannelSource.fetchTokenHints();
  } catch (error) {
    this.logger.log("telegram signal source failed:", error.message);
    return {
      candidates: [],
      telemetry: {
        telegramSignalRaw: 0,
        telegramSignalTokens: 0,
        telegramSignalAccepted: 0,
        telegramSignalPublishWorthy: 0,
        feedEnabled: true,
        feedMode: "error"
      }
    };
  }

  const hints = Array.isArray(snapshot?.tokens) ? snapshot.tokens : [];
  const selected = hints.slice(0, this.maxTelegramSignalCandidates);

  const pairs = [];
  for (const hint of selected) {
    const pair = await this.fetchDexTokenByCA(hint.ca);
    if (pair) pairs.push({ pair, hint });
  }

  const candidates = pairs.map(({ pair, hint }) => {
    const candidate = this.analyzePair(pair);
    candidate.discoveryBucket = "telegram_signals";
    candidate.discoverySource = "telegram_signal_channels";
    candidate.telegramSignal = {
      channelHits: safeNum(hint?.channelHits, 0),
      telegramSignalScore: safeNum(hint?.telegramSignalScore, 0),
      channels: Array.isArray(hint?.channels) ? hint.channels.slice(0, 8) : [],
      newestAgeMin: safeNum(hint?.newestAgeMin, 999999),
      sampleMessages: Array.isArray(hint?.messages)
        ? hint.messages.slice(0, 3).map((x) => ({
            channel: x.channel,
            ageMin: safeNum(x.ageMin, 0),
            text: shortText(x.text, 180)
          }))
        : []
    };

    candidate.reasons = Array.isArray(candidate.reasons) ? candidate.reasons : [];
    candidate.reasons.push(
      \`telegram signal source: \${candidate.telegramSignal.channelHits} channel hits\`
    );

    candidate.score = clamp(
      safeNum(candidate?.score, 0) +
        Math.min(12, safeNum(hint?.channelHits, 0) * 3 + Math.round(safeNum(hint?.telegramSignalScore, 0) / 8)),
      0,
      99
    );

    return candidate;
  });

  return {
    candidates,
    telemetry: {
      telegramSignalRaw: safeNum(snapshot?.telemetry?.rawSignals, hints.length),
      telegramSignalTokens: selected.length,
      telegramSignalAccepted: candidates.length,
      telegramSignalPublishWorthy: 0,
      feedEnabled: true,
      feedMode: asText(snapshot?.telemetry?.mode, "telegram_public_channels")
    }
  };
}
`;

if (!src.includes("async fetchCandidatesFromTelegramChannels()")) {
  const anchor = "  buildLinksMap(links = []) {";
  const idx = src.indexOf(anchor);
  if (idx === -1) fail("Cannot find buildLinksMap anchor");
  src = src.slice(0, idx) + telegramMethod + "\n  " + src.slice(idx);
}

src = replaceOnce(
  src,
  `  const smartWalletResult = await this.fetchCandidatesFromSmartWalletFeed();

  this.lastRadarTelemetry.smartWalletFeedRaw = safeNum(smartWalletResult?.telemetry?.smartWalletFeedRaw, 0);
  this.lastRadarTelemetry.smartWalletTokens = safeNum(smartWalletResult?.telemetry?.smartWalletTokens, 0);
  this.lastRadarTelemetry.smartWalletAccepted = safeNum(smartWalletResult?.telemetry?.smartWalletAccepted, 0);
  this.lastRadarTelemetry.scannedRaw += safeNum(smartWalletResult?.telemetry?.smartWalletFeedRaw, 0);`,
  `  const smartWalletResult = await this.fetchCandidatesFromSmartWalletFeed();
  const telegramSignalResult = await this.fetchCandidatesFromTelegramChannels();

  this.lastRadarTelemetry.smartWalletFeedRaw = safeNum(smartWalletResult?.telemetry?.smartWalletFeedRaw, 0);
  this.lastRadarTelemetry.smartWalletTokens = safeNum(smartWalletResult?.telemetry?.smartWalletTokens, 0);
  this.lastRadarTelemetry.smartWalletAccepted = safeNum(smartWalletResult?.telemetry?.smartWalletAccepted, 0);
  this.lastRadarTelemetry.scannedRaw += safeNum(smartWalletResult?.telemetry?.smartWalletFeedRaw, 0);

  this.lastRadarTelemetry.telegramSignalRaw = safeNum(telegramSignalResult?.telemetry?.telegramSignalRaw, 0);
  this.lastRadarTelemetry.telegramSignalTokens = safeNum(telegramSignalResult?.telemetry?.telegramSignalTokens, 0);
  this.lastRadarTelemetry.telegramSignalAccepted = safeNum(telegramSignalResult?.telemetry?.telegramSignalAccepted, 0);
  this.lastRadarTelemetry.scannedRaw += safeNum(telegramSignalResult?.telemetry?.telegramSignalRaw, 0);`,
  "fetch market telegram result"
);

src = replaceOnce(
  src,
  `  for (const candidate of smartWalletResult?.candidates || []) {
    const ca = asText(candidate?.token?.ca);
    if (!ca) continue;
    this.bumpBucket('smart_wallets', 1);
    if (!byCa.has(ca)) {
      byCa.set(ca, candidate);
      continue;
    }
    const existing = byCa.get(ca);
    existing.discoveryBucket = 'smart_wallets';
    existing.discoverySource = existing.discoverySource === 'dex_search'
      ? 'dex_search+gmgn_smart_wallets'
      : existing.discoverySource;
    existing.smartWalletFeed = candidate.smartWalletFeed;
    existing.score = clamp(Math.max(safeNum(existing.score, 0), safeNum(candidate.score, 0)), 0, 99);
    existing.reasons = [...new Set([...(existing.reasons || []), ...(candidate.reasons || [])])];
    byCa.set(ca, existing);
  }`,
  `  for (const candidate of smartWalletResult?.candidates || []) {
    const ca = asText(candidate?.token?.ca);
    if (!ca) continue;
    this.bumpBucket('smart_wallets', 1);
    if (!byCa.has(ca)) {
      byCa.set(ca, candidate);
      continue;
    }
    const existing = byCa.get(ca);
    existing.discoveryBucket = 'smart_wallets';
    existing.discoverySource = existing.discoverySource === 'dex_search'
      ? 'dex_search+gmgn_smart_wallets'
      : existing.discoverySource;
    existing.smartWalletFeed = candidate.smartWalletFeed;
    existing.score = clamp(Math.max(safeNum(existing.score, 0), safeNum(candidate.score, 0)), 0, 99);
    existing.reasons = [...new Set([...(existing.reasons || []), ...(candidate.reasons || [])])];
    byCa.set(ca, existing);
  }

  for (const candidate of telegramSignalResult?.candidates || []) {
    const ca = asText(candidate?.token?.ca);
    if (!ca) continue;
    this.bumpBucket('telegram_signals', 1);
    if (!byCa.has(ca)) {
      byCa.set(ca, candidate);
      continue;
    }
    const existing = byCa.get(ca);
    existing.discoveryBucket = existing.discoveryBucket === 'smart_wallets'
      ? 'smart_wallets+telegram_signals'
      : 'telegram_signals';
    existing.discoverySource = [existing.discoverySource, 'telegram_signal_channels']
      .filter(Boolean)
      .join('+');
    existing.telegramSignal = candidate.telegramSignal;
    existing.score = clamp(Math.max(safeNum(existing.score, 0), safeNum(candidate.score, 0)), 0, 99);
    existing.reasons = [...new Set([...(existing.reasons || []), ...(candidate.reasons || [])])];
    byCa.set(ca, existing);
  }`,
  "merge telegram candidates"
);

src = replaceOnce(
  src,
  `      smartWalletPublishWorthy: ranked.filter((row) => row?.smartWalletFeed && (row?.packaging?.priorityWatch || row?.reversal?.allow || row?.migration?.passes || row?.migrationAccumulation?.priorityWatch || row?.runnerLike?.allow)).length,`,
  `      smartWalletPublishWorthy: ranked.filter((row) => row?.smartWalletFeed && (row?.packaging?.priorityWatch || row?.reversal?.allow || row?.migration?.passes || row?.migrationAccumulation?.priorityWatch || row?.runnerLike?.allow)).length,
      telegramSignalPublishWorthy: ranked.filter((row) => row?.telegramSignal && (row?.packaging?.priorityWatch || row?.reversal?.allow || row?.migration?.passes || row?.migrationAccumulation?.priorityWatch || row?.runnerLike?.allow)).length,`,
  "publish worthy telemetry"
);

src = replaceOnce(
  src,
  `migration accumulation: ${safeNum(candidate?.migrationAccumulation?.score, 0)} / ${escapeHtml(candidate?.migrationAccumulation?.mode || "-")}
price:`,
  `migration accumulation: ${safeNum(candidate?.migrationAccumulation?.score, 0)} / ${escapeHtml(candidate?.migrationAccumulation?.mode || "-")}
telegram channels: ${safeNum(candidate?.telegramSignal?.channelHits, 0)} | ${escapeHtml((candidate?.telegramSignal?.channels || []).join(", ") || "-")}
price:`,
  "hero telegram line"
);

src = replaceOnce(
  src,
  `🧬 Migration Accumulation:
allow: ${migrationAccumulation?.allow ? "yes" : "no"}`,
  `📣 Telegram Signal Source:
channels: ${safeNum(candidate?.telegramSignal?.channelHits, 0)}
source list: ${escapeHtml((candidate?.telegramSignal?.channels || []).join(", ") || "-")}
age min: ${safeNum(candidate?.telegramSignal?.newestAgeMin, 0).toFixed(1)}

🧬 Migration Accumulation:
allow: ${migrationAccumulation?.allow ? "yes" : "no"}`,
  "analysis telegram block"
);

write(candidatePath, src);
console.log("✅ Telegram signal source patched into CandidateService.");
