import TelegramChannelSource from "./telegram-channel-source.js";
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortText(text, max = 220) {
  const s = asText(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function isSolanaChain(chainId) {
  return String(chainId || "").trim().toLowerCase() === "solana";
}

function dedupeByCA(rows = []) {
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const ca = asText(row?.baseToken?.address || row?.token?.ca || row?.ca);
    if (!ca || seen.has(ca)) continue;
    seen.add(ca);
    out.push(row);
  }

  return out;
}

function sumTxns(txnBlock) {
  return safeNum(txnBlock?.buys, 0) + safeNum(txnBlock?.sells, 0);
}

function buyPressurePct(buys, sells) {
  const b = safeNum(buys, 0);
  const s = safeNum(sells, 0);
  const total = b + s;
  if (total <= 0) return 0;
  return (b / total) * 100;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safeDiv(a, b, fallback = 0) {
  const den = safeNum(b, 0);
  if (den === 0) return fallback;
  return safeNum(a, 0) / den;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export default class CandidateService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.searchQueries = options.searchQueries || [
      "solana meme",
      "pumpfun solana",
      "cto solana",
      "memecoin solana",
      "solana community takeover"
    ];
    this.radarQueryBuckets = options.radarQueryBuckets || {
      fresh: [
        "new pair solana",
        "pump fun solana",
        "pumpfun solana",
        "meteora solana",
        "dbc solana",
        "pumpswap solana"
      ],
      packaging: [
        "solana meme",
        "micro cap solana",
        "solana low cap",
        "cto solana",
        "community takeover solana",
        "bottom accumulation solana"
      ],
      migration: [
        "post migration solana",
        "solana migration",
        "meteora migration solana",
        "pumpswap migration solana"
      ],
      momentum: [
        "solana trending",
        "solana breakout",
        "solana whale buy",
        "solana smart money"
      ],
      forgotten: [
        "old meme solana",
        "solana revival",
        "forgotten meme solana"
      ]
    };
    this.holderAccumulationEngine = options.holderAccumulationEngine || null;
    this.smartWalletFeed = options.smartWalletFeed || null;
    this.telegramChannelSource = options.telegramChannelSource || new TelegramChannelSource({
      logger: this.logger
    });
    this.maxHolderEnrichPerPass = Number(options.maxHolderEnrichPerPass || 8);
    this.maxSmartWalletCandidates = Number(options.maxSmartWalletCandidates || process.env.GMGN_SMART_WALLET_MAX_CANDIDATES || 30);
    this.maxTelegramSignalCandidates = Number(options.maxTelegramSignalCandidates || process.env.TELEGRAM_SIGNAL_MAX_CANDIDATES || 30);

    // External API protection: avoids Dex 429 storms and GMGN 403 hammering.
    this.dexSearchLastFetchAt = 0;
    this.dexTokenLastFetchAt = 0;
    this.dexSearchMinDelayMs = Number(process.env.DEX_SEARCH_MIN_DELAY_MS || 1500);
    this.dexTokenMinDelayMs = Number(process.env.DEX_TOKEN_MIN_DELAY_MS || 1800);
    this.dex429CooldownUntil = 0;
    this.dexSearchCache = new Map();
    this.dexTokenCache = new Map();
    this.dexCacheTtlMs = Number(process.env.DEX_CACHE_TTL_MS || 90_000);
    this.maxDexSearchQueriesPerScan = Number(process.env.MAX_DEX_SEARCH_QUERIES_PER_SCAN || 8);
    this.smartWalletDisabledUntil = 0;
    this.smartWalletFailureCooldownMs = Number(process.env.SMART_WALLET_FAILURE_COOLDOWN_MS || 10 * 60 * 1000);
    this.smartWalletHardDisabled = process.env.GMGN_SMART_WALLET_ENABLED === "false";

    this.defaultTradingMode = this.normalizeTradingMode(
      options.tradingMode ||
      process.env.TRADING_MODE ||
      process.env.TRADING_BEHAVIOR_MODE ||
      "balanced"
    );
    this.lastRadarTelemetry = this.createEmptyRadarTelemetry();
  }

  createEmptyRadarTelemetry() {
    return {
      scannedRaw: 0,
      uniquePairs: 0,
      candidatesAfterAnalysis: 0,
      filteredNoise: 0,
      trapRejected: 0,
      watchlist: 0,
      priorityWatch: 0,
      packagingDetected: 0,
      packagingProbe: 0,
      reversalWatch: 0,
      runnerLike: 0,
      migrationStructure: 0,
      migrationAccumulation: 0,
      deepAnalyzed: 0,
      tradeReady: 0,
      smartWalletFeedRaw: 0,
      smartWalletTokens: 0,
      smartWalletAccepted: 0,
      smartWalletPublishWorthy: 0,
      telegramSignalRaw: 0,
      telegramSignalTokens: 0,
      telegramSignalAccepted: 0,
      telegramSignalPublishWorthy: 0,
      byBucket: {
        fresh: 0,
        packaging: 0,
        migration: 0,
        momentum: 0,
        forgotten: 0,
        smart_wallets: 0,
        telegram_signals: 0
      },
      lastUpdatedAt: new Date().toISOString()
    };
  }

  resetRadarTelemetry() {
    this.lastRadarTelemetry = this.createEmptyRadarTelemetry();
    return this.lastRadarTelemetry;
  }

  getRadarTelemetry() {
    return {
      ...this.lastRadarTelemetry,
      byBucket: { ...(this.lastRadarTelemetry?.byBucket || {}) }
    };
  }

  bumpBucket(bucket, amount = 1) {
    const map = this.lastRadarTelemetry.byBucket || (this.lastRadarTelemetry.byBucket = {});
    map[bucket] = safeNum(map[bucket], 0) + amount;
  }

  normalizeTradingMode(value = "balanced") {
    const mode = String(value || "balanced").toLowerCase().trim();
    if (mode === "aggressive" || mode === "aggro" || mode === "risk") return "aggressive";
    if (mode === "sniper" || mode === "safe" || mode === "strict") return "sniper";
    return "balanced";
  }

  getTradingMode(runtime = null) {
    return this.normalizeTradingMode(
      runtime?.activeConfig?.tradingMode ||
      runtime?.activeConfig?.behaviorMode ||
      process.env.TRADING_MODE ||
      process.env.TRADING_BEHAVIOR_MODE ||
      this.defaultTradingMode ||
      "balanced"
    );
  }

  getTradingModeConfig(modeInput = "balanced") {
    const mode = this.normalizeTradingMode(modeInput);

    if (mode === "aggressive") {
      return {
        mode,
        label: "AGGRESSIVE",
        scoreOffset: 6,
        copytradeMinScore: 64,
        scalpMinScore: 58,
        reversalMinScore: 62,
        runnerMinScore: 78,
        allowSoftVetoProbe: true,
        allowRiskyWatch: true,
        maxAllowedAntiRugRisk: 68,
        forceProbeOnSoftVeto: true
      };
    }

    if (mode === "sniper") {
      return {
        mode,
        label: "SNIPER",
        scoreOffset: -8,
        copytradeMinScore: 82,
        scalpMinScore: 78,
        reversalMinScore: 82,
        runnerMinScore: 90,
        allowSoftVetoProbe: false,
        allowRiskyWatch: false,
        maxAllowedAntiRugRisk: 34,
        forceProbeOnSoftVeto: false
      };
    }

    return {
      mode: "balanced",
      label: "BALANCED",
      scoreOffset: 0,
      copytradeMinScore: 70,
      scalpMinScore: 64,
      reversalMinScore: 68,
      runnerMinScore: 84,
      allowSoftVetoProbe: true,
      allowRiskyWatch: true,
      maxAllowedAntiRugRisk: 54,
      forceProbeOnSoftVeto: true
    };
  }

  applyTradingModeToScore(score, antiRug = {}, modeInput = "balanced") {
    const cfg = this.getTradingModeConfig(modeInput);
    let nextScore = safeNum(score, 0) + safeNum(cfg.scoreOffset, 0);

    if (cfg.mode === "aggressive") {
      if (antiRug?.softVeto) nextScore = Math.min(nextScore, 66);
      else if (safeNum(antiRug?.riskScore, 0) >= 40) nextScore = Math.min(nextScore + 3, 78);
    } else if (cfg.mode === "sniper") {
      if (antiRug?.softVeto || safeNum(antiRug?.riskScore, 0) >= 40) nextScore = Math.min(nextScore, 42);
      if (safeNum(antiRug?.riskScore, 0) > cfg.maxAllowedAntiRugRisk) nextScore = Math.min(nextScore, 35);
    }

    if (antiRug?.hardVeto) nextScore = Math.min(nextScore, 25);

    return clamp(Math.round(nextScore), 0, 99);
  }

  adjustPlanForTradingMode(plan = {}, modeInput = "balanced", candidate = {}) {
    const cfg = this.getTradingModeConfig(modeInput);
    const antiRug = candidate?.antiRug || {};
    const next = { ...plan };

    next.tradingMode = cfg.mode;

    if (antiRug?.softVeto || antiRug?.probeOnly) {
      if (cfg.forceProbeOnSoftVeto) {
        next.entryMode = "PROBE";
        next.thesis = `${next.thesis || "Trade"} | anti-rug probe only`;
        next.expectedEdgePct = Math.max(0, safeNum(next.expectedEdgePct, 0) - 2);
        next.stopLossPct = Math.max(2.8, safeNum(next.stopLossPct, 0) * 0.85);
      }
    }

    if (cfg.mode === "aggressive") {
      next.expectedEdgePct = safeNum(next.expectedEdgePct, 0) + 1;
      if (next.entryMode === "PROBE" && !antiRug?.softVeto) next.entryMode = "SCALED";
    }

    if (cfg.mode === "sniper") {
      next.entryMode = next.entryMode === "FULL" ? "SCALED" : next.entryMode;
      next.expectedEdgePct = safeNum(next.expectedEdgePct, 0) + 2;
      next.stopLossPct = Math.max(2.5, safeNum(next.stopLossPct, 0) * 0.9);
    }

    return next;
  }

  classifyRadarBucket(token = {}) {
    const pairCreatedAt = safeNum(token?.pairCreatedAt, 0);
    const pairAgeMin = pairCreatedAt > 0 ? Math.max(0, (Date.now() - pairCreatedAt) / 60000) : 99999;
    const fdv = safeNum(token?.fdv, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
    const priceH1 = safeNum(token?.priceChangeH1, 0);

    if (pairAgeMin <= 180) return "fresh";
    if (fdv >= 30000 && fdv <= 120000) return "migration";
    if (pairAgeMin <= 14400 && fdv >= 5000 && fdv <= 50000) return "packaging";
    if (volumeH1 >= 15000 || txnsH1 >= 200 || priceH1 >= 18) return "momentum";
    return "forgotten";
  }

  isNoiseCandidate(candidate = {}) {
    const token = candidate?.token || {};
    const fdv = safeNum(token?.fdv, 0);
    const liquidity = safeNum(token?.liquidity, 0);
    const volumeH24 = safeNum(token?.volumeH24, token?.volume, 0);
    const txnsH24 = safeNum(token?.txnsH24, token?.txns, 0);
    const rugRisk = safeNum(candidate?.rug?.risk, 0);

    if (candidate?.antiRug?.hardVeto) return true;
    if (rugRisk >= 80) return true;
    if (candidate?.corpse?.isCorpse && liquidity < 12000) return true;
    if (fdv < 5000 && liquidity < 5000) return true;
    if (volumeH24 < 5000 && txnsH24 < 35) return true;
    return false;
  }

  buildPackagingSignals(candidate = {}) {
    const token = candidate?.token || {};
    const holder = candidate?.holderAccumulation || {};
    const migration = candidate?.migration || {};

    const fdv = safeNum(token?.fdv, 0);
    const pairAgeMin = safeNum(migration?.pairAgeMin, 0);
    const retention30m = safeNum(holder?.retention30mPct, 0);
    const retention2h = safeNum(holder?.retention2hPct, 0);
    const retention6h = safeNum(holder?.historicalRetention6hPct, 0);
    const netControlPct = safeNum(holder?.netControlPct, 0);
    const netAccumulationPct = safeNum(holder?.netAccumulationPct, 0);
    const freshWalletBuyCount = safeNum(holder?.freshWalletBuyCount, 0);
    const reloadCount = safeNum(holder?.reloadCount, 0);
    const bottomTouches = safeNum(holder?.bottomTouches, 0);
    const cohortArchetype = asText(holder?.cohortArchetype, "");

    const mcPackagingWindow = fdv >= 5000 && fdv <= 50000;
    const migrationWindow = fdv >= 30000 && fdv <= 120000;
    const ageOk = pairAgeMin >= 30 && pairAgeMin <= 14400;
    const quietAccumulation = Boolean(holder?.quietAccumulationPass);
    const bottomPack = Boolean(holder?.bottomPackReversalPass);
    const warehouseLike = cohortArchetype === "warehouse_storage" || quietAccumulation;

    let score = 0;
    if (mcPackagingWindow) score += 18;
    if (migrationWindow) score += 10;
    if (ageOk) score += 8;
    if (freshWalletBuyCount >= 10) score += 14;
    if (freshWalletBuyCount >= 16) score += 6;
    if (retention30m >= 55) score += 12;
    if (retention2h >= 35) score += 12;
    if (retention6h >= 12) score += 8;
    if (netAccumulationPct >= 55) score += 10;
    if (netControlPct >= 35) score += 12;
    if (netControlPct >= 55) score += 10;
    if (bottomTouches >= 3) score += 8;
    if (warehouseLike) score += 8;
    if (bottomPack) score += 14;
    if (reloadCount >= 2) score += 4;
    if (safeNum(candidate?.rug?.risk, 0) >= 65) score -= 14;
    if (safeNum(candidate?.delta?.priceH1Pct, 0) > 40) score -= 10;

    const detected = score >= 46 && warehouseLike && freshWalletBuyCount >= 8;
    const priorityWatch = detected && (netControlPct >= 45 || retention2h >= 35 || bottomPack);
    const probeEligible = detected && priorityWatch && netControlPct >= 55 && retention30m >= 55 && !candidate?.corpse?.isCorpse;

    return {
      detected,
      priorityWatch,
      probeEligible,
      score: clamp(Math.round(score), 0, 99),
      mcPackagingWindow,
      migrationWindow,
      warehouseLike,
      quietAccumulation,
      bottomPack,
      comment: warehouseLike
        ? "warehouse-style packaging / storage cohort behavior"
        : "watchlist packaging structure"
    };
  }

  buildRunnerLikeSignals(candidate = {}) {
    const token = candidate?.token || {};
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, safeNum(token?.priceChangeH1, 0));
    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, safeNum(token?.priceChangeH6, 0));
    const priceH24 = safeNum(candidate?.delta?.priceH24Pct, safeNum(token?.priceChangeH24, 0));
    const volToLiq = safeNum(candidate?.migration?.volToLiqPct, 0);
    const linearityRisk = priceH1 > 18 && priceH6 > 45 && priceH24 > 80;
    const allow = Boolean(linearityRisk || (priceH1 > 10 && volToLiq > 80 && safeNum(candidate?.absorption?.score, 0) >= 8));

    return {
      allow,
      linearityRisk,
      score: clamp(Math.round((Math.max(priceH1, 0) * 0.4) + (Math.max(priceH6, 0) * 0.2) + safeNum(candidate?.absorption?.score, 0)), 0, 99)
    };
  }



  buildAntiRugIntel(candidate = {}) {
    const token = candidate?.token || {};
    const holder = candidate?.holderAccumulation || {};
    const walletCluster = holder?.walletCluster || {};
    const migration = candidate?.migration || {};
    const scalp = candidate?.scalp || {};
    const reversal = candidate?.reversal || {};

    const liquidity = safeNum(token?.liquidity, 0);
    const fdv = safeNum(token?.fdv, 0);
    const volumeH24 = safeNum(token?.volumeH24, token?.volume, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const volumeM5 = safeNum(token?.volumeM5, 0);
    const txnsH24 = safeNum(token?.txnsH24, token?.txns, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
    const txnsM5 = safeNum(token?.txnsM5, 0);

    const priceM5 = safeNum(token?.priceChangeM5, safeNum(candidate?.delta?.priceM5Pct, 0));
    const priceH1 = safeNum(token?.priceChangeH1, safeNum(candidate?.delta?.priceH1Pct, 0));
    const priceH6 = safeNum(token?.priceChangeH6, safeNum(candidate?.delta?.priceH6Pct, 0));
    const priceH24 = safeNum(token?.priceChangeH24, safeNum(candidate?.delta?.priceH24Pct, 0));

    const rugRisk = safeNum(candidate?.rug?.risk, 0);
    const corpseScore = safeNum(candidate?.corpse?.score, 0);
    const botActivity = safeNum(candidate?.bots?.botActivity, 0);
    const concentration = safeNum(candidate?.wallet?.concentration, 0);
    const distribution = safeNum(candidate?.distribution?.score, 0);
    const absorption = safeNum(candidate?.absorption?.score, 0);
    const accumulation = safeNum(candidate?.accumulation?.score, 0);

    const retention30m = safeNum(holder?.retention30mPct, 0);
    const retention2h = safeNum(holder?.retention2hPct, 0);
    const retention6h = safeNum(holder?.historicalRetention6hPct, 0);
    const netControlPct = safeNum(holder?.netControlPct, 0);
    const netAccumulationPct = safeNum(holder?.netAccumulationPct, 0);
    const freshWalletBuyCount = safeNum(holder?.freshWalletBuyCount, 0);
    const reloadCount = safeNum(holder?.reloadCount, 0);
    const quietAccumulation = Boolean(holder?.quietAccumulationPass);
    const warehouseStorage = Boolean(holder?.warehouseStoragePass);
    const bottomPack = Boolean(holder?.bottomPackReversalPass);
    const walletClusterRiskScore = safeNum(walletCluster?.clusterRiskScore, 0);
    const youngSupplyPct = safeNum(walletCluster?.youngSupplyPct, 0);
    const sameDayClusterCount = safeNum(walletCluster?.sameDayClusterCount, 0);
    const sameDayClusterSupplyPct = safeNum(walletCluster?.sameDayClusterSupplyPct, 0);
    const sameBuyWindowClusterCount = safeNum(walletCluster?.sameBuyWindowClusterCount, 0);

    const socialCount = safeNum(candidate?.socials?.socialCount, 0);
    const liqToMcapPct = fdv > 0 ? (liquidity / Math.max(fdv, 1)) * 100 : 0;
    const volToLiqPct = liquidity > 0 ? (volumeH24 / Math.max(liquidity, 1)) * 100 : 0;
    const isPumpAddress = String(token?.ca || '').toLowerCase().endsWith('pump');

    const reasons = [];
    const warnings = [];
    let riskScore = 0;
    let protectionScore = 0;

    if (liquidity < 5000) {
      riskScore += 30;
      reasons.push('critical liquidity under $5k');
    } else if (liquidity < 10000) {
      riskScore += 18;
      reasons.push('thin liquidity under $10k');
    }

    if (fdv >= 100000 && liquidity < 12000) {
      riskScore += 22;
      reasons.push('high FDV on thin liquidity');
    }

    if (fdv >= 500000 && liquidity < 30000) {
      riskScore += 24;
      reasons.push('six-figure+ FDV with fragile liquidity');
    }

    if (fdv > 0 && liqToMcapPct < 4 && fdv >= 80000) {
      riskScore += 22;
      reasons.push('liquidity/MC ratio critically weak');
    } else if (fdv > 0 && liqToMcapPct < 8 && fdv >= 80000) {
      riskScore += 14;
      warnings.push('liquidity/MC ratio weak');
    }

    if (volumeH24 > liquidity * 12 && liquidity < 20000) {
      riskScore += 20;
      reasons.push('oversized churn on thin liquidity');
    }

    if (volumeH24 > liquidity * 20 && liquidity < 30000) {
      riskScore += 16;
      reasons.push('extreme volume/liquidity churn');
    }

    if (txnsH24 > 2500 && liquidity < 12000) {
      riskScore += 18;
      reasons.push('too many transactions for weak liquidity');
    }

    if (priceH24 < -65 && volumeH24 > 50000) {
      riskScore += 24;
      reasons.push('major collapse with remaining churn');
    }

    if (priceH6 < -45 && priceH1 <= 5) {
      riskScore += 18;
      reasons.push('post-dump weak recovery');
    }

    if (priceM5 > 15 && txnsH1 < 80 && volumeH1 < 10000) {
      riskScore += 14;
      reasons.push('sharp micro pump without enough participation');
    }

    if (volumeM5 > 0 && txnsM5 <= 3 && priceM5 > 8) {
      riskScore += 10;
      warnings.push('micro candle with too few participants');
    }

    if (corpseScore >= 65) {
      riskScore += 26;
      reasons.push('corpse score critical');
    } else if (corpseScore >= 45) {
      riskScore += 14;
      warnings.push('corpse score elevated');
    }

    if (rugRisk >= 70) {
      riskScore += 24;
      reasons.push('rug risk critical');
    } else if (rugRisk >= 55) {
      riskScore += 12;
      warnings.push('rug risk elevated');
    }

    if (botActivity >= 55) {
      riskScore += 18;
      reasons.push('bot activity elevated');
    }

    if (concentration >= 55) {
      riskScore += 14;
      reasons.push('holder concentration proxy high');
    }

    if (distribution > accumulation + 15 && distribution > absorption + 15) {
      riskScore += 18;
      reasons.push('distribution dominates accumulation');
    }

    if (walletClusterRiskScore >= 70) {
      riskScore += 28;
      reasons.push('wallet cluster risk high');
    } else if (walletClusterRiskScore >= 45) {
      riskScore += 18;
      reasons.push('wallet cluster risk medium');
    } else if (walletClusterRiskScore >= 25) {
      riskScore += 8;
      warnings.push('wallet cluster watch');
    }

    if (youngSupplyPct >= 45 && sameDayClusterCount >= 5) {
      riskScore += 26;
      reasons.push('young same-day wallet cluster controls large supply');
    }

    if (sameDayClusterSupplyPct >= 30 && sameBuyWindowClusterCount >= 4) {
      riskScore += 20;
      reasons.push('same-day and same-buy-window holder coordination');
    }

    if (socialCount === 0 && liquidity < 15000 && fdv > 30000) {
      riskScore += 14;
      warnings.push('no socials with fragile structure');
    }

    if (isPumpAddress && priceH24 < -55 && liquidity < 18000) {
      riskScore += 12;
      warnings.push('pump-style post-collapse structure');
    }

    if (quietAccumulation) {
      protectionScore += 12;
      warnings.push('quiet accumulation softens risk');
    }

    if (warehouseStorage) {
      protectionScore += 12;
      warnings.push('warehouse storage softens risk');
    }

    if (bottomPack) {
      protectionScore += 10;
      warnings.push('bottom-pack reversal softens risk');
    }

    if (retention30m >= 55) protectionScore += 8;
    if (retention2h >= 35) protectionScore += 8;
    if (retention6h >= 12) protectionScore += 4;
    if (netControlPct >= 45) protectionScore += 10;
    if (netAccumulationPct >= 55) protectionScore += 8;
    if (freshWalletBuyCount >= 12) protectionScore += 6;
    if (reloadCount >= 2) protectionScore += 3;
    if (safeNum(migration?.passes, false)) protectionScore += 7;
    if (safeNum(scalp?.score, 0) >= 70 && priceM5 <= 10) protectionScore += 4;
    if (safeNum(reversal?.score, 0) >= 70) protectionScore += 5;

    const adjustedRisk = clamp(Math.round(riskScore - protectionScore), 0, 100);

    const hardVeto =
      adjustedRisk >= 72 ||
      (liquidity < 5000 && fdv >= 50000) ||
      (priceH24 < -80 && liquidity < 20000) ||
      (corpseScore >= 75 && rugRisk >= 55) ||
      (volumeH24 > liquidity * 25 && liquidity < 10000) ||
      (youngSupplyPct >= 45 && sameDayClusterCount >= 5 && priceH1 > 0) ||
      (walletClusterRiskScore >= 82 && priceH1 > 0);

    const softVeto =
      !hardVeto &&
      (
        adjustedRisk >= 55 ||
        (rugRisk >= 60 && liquidity < 15000) ||
        (volumeH24 > liquidity * 15 && liquidity < 25000)
      );

    const verdict =
      hardVeto ? 'HARD_BLOCK' :
      softVeto ? 'SOFT_BLOCK' :
      adjustedRisk >= 40 ? 'RISKY' :
      adjustedRisk >= 22 ? 'WATCH' :
      'CLEAN';

    return {
      verdict,
      riskScore: adjustedRisk,
      rawRiskScore: clamp(Math.round(riskScore), 0, 100),
      protectionScore: clamp(Math.round(protectionScore), 0, 100),
      hardVeto,
      softVeto,
      tradeBlocked: hardVeto,
      probeOnly: softVeto,
      liqToMcapPct,
      volToLiqPct,
      reasons,
      warnings
    };
  }

    async waitForDexSlot(kind = "search") {
    const isToken = kind === "token";
    const minDelay = isToken ? this.dexTokenMinDelayMs : this.dexSearchMinDelayMs;
    const key = isToken ? "dexTokenLastFetchAt" : "dexSearchLastFetchAt";
    const now = Date.now();

    if (this.dex429CooldownUntil && now < this.dex429CooldownUntil) {
      await sleepMs(this.dex429CooldownUntil - now);
    }

    const elapsed = Date.now() - safeNum(this[key], 0);
    if (elapsed < minDelay) {
      await sleepMs(minDelay - elapsed);
    }

    this[key] = Date.now();
  }

  getCache(map, key) {
    const row = map.get(key);
    if (!row) return null;
    if (Date.now() - safeNum(row.ts, 0) > this.dexCacheTtlMs) {
      map.delete(key);
      return null;
    }
    return row.value;
  }

  setCache(map, key, value) {
    map.set(key, { ts: Date.now(), value });
    return value;
  }

  async fetchJsonWithProtection(url, { kind = "search", cacheKey = "" } = {}) {
    const cacheMap = kind === "token" ? this.dexTokenCache : this.dexSearchCache;
    if (cacheKey) {
      const cached = this.getCache(cacheMap, cacheKey);
      if (cached) return cached;
    }

    await this.waitForDexSlot(kind);

    let res;
    try {
      res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "ChiikawaTradingBot/1.0"
        }
      });
    } catch (error) {
      this.logger.log("dex fetch network failed:", error.message);
      return null;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers?.get?.("retry-after") || 0);
      const cooldownMs = retryAfter > 0 ? retryAfter * 1000 : Number(process.env.DEX_429_COOLDOWN_MS || 60_000);
      this.dex429CooldownUntil = Date.now() + cooldownMs;
      this.logger.log(`dex rate limited 429. cooling down ${cooldownMs}ms`);
      return null;
    }

    if (!res.ok) {
      this.logger.log(`dex fetch failed HTTP ${res.status}: ${url}`);
      return null;
    }

    const json = await res.json().catch((error) => {
      this.logger.log("dex json parse failed:", error.message);
      return null;
    });

    if (cacheKey && json) this.setCache(cacheMap, cacheKey, json);
    return json;
  }

  async fetchDexSearch(query) {
    const q = asText(query);
    if (!q) return [];

    try {
      const url = `https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(q)}`;
      const json = await this.fetchJsonWithProtection(url, {
        kind: "search",
        cacheKey: `search:${q}`
      });
      if (!json) return [];
      const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
      return pairs.filter((p) => isSolanaChain(p?.chainId));
    } catch (error) {
      this.logger.log("candidate-service search failed:", error.message);
      return [];
    }
  }


async fetchDexTokenByCA(ca) {
  const tokenAddress = asText(ca);
  if (!tokenAddress) return null;

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`;
    const json = await this.fetchJsonWithProtection(url, {
      kind: "token",
      cacheKey: `token:${tokenAddress}`
    });
    if (!json) return null;
    const pairs = (Array.isArray(json?.pairs) ? json.pairs : []).filter((p) => isSolanaChain(p?.chainId));
    if (!pairs.length) return null;
    return pairs.sort((a, b) =>
      safeNum(b?.liquidity?.usd, 0) - safeNum(a?.liquidity?.usd, 0) ||
      safeNum(b?.volume?.h24, 0) - safeNum(a?.volume?.h24, 0)
    )[0] || null;
  } catch (error) {
    this.logger.log('candidate-service token fetch failed:', error.message);
    return null;
  }
}

async fetchCandidatesFromSmartWalletFeed() {
  if (
    this.smartWalletHardDisabled ||
    !this.smartWalletFeed ||
    typeof this.smartWalletFeed.fetchTokenHints !== 'function' ||
    Date.now() < safeNum(this.smartWalletDisabledUntil, 0)
  ) {
    return {
      candidates: [],
      telemetry: {
        smartWalletFeedRaw: 0,
        smartWalletTokens: 0,
        smartWalletAccepted: 0,
        smartWalletPublishWorthy: 0,
        feedEnabled: !this.smartWalletHardDisabled,
        feedMode: this.smartWalletHardDisabled ? 'disabled_by_env' : 'cooldown_or_disabled'
      }
    };
  }

  let snapshot;
  try {
    snapshot = await this.smartWalletFeed.fetchTokenHints();
  } catch (error) {
    const msg = String(error?.message || error || "");
    this.logger.log('smart-wallet feed failed:', msg);
    if (msg.includes("403") || msg.includes("429") || msg.includes("Too Many Requests")) {
      this.smartWalletDisabledUntil = Date.now() + this.smartWalletFailureCooldownMs;
      this.logger.log(`smart-wallet feed cooldown for ${this.smartWalletFailureCooldownMs}ms`);
    }
    return {
      candidates: [],
      telemetry: {
        smartWalletFeedRaw: 0,
        smartWalletTokens: 0,
        smartWalletAccepted: 0,
        smartWalletPublishWorthy: 0,
        feedEnabled: true,
        feedMode: 'error_cooldown'
      }
    };
  }

  const hints = Array.isArray(snapshot?.tokens) ? snapshot.tokens : [];
  const deduped = [];
  const seen = new Set();

  for (const row of hints) {
    const ca = asText(row?.ca || row?.tokenAddress || row?.address);
    if (!ca || seen.has(ca)) continue;
    seen.add(ca);
    deduped.push({
      ...row,
      ca,
      walletHits: safeNum(row?.walletHits, 0),
      smartWalletScore: safeNum(row?.smartWalletScore, 0),
      source: asText(row?.source, 'gmgn_smart_wallets')
    });
  }

  deduped.sort((a, b) =>
    safeNum(b?.smartWalletScore, 0) - safeNum(a?.smartWalletScore, 0) ||
    safeNum(b?.walletHits, 0) - safeNum(a?.walletHits, 0)
  );

  const selected = deduped.slice(0, this.maxSmartWalletCandidates);
  const pairs = [];
  for (const hint of selected) {
    const pair = await this.fetchDexTokenByCA(hint.ca);
    if (pair) pairs.push({ pair, hint });
  }

  const candidates = pairs.map(({ pair, hint }) => {
    const candidate = this.analyzePair(pair);
    candidate.discoveryBucket = 'smart_wallets';
    candidate.discoverySource = 'gmgn_smart_wallets';
    candidate.smartWalletFeed = {
      walletHits: safeNum(hint?.walletHits, 0),
      smartWalletScore: safeNum(hint?.smartWalletScore, 0),
      source: asText(hint?.source, 'gmgn_smart_wallets'),
      sampleWallets: Array.isArray(hint?.sampleWallets) ? hint.sampleWallets.slice(0, 6) : []
    };
    candidate.reasons = Array.isArray(candidate.reasons) ? candidate.reasons : [];
    if (candidate.smartWalletFeed.walletHits > 0) {
      candidate.reasons.push(`gmgn smart-wallet feed ${candidate.smartWalletFeed.walletHits} wallet hits`);
    } else {
      candidate.reasons.push('gmgn smart-wallet proxy feed');
    }
    candidate.score = clamp(
      safeNum(candidate?.score, 0) + Math.min(10, safeNum(hint?.walletHits, 0) * 2 + Math.round(safeNum(hint?.smartWalletScore, 0) / 20)),
      0,
      99
    );
    return candidate;
  });

  return {
    candidates,
    telemetry: {
      smartWalletFeedRaw: safeNum(snapshot?.telemetry?.rawRecords, hints.length),
      smartWalletTokens: selected.length,
      smartWalletAccepted: candidates.length,
      smartWalletPublishWorthy: 0,
      feedEnabled: true,
      feedMode: asText(snapshot?.telemetry?.mode, 'mixed')
    }
  };
}

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
    if (pair) {
      pairs.push({
        pair,
        hint
      });
    }
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
      `telegram signal source: ${candidate.telegramSignal.channelHits} channel hits`
    );

    candidate.score = clamp(
      safeNum(candidate?.score, 0) +
        Math.min(
          12,
          safeNum(hint?.channelHits, 0) * 3 +
            Math.round(safeNum(hint?.telegramSignalScore, 0) / 8)
        ),
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

  buildLinksMap(links = []) {
    const map = {
      twitter: "",
      telegram: "",
      website: "",
      instagram: "",
      tiktok: "",
      youtube: ""
    };

    for (const row of links) {
      const type = asText(row?.type).toLowerCase();
      const url = asText(row?.url);
      if (!url) continue;

      if (type === "x" && !map.twitter) {
        map.twitter = url;
        continue;
      }

      if (type in map && !map[type]) {
        map[type] = url;
      }
    }

    return map;
  }

  extractLinksFromPair(pair) {
    const socials = Array.isArray(pair?.info?.socials) ? pair.info.socials : [];
    const websites = Array.isArray(pair?.info?.websites) ? pair.info.websites : [];

    return [
      ...socials.map((x) => ({ type: x?.type || "", url: x?.url || "" })),
      ...websites.map((x) => ({ type: "website", url: x?.url || "" }))
    ];
  }

  toTokenFromPair(pair) {
    const links = this.extractLinksFromPair(pair);

    const txnsM5 = sumTxns(pair?.txns?.m5);
    const txnsH1 = sumTxns(pair?.txns?.h1);
    const txnsH6 = sumTxns(pair?.txns?.h6);
    const txnsH24 = sumTxns(pair?.txns?.h24);

    return {
      name: asText(pair?.baseToken?.name, "UNKNOWN"),
      symbol: asText(pair?.baseToken?.symbol, ""),
      ca: asText(pair?.baseToken?.address, ""),
      pairAddress: asText(pair?.pairAddress, ""),
      chainId: asText(pair?.chainId, ""),
      dexId: asText(pair?.dexId, ""),
      price: safeNum(pair?.priceUsd, 0),
      liquidity: safeNum(pair?.liquidity?.usd, 0),
      volume: safeNum(pair?.volume?.h24, 0),
      volumeM5: safeNum(pair?.volume?.m5, 0),
      volumeH1: safeNum(pair?.volume?.h1, 0),
      volumeH6: safeNum(pair?.volume?.h6, 0),
      volumeH24: safeNum(pair?.volume?.h24, 0),
      buys: safeNum(pair?.txns?.h24?.buys, 0),
      sells: safeNum(pair?.txns?.h24?.sells, 0),
      buysM5: safeNum(pair?.txns?.m5?.buys, 0),
      sellsM5: safeNum(pair?.txns?.m5?.sells, 0),
      buysH1: safeNum(pair?.txns?.h1?.buys, 0),
      sellsH1: safeNum(pair?.txns?.h1?.sells, 0),
      buysH6: safeNum(pair?.txns?.h6?.buys, 0),
      sellsH6: safeNum(pair?.txns?.h6?.sells, 0),
      txns: txnsH24,
      txnsM5,
      txnsH1,
      txnsH6,
      txnsH24,
      fdv: safeNum(pair?.fdv, 0),
      pairCreatedAt: safeNum(pair?.pairCreatedAt, 0),
      url: asText(pair?.url, ""),
      imageUrl: pair?.info?.imageUrl || null,
      description: asText(pair?.info?.description || pair?.info?.header, ""),
      priceChangeM5: safeNum(pair?.priceChange?.m5, 0),
      priceChangeH1: safeNum(pair?.priceChange?.h1, 0),
      priceChangeH6: safeNum(pair?.priceChange?.h6, 0),
      priceChangeH24: safeNum(pair?.priceChange?.h24, 0),
      links
    };
  }

  computeBaseScore(token, extra = {}) {
    let score = 0;

    const liquidity = safeNum(token?.liquidity, 0);
    const volumeH24 = safeNum(token?.volumeH24, token?.volume, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const txnsH24 = safeNum(token?.txnsH24, token?.txns, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
    const fdv = safeNum(token?.fdv, 0);
    const socialCount = safeNum(extra?.socialCount, 0);
    const priceH1 = safeNum(token?.priceChangeH1, 0);
    const priceM5 = safeNum(token?.priceChangeM5, 0);
    const buyPressureH24 = safeNum(extra?.buyPressureH24, 0);
    const buyPressureH1 = safeNum(extra?.buyPressureH1, 0);
    const buyPressureM5 = safeNum(extra?.buyPressureM5, 0);

    if (liquidity >= 8000) score += 10;
    if (liquidity >= 15000) score += 10;
    if (liquidity >= 30000) score += 8;
    if (liquidity >= 60000) score += 6;

    if (volumeH24 >= 15000) score += 8;
    if (volumeH24 >= 50000) score += 8;
    if (volumeH24 >= 150000) score += 6;

    if (volumeH1 >= 4000) score += 5;
    if (volumeH1 >= 12000) score += 5;

    if (txnsH24 >= 80) score += 7;
    if (txnsH24 >= 250) score += 6;
    if (txnsH24 >= 600) score += 5;

    if (txnsH1 >= 50) score += 5;
    if (txnsH1 >= 120) score += 4;

    if (socialCount >= 1) score += 5;
    if (socialCount >= 2) score += 5;
    if (socialCount >= 3) score += 4;

    if (fdv > 0 && liquidity > 0) {
      const ratio = fdv / Math.max(liquidity, 1);
      if (ratio <= 8) score += 7;
      else if (ratio <= 14) score += 3;
      else if (ratio > 22) score -= 7;
    }

    if (buyPressureH24 >= 52) score += 4;
    if (buyPressureH1 >= 54) score += 5;
    if (buyPressureM5 >= 56) score += 4;

    if (priceH1 > 0 && priceH1 <= 22) score += 4;
    if (priceH1 > 45) score -= 5;
    if (priceM5 > 12) score -= 3;

    return clamp(Math.round(score), 0, 99);
  }

  buildMigrationSignals(token, extra = {}) {
    const now = Date.now();
    const pairCreatedAt = safeNum(token?.pairCreatedAt, 0);
    const pairAgeMin = pairCreatedAt > 0 ? Math.max(0, (now - pairCreatedAt) / 60000) : 99999;

    const liquidity = safeNum(token?.liquidity, 0);
    const volume = safeNum(token?.volumeH24, token?.volume, 0);
    const txns = safeNum(token?.txnsH24, token?.txns, 0);
    const fdv = safeNum(token?.fdv, 0);
    const socialCount = safeNum(extra?.socialCount, 0);
    const buyPressure = safeNum(extra?.buyPressureH24, 0);
    const priceDeltaPct = safeNum(extra?.priceDeltaPct, 0);

    const liqToMcapPct = fdv > 0 ? (liquidity / Math.max(fdv, 1)) * 100 : 0;
    const volToLiqPct = liquidity > 0 ? (volume / Math.max(liquidity, 1)) * 100 : 0;

    let survivorScore = 0;

    if (pairAgeMin >= 10 && pairAgeMin <= 120) survivorScore += 18;
    else if (pairAgeMin >= 5 && pairAgeMin <= 180) survivorScore += 10;

    if (liquidity >= 15000) survivorScore += 14;
    if (liquidity >= 25000) survivorScore += 8;

    if (volume >= 15000) survivorScore += 10;
    if (volume >= 50000) survivorScore += 8;

    if (txns >= 100) survivorScore += 8;
    if (txns >= 300) survivorScore += 6;

    if (fdv >= 25000 && fdv <= 250000) survivorScore += 12;
    else if (fdv >= 15000 && fdv <= 400000) survivorScore += 6;

    if (liqToMcapPct >= 20) survivorScore += 8;
    if (volToLiqPct >= 25) survivorScore += 8;
    if (buyPressure >= 52) survivorScore += 6;
    if (priceDeltaPct >= 8 && priceDeltaPct <= 140) survivorScore += 8;
    if (socialCount >= 1) survivorScore += 4;

    const inAgeWindow = pairAgeMin >= 10 && pairAgeMin <= 180;
    const retainedLiquidity = liquidity >= 15000;
    const retainedFlow = volume >= 15000 && txns >= 100;
    const mcapWindow = fdv >= 25000 && fdv <= 250000;
    const demandHealthy = buyPressure >= 50 && volToLiqPct >= 20;

    const passes =
      inAgeWindow &&
      retainedLiquidity &&
      retainedFlow &&
      mcapWindow &&
      demandHealthy &&
      survivorScore >= 50;

    return {
      pairAgeMin,
      liqToMcapPct,
      volToLiqPct,
      survivorScore,
      inAgeWindow,
      retainedLiquidity,
      retainedFlow,
      mcapWindow,
      demandHealthy,
      passes
    };
  }

  buildScalpSignals(token, extra = {}) {
    const liquidity = safeNum(token?.liquidity, 0);
    const volumeM5 = safeNum(token?.volumeM5, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const volumeH6 = safeNum(token?.volumeH6, 0);
    const volumeH24 = safeNum(token?.volumeH24, token?.volume, 0);

    const txnsM5 = safeNum(token?.txnsM5, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
    const txnsH6 = safeNum(token?.txnsH6, 0);
    const txnsH24 = safeNum(token?.txnsH24, token?.txns, 0);

    const priceM5 = safeNum(token?.priceChangeM5, 0);
    const priceH1 = safeNum(token?.priceChangeH1, 0);
    const priceH6 = safeNum(token?.priceChangeH6, 0);
    const priceH24 = safeNum(token?.priceChangeH24, 0);

    const buyPressureM5 = safeNum(extra?.buyPressureM5, 0);
    const buyPressureH1 = safeNum(extra?.buyPressureH1, 0);
    const buyPressureH24 = safeNum(extra?.buyPressureH24, 0);

    const socialCount = safeNum(extra?.socialCount, 0);
    const rugRisk = safeNum(extra?.rugRisk, 0);
    const developerVerdict = asText(extra?.developerVerdict, "Neutral");

    const pairAgeMin = safeNum(extra?.pairAgeMin, 99999);
    const migration = extra?.migration || {};

    const volToLiqM5 = liquidity > 0 ? (volumeM5 / Math.max(liquidity, 1)) * 100 : 0;
    const volToLiqH1 = liquidity > 0 ? (volumeH1 / Math.max(liquidity, 1)) * 100 : 0;
    const volToLiqH24 = liquidity > 0 ? (volumeH24 / Math.max(liquidity, 1)) * 100 : 0;

    const notScamEnough =
      rugRisk < 60 &&
      developerVerdict !== "Bad" &&
      liquidity >= 10000;

    const burstAttention =
      volumeH1 >= 5000 ||
      volumeH24 >= 60000 ||
      txnsH1 >= 80 ||
      txnsH24 >= 500 ||
      volToLiqH1 >= 25;

    const burstDemand =
      buyPressureH1 >= 54 ||
      buyPressureM5 >= 56;

    const burstPriceHealthy =
      priceM5 > -3 &&
      priceM5 <= 10 &&
      priceH1 > -8 &&
      priceH1 <= 28 &&
      priceH24 <= 140;

    let hypeBurstScore = 0;
    if (burstAttention) hypeBurstScore += 24;
    if (burstDemand) hypeBurstScore += 20;
    if (burstPriceHealthy) hypeBurstScore += 16;
    if (liquidity >= 15000) hypeBurstScore += 10;
    if (socialCount >= 1) hypeBurstScore += 8;
    if (txnsM5 >= 15) hypeBurstScore += 6;
    if (volToLiqH1 >= 35) hypeBurstScore += 8;
    if (priceM5 > 12 || priceH1 > 35) hypeBurstScore -= 14;

    const hypeBurstPass =
      notScamEnough &&
      burstAttention &&
      burstDemand &&
      burstPriceHealthy &&
      hypeBurstScore >= 58;

    const migrationFlush =
      priceH6 <= -8 ||
      priceH24 <= -15;

    const migrationReclaim =
      priceM5 > 0 &&
      (buyPressureM5 >= 58 || buyPressureH1 >= 55);

    const migrationFlowAlive =
      safeNum(migration?.retainedLiquidity, false) ||
      (liquidity >= 15000 && volumeH1 >= 3000 && txnsH1 >= 45);

    let migrationReboundScore = 0;
    if (safeNum(migration?.retainedLiquidity, false)) migrationReboundScore += 15;
    if (safeNum(migration?.retainedFlow, false)) migrationReboundScore += 15;
    if (safeNum(migration?.demandHealthy, false)) migrationReboundScore += 12;
    if (migrationFlush) migrationReboundScore += 12;
    if (migrationReclaim) migrationReboundScore += 18;
    if (volumeH1 >= 4000) migrationReboundScore += 8;
    if (txnsH1 >= 40) migrationReboundScore += 6;
    if (buyPressureM5 >= 60) migrationReboundScore += 8;

    const migrationReboundPass =
      notScamEnough &&
      migrationFlowAlive &&
      migrationFlush &&
      migrationReclaim &&
      migrationReboundScore >= 56;

    const volatilityHigh =
      Math.abs(priceH1) >= 8 ||
      Math.abs(priceH6) >= 18 ||
      volToLiqH24 >= 70 ||
      txnsH1 >= 100;

    const formingBottom =
      priceH6 < 0 &&
      priceH1 > -8 &&
      priceM5 > 0;

    const reclaimPressure =
      buyPressureM5 >= 58 &&
      (buyPressureM5 >= buyPressureH1 || buyPressureH1 >= 52);

    const accumulationSigns =
      txnsM5 >= 12 ||
      txnsH1 >= 60 ||
      volumeM5 >= 1200 ||
      volumeH1 >= 5000;

    let volatilityReclaimScore = 0;
    if (pairAgeMin <= 10080) volatilityReclaimScore += 8;
    if (volatilityHigh) volatilityReclaimScore += 20;
    if (formingBottom) volatilityReclaimScore += 18;
    if (reclaimPressure) volatilityReclaimScore += 18;
    if (accumulationSigns) volatilityReclaimScore += 14;
    if (socialCount >= 1) volatilityReclaimScore += 6;
    if (liquidity >= 15000) volatilityReclaimScore += 8;
    if (priceM5 > 12) volatilityReclaimScore -= 10;

    const volatilityReclaimPass =
      notScamEnough &&
      volatilityHigh &&
      formingBottom &&
      reclaimPressure &&
      accumulationSigns &&
      volatilityReclaimScore >= 58;

    const modeScores = {
      hype_burst: hypeBurstScore,
      migration_rebound: migrationReboundScore,
      volatility_reclaim: volatilityReclaimScore
    };

    const passedModes = Object.entries({
      hype_burst: hypeBurstPass,
      migration_rebound: migrationReboundPass,
      volatility_reclaim: volatilityReclaimPass
    })
      .filter(([, pass]) => pass)
      .map(([key]) => key);

    const primaryMode =
      passedModes.sort((a, b) => safeNum(modeScores[b], 0) - safeNum(modeScores[a], 0))[0] || "";

    const scalpScore = clamp(
      Math.max(hypeBurstScore, migrationReboundScore, volatilityReclaimScore),
      0,
      99
    );

    const allow =
      passedModes.length > 0 &&
      scalpScore >= 58 &&
      notScamEnough;

    return {
      allow,
      score: scalpScore,
      primaryMode,
      passedModes,
      modeScores,
      metrics: {
        volToLiqM5,
        volToLiqH1,
        volToLiqH24,
        buyPressureM5,
        buyPressureH1,
        buyPressureH24,
        priceM5,
        priceH1,
        priceH6,
        priceH24,
        txnsM5,
        txnsH1,
        txnsH24,
        pairAgeMin
      },
      reasons: {
        hypeBurst: hypeBurstPass
          ? "volume burst + demand + not overextended"
          : "",
        migrationRebound: migrationReboundPass
          ? "post-migration flush stabilized and reclaimed"
          : "",
        volatilityReclaim: volatilityReclaimPass
          ? "fresh volatility with bottoming/reclaim signs"
          : ""
      }
    };
  }

  analyzeToken(token) {
    const links = Array.isArray(token?.links) ? token.links : [];
    const linksMap = this.buildLinksMap(links);
    const socialCount = Object.values(linksMap).filter(Boolean).length;

    const txns = safeNum(token?.txnsH24, token?.txns, 0);
    const liquidity = safeNum(token?.liquidity, 0);
    const fdv = safeNum(token?.fdv, 0);

    const buysH24 = safeNum(token?.buys, 0);
    const sellsH24 = safeNum(token?.sells, 0);
    const buysH1 = safeNum(token?.buysH1, 0);
    const sellsH1 = safeNum(token?.sellsH1, 0);
    const buysM5 = safeNum(token?.buysM5, 0);
    const sellsM5 = safeNum(token?.sellsM5, 0);

    const buyPressureH24 = buyPressurePct(buysH24, sellsH24);
    const buyPressureH1 = buyPressurePct(buysH1, sellsH1);
    const buyPressureM5 = buyPressurePct(buysM5, sellsM5);

    const priceDeltaPct = safeNum(token?.priceChangeH1, 0);

    const narrativeText = shortText(token?.description || "", 240);
    const narrativeVerdict =
      narrativeText || socialCount >= 2 ? "good" : "weak";

    const fdvLiquidityRatio =
      liquidity > 0 && fdv > 0 ? fdv / Math.max(liquidity, 1) : 4;

    const proxyConcentration = Math.round(
      Math.min(65, Math.max(18, fdvLiquidityRatio * 2))
    );

    const rugRisk = Math.max(
      5,
      Math.min(
        85,
        Math.round(
          (liquidity < 8000 ? 18 : 8) +
            (socialCount === 0 ? 12 : 0) +
            (fdv > liquidity * 20 ? 12 : 0) +
            (safeNum(token?.volumeH24, token?.volume, 0) < 5000 ? 8 : 0)
        )
      )
    );

    const corpseScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          (safeNum(token?.volumeH24, token?.volume, 0) < 3000 ? 25 : 5) +
            (txns < 25 ? 20 : 0) +
            (buyPressureH24 < 45 ? 10 : 0)
        )
      )
    );

    const isCorpse = corpseScore >= 70;
    const falseBounceRejected =
      buyPressureH24 < 42 &&
      txns < 40 &&
      safeNum(token?.volumeH24, token?.volume, 0) < 4000;

    const distributionScore = Math.max(
      0,
      Math.min(100, Math.round(proxyConcentration / 2))
    );

    const accumulationScore =
      buyPressureH1 >= 56 ? 18 :
      buyPressureH24 >= 52 ? 10 : 0;

    const absorptionScore =
      safeNum(token?.txnsH1, 0) >= 80 && safeNum(token?.volumeH1, 0) >= 10000
        ? 14
        : safeNum(token?.txnsH1, 0) >= 40
          ? 8
          : 0;

    const botActivity = 0;

    let developerVerdict = "Neutral";
    if (rugRisk >= 65 || (socialCount === 0 && liquidity < 8000)) {
      developerVerdict = "Bad";
    } else if (rugRisk >= 45 || (socialCount === 0 && liquidity < 12000)) {
      developerVerdict = "Risky";
    }

    const tokenType = "meme";
    const rewardModel = "None";

    const migration = this.buildMigrationSignals(token, {
      socialCount,
      buyPressureH24,
      priceDeltaPct
    });

    const baseScore = this.computeBaseScore(token, {
      socialCount,
      buyPressureH24,
      buyPressureH1,
      buyPressureM5
    });

    const scalp = this.buildScalpSignals(token, {
      socialCount,
      rugRisk,
      developerVerdict,
      pairAgeMin: migration?.pairAgeMin,
      migration,
      buyPressureH24,
      buyPressureH1,
      buyPressureM5
    });

    const antiRug = this.buildAntiRugIntel({
      token,
      rug: { risk: rugRisk },
      corpse: {
        score: corpseScore,
        isCorpse
      },
      falseBounce: {
        rejected: falseBounceRejected
      },
      developer: {
        verdict: developerVerdict
      },
      wallet: {
        concentration: proxyConcentration
      },
      bots: {
        botActivity
      },
      distribution: {
        score: distributionScore
      },
      accumulation: {
        score: accumulationScore
      },
      absorption: {
        score: absorptionScore
      },
      migration,
      scalp,
      socials: {
        socialCount
      }
    });

    const tradingMode = this.getTradingMode();

    let score = baseScore;
    if (scalp.allow) {
      score = Math.max(score, Math.round((baseScore * 0.55) + (safeNum(scalp.score, 0) * 0.45)));
    }
    if (migration.passes) {
      score = Math.max(score, Math.round((score * 0.7) + (safeNum(migration?.survivorScore, 0) * 0.3)));
    }

    if (antiRug.hardVeto) {
      score = Math.max(0, score - 45);
    } else if (antiRug.softVeto) {
      score = Math.max(0, score - 24);
    } else if (antiRug.riskScore >= 40) {
      score = Math.max(0, score - 12);
    }

    score = this.applyTradingModeToScore(score, antiRug, tradingMode);

    const reasons = [
      "solana chain only",
      liquidity >= 15000 ? "liquidity acceptable" : "liquidity moderate",
      socialCount > 0 ? "socials detected" : "no socials",
      buyPressureH24 >= 50 ? "buy pressure acceptable" : "buy pressure weak"
    ];

    if (migration.passes) {
      reasons.push("post-migration survivor profile");
    }

    if (scalp.allow) {
      reasons.push(`scalp mode ${scalp.primaryMode}`);
    }

    if (antiRug.hardVeto) {
      reasons.push(`anti-rug hard block: ${antiRug.reasons.join(', ') || 'critical risk'}`);
    } else if (antiRug.softVeto) {
      reasons.push(`anti-rug soft block: ${antiRug.reasons.join(', ') || 'elevated risk'}`);
    } else if (antiRug.riskScore >= 40) {
      reasons.push(`anti-rug watch: ${antiRug.warnings.join(', ') || 'risk elevated'}`);
    }

    reasons.push(`trading mode ${tradingMode}`);

    return {
      token,
      score,
      tradingMode,
      strategy: "solana_only",
      rug: {
        risk: rugRisk
      },
      corpse: {
        score: corpseScore,
        isCorpse
      },
      falseBounce: {
        rejected: falseBounceRejected
      },
      developer: {
        verdict: developerVerdict
      },
      wallet: {
        concentration: proxyConcentration
      },
      holders: {
        concentration: null
      },
      bots: {
        botActivity
      },
      distribution: {
        score: distributionScore
      },
      accumulation: {
        score: accumulationScore
      },
      absorption: {
        score: absorptionScore
      },
      delta: {
        priceDeltaPct,
        priceM5Pct: safeNum(token?.priceChangeM5, 0),
        priceH1Pct: safeNum(token?.priceChangeH1, 0),
        priceH6Pct: safeNum(token?.priceChangeH6, 0),
        priceH24Pct: safeNum(token?.priceChangeH24, 0),
        volumeDeltaPct: 0,
        txnsDeltaPct: 0,
        liquidityDeltaPct: 0,
        buyPressureDelta: safeNum(buyPressureM5 - buyPressureH1, 0)
      },
      socials: {
        socialCount,
        links: linksMap
      },
      narrative: {
        verdict: narrativeVerdict,
        summary: narrativeText || "No narrative available."
      },
      mechanics: {
        tokenType,
        rewardModel
      },
      migration,
      scalp,
      antiRug,
      dexPaid: false,
      copytradeMeta: {
        followDelaySec: 0,
        priceExtensionPct: Math.max(0, priceDeltaPct)
      },
      reasons
    };
  }

  analyzePair(pair) {
    const token = this.toTokenFromPair(pair);
    const analyzed = this.analyzeToken(token);

    const boostsActive = safeNum(pair?.boosts?.active, 0);
    analyzed.dexPaid = boostsActive > 0;

    if (boostsActive > 0) {
      analyzed.reasons.push(`dex boost active ${boostsActive}`);
      analyzed.score = clamp(safeNum(analyzed.score, 0) + 2, 0, 99);
    }

    return analyzed;
  }

  buildScalpPlan(candidate) {
    const scalp = candidate?.scalp || {};
    const mode = asText(scalp?.primaryMode, "");

    const base = {
      strategyKey: "scalp",
      thesis: "Volume/Rebound scalp on Solana",
      plannedHoldMs: 6 * 60 * 1000,
      stopLossPct: 3.2,
      takeProfitPct: 4.8,
      runnerTargetsPct: [],
      signalScore: safeNum(scalp?.score, safeNum(candidate?.score, 0)),
      expectedEdgePct: 5,
      entryMode: "SCALED",
      planName: "Scalp",
      objective: "quick rebound capture"
    };

    if (mode === "hype_burst") {
      return {
        ...base,
        thesis: "High-volume attention burst scalp",
        plannedHoldMs: 5 * 60 * 1000,
        stopLossPct: 3,
        takeProfitPct: 4.5,
        expectedEdgePct: 5.5,
        planName: "Hype Burst Scalp",
        objective: "attention burst"
      };
    }

    if (mode === "migration_rebound") {
      return {
        ...base,
        thesis: "Post-migration flush rebound scalp",
        plannedHoldMs: 7 * 60 * 1000,
        stopLossPct: 3.4,
        takeProfitPct: 5.2,
        expectedEdgePct: 6,
        entryMode: "PROBE",
        planName: "Migration Rebound Scalp",
        objective: "post-migration rebound"
      };
    }

    if (mode === "volatility_reclaim") {
      return {
        ...base,
        thesis: "Fresh volatility reclaim scalp",
        plannedHoldMs: 6 * 60 * 1000,
        stopLossPct: 3.2,
        takeProfitPct: 5,
        expectedEdgePct: 5.8,
        planName: "Volatility Reclaim Scalp",
        objective: "bottom reclaim"
      };
    }

    return base;
  }

  buildReversalSignals(candidate = {}) {
    const token = candidate?.token || {};
    const holder = candidate?.holderAccumulation || {};
    const migration = candidate?.migration || {};
    const scalpMetrics = candidate?.scalp?.metrics || {};

    const priceM5 = safeNum(candidate?.delta?.priceM5Pct, safeNum(token?.priceChangeM5, 0));
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, safeNum(token?.priceChangeH1, 0));
    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, safeNum(token?.priceChangeH6, 0));
    const priceH24 = safeNum(candidate?.delta?.priceH24Pct, safeNum(token?.priceChangeH24, 0));

    const buyPressureM5 = safeNum(scalpMetrics?.buyPressureM5, 0);
    const buyPressureH1 = safeNum(scalpMetrics?.buyPressureH1, 0);
    const buyPressureH24 = safeNum(scalpMetrics?.buyPressureH24, 0);

    const liquidity = safeNum(token?.liquidity, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
    const socialCount = safeNum(candidate?.socials?.socialCount, 0);

    const flushDetected = priceH6 <= -10 || priceH24 <= -18 || (safeNum(migration?.pairAgeMin, 0) <= 720 && priceH1 < 0);
    const baseForming = priceH1 > -12 && priceM5 > -4 && Math.abs(priceM5) <= 7;
    const sellerExhaustion = buyPressureM5 >= 52 && buyPressureM5 >= (buyPressureH1 - 2);
    const reclaimPressure = priceM5 > 0 && buyPressureM5 >= 55 && buyPressureH1 >= 50;
    const accumulationBase = safeNum(candidate?.accumulation?.score, 0) >= 10 || safeNum(candidate?.absorption?.score, 0) >= 10;
    const liquidityAlive = liquidity >= 12000 && volumeH1 >= 2500 && txnsH1 >= 30;
    const quietAccumulation = Boolean(holder?.quietAccumulationPass);
    const bottomPack = Boolean(holder?.bottomPackReversalPass);
    const linearityRisk = priceH1 >= 18 && priceH6 >= 45 && priceH24 >= 80 && !quietAccumulation && !bottomPack;
    const liquidityWeakeningRisk = liquidity < 14000 && priceH1 > 14 && !bottomPack;

    let score = 0;
    if (flushDetected) score += 16;
    if (baseForming) score += 14;
    if (sellerExhaustion) score += 14;
    if (reclaimPressure) score += 18;
    if (accumulationBase) score += 10;
    if (liquidityAlive) score += 10;
    if (socialCount >= 1) score += 4;
    if (safeNum(migration?.retainedLiquidity, false)) score += 6;
    if (safeNum(migration?.retainedFlow, false)) score += 6;
    if (quietAccumulation) score += 12;
    if (bottomPack) score += 16;
    if (buyPressureH24 < 45) score -= 8;
    if (priceM5 > 10) score -= 8;
    if (linearityRisk) score -= 18;
    if (liquidityWeakeningRisk) score -= 10;

    const notScamEnough =
      safeNum(candidate?.rug?.risk, 0) < 65 &&
      asText(candidate?.developer?.verdict, 'Neutral') !== 'Bad' &&
      !candidate?.corpse?.isCorpse;

    const primaryMode = bottomPack
      ? 'bottom_pack_reversal'
      : (migration?.passes && reclaimPressure)
        ? 'migration_base_reversal'
        : 'base_reclaim_reversal';

    const allow =
      notScamEnough &&
      flushDetected &&
      baseForming &&
      (reclaimPressure || quietAccumulation) &&
      liquidityAlive &&
      !linearityRisk &&
      score >= 58;

    return {
      allow,
      score: clamp(Math.round(score), 0, 99),
      primaryMode,
      quietAccumulation,
      bottomPack,
      metrics: {
        priceM5,
        priceH1,
        priceH6,
        priceH24,
        buyPressureM5,
        buyPressureH1,
        buyPressureH24,
        retention30m: safeNum(holder?.retention30mPct, 0),
        retention2h: safeNum(holder?.retention2hPct, 0),
        netControlPct: safeNum(holder?.netControlPct, 0),
        freshWalletBuyCount: safeNum(holder?.freshWalletBuyCount, 0),
        reloadCount: safeNum(holder?.reloadCount, 0),
        dipBuyRatio: safeNum(holder?.dipBuyRatio, 0),
        bottomTouches: safeNum(holder?.bottomTouches, 0),
        linearityRisk,
        liquidityWeakeningRisk
      }
    };
  }

  recomputeCompositeScore(candidate = {}) {
    if (candidate?.token) {
      candidate.antiRug = this.buildAntiRugIntel(candidate);
    }

    const tradingMode = this.getTradingMode();
    const antiRugProbeOnly = Boolean(candidate?.antiRug?.probeOnly || candidate?.antiRug?.softVeto);

    let score = safeNum(candidate?.score, 0);
    if (candidate?.scalp?.allow && !(antiRugProbeOnly && tradingMode === "sniper")) {
      score = Math.max(score, Math.round(score * 0.65 + safeNum(candidate?.scalp?.score, 0) * 0.35));
    }
    if (candidate?.reversal?.allow) {
      score = Math.max(score, Math.round(score * 0.55 + safeNum(candidate?.reversal?.score, 0) * 0.45));
    }
    if (candidate?.packaging?.detected) {
      score = Math.max(score, Math.round(score * 0.72 + safeNum(candidate?.packaging?.score, 0) * 0.28));
    }
    if (candidate?.migration?.passes && !candidate?.antiRug?.hardVeto) {
      score = Math.max(score, Math.round(score * 0.7 + safeNum(candidate?.migration?.survivorScore, 0) * 0.3));
    }
    if (candidate?.migrationAccumulation?.priorityWatch && !candidate?.antiRug?.hardVeto) {
      score = Math.max(score, Math.round(score * 0.62 + safeNum(candidate?.migrationAccumulation?.score, 0) * 0.38));
    }
    if (candidate?.runnerLike?.allow && !this.shouldPreferReversalOverRunner(candidate)) {
      score = Math.max(score, Math.round(score * 0.76 + safeNum(candidate?.runnerLike?.score, 0) * 0.24));
    }
    if (candidate?.antiRug?.hardVeto) {
      score = Math.min(score, 35);
    } else if (candidate?.antiRug?.softVeto) {
      score = Math.min(score, tradingMode === "aggressive" ? 66 : 58);
    }

    candidate.tradingMode = tradingMode;
    candidate.score = this.applyTradingModeToScore(score, candidate?.antiRug, tradingMode);
    return candidate;
  }

  buildPackagingProbePlan(candidate = {}) {
    return {
      strategyKey: "reversal",
      thesis: "Early warehouse accumulation / packaging probe on Solana",
      plannedHoldMs: 40 * 60 * 1000,
      stopLossPct: 4.4,
      takeProfitPct: 9,
      runnerTargetsPct: [],
      signalScore: safeNum(candidate?.packaging?.score, safeNum(candidate?.score, 0)),
      expectedEdgePct: 8,
      entryMode: "PROBE",
      planName: "Packaging Probe",
      objective: "early packaging watch"
    };
  }

  async enrichCandidateWithHolderLive(candidate = {}) {
    if (!candidate || !this.holderAccumulationEngine) {
      candidate.packaging = this.buildPackagingSignals(candidate);
      candidate.runnerLike = this.buildRunnerLikeSignals(candidate);
      candidate.reversal = this.buildReversalSignals(candidate);
      candidate.migrationAccumulation = this.buildMigrationAccumulationSignals(candidate);
      return this.recomputeCompositeScore(candidate);
    }

    try {
      const holderAccumulation = await this.holderAccumulationEngine.trackCandidate(candidate);
      candidate.holderAccumulation = holderAccumulation || null;
    } catch (error) {
      this.logger.log("holder enrich failed:", error.message);
    }

    candidate.packaging = this.buildPackagingSignals(candidate);
    candidate.runnerLike = this.buildRunnerLikeSignals(candidate);
    candidate.reversal = this.buildReversalSignals(candidate);
    candidate.migrationAccumulation = this.buildMigrationAccumulationSignals(candidate);
    return this.recomputeCompositeScore(candidate);
  }

    buildMigrationAccumulationSignals(candidate = {}) {
    const token = candidate?.token || {};
    const holder = candidate?.holderAccumulation || {};
    const migration = candidate?.migration || {};
    const scalpMetrics = candidate?.scalp?.metrics || {};

    const pairAgeMin = safeNum(migration?.pairAgeMin, 99999);
    const fdv = safeNum(token?.fdv, 0);
    const liquidity = safeNum(token?.liquidity, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const volumeH6 = safeNum(token?.volumeH6, 0);
    const volumeH24 = safeNum(token?.volumeH24, token?.volume, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
    const txnsH6 = safeNum(token?.txnsH6, 0);
    const txnsH24 = safeNum(token?.txnsH24, token?.txns, 0);

    const priceM5 = safeNum(candidate?.delta?.priceM5Pct, safeNum(token?.priceChangeM5, 0));
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, safeNum(token?.priceChangeH1, 0));
    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, safeNum(token?.priceChangeH6, 0));
    const priceH24 = safeNum(candidate?.delta?.priceH24Pct, safeNum(token?.priceChangeH24, 0));

    const buyPressureM5 = safeNum(scalpMetrics?.buyPressureM5, 0);
    const buyPressureH1 = safeNum(scalpMetrics?.buyPressureH1, 0);
    const buyPressureH24 = safeNum(scalpMetrics?.buyPressureH24, 0);

    const retention30m = safeNum(holder?.retention30mPct, 0);
    const retention2h = safeNum(holder?.retention2hPct, 0);
    const netControlPct = safeNum(holder?.netControlPct, 0);
    const netAccumulationPct = safeNum(holder?.netAccumulationPct, 0);
    const freshWalletBuyCount = safeNum(holder?.freshWalletBuyCount, 0);
    const bottomTouches = safeNum(holder?.bottomTouches, 0);
    const reloadCount = safeNum(holder?.reloadCount, 0);
    const dipBuyRatio = safeNum(holder?.dipBuyRatio, 0);

    const quietAccumulation = Boolean(holder?.quietAccumulationPass);
    const warehouseStorage = Boolean(holder?.warehouseStoragePass) || String(holder?.cohortArchetype || "") === "warehouse_storage";
    const bottomPack = Boolean(holder?.bottomPackReversalPass);

    const ageWindow = pairAgeMin >= 60 && pairAgeMin <= 36 * 60;
    const mcWindow = fdv >= 12000 && fdv <= 180000;
    const deepCorrection = priceH24 <= -25 || priceH6 <= -18 || (priceH1 <= -8 && pairAgeMin >= 90);
    const notFullyDead = liquidity >= 7000 && volumeH24 >= 12000 && txnsH24 >= 90;
    const stillBreathing = volumeH1 >= 1200 || txnsH1 >= 18 || volumeH6 >= 6000 || txnsH6 >= 60;
    const baseStabilizing = priceM5 >= -5 && priceH1 >= -16 && priceH1 <= 18;
    const earlyReclaim = priceM5 > -1 && (buyPressureM5 >= 52 || buyPressureH1 >= 50 || priceH1 > 0);

    const accumulationEvidence = quietAccumulation || warehouseStorage || bottomPack || retention30m >= 45 || retention2h >= 25 || netControlPct >= 25 || netAccumulationPct >= 35 || freshWalletBuyCount >= 8 || bottomTouches >= 2 || reloadCount >= 2 || dipBuyRatio >= 0.35;
    const antiRugHard = Boolean(candidate?.antiRug?.hardVeto) || safeNum(candidate?.rug?.risk, 0) >= 80 || Boolean(candidate?.corpse?.isCorpse);
    const liquidityOkRelative = fdv > 0 ? (liquidity / Math.max(fdv, 1)) * 100 >= 5 : liquidity >= 10000;

    let score = 0;
    if (ageWindow) score += 14;
    if (mcWindow) score += 12;
    if (deepCorrection) score += 16;
    if (notFullyDead) score += 12;
    if (stillBreathing) score += 10;
    if (baseStabilizing) score += 12;
    if (earlyReclaim) score += 14;
    if (accumulationEvidence) score += 16;
    if (liquidityOkRelative) score += 8;
    if (quietAccumulation) score += 10;
    if (warehouseStorage) score += 8;
    if (bottomPack) score += 12;
    if (retention30m >= 55) score += 6;
    if (retention2h >= 35) score += 8;
    if (netControlPct >= 45) score += 8;
    if (freshWalletBuyCount >= 14) score += 6;
    if (bottomTouches >= 3) score += 6;
    if (buyPressureH24 < 42 && buyPressureH1 < 48 && buyPressureM5 < 50) score -= 10;
    if (liquidity < 6000) score -= 16;
    if (fdv > 250000) score -= 12;
    if (priceH1 > 35 || priceM5 > 18) score -= 14;
    if (antiRugHard) score -= 35;

    const allow = !antiRugHard && ageWindow && mcWindow && deepCorrection && notFullyDead && stillBreathing && baseStabilizing && accumulationEvidence && score >= 58;
    const priorityWatch = !antiRugHard && ageWindow && mcWindow && deepCorrection && notFullyDead && (accumulationEvidence || earlyReclaim) && score >= 48;
    const probeEligible = allow && score >= 66 && (bottomPack || quietAccumulation || warehouseStorage || netControlPct >= 40 || retention2h >= 32);

    const mode = bottomPack ? "bottom_pack_after_migration" : quietAccumulation || warehouseStorage ? "quiet_accumulation_after_migration" : earlyReclaim ? "early_reclaim_after_migration" : "post_migration_base";

    return {
      allow,
      priorityWatch,
      probeEligible,
      score: clamp(Math.round(score), 0, 99),
      mode,
      ageWindow,
      mcWindow,
      deepCorrection,
      notFullyDead,
      stillBreathing,
      baseStabilizing,
      earlyReclaim,
      accumulationEvidence,
      liquidityOkRelative,
      metrics: {
        pairAgeMin,
        fdv,
        liquidity,
        volumeH1,
        volumeH6,
        volumeH24,
        txnsH1,
        txnsH6,
        txnsH24,
        priceM5,
        priceH1,
        priceH6,
        priceH24,
        buyPressureM5,
        buyPressureH1,
        buyPressureH24,
        retention30m,
        retention2h,
        netControlPct,
        netAccumulationPct,
        freshWalletBuyCount,
        bottomTouches,
        reloadCount,
        dipBuyRatio
      }
    };
  }

  buildMigrationAccumulationPlan(candidate = {}) {
    return {
      strategyKey: "migration_survivor",
      thesis: "Post-migration dump → accumulation base → early reversal attempt",
      plannedHoldMs: 4 * 60 * 60 * 1000,
      stopLossPct: 6.5,
      takeProfitPct: 0,
      runnerTargetsPct: [18, 35, 65],
      signalScore: safeNum(candidate?.migrationAccumulation?.score, safeNum(candidate?.score, 0)),
      expectedEdgePct: 18,
      entryMode: candidate?.migrationAccumulation?.probeEligible ? "SCALED" : "PROBE",
      planName: "Migration Accumulation",
      objective: "catch post-migration base before expansion"
    };
  }

  getAntiRugBadge(candidate = {}) {
    const anti = candidate?.antiRug || {};
    const verdict = String(anti?.verdict || "CLEAN").toUpperCase();
    let emoji = "🟢";
    if (verdict === "HARD_BLOCK") emoji = "🔴";
    else if (verdict === "SOFT_BLOCK" || verdict === "RISKY") emoji = "🟠";
    else if (verdict === "WATCH") emoji = "🟡";
    return { emoji, verdict, riskScore: safeNum(anti?.riskScore, 0) };
  }

  shouldPreferReversalOverRunner(candidate = {}) {
    const holder = candidate?.holderAccumulation || {};
    const packaging = candidate?.packaging || {};
    const reversal = candidate?.reversal || {};
    const migrationAccumulation = candidate?.migrationAccumulation || {};
    const token = candidate?.token || {};
    const priceM5 = safeNum(candidate?.delta?.priceM5Pct, safeNum(token?.priceChangeM5, 0));
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, safeNum(token?.priceChangeH1, 0));
    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, safeNum(token?.priceChangeH6, 0));
    const priceH24 = safeNum(candidate?.delta?.priceH24Pct, safeNum(token?.priceChangeH24, 0));
    const quietAccumulation = Boolean(holder?.quietAccumulationPass) || Boolean(packaging?.quietAccumulation) || Boolean(reversal?.quietAccumulation);
    const bottomPack = Boolean(holder?.bottomPackReversalPass) || Boolean(packaging?.bottomPack) || Boolean(reversal?.bottomPack);
    const packagingReversal = Boolean(packaging?.priorityWatch) || Boolean(packaging?.probeEligible) || Boolean(packaging?.warehouseLike);
    const postFlushReclaim = (priceH6 < 0 || priceH24 < -10) && priceH1 > -4 && priceM5 >= -2;
    const trueContinuation = priceH1 >= 8 && priceH6 >= 18 && priceH24 >= 25 && !quietAccumulation && !bottomPack && !packagingReversal && !postFlushReclaim && !migrationAccumulation?.priorityWatch;
    if (trueContinuation) return false;
    return Boolean(reversal?.allow || migrationAccumulation?.priorityWatch || migrationAccumulation?.allow || quietAccumulation || bottomPack || packagingReversal || postFlushReclaim);
  }

  getMainPlanLabel(plans = [], candidate = {}) {
    const list = Array.isArray(plans) ? plans : [];
    const nonCopy = list.filter((p) => p?.strategyKey && p.strategyKey !== "copytrade");
    const migrationAccumulationPlan = nonCopy.find((p) => String(p?.planName || "").toLowerCase().includes("migration accumulation") || (p.strategyKey === "migration_survivor" && candidate?.migrationAccumulation?.priorityWatch));
    if (migrationAccumulationPlan) return "MIGRATION_ACCUMULATION";
    if (this.shouldPreferReversalOverRunner(candidate)) {
      const reversalPlan = nonCopy.find((p) => p.strategyKey === "reversal" || String(p?.planName || "").toLowerCase().includes("reversal") || String(p?.planName || "").toLowerCase().includes("packaging"));
      if (reversalPlan) return "REVERSAL";
    }
    const preferred = nonCopy.find((p) => p.strategyKey === "scalp") || nonCopy.find((p) => p.strategyKey === "migration_survivor") || nonCopy.find((p) => p.strategyKey === "runner") || nonCopy[0] || list[0];
    if (!preferred?.strategyKey) return "WATCH";
    if (preferred.strategyKey === "migration_survivor") return "MIGRATION_SURVIVOR";
    return String(preferred.strategyKey).toUpperCase();
  }

  buildTopSignalHeader(candidate = {}, plans = []) {
    const anti = this.getAntiRugBadge(candidate);
    const mainPlan = this.getMainPlanLabel(plans, candidate);
    const planLine = (plans || []).map((p) => p.strategyKey).filter(Boolean).join(", ") || "none";
    return `${anti.emoji} <b>Anti-rug:</b> <b>${escapeHtml(anti.verdict)}</b> / ${safeNum(anti.riskScore, 0)}
🎯 <b>Main plan:</b> <b>${escapeHtml(mainPlan)}</b>
📌 <b>Plans:</b> ${escapeHtml(planLine)}
👛 <b>Wallet cluster:</b> ${escapeHtml(candidate?.holderAccumulation?.walletCluster?.clusterRisk || "-")} / ${safeNum(candidate?.holderAccumulation?.walletCluster?.clusterRiskScore, 0)} | young supply ${safeNum(candidate?.holderAccumulation?.walletCluster?.youngSupplyPct, 0).toFixed(1)}%
↩️ <b>Reversal score:</b> ${safeNum(candidate?.reversal?.score, 0)} | 🧬 <b>Migration accumulation:</b> ${safeNum(candidate?.migrationAccumulation?.score, 0)} | 🏃 <b>Runner-like:</b> ${safeNum(candidate?.runnerLike?.score, 0)} | 📦 <b>Packaging:</b> ${safeNum(candidate?.packaging?.score, 0)}`;
  }

  buildReversalPlan(candidate = {}) {
    const reversal = candidate?.reversal || {};
    const mode = asText(reversal?.primaryMode, 'base_reclaim_reversal');

    const base = {
      strategyKey: 'reversal',
      thesis: 'Bottom reclaim reversal on Solana',
      plannedHoldMs: 45 * 60 * 1000,
      stopLossPct: 4.6,
      takeProfitPct: 9.5,
      runnerTargetsPct: [],
      signalScore: safeNum(reversal?.score, safeNum(candidate?.score, 0)),
      expectedEdgePct: 9,
      entryMode: 'SCALED',
      planName: 'Reversal',
      objective: 'bounce capture'
    };

    if (mode === 'bottom_pack_reversal') {
      return {
        ...base,
        thesis: 'Quiet accumulation / bottom-pack reversal',
        plannedHoldMs: 55 * 60 * 1000,
        stopLossPct: 4.2,
        takeProfitPct: 11,
        expectedEdgePct: 11,
        planName: 'Bottom Pack Reversal',
        objective: 'quiet accumulation reclaim'
      };
    }

    if (mode === 'migration_base_reversal') {
      return {
        ...base,
        thesis: 'Post-migration base reversal',
        plannedHoldMs: 50 * 60 * 1000,
        stopLossPct: 4.8,
        takeProfitPct: 10,
        expectedEdgePct: 10,
        entryMode: 'PROBE',
        planName: 'Migration Base Reversal',
        objective: 'post-migration bounce'
      };
    }

    return base;
  }

  buildPlans(candidate, strategyScope = "all", runtime = null) {
    const tradingMode = this.getTradingMode(runtime);
    const cfg = this.getTradingModeConfig(tradingMode);
    candidate.tradingMode = tradingMode;

    if (candidate?.antiRug?.hardVeto) return [];
    if (tradingMode === "sniper" && candidate?.antiRug?.softVeto) return [];
    if (tradingMode === "sniper" && safeNum(candidate?.antiRug?.riskScore, 0) > cfg.maxAllowedAntiRugRisk) return [];

    const plans = [];
    const score = safeNum(candidate?.score, 0);
    const antiRugProbeOnly = Boolean(candidate?.antiRug?.probeOnly || candidate?.antiRug?.softVeto);
    const softRiskAllowed = !antiRugProbeOnly || cfg.allowSoftVetoProbe;

    if (score >= cfg.copytradeMinScore && !antiRugProbeOnly) {
      plans.push({
        strategyKey: "copytrade",
        thesis: "Leader-confirmed Solana follow",
        plannedHoldMs: 60 * 60 * 1000,
        stopLossPct: 7,
        takeProfitPct: 16,
        runnerTargetsPct: [],
        signalScore: score,
        expectedEdgePct: 12,
        entryMode: "SCALED",
        planName: "Copytrade Follow",
        objective: "follow"
      });
    }

    if (
      candidate?.scalp?.allow &&
      score >= cfg.scalpMinScore &&
      softRiskAllowed &&
      !(tradingMode === "sniper" && safeNum(candidate?.antiRug?.riskScore, 0) >= 30)
    ) {
      plans.push(this.buildScalpPlan(candidate));
    }

    if (
      candidate?.reversal?.allow &&
      score >= cfg.reversalMinScore &&
      softRiskAllowed
    ) {
      plans.push(this.buildReversalPlan(candidate));
    } else if (
      candidate?.packaging?.probeEligible &&
      softRiskAllowed &&
      tradingMode !== "sniper"
    ) {
      plans.push(this.buildPackagingProbePlan(candidate));
    }

    if (
      candidate?.migration?.passes &&
      softRiskAllowed &&
      !(tradingMode === "sniper" && safeNum(candidate?.antiRug?.riskScore, 0) >= 28)
    ) {
      plans.push({
        strategyKey: "migration_survivor",
        thesis: "Post-migration survivor with retained demand",
        plannedHoldMs: 3 * 60 * 60 * 1000,
        stopLossPct: 8,
        takeProfitPct: 0,
        runnerTargetsPct: [25, 50, 80],
        signalScore: Math.max(score, safeNum(candidate?.migration?.survivorScore, 0)),
        expectedEdgePct: 22,
        entryMode: antiRugProbeOnly ? "PROBE" : "SCALED",
        planName: "Migration Survivor",
        objective: "post-migration expansion"
      });
    } else if (
      (candidate?.migrationAccumulation?.probeEligible || candidate?.migrationAccumulation?.allow) &&
      softRiskAllowed &&
      !(tradingMode === "sniper" && safeNum(candidate?.antiRug?.riskScore, 0) >= 28)
    ) {
      plans.push(this.buildMigrationAccumulationPlan(candidate));
    }

    if (
      score >= cfg.runnerMinScore &&
      !antiRugProbeOnly &&
      safeNum(candidate?.delta?.priceH1Pct, 0) > 0 &&
      safeNum(candidate?.absorption?.score, 0) >= 8 &&
      !this.shouldPreferReversalOverRunner(candidate)
    ) {
      plans.push({
        strategyKey: "runner",
        thesis: "Strong Solana runner",
        plannedHoldMs: 4 * 60 * 60 * 1000,
        stopLossPct: 7,
        takeProfitPct: 24,
        runnerTargetsPct: [12, 22, 35],
        signalScore: score,
        expectedEdgePct: 18,
        entryMode: "SCALED",
        planName: "Runner",
        objective: "trend expansion"
      });
    }

    const adjustedPlans = plans.map((plan) => this.adjustPlanForTradingMode(plan, tradingMode, candidate));

    if (strategyScope && strategyScope !== "all") {
      return adjustedPlans.filter((plan) => plan.strategyKey === strategyScope);
    }

    return adjustedPlans;
  }

  getRelevantRank(candidate, strategyScope = "all") {
    if (!candidate) return 0;

    if (strategyScope === "scalp") {
      return candidate?.scalp?.allow
        ? safeNum(candidate?.scalp?.score, 0) + safeNum(candidate?.token?.volumeH1, 0) / 2000
        : 0;
    }

    if (strategyScope === "reversal") {
      if (candidate?.reversal?.allow) {
        return safeNum(candidate?.reversal?.score, 0) + safeNum(candidate?.holderAccumulation?.netControlPct, 0) * 2;
      }
      if (candidate?.packaging?.priorityWatch || candidate?.packaging?.probeEligible) {
        return safeNum(candidate?.packaging?.score, 0) + safeNum(candidate?.holderAccumulation?.netControlPct, 0) * 1.4;
      }
      return safeNum(candidate?.reversal?.score, 0) * 0.4;
    }

    if (strategyScope === "migration_survivor") {
      if (candidate?.migration?.passes) return safeNum(candidate?.migration?.survivorScore, 0);
      if (candidate?.migrationAccumulation?.priorityWatch || candidate?.migrationAccumulation?.allow) {
        return safeNum(candidate?.migrationAccumulation?.score, 0) + safeNum(candidate?.holderAccumulation?.netControlPct, 0) * 1.2;
      }
      return 0;
    }

    if (strategyScope === "runner") {
      return safeNum(candidate?.score, 0) + Math.max(0, safeNum(candidate?.delta?.priceH1Pct, 0));
    }

    if (strategyScope === "copytrade") {
      return safeNum(candidate?.score, 0);
    }

    return Math.max(
      safeNum(candidate?.score, 0),
      safeNum(candidate?.migration?.survivorScore, 0),
      safeNum(candidate?.scalp?.score, 0),
      safeNum(candidate?.reversal?.score, 0),
      safeNum(candidate?.packaging?.score, 0),
      safeNum(candidate?.migrationAccumulation?.score, 0)
    );
  }


async fetchMarketCandidates() {
  this.resetRadarTelemetry();

  const plannedQueries = Object.entries(this.radarQueryBuckets || {}).flatMap(([bucket, queries]) =>
    (queries || []).map((query) => ({ bucket, query }))
  );

  const selectedQueries = plannedQueries.slice(0, Math.max(1, this.maxDexSearchQueriesPerScan));
  const results = [];

  for (const row of selectedQueries) {
    const pairs = await this.fetchDexSearch(row.query);
    results.push({ ...row, pairs });
    this.lastRadarTelemetry.scannedRaw += Array.isArray(pairs) ? pairs.length : 0;
  }

  const searchPairs = dedupeByCA(results.flatMap((x) => x.pairs || [])).filter((p) => isSolanaChain(p?.chainId));
  const smartWalletResult = await this.fetchCandidatesFromSmartWalletFeed();
  const telegramSignalResult = await this.fetchCandidatesFromTelegramChannels();

  this.lastRadarTelemetry.smartWalletFeedRaw = safeNum(smartWalletResult?.telemetry?.smartWalletFeedRaw, 0);
  this.lastRadarTelemetry.smartWalletTokens = safeNum(smartWalletResult?.telemetry?.smartWalletTokens, 0);
  this.lastRadarTelemetry.smartWalletAccepted = safeNum(smartWalletResult?.telemetry?.smartWalletAccepted, 0);
  this.lastRadarTelemetry.scannedRaw += safeNum(smartWalletResult?.telemetry?.smartWalletFeedRaw, 0);

  this.lastRadarTelemetry.telegramSignalRaw = safeNum(telegramSignalResult?.telemetry?.telegramSignalRaw, 0);
  this.lastRadarTelemetry.telegramSignalTokens = safeNum(telegramSignalResult?.telemetry?.telegramSignalTokens, 0);
  this.lastRadarTelemetry.telegramSignalAccepted = safeNum(telegramSignalResult?.telemetry?.telegramSignalAccepted, 0);
  this.lastRadarTelemetry.scannedRaw += safeNum(telegramSignalResult?.telemetry?.telegramSignalRaw, 0);

  const analyzed = [];
  const byCa = new Map();

  for (const pair of searchPairs) {
    const candidate = this.analyzePair(pair);
    const bucket = this.classifyRadarBucket(candidate?.token || {});
    candidate.discoveryBucket = bucket;
    candidate.discoverySource = 'dex_search';
    this.bumpBucket(bucket, 1);
    const ca = asText(candidate?.token?.ca);
    if (!ca) continue;
    byCa.set(ca, candidate);
  }

  for (const candidate of smartWalletResult?.candidates || []) {
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
  }

  this.lastRadarTelemetry.uniquePairs = byCa.size;

  for (const candidate of byCa.values()) {
    if (!isSolanaChain(candidate?.token?.chainId)) continue;
    if (this.isNoiseCandidate(candidate)) {
      this.lastRadarTelemetry.filteredNoise += 1;
      continue;
    }
    analyzed.push(candidate);
  }

  this.lastRadarTelemetry.candidatesAfterAnalysis = analyzed.length;

  return analyzed.sort((a, b) => {
    const bScore = Math.max(
      safeNum(b?.score, 0),
      safeNum(b?.migration?.survivorScore, 0),
      safeNum(b?.scalp?.score, 0),
      safeNum(b?.reversal?.score, 0),
      safeNum(b?.packaging?.score, 0),
      safeNum(b?.migrationAccumulation?.score, 0)
    );
    const aScore = Math.max(
      safeNum(a?.score, 0),
      safeNum(a?.migration?.survivorScore, 0),
      safeNum(a?.scalp?.score, 0),
      safeNum(a?.reversal?.score, 0),
      safeNum(a?.packaging?.score, 0),
      safeNum(a?.migrationAccumulation?.score, 0)
    );
    return (
      bScore - aScore ||
      safeNum(b?.smartWalletFeed?.walletHits, 0) - safeNum(a?.smartWalletFeed?.walletHits, 0) ||
      safeNum(b?.token?.volumeH1, 0) - safeNum(a?.token?.volumeH1, 0) ||
      safeNum(b?.token?.liquidity, 0) - safeNum(a?.token?.liquidity, 0)
    );
  });
}

async findBestCandidate({ runtime, openPositions = [], recentlyTraded = [] }) {
    const candidates = await this.fetchMarketCandidates();

    const openCA = new Set((openPositions || []).map((p) => asText(p?.ca)).filter(Boolean));
    const recentCA = new Set((recentlyTraded || []).map((x) => asText(x)).filter(Boolean));
    const strategyScope = runtime?.strategyScope || "all";

    let ranked = candidates
      .filter((row) => {
        const ca = asText(row?.token?.ca);
        if (!ca) return false;
        if (!isSolanaChain(row?.token?.chainId)) return false;
        if (openCA.has(ca)) return false;
        if (recentCA.has(ca)) return false;
        return true;
      })
      .sort((a, b) => this.getRelevantRank(b, strategyScope) - this.getRelevantRank(a, strategyScope));

    const enrichCount = strategyScope === "reversal"
      ? Math.max(this.maxHolderEnrichPerPass, 28)
      : strategyScope === "all"
        ? Math.max(this.maxHolderEnrichPerPass, 18)
        : Math.max(this.maxHolderEnrichPerPass, 10);

    for (const candidate of ranked.slice(0, enrichCount)) {
      await this.enrichCandidateWithHolderLive(candidate);
    }

    ranked = ranked.sort((a, b) => this.getRelevantRank(b, strategyScope) - this.getRelevantRank(a, strategyScope));
    this.lastRadarTelemetry.deepAnalyzed = Math.min(enrichCount, ranked.length);

    let watchlist = 0;
    let priorityWatch = 0;
    let packagingDetected = 0;
    let packagingProbe = 0;
    let reversalWatch = 0;
    let runnerLike = 0;
    let migrationStructure = 0;
    let migrationAccumulation = 0;
    let trapRejected = 0;
    let tradeReady = 0;

    for (const row of ranked.slice(0, this.lastRadarTelemetry.deepAnalyzed)) {
      if (row?.packaging?.detected) packagingDetected += 1;
      if (row?.packaging?.priorityWatch) priorityWatch += 1;
      if (row?.packaging?.probeEligible) packagingProbe += 1;
      if (row?.runnerLike?.allow) runnerLike += 1;
      if (row?.migration?.passes) migrationStructure += 1;
      if (row?.migrationAccumulation?.priorityWatch || row?.migrationAccumulation?.allow) migrationAccumulation += 1;
      if (row?.reversal?.allow || row?.packaging?.priorityWatch || row?.migrationAccumulation?.priorityWatch) reversalWatch += 1;
      if (row?.packaging?.detected || row?.reversal?.allow || row?.migration?.passes || row?.migrationAccumulation?.priorityWatch || row?.runnerLike?.allow) watchlist += 1;
      if (row?.falseBounce?.rejected || row?.corpse?.isCorpse || safeNum(row?.rug?.risk, 0) >= 70) trapRejected += 1;
      if (this.buildPlans(row, strategyScope, runtime).length > 0) tradeReady += 1;
    }

    Object.assign(this.lastRadarTelemetry, {
      watchlist,
      priorityWatch,
      packagingDetected,
      packagingProbe,
      reversalWatch,
      runnerLike,
      migrationStructure,
      migrationAccumulation,
      trapRejected,
      tradeReady,
      smartWalletPublishWorthy: ranked.filter((row) => row?.smartWalletFeed && (row?.packaging?.priorityWatch || row?.reversal?.allow || row?.migration?.passes || row?.migrationAccumulation?.priorityWatch || row?.runnerLike?.allow)).length,
      telegramSignalPublishWorthy: ranked.filter((row) => row?.telegramSignal && (row?.packaging?.priorityWatch || row?.reversal?.allow || row?.migration?.passes || row?.migrationAccumulation?.priorityWatch || row?.runnerLike?.allow)).length,
      lastUpdatedAt: new Date().toISOString()
    });

    const candidate = ranked.find((row) => {
      const plans = this.buildPlans(row, strategyScope, runtime);
      return plans.length > 0;
    }) || null;

    if (!candidate) return null;

    const plans = this.buildPlans(candidate, strategyScope, runtime);
    if (!plans.length) return null;

    return {
      candidate,
      plans,
      heroImage: candidate?.token?.imageUrl || null
    };
  }

  buildHeroCaption(candidate) {
    const token = candidate?.token || {};
    const plans = this.buildPlans(candidate, "all");
    const topHeader = this.buildTopSignalHeader(candidate, plans);
    return `🧭 <b>${escapeHtml(token.name || token.symbol || "UNKNOWN")}</b>
${topHeader}
chain: ${escapeHtml(token.chainId || "-")}
score: ${safeNum(candidate?.score, 0)}
anti-rug: ${escapeHtml(candidate?.antiRug?.verdict || '-')}
anti-rug risk: ${safeNum(candidate?.antiRug?.riskScore, 0)}
discovery: ${escapeHtml(candidate?.discoverySource || candidate?.discoveryBucket || "-")}
smart-wallet hits: ${safeNum(candidate?.smartWalletFeed?.walletHits, 0)}
scalp score: ${safeNum(candidate?.scalp?.score, 0)}
scalp mode: ${escapeHtml(candidate?.scalp?.primaryMode || "-")}
reversal score: ${safeNum(candidate?.reversal?.score, 0)}
reversal mode: ${escapeHtml(candidate?.reversal?.primaryMode || "-")}
quiet accumulation: ${candidate?.holderAccumulation?.quietAccumulationPass ? "yes" : "no"}
control pct: ${safeNum(candidate?.holderAccumulation?.netControlPct, 0).toFixed(2)}
migration score: ${safeNum(candidate?.migration?.survivorScore, 0)}
migration accumulation: ${safeNum(candidate?.migrationAccumulation?.score, 0)} / ${escapeHtml(candidate?.migrationAccumulation?.mode || "-")}
telegram channels: ${safeNum(candidate?.telegramSignal?.channelHits, 0)} | ${escapeHtml((candidate?.telegramSignal?.channels || []).join(", ") || "-")}
price: ${safeNum(token.price, 0)}
liquidity: ${safeNum(token.liquidity, 0)}
volume 1h: ${safeNum(token.volumeH1, 0)}
volume 24h: ${safeNum(token.volumeH24, token.volume, 0)}
txns 1h: ${safeNum(token.txnsH1, 0)}
txns 24h: ${safeNum(token.txnsH24, token.txns, 0)}
fdv: ${safeNum(token.fdv, 0)}
pair age min: ${safeNum(candidate?.migration?.pairAgeMin, 0).toFixed(1)}
dex: ${escapeHtml(token.dexId || "-")}
url: ${escapeHtml(token.url || "-")}`;
  }

  buildAnalysisText(candidate, plans = []) {
    const token = candidate?.token || {};
    const socials = candidate?.socials?.links || {};
    const planLine = plans.map((p) => p.strategyKey).join(", ") || "none";
    const migration = candidate?.migration || {};
    const scalp = candidate?.scalp || {};
    const reversal = candidate?.reversal || {};
    const migrationAccumulation = candidate?.migrationAccumulation || {};
    const holder = candidate?.holderAccumulation || {};
    const scalpMetrics = scalp?.metrics || {};
    const reversalMetrics = reversal?.metrics || {};

    return `🔎 <b>ANALYSIS</b>
${this.buildTopSignalHeader(candidate, plans)}

Token: ${escapeHtml(token.name || token.symbol || "UNKNOWN")}
CA: <code>${escapeHtml(token.ca || "-")}</code>
Chain: ${escapeHtml(token.chainId || "-")}
Score: ${safeNum(candidate?.score, 0)}
Trading mode: ${escapeHtml(candidate?.tradingMode || this.getTradingMode())}
Discovery bucket: ${escapeHtml(candidate?.discoveryBucket || "-")}
Discovery source: ${escapeHtml(candidate?.discoverySource || "-")}
Smart-wallet hits: ${safeNum(candidate?.smartWalletFeed?.walletHits, 0)}

Price: ${safeNum(token.price, 0)}
Liquidity: ${safeNum(token.liquidity, 0)}
Volume 1h: ${safeNum(token.volumeH1, 0)}
Volume 24h: ${safeNum(token.volumeH24, token.volume, 0)}
Txns 1h: ${safeNum(token.txnsH1, 0)}
Txns 24h: ${safeNum(token.txnsH24, token.txns, 0)}
FDV: ${safeNum(token.fdv, 0)}

⚠️ Rug: ${safeNum(candidate?.rug?.risk, 0)}
🛡️ Anti-Rug: ${escapeHtml(candidate?.antiRug?.verdict || '-')} | risk ${safeNum(candidate?.antiRug?.riskScore, 0)} | protection ${safeNum(candidate?.antiRug?.protectionScore, 0)}
🧟 Corpse: ${safeNum(candidate?.corpse?.score, 0)}
👥 Concentration: ${safeNum(candidate?.wallet?.concentration, 0)}
🤖 Bot Activity: ${safeNum(candidate?.bots?.botActivity, 0)}
🧠 Narrative: ${escapeHtml(candidate?.narrative?.verdict || "-")}
🌐 Socials: ${safeNum(candidate?.socials?.socialCount, 0)}
🧩 Token Type: ${escapeHtml(candidate?.mechanics?.tokenType || "-")}
🎁 Reward Model: ${escapeHtml(candidate?.mechanics?.rewardModel || "-")}
💵 Dex Paid: ${candidate?.dexPaid ? "yes" : "no"}

🫧 Scalp:
allow: ${scalp?.allow ? "yes" : "no"}
score: ${safeNum(scalp?.score, 0)}
mode: ${escapeHtml(scalp?.primaryMode || "-")}
passed: ${escapeHtml((scalp?.passedModes || []).join(", ") || "-")}
buy pressure m5/h1/h24: ${safeNum(scalpMetrics?.buyPressureM5, 0).toFixed(1)} / ${safeNum(scalpMetrics?.buyPressureH1, 0).toFixed(1)} / ${safeNum(scalpMetrics?.buyPressureH24, 0).toFixed(1)}
price m5/h1/h6/h24: ${safeNum(scalpMetrics?.priceM5, 0).toFixed(1)} / ${safeNum(scalpMetrics?.priceH1, 0).toFixed(1)} / ${safeNum(scalpMetrics?.priceH6, 0).toFixed(1)} / ${safeNum(scalpMetrics?.priceH24, 0).toFixed(1)}
vol/liq m5/h1/h24: ${safeNum(scalpMetrics?.volToLiqM5, 0).toFixed(1)} / ${safeNum(scalpMetrics?.volToLiqH1, 0).toFixed(1)} / ${safeNum(scalpMetrics?.volToLiqH24, 0).toFixed(1)}

↩️ Reversal:
allow: ${reversal?.allow ? "yes" : "no"}
score: ${safeNum(reversal?.score, 0)}
mode: ${escapeHtml(reversal?.primaryMode || "-")}
quiet accumulation: ${reversal?.quietAccumulation ? "yes" : "no"}
bottom pack: ${reversal?.bottomPack ? "yes" : "no"}
retention 30m / 2h: ${safeNum(reversalMetrics?.retention30m, 0).toFixed(1)} / ${safeNum(reversalMetrics?.retention2h, 0).toFixed(1)}
net control %: ${safeNum(reversalMetrics?.netControlPct, 0).toFixed(2)}
fresh wallets: ${safeNum(reversalMetrics?.freshWalletBuyCount, 0)} | reloads: ${safeNum(reversalMetrics?.reloadCount, 0)} | dip-buy ratio: ${safeNum(reversalMetrics?.dipBuyRatio, 0).toFixed(2)}

🧺 Holder accumulation:
tracked wallets: ${safeNum(holder?.trackedWallets, 0)}
fresh wallet cohort: ${safeNum(holder?.freshWalletBuyCount, 0)}
retention 30m: ${safeNum(holder?.retention30mPct, 0).toFixed(1)}%
retention 2h: ${safeNum(holder?.retention2hPct, 0).toFixed(1)}%
net accumulation pct: ${safeNum(holder?.netAccumulationPct, 0).toFixed(2)}%
net control pct: ${safeNum(holder?.netControlPct, 0).toFixed(2)}%
reload count: ${safeNum(holder?.reloadCount, 0)}
dip-buy ratio: ${safeNum(holder?.dipBuyRatio, 0).toFixed(2)}
bottom touches: ${safeNum(holder?.bottomTouches, 0)}
quiet accumulation pass: ${holder?.quietAccumulationPass ? "yes" : "no"}
bottom-pack reversal pass: ${holder?.bottomPackReversalPass ? "yes" : "no"}

🌊 Migration:
pair age min: ${safeNum(migration?.pairAgeMin, 0).toFixed(1)}
survivor score: ${safeNum(migration?.survivorScore, 0)}
liq/mcap %: ${safeNum(migration?.liqToMcapPct, 0).toFixed(1)}
vol/liq %: ${safeNum(migration?.volToLiqPct, 0).toFixed(1)}
passes: ${migration?.passes ? "yes" : "no"}

📣 Telegram Signal Source:
channels: ${safeNum(candidate?.telegramSignal?.channelHits, 0)}
source list: ${escapeHtml((candidate?.telegramSignal?.channels || []).join(", ") || "-")}
age min: ${safeNum(candidate?.telegramSignal?.newestAgeMin, 0).toFixed(1)}

👛 Wallet Cluster Intelligence:
cluster risk: ${escapeHtml(candidate?.holderAccumulation?.walletCluster?.clusterRisk || "-")} / ${safeNum(candidate?.holderAccumulation?.walletCluster?.clusterRiskScore, 0)}
young supply 7d: ${safeNum(candidate?.holderAccumulation?.walletCluster?.youngSupplyPct, 0).toFixed(1)}%
very young supply 3d: ${safeNum(candidate?.holderAccumulation?.walletCluster?.veryYoungSupplyPct, 0).toFixed(1)}%
same-day cluster: ${safeNum(candidate?.holderAccumulation?.walletCluster?.sameDayClusterCount, 0)} wallets / ${safeNum(candidate?.holderAccumulation?.walletCluster?.sameDayClusterSupplyPct, 0).toFixed(1)}%
same 15m buy-window: ${safeNum(candidate?.holderAccumulation?.walletCluster?.sameBuyWindowClusterCount, 0)} wallets
buy-size similarity CV: ${safeNum(candidate?.holderAccumulation?.walletCluster?.sameDayBuySizeCv, 999).toFixed(3)}
avg age: ${safeNum(candidate?.holderAccumulation?.walletCluster?.avgAgeDays, 0).toFixed(1)}d

🧬 Migration Accumulation:
allow: ${migrationAccumulation?.allow ? "yes" : "no"}
priority watch: ${migrationAccumulation?.priorityWatch ? "yes" : "no"}
probe eligible: ${migrationAccumulation?.probeEligible ? "yes" : "no"}
score: ${safeNum(migrationAccumulation?.score, 0)}
mode: ${escapeHtml(migrationAccumulation?.mode || "-")}
age window: ${migrationAccumulation?.ageWindow ? "yes" : "no"}
deep correction: ${migrationAccumulation?.deepCorrection ? "yes" : "no"}
still breathing: ${migrationAccumulation?.stillBreathing ? "yes" : "no"}
base stabilizing: ${migrationAccumulation?.baseStabilizing ? "yes" : "no"}
accumulation evidence: ${migrationAccumulation?.accumulationEvidence ? "yes" : "no"}

Narrative summary:
${escapeHtml(candidate?.narrative?.summary || "No narrative available.")}

Plans:
${escapeHtml(planLine)}

Links:
twitter: ${escapeHtml(socials.twitter || "-")}
telegram: ${escapeHtml(socials.telegram || "-")}
website: ${escapeHtml(socials.website || "-")}`;
  }

  async scanCA({ runtime, fetchTokenByCA, ca }) {
    const token = await fetchTokenByCA(ca);
    if (!token) return null;
    if (!isSolanaChain(token?.chainId)) return null;

    const analyzed = this.analyzeToken(token);
    if (!isSolanaChain(analyzed?.token?.chainId)) return null;

    await this.enrichCandidateWithHolderLive(analyzed);

    const plans = this.buildPlans(analyzed, runtime?.strategyScope || "all");

    return {
      analyzed,
      plans,
      heroImage: token?.imageUrl || null
    };
  }

}
