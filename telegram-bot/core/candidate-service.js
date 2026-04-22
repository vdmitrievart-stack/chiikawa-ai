import GMGNMarketDiscoveryService from "./gmgn-market-discovery-service.js";

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
    const ca = asText(row?.baseToken?.address || row?.token?.ca || row?.ca || row?.token?.address);
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

function uniqStrings(rows = []) {
  return [...new Set(rows.map((x) => asText(x)).filter(Boolean))];
}

function mergeLinks(a = [], b = []) {
  return [...a, ...b].filter((row) => row?.url);
}

export default class CandidateService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.searchQueries = options.searchQueries || [
      "solana meme",
      "pumpfun solana",
      "cto solana",
      "memecoin solana",
      "solana community takeover",
      "solana revival",
      "cto revival solana",
      "solana accumulation"
    ];
    this.holderAccumulationEngine = options.holderAccumulationEngine || null;
    this.maxHolderEnrichPerPass = Number(options.maxHolderEnrichPerPass || process.env.HOLDER_ENRICH_TOP_N || 24);
    this.dexEnrichLimit = Number(options.dexEnrichLimit || process.env.DEX_ENRICH_LIMIT || 36);
    this.gmgnDiscovery = options.gmgnDiscovery || new GMGNMarketDiscoveryService({ logger: this.logger });
  }

  async fetchDexSearch(query) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const json = await res.json();
      const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
      return pairs.filter((p) => isSolanaChain(p?.chainId));
    } catch (error) {
      this.logger.log("candidate-service search failed:", error.message);
      return [];
    }
  }

  async fetchDexTokenByCA(ca) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(ca)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
      const solPairs = pairs.filter((p) => isSolanaChain(p?.chainId));
      if (!solPairs.length) return null;
      return solPairs.sort(
        (a, b) =>
          safeNum(b?.liquidity?.usd, 0) - safeNum(a?.liquidity?.usd, 0) ||
          safeNum(b?.volume?.h24, 0) - safeNum(a?.volume?.h24, 0)
      )[0];
    } catch (error) {
      this.logger.log(`candidate-service dex token failed for ${ca}:`, error.message);
      return null;
    }
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
      links,
      sourceFlags: {
        dex: true,
        gmgn: false
      }
    };
  }

  toTokenFromDiscovery(item = {}) {
    const token = item?.token || {};
    return {
      ...token,
      links: Array.isArray(token?.links) ? token.links : [],
      sourceFlags: {
        dex: false,
        gmgn: true
      }
    };
  }

  mergeTokenData(primary = {}, overlay = {}) {
    return {
      ...primary,
      ...overlay,
      name: asText(overlay?.name || primary?.name, "UNKNOWN"),
      symbol: asText(overlay?.symbol || primary?.symbol, ""),
      ca: asText(overlay?.ca || primary?.ca, ""),
      pairAddress: asText(overlay?.pairAddress || primary?.pairAddress, ""),
      chainId: asText(overlay?.chainId || primary?.chainId, "solana"),
      dexId: asText(overlay?.dexId || primary?.dexId, ""),
      price: safeNum(overlay?.price, safeNum(primary?.price, 0)),
      liquidity: Math.max(safeNum(primary?.liquidity, 0), safeNum(overlay?.liquidity, 0)),
      volume: Math.max(safeNum(primary?.volume, 0), safeNum(overlay?.volume, 0)),
      volumeM5: Math.max(safeNum(primary?.volumeM5, 0), safeNum(overlay?.volumeM5, 0)),
      volumeH1: Math.max(safeNum(primary?.volumeH1, 0), safeNum(overlay?.volumeH1, 0)),
      volumeH6: Math.max(safeNum(primary?.volumeH6, 0), safeNum(overlay?.volumeH6, 0)),
      volumeH24: Math.max(safeNum(primary?.volumeH24, 0), safeNum(overlay?.volumeH24, 0)),
      buys: Math.max(safeNum(primary?.buys, 0), safeNum(overlay?.buys, 0)),
      sells: Math.max(safeNum(primary?.sells, 0), safeNum(overlay?.sells, 0)),
      buysM5: Math.max(safeNum(primary?.buysM5, 0), safeNum(overlay?.buysM5, 0)),
      sellsM5: Math.max(safeNum(primary?.sellsM5, 0), safeNum(overlay?.sellsM5, 0)),
      buysH1: Math.max(safeNum(primary?.buysH1, 0), safeNum(overlay?.buysH1, 0)),
      sellsH1: Math.max(safeNum(primary?.sellsH1, 0), safeNum(overlay?.sellsH1, 0)),
      txns: Math.max(safeNum(primary?.txns, 0), safeNum(overlay?.txns, 0)),
      txnsM5: Math.max(safeNum(primary?.txnsM5, 0), safeNum(overlay?.txnsM5, 0)),
      txnsH1: Math.max(safeNum(primary?.txnsH1, 0), safeNum(overlay?.txnsH1, 0)),
      txnsH6: Math.max(safeNum(primary?.txnsH6, 0), safeNum(overlay?.txnsH6, 0)),
      txnsH24: Math.max(safeNum(primary?.txnsH24, 0), safeNum(overlay?.txnsH24, 0)),
      fdv: Math.max(safeNum(primary?.fdv, 0), safeNum(overlay?.fdv, 0)),
      pairCreatedAt: safeNum(overlay?.pairCreatedAt, 0) || safeNum(primary?.pairCreatedAt, 0),
      url: asText(overlay?.url || primary?.url, ""),
      imageUrl: overlay?.imageUrl || primary?.imageUrl || null,
      description: asText(overlay?.description || primary?.description, ""),
      priceChangeM5: Math.abs(safeNum(overlay?.priceChangeM5, 0)) > 0 ? safeNum(overlay?.priceChangeM5, 0) : safeNum(primary?.priceChangeM5, 0),
      priceChangeH1: Math.abs(safeNum(overlay?.priceChangeH1, 0)) > 0 ? safeNum(overlay?.priceChangeH1, 0) : safeNum(primary?.priceChangeH1, 0),
      priceChangeH6: Math.abs(safeNum(overlay?.priceChangeH6, 0)) > 0 ? safeNum(overlay?.priceChangeH6, 0) : safeNum(primary?.priceChangeH6, 0),
      priceChangeH24: Math.abs(safeNum(overlay?.priceChangeH24, 0)) > 0 ? safeNum(overlay?.priceChangeH24, 0) : safeNum(primary?.priceChangeH24, 0),
      links: mergeLinks(primary?.links || [], overlay?.links || []),
      sourceFlags: {
        gmgn: Boolean(primary?.sourceFlags?.gmgn || overlay?.sourceFlags?.gmgn),
        dex: Boolean(primary?.sourceFlags?.dex || overlay?.sourceFlags?.dex)
      }
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
    const gmgnScore = safeNum(extra?.gmgnDiscoveryScore, 0);

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

    score += Math.min(18, gmgnScore * 0.22);

    return clamp(Math.round(score), 0, 99);
  }

  buildDiscoverySignals(token, gmgn = {}) {
    const volumeM5 = safeNum(token?.volumeM5, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const volumeH24 = safeNum(token?.volumeH24, token?.volume, 0);
    const txnsM5 = safeNum(token?.txnsM5, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
    const liquidity = safeNum(token?.liquidity, 0);
    const smartMoney = safeNum(gmgn?.smartMoney, 0);
    const holderCount = safeNum(gmgn?.holderCount, 0);
    const discoveryScore = safeNum(gmgn?.discoveryScore, 0);

    const volumeSpike = volumeH1 > 0 ? volumeM5 / Math.max(volumeH1, 1) : 0;
    const txnsSpike = txnsH1 > 0 ? txnsM5 / Math.max(txnsH1, 1) : 0;
    const volToLiqH1 = liquidity > 0 ? (volumeH1 / Math.max(liquidity, 1)) * 100 : 0;
    const attentionScore = clamp(
      Math.round(
        discoveryScore * 0.55 +
        Math.min(18, smartMoney / 4) +
        Math.min(14, holderCount / 300) +
        Math.min(16, volumeH24 / 30000)
      ),
      0,
      99
    );

    const impulsePass =
      volumeSpike >= 0.18 ||
      txnsSpike >= 0.18 ||
      volToLiqH1 >= 18 ||
      smartMoney >= 35 ||
      attentionScore >= 58;

    return {
      volumeSpike,
      txnsSpike,
      volToLiqH1,
      smartMoney,
      holderCount,
      attentionScore,
      impulsePass,
      primary: asText(gmgn?.topSource?.orderBy, "volume")
    };
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
    const volumeH24 = safeNum(token?.volumeH24, token?.volume, 0);
    const txnsM5 = safeNum(token?.txnsM5, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
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
    const discovery = extra?.discovery || {};

    const volToLiqM5 = liquidity > 0 ? (volumeM5 / Math.max(liquidity, 1)) * 100 : 0;
    const volToLiqH1 = liquidity > 0 ? (volumeH1 / Math.max(liquidity, 1)) * 100 : 0;
    const volToLiqH24 = liquidity > 0 ? (volumeH24 / Math.max(liquidity, 1)) * 100 : 0;

    const notScamEnough = rugRisk < 60 && developerVerdict !== "Bad" && liquidity >= 10000;

    const burstAttention =
      volumeH1 >= 5000 ||
      volumeH24 >= 60000 ||
      txnsH1 >= 80 ||
      txnsH24 >= 500 ||
      volToLiqH1 >= 25 ||
      safeNum(discovery?.volumeSpike, 0) >= 0.2 ||
      safeNum(discovery?.txnsSpike, 0) >= 0.2;

    const burstDemand = buyPressureH1 >= 54 || buyPressureM5 >= 56;
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
    if (safeNum(discovery?.attentionScore, 0) >= 60) hypeBurstScore += 10;
    if (priceM5 > 12 || priceH1 > 35) hypeBurstScore -= 14;

    const hypeBurstPass = notScamEnough && burstAttention && burstDemand && burstPriceHealthy && hypeBurstScore >= 58;

    const migrationFlush = priceH6 <= -8 || priceH24 <= -15;
    const migrationReclaim = priceM5 > 0 && (buyPressureM5 >= 58 || buyPressureH1 >= 55);
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

    const migrationReboundPass = notScamEnough && migrationFlowAlive && migrationFlush && migrationReclaim && migrationReboundScore >= 56;

    const volatilityHigh =
      Math.abs(priceH1) >= 8 ||
      Math.abs(priceH6) >= 18 ||
      volToLiqH24 >= 70 ||
      txnsH1 >= 100;
    const formingBottom = priceH6 < 0 && priceH1 > -8 && priceM5 > 0;
    const reclaimPressure = buyPressureM5 >= 58 && (buyPressureM5 >= buyPressureH1 || buyPressureH1 >= 52);
    const accumulationSigns = txnsM5 >= 12 || txnsH1 >= 60 || volumeM5 >= 1200 || volumeH1 >= 5000;

    let volatilityReclaimScore = 0;
    if (pairAgeMin <= 10080) volatilityReclaimScore += 8;
    if (volatilityHigh) volatilityReclaimScore += 20;
    if (formingBottom) volatilityReclaimScore += 18;
    if (reclaimPressure) volatilityReclaimScore += 18;
    if (accumulationSigns) volatilityReclaimScore += 14;
    if (socialCount >= 1) volatilityReclaimScore += 6;
    if (liquidity >= 15000) volatilityReclaimScore += 8;
    if (safeNum(discovery?.attentionScore, 0) >= 58) volatilityReclaimScore += 8;
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

    const primaryMode = passedModes.sort((a, b) => safeNum(modeScores[b], 0) - safeNum(modeScores[a], 0))[0] || "";
    const scalpScore = clamp(Math.max(hypeBurstScore, migrationReboundScore, volatilityReclaimScore), 0, 99);
    const allow = passedModes.length > 0 && scalpScore >= 58 && notScamEnough;

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
        pairAgeMin,
        discoveryAttention: safeNum(discovery?.attentionScore, 0),
        volumeSpike: safeNum(discovery?.volumeSpike, 0),
        txnsSpike: safeNum(discovery?.txnsSpike, 0)
      }
    };
  }

  buildReversalSignals(candidate = {}) {
    const token = candidate?.token || {};
    const holder = candidate?.holderAccumulation || {};
    const migration = candidate?.migration || {};
    const scalpMetrics = candidate?.scalp?.metrics || {};
    const trap = candidate?.trap || {};

    const priceM5 = safeNum(candidate?.delta?.priceM5Pct, safeNum(token?.priceChangeM5, 0));
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, safeNum(token?.priceChangeH1, 0));
    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, safeNum(token?.priceChangeH6, 0));
    const priceH24 = safeNum(candidate?.delta?.priceH24Pct, safeNum(token?.priceChangeH24, 0));

    const buyPressureM5 = safeNum(scalpMetrics?.buyPressureM5, buyPressurePct(token?.buysM5, token?.sellsM5));
    const buyPressureH1 = safeNum(scalpMetrics?.buyPressureH1, buyPressurePct(token?.buysH1, token?.sellsH1));
    const buyPressureH24 = safeNum(scalpMetrics?.buyPressureH24, buyPressurePct(token?.buys, token?.sells));

    const liquidity = safeNum(token?.liquidity, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);
    const socialCount = safeNum(candidate?.socials?.socialCount, 0);
    const marketCap = safeNum(token?.fdv, 0) > 0 ? safeNum(token?.fdv, 0) : safeNum(token?.marketCap, 0);

    const pairAgeMin = safeNum(migration?.pairAgeMin, 0);
    const pairAgeHours = pairAgeMin / 60;
    const tacticalAgeWindow = pairAgeHours >= 1 && pairAgeHours <= 24 * 10;
    const forgottenAgeWindow = pairAgeHours > 24 * 10;
    const tacticalMcWindow = marketCap >= 5000 && marketCap <= 30000;
    const acceptableMcWindow = marketCap >= 5000 && marketCap <= 90000;

    const classicalFlush = priceH6 <= -12 || priceH24 <= -22 || (pairAgeMin <= 720 && priceH1 <= -5);
    const softFlush = priceH6 <= -6 || priceH24 <= -10 || priceH1 <= -3;
    const baseForming = priceH1 > -12 && priceM5 > -5 && Math.abs(priceM5) <= 8;
    const sellerExhaustion = buyPressureM5 >= 51 && buyPressureM5 >= (buyPressureH1 - 2);
    const reclaimPressure = priceM5 > -1 && buyPressureM5 >= 54 && buyPressureH1 >= 50;
    const accumulationBase = safeNum(candidate?.accumulation?.score, 0) >= 10 || safeNum(candidate?.absorption?.score, 0) >= 10;
    const liquidityAlive = liquidity >= 9000 && volumeH1 >= 1500 && txnsH1 >= 20;

    const warehouseWalletCount = safeNum(holder?.freshWalletBuyCount, 0);
    const warehouseRetention30m = safeNum(holder?.retention30mPct, 0);
    const warehouseRetention2h = safeNum(holder?.retention2hPct, 0);
    const warehouseReloadCount = safeNum(holder?.reloadCount, 0);
    const warehouseDipBuyRatio = safeNum(holder?.dipBuyRatio, 0);
    const warehouseBottomTouches = safeNum(holder?.bottomTouches, 0);
    const warehouseNetAccumulationPct = safeNum(holder?.netAccumulationPct, 0);
    const warehouseNetControlPct = safeNum(holder?.netControlPct, 0);

    const warehouseWalletsStrong = warehouseWalletCount >= 12;
    const warehouseRetentionStrong = warehouseRetention30m >= 35 || warehouseRetention2h >= 22;
    const warehouseReloadStrong = warehouseReloadCount >= 3 && warehouseDipBuyRatio >= 0.45;
    const warehouseBottomStructure = warehouseBottomTouches >= 2;
    const warehouseStorageBehavior = warehouseWalletsStrong && (warehouseRetentionStrong || warehouseReloadStrong || warehouseBottomStructure);
    const quietAccumulation = Boolean(holder?.quietAccumulationPass) || warehouseStorageBehavior;
    const bottomPack = Boolean(holder?.bottomPackReversalPass) || (warehouseStorageBehavior && warehouseReloadStrong && warehouseBottomStructure);

    const warehouseBaseCandidate = tacticalAgeWindow && acceptableMcWindow && warehouseStorageBehavior && liquidityAlive;
    const forgottenRevivalCandidate = forgottenAgeWindow && warehouseStorageBehavior && liquidityAlive && baseForming && sellerExhaustion;
    const storageCohortReversal = warehouseStorageBehavior && (baseForming || warehouseBottomStructure) && reclaimPressure && acceptableMcWindow;

    const runnerLikeContinuation = Boolean(
      !forgottenAgeWindow &&
      (priceH1 >= 18 || priceH6 >= 60 || priceH24 >= 140) &&
      priceM5 > -4 &&
      buyPressureH1 >= 52 &&
      buyPressureH24 >= 50
    );

    const migrationBaseReversal = Boolean(
      migration?.passes &&
      classicalFlush &&
      baseForming &&
      reclaimPressure &&
      !runnerLikeContinuation
    );

    const olderBaseCandidate = forgottenAgeWindow || forgottenRevivalCandidate;

    let score = 0;
    if (classicalFlush) score += 18;
    else if (softFlush) score += 9;
    if (baseForming) score += 14;
    if (sellerExhaustion) score += 14;
    if (reclaimPressure) score += 18;
    if (accumulationBase) score += 10;
    if (liquidityAlive) score += 10;
    if (socialCount >= 1) score += 4;
    if (tacticalMcWindow) score += 12;
    else if (acceptableMcWindow) score += 6;
    if (tacticalAgeWindow) score += 8;
    if (warehouseWalletsStrong) score += 8;
    if (warehouseRetentionStrong) score += 10;
    if (warehouseReloadStrong) score += 10;
    if (warehouseBottomStructure) score += 10;
    if (quietAccumulation) score += 12;
    if (bottomPack) score += 14;
    if (forgottenRevivalCandidate) score += 12;
    if (storageCohortReversal) score += 10;
    if (migrationBaseReversal) score += 8;
    if (runnerLikeContinuation) score -= 18;
    if (buyPressureH24 < 45) score -= 8;
    if (priceM5 > 12) score -= 6;
    if (trap?.reject) score -= 50;

    const notScamEnough = !trap?.reject && safeNum(candidate?.rug?.risk, 0) < 65 && asText(candidate?.developer?.verdict, 'Neutral') !== 'Bad' && !candidate?.corpse?.isCorpse;

    const allow = Boolean(
      notScamEnough &&
      liquidityAlive &&
      !runnerLikeContinuation &&
      score >= 60 &&
      (
        migrationBaseReversal ||
        (classicalFlush && baseForming && reclaimPressure) ||
        storageCohortReversal ||
        warehouseBaseCandidate ||
        forgottenRevivalCandidate ||
        (quietAccumulation && baseForming && sellerExhaustion && reclaimPressure)
      )
    );

    const passedModes = [];
    if (migrationBaseReversal && allow) passedModes.push('migration_base_reversal');
    if (storageCohortReversal && allow) passedModes.push('storage_cohort_reversal');
    if (warehouseBaseCandidate && allow) passedModes.push('warehouse_base_reversal');
    if (forgottenRevivalCandidate && allow) passedModes.push('forgotten_revival_reversal');
    if (allow && passedModes.length === 0) passedModes.push('base_reclaim_reversal');

    const primaryMode = passedModes[0] || (migrationBaseReversal ? 'migration_base_reversal' : forgottenRevivalCandidate ? 'forgotten_revival_reversal' : warehouseBaseCandidate ? 'warehouse_base_reversal' : storageCohortReversal ? 'storage_cohort_reversal' : 'base_reclaim_reversal');

    return {
      allow,
      score: clamp(Math.round(score), 0, 99),
      primaryMode,
      passedModes,
      quietAccumulation,
      bottomPack,
      olderBaseCandidate,
      warehouseBaseCandidate,
      forgottenRevivalCandidate,
      storageCohortReversal,
      flushDetected: classicalFlush || softFlush,
      classicFlush: classicalFlush,
      softFlush,
      baseForming,
      sellerExhaustion,
      reclaimPressure,
      runnerLikeContinuation,
      metrics: {
        priceM5,
        priceH1,
        priceH6,
        priceH24,
        buyPressureM5,
        buyPressureH1,
        buyPressureH24,
        pairAgeHours,
        marketCap,
        retention30m: warehouseRetention30m,
        retention2h: warehouseRetention2h,
        netAccumulationPct: warehouseNetAccumulationPct,
        netControlPct: warehouseNetControlPct,
        freshWalletBuyCount: warehouseWalletCount,
        reloadCount: warehouseReloadCount,
        dipBuyRatio: warehouseDipBuyRatio,
        bottomTouches: warehouseBottomTouches,
        warehouseWalletsStrong,
        warehouseStorageBehavior,
        tacticalMcWindow,
        tacticalAgeWindow,
        forgottenAgeWindow
      }
    };
  }

  buildTrapSignals(candidate = {}, liveToken = null) {
    const baseline = candidate?.token || {};
    const latest = liveToken || baseline;
    const baselineLiquidity = safeNum(baseline?.liquidity, 0);
    const latestLiquidity = safeNum(latest?.liquidity, baselineLiquidity);
    const liqDropPct = baselineLiquidity > 0
      ? ((baselineLiquidity - latestLiquidity) / Math.max(baselineLiquidity, 1)) * 100
      : 0;

    const removeUsd = safeNum(candidate?.gmgn?.recentRemoveUsd, safeNum(candidate?.discovery?.recentRemoveUsd, 0));
    const removeFlag = Boolean(candidate?.gmgn?.hasRecentRemove || candidate?.discovery?.hasRecentRemove || candidate?.token?.hasRecentRemove);
    const freshLargeRemove = removeFlag && (removeUsd >= 5000 || removeUsd >= baselineLiquidity * 0.2);
    const lowLiquidity = latestLiquidity < 8000;
    const microLiquidity = latestLiquidity < 1500;
    const liquidityCollapse = baselineLiquidity >= 15000 && latestLiquidity <= baselineLiquidity * 0.25;
    const extremeFdvToLiq = latestLiquidity > 0 && safeNum(latest?.fdv, safeNum(baseline?.fdv, 0)) / Math.max(latestLiquidity, 1) > 35;
    const suspiciousCollapse = liqDropPct >= 55 && extremeFdvToLiq;

    const reasons = [];
    if (freshLargeRemove) reasons.push('recent large liquidity remove detected');
    if (microLiquidity) reasons.push('live liquidity is near zero');
    else if (lowLiquidity) reasons.push('live liquidity too low');
    if (liquidityCollapse) reasons.push('live liquidity collapsed versus discovery snapshot');
    if (suspiciousCollapse) reasons.push('fdv/liquidity profile collapsed into trap shape');

    const severityScore =
      (freshLargeRemove ? 45 : 0) +
      (microLiquidity ? 40 : 0) +
      (lowLiquidity ? 20 : 0) +
      (liquidityCollapse ? 30 : 0) +
      (suspiciousCollapse ? 20 : 0);

    const reject = freshLargeRemove || microLiquidity || lowLiquidity || liquidityCollapse || suspiciousCollapse;

    return {
      reject,
      severity: severityScore >= 70 ? 'high' : severityScore >= 40 ? 'medium' : 'low',
      lowLiquidity,
      microLiquidity,
      liquidityCollapse,
      freshLargeRemove,
      baselineLiquidity,
      latestLiquidity,
      liqDropPct,
      removeUsd,
      reasons
    };
  }

  buildRunnerSignals(candidate = {}) {
    const token = candidate?.token || {};
    const migration = candidate?.migration || {};
    const reversal = candidate?.reversal || {};
    const trap = candidate?.trap || {};
    const scalpMetrics = candidate?.scalp?.metrics || {};

    const priceM5 = safeNum(candidate?.delta?.priceM5Pct, safeNum(token?.priceChangeM5, 0));
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, safeNum(token?.priceChangeH1, 0));
    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, safeNum(token?.priceChangeH6, 0));
    const priceH24 = safeNum(candidate?.delta?.priceH24Pct, safeNum(token?.priceChangeH24, 0));
    const buyPressureH1 = safeNum(scalpMetrics?.buyPressureH1, buyPressurePct(token?.buysH1, token?.sellsH1));
    const buyPressureH24 = safeNum(scalpMetrics?.buyPressureH24, buyPressurePct(token?.buys, token?.sells));
    const liquidity = safeNum(token?.liquidity, 0);
    const volumeH1 = safeNum(token?.volumeH1, 0);
    const txnsH1 = safeNum(token?.txnsH1, 0);

    const pairAgeMin = safeNum(migration?.pairAgeMin, 0);
    const strongContinuation = priceH1 >= 18 || priceH6 >= 55 || priceH24 >= 120;
    const demandStrong = buyPressureH1 >= 52 && buyPressureH24 >= 50;
    const healthyPullback = priceM5 > -4 && priceM5 <= 12;
    const liquidityAlive = liquidity >= 12000 && volumeH1 >= 2500 && txnsH1 >= 30;
    const olderBaseCandidate = pairAgeMin >= 3 * 24 * 60;
    const postMigrationContinuation = migration?.passes && pairAgeMin <= 6 * 60 && !reversal?.flushDetected && strongContinuation && demandStrong && healthyPullback;
    const classicRunner = !olderBaseCandidate && safeNum(candidate?.score, 0) >= 84 && priceH1 > 0 && safeNum(candidate?.absorption?.score, 0) >= 8 && strongContinuation && healthyPullback && demandStrong;

    let score = 0;
    if (strongContinuation) score += 24;
    if (demandStrong) score += 18;
    if (healthyPullback) score += 14;
    if (liquidityAlive) score += 12;
    if (postMigrationContinuation) score += 20;
    if (classicRunner) score += 12;
    if (priceM5 > 14) score -= 10;
    if (trap?.reject) score -= 40;

    const allow =
      !trap?.reject &&
      !olderBaseCandidate &&
      safeNum(candidate?.rug?.risk, 0) < 65 &&
      asText(candidate?.developer?.verdict, 'Neutral') !== 'Bad' &&
      !candidate?.corpse?.isCorpse &&
      (postMigrationContinuation || classicRunner) &&
      score >= 62;

    return {
      allow,
      score: clamp(Math.round(score), 0, 99),
      primaryMode: postMigrationContinuation ? 'migration_continuation_runner' : 'runner_continuation',
      strongContinuation,
      demandStrong,
      healthyPullback,
      postMigrationContinuation
    };
  }

  recomputeCompositeScore(candidate = {}) {
    let score = safeNum(candidate?.score, 0);
    if (candidate?.scalp?.allow) {
      score = Math.max(score, Math.round(score * 0.65 + safeNum(candidate?.scalp?.score, 0) * 0.35));
    }
    if (candidate?.reversal?.allow) {
      score = Math.max(score, Math.round(score * 0.55 + safeNum(candidate?.reversal?.score, 0) * 0.45));
    }
    if (candidate?.runner?.allow) {
      score = Math.max(score, Math.round(score * 0.55 + safeNum(candidate?.runner?.score, 0) * 0.45));
    }
    if (candidate?.migration?.passes) {
      score = Math.max(score, Math.round(score * 0.7 + safeNum(candidate?.migration?.survivorScore, 0) * 0.3));
    }
    candidate.score = clamp(score, 0, 99);
    return candidate;
  }

  async enrichCandidateWithHolderLive(candidate = {}) {
    if (!candidate) return candidate;

    if (this.holderAccumulationEngine) {
      try {
        const holderAccumulation = await this.holderAccumulationEngine.trackCandidate(candidate);
        candidate.holderAccumulation = holderAccumulation || null;
      } catch (error) {
        this.logger.log('holder enrich failed:', error.message);
      }
    }

    const ca = asText(candidate?.token?.ca);
    if (ca) {
      try {
        const livePair = await this.fetchDexTokenByCA(ca);
        if (livePair) {
          const liveToken = this.toTokenFromPair(livePair);
          this.applyLiveTokenSnapshot(candidate, liveToken);
        }
      } catch (error) {
        this.logger.log('live dex refresh failed:', error.message);
      }
    }

    candidate.trap = this.buildTrapSignals(candidate, candidate?.liveToken || null);
    candidate.reversal = this.buildReversalSignals(candidate);
    candidate.runner = this.buildRunnerSignals(candidate);
    return this.recomputeCompositeScore(candidate);
  }

  buildReversalPlan(candidate = {}) {
    const reversal = candidate?.reversal || {};
    const mode = asText(reversal?.primaryMode, "base_reclaim_reversal");

    const base = {
      strategyKey: "reversal",
      thesis: "GMGN-first bottom reclaim reversal on Solana",
      plannedHoldMs: 45 * 60 * 1000,
      stopLossPct: 4.6,
      takeProfitPct: 9.5,
      runnerTargetsPct: [],
      signalScore: safeNum(reversal?.score, safeNum(candidate?.score, 0)),
      expectedEdgePct: 9,
      entryMode: "SCALED",
      planName: "Reversal",
      objective: "bounce capture"
    };

    if (mode === "bottom_pack_reversal") {
      return { ...base, thesis: "Quiet accumulation / bottom-pack reversal", plannedHoldMs: 55 * 60 * 1000, stopLossPct: 4.2, takeProfitPct: 11, expectedEdgePct: 11, planName: "Bottom Pack Reversal", objective: "quiet accumulation reclaim" };
    }
    if (mode === "migration_base_reversal") {
      return { ...base, thesis: "Post-migration base reversal", plannedHoldMs: 50 * 60 * 1000, stopLossPct: 4.8, takeProfitPct: 10, expectedEdgePct: 10, entryMode: "PROBE", planName: "Migration Base Reversal", objective: "post-migration bounce" };
    }
    return base;
  }

  buildRunnerPlan(candidate = {}) {
    const runner = candidate?.runner || {};
    const mode = asText(runner?.primaryMode, 'runner_continuation');

    const base = {
      strategyKey: 'runner',
      thesis: 'Strong Solana continuation runner',
      plannedHoldMs: 4 * 60 * 60 * 1000,
      stopLossPct: 7,
      takeProfitPct: 24,
      runnerTargetsPct: [12, 22, 35],
      signalScore: safeNum(runner?.score, safeNum(candidate?.score, 0)),
      expectedEdgePct: 18,
      entryMode: 'SCALED',
      planName: 'Runner',
      objective: 'trend expansion'
    };

    if (mode === 'migration_continuation_runner') {
      return {
        ...base,
        thesis: 'Post-migration continuation runner',
        plannedHoldMs: 3 * 60 * 60 * 1000,
        stopLossPct: 6.5,
        takeProfitPct: 22,
        runnerTargetsPct: [10, 18, 30],
        expectedEdgePct: 17,
        planName: 'Migration Continuation Runner',
        objective: 'post-migration continuation'
      };
    }

    return base;
  }

  getPrimaryCategory(candidate = {}, plans = []) {
    const keys = new Set((plans || []).map((p) => asText(p?.strategyKey)));
    const reversal = candidate?.reversal || {};
    const runner = candidate?.runner || {};

    if (candidate?.trap?.reject) return 'TRAP';
    if (reversal?.allow && (reversal?.olderBaseCandidate || reversal?.warehouseBaseCandidate || reversal?.forgottenRevivalCandidate || reversal?.storageCohortReversal || reversal?.bottomPack)) return 'REVERSAL';
    if (keys.has('runner') || runner?.allow) return 'RUNNER';
    if (keys.has('migration_survivor') || candidate?.migration?.passes) return 'MIGRATION_SURVIVOR';
    if (keys.has('reversal') || reversal?.allow) return 'REVERSAL';
    if (keys.has('scalp') || candidate?.scalp?.allow) return 'SCALP';
    if (keys.has('copytrade')) return 'COPYTRADE';
    return 'WATCH';
  }

  buildPlans(candidate, strategyScope = "all") {
    if (candidate?.trap?.reject) {
      return [];
    }

    const plans = [];
    const score = safeNum(candidate?.score, 0);

    if (score >= 70) {
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

    if (candidate?.scalp?.allow) {
      plans.push(this.buildScalpPlan(candidate));
    }

    if (candidate?.reversal?.allow) {
      plans.push(this.buildReversalPlan(candidate));
    }

    if (candidate?.runner?.allow) {
      plans.push(this.buildRunnerPlan(candidate));
    }

    if (candidate?.migration?.passes) {
      plans.push({
        strategyKey: "migration_survivor",
        thesis: "Post-migration survivor with retained demand",
        plannedHoldMs: 3 * 60 * 60 * 1000,
        stopLossPct: 8,
        takeProfitPct: 0,
        runnerTargetsPct: [25, 50, 80],
        signalScore: Math.max(score, safeNum(candidate?.migration?.survivorScore, 0)),
        expectedEdgePct: 22,
        entryMode: "SCALED",
        planName: "Migration Survivor",
        objective: "post-migration expansion"
      });
    }

    if (strategyScope && strategyScope !== "all") {
      return plans.filter((p) => p.strategyKey === strategyScope);
    }

    return plans;
  }

  getRelevantRank(candidate, strategyScope = "all") {
    if (!candidate) return 0;

    if (strategyScope === "scalp") {
      return candidate?.scalp?.allow
        ? safeNum(candidate?.scalp?.score, 0) + safeNum(candidate?.discovery?.attentionScore, 0) * 0.2
        : 0;
    }

    if (strategyScope === "reversal") {
      const reversal = candidate?.reversal || {};
      const holder = candidate?.holderAccumulation || {};
      const tacticalMcBonus = reversal?.metrics?.tacticalMcWindow ? 10 : reversal?.metrics?.marketCap >= 5000 && reversal?.metrics?.marketCap <= 90000 ? 4 : -6;
      const ageBonus = reversal?.metrics?.tacticalAgeWindow ? 8 : reversal?.olderBaseCandidate ? 5 : 0;
      const storageBonus = safeNum(holder?.freshWalletBuyCount, 0) * 0.6 + safeNum(holder?.reloadCount, 0) * 1.2 + safeNum(holder?.bottomTouches, 0) * 2;
      return reversal?.allow
        ? safeNum(reversal?.score, 0) + tacticalMcBonus + ageBonus + storageBonus + safeNum(holder?.netControlPct, 0) * 0.6
        : 0;
    }

    if (strategyScope === "migration_survivor") {
      return candidate?.migration?.passes && !candidate?.trap?.reject
        ? safeNum(candidate?.migration?.survivorScore, 0)
        : 0;
    }

    if (strategyScope === "runner") {
      return candidate?.runner?.allow
        ? safeNum(candidate?.runner?.score, 0) + safeNum(candidate?.discovery?.attentionScore, 0) * 0.35
        : 0;
    }

    if (strategyScope === "copytrade") {
      return safeNum(candidate?.score, 0);
    }

    return Math.max(
      safeNum(candidate?.score, 0),
      safeNum(candidate?.migration?.survivorScore, 0),
      safeNum(candidate?.scalp?.score, 0),
      safeNum(candidate?.reversal?.score, 0),
      safeNum(candidate?.runner?.score, 0)
    );
  }

  async fetchMarketCandidates() {
    const gmgnCandidates = await this.buildAnalyzedFromGMGN();
    const dexFallback = await this.buildAnalyzedFromDexFallback();

    const merged = new Map();
    for (const row of [...gmgnCandidates, ...dexFallback]) {
      const ca = asText(row?.token?.ca);
      if (!ca) continue;
      const prev = merged.get(ca);
      if (!prev || safeNum(row?.score, 0) > safeNum(prev?.score, 0)) merged.set(ca, row);
    }

    const preliminary = [...merged.values()]
      .filter((candidate) => isSolanaChain(candidate?.token?.chainId))
      .filter((candidate) => {
        const fdv = safeNum(candidate?.token?.fdv, 0);
        const pairAgeHours = safeNum(candidate?.migration?.pairAgeMin, 0) / 60;
        const reversalWatch = (fdv >= 5000 && fdv <= 90000 && pairAgeHours <= 24 * 10) || safeNum(candidate?.accumulation?.score, 0) >= 8 || safeNum(candidate?.absorption?.score, 0) >= 8;
        return safeNum(candidate?.score, 0) >= 56 || Boolean(candidate?.migration?.passes) || Boolean(candidate?.scalp?.allow) || Boolean(candidate?.discovery?.impulsePass) || reversalWatch;
      })
      .sort((a, b) => this.getRelevantRank(b, "all") - this.getRelevantRank(a, "all"));

    const topForHolder = preliminary.slice(0, this.maxHolderEnrichPerPass);
    for (const candidate of topForHolder) {
      await this.enrichCandidateWithHolderLive(candidate);
    }
    for (const candidate of preliminary.slice(this.maxHolderEnrichPerPass)) {
      candidate.trap = this.buildTrapSignals(candidate, candidate?.liveToken || null);
      candidate.reversal = this.buildReversalSignals(candidate);
      candidate.runner = this.buildRunnerSignals(candidate);
      this.recomputeCompositeScore(candidate);
    }

    return preliminary.sort((a, b) => this.getRelevantRank(b, "all") - this.getRelevantRank(a, "all"));
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

    const enrichCount = strategyScope === 'reversal'
      ? Math.max(this.maxHolderEnrichPerPass, 40)
      : Math.max(this.maxHolderEnrichPerPass, 12);

    for (const candidate of ranked.slice(0, enrichCount)) {
      await this.enrichCandidateWithHolderLive(candidate);
    }
    for (const candidate of ranked.slice(enrichCount)) {
      candidate.trap = this.buildTrapSignals(candidate, candidate?.liveToken || null);
      candidate.reversal = this.buildReversalSignals(candidate);
      candidate.runner = this.buildRunnerSignals(candidate);
      this.recomputeCompositeScore(candidate);
    }

    ranked = ranked
      .filter((row) => !row?.trap?.reject)
      .filter((row) => {
        const plans = this.buildPlans(row, strategyScope);
        return plans.length > 0;
      })
      .sort((a, b) => this.getRelevantRank(b, strategyScope) - this.getRelevantRank(a, strategyScope));

    const candidate = ranked[0] || null;
    if (!candidate) return null;

    const plans = this.buildPlans(candidate, strategyScope);
    if (!plans.length) return null;

    return {
      candidate,
      plans,
      heroImage: candidate?.token?.imageUrl || null
    };
  }

  buildHeroCaption(candidate) {
    const token = candidate?.token || {};
    const category = this.getPrimaryCategory(candidate, this.buildPlans(candidate, 'all'));
    return `🧭 <b>${escapeHtml(token.name || token.symbol || "UNKNOWN")}</b>
category: ${escapeHtml(category)}
source: ${escapeHtml(candidate?.discoverySource || "-")}
primary: ${escapeHtml(candidate?.discoveryPrimary || "-")}
score: ${safeNum(candidate?.score, 0)}
reversal score: ${safeNum(candidate?.reversal?.score, 0)}
reversal mode: ${escapeHtml(candidate?.reversal?.primaryMode || "-")}
runner score: ${safeNum(candidate?.runner?.score, 0)}
runner mode: ${escapeHtml(candidate?.runner?.primaryMode || "-")}
scalp score: ${safeNum(candidate?.scalp?.score, 0)}
scalp mode: ${escapeHtml(candidate?.scalp?.primaryMode || "-")}
trap: ${candidate?.trap?.reject ? 'YES' : 'no'}
gmgn attention: ${safeNum(candidate?.discovery?.attentionScore, 0)}
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
    const planLine = plans.length
      ? plans.map((p) => String(p?.strategyKey || '').toUpperCase()).join(', ')
      : 'none';
    const migration = candidate?.migration || {};
    const scalp = candidate?.scalp || {};
    const scalpMetrics = scalp?.metrics || {};
    const holder = candidate?.holderAccumulation || {};
    const reversal = candidate?.reversal || {};
    const discovery = candidate?.discovery || {};
    const runner = candidate?.runner || {};
    const trap = candidate?.trap || {};
    const category = this.getPrimaryCategory(candidate, plans);

    return `🔎 <b>ANALYSIS • CATEGORY: ${escapeHtml(category)}</b>

<b>Token:</b> <b>${escapeHtml(token.name || token.symbol || "UNKNOWN")}</b>
📋 <b>CONTRACT</b>
<code>${escapeHtml(token.ca || "-")}</code>
<b>Chain:</b> ${escapeHtml(token.chainId || "-")}
<b>Score:</b> ${safeNum(candidate?.score, 0)}

<b>Discovery source:</b> ${escapeHtml(candidate?.discoverySource || "-")}
<b>Discovery primary:</b> ${escapeHtml(candidate?.discoveryPrimary || "-")}
<b>GMGN attention:</b> ${safeNum(discovery?.attentionScore, 0)}
<b>GMGN smart money:</b> ${safeNum(discovery?.smartMoney, 0)}
<b>GMGN holder count:</b> ${safeNum(discovery?.holderCount, 0)}
<b>Volume spike m5/h1:</b> ${safeNum(discovery?.volumeSpike, 0).toFixed(2)}
<b>Txns spike m5/h1:</b> ${safeNum(discovery?.txnsSpike, 0).toFixed(2)}

<b>Price:</b> ${safeNum(token.price, 0)}
<b>Liquidity:</b> ${safeNum(token.liquidity, 0)}
<b>Volume 1h:</b> ${safeNum(token.volumeH1, 0)}
<b>Volume 24h:</b> ${safeNum(token.volumeH24, token.volume, 0)}
<b>Txns 1h:</b> ${safeNum(token.txnsH1, 0)}
<b>Txns 24h:</b> ${safeNum(token.txnsH24, token.txns, 0)}
<b>FDV:</b> ${safeNum(token.fdv, 0)}

⚠️ <b>Rug:</b> ${safeNum(candidate?.rug?.risk, 0)}
🧟 <b>Corpse:</b> ${safeNum(candidate?.corpse?.score, 0)}
👥 <b>Concentration:</b> ${safeNum(candidate?.wallet?.concentration, 0)}
🤖 <b>Bot Activity:</b> ${safeNum(candidate?.bots?.botActivity, 0)}
🧠 <b>Narrative:</b> ${escapeHtml(candidate?.narrative?.verdict || "-")}
🌐 <b>Socials:</b> ${safeNum(candidate?.socials?.socialCount, 0)}
💵 <b>Dex Paid:</b> ${candidate?.dexPaid ? "yes" : "no"}

🧨 <b>Trap</b>
reject: ${trap?.reject ? 'yes' : 'no'}
severity: ${escapeHtml(trap?.severity || '-')}
live liquidity: ${safeNum(trap?.latestLiquidity, safeNum(token.liquidity, 0))}
liquidity drop: ${safeNum(trap?.liqDropPct, 0).toFixed(1)}%
reason: ${escapeHtml((trap?.reasons || []).join(' | ') || '-')}

🫧 <b>Scalp</b>
allow: ${scalp?.allow ? "yes" : "no"}
score: ${safeNum(scalp?.score, 0)}
mode: ${escapeHtml(scalp?.primaryMode || "-")}
passed: ${escapeHtml((scalp?.passedModes || []).join(", ") || "-")}
buy pressure m5/h1/h24: ${safeNum(scalpMetrics?.buyPressureM5, 0).toFixed(1)} / ${safeNum(scalpMetrics?.buyPressureH1, 0).toFixed(1)} / ${safeNum(scalpMetrics?.buyPressureH24, 0).toFixed(1)}
price m5/h1/h6/h24: ${safeNum(scalpMetrics?.priceM5, 0).toFixed(1)} / ${safeNum(scalpMetrics?.priceH1, 0).toFixed(1)} / ${safeNum(scalpMetrics?.priceH6, 0).toFixed(1)} / ${safeNum(scalpMetrics?.priceH24, 0).toFixed(1)}
vol/liq m5/h1/h24: ${safeNum(scalpMetrics?.volToLiqM5, 0).toFixed(1)} / ${safeNum(scalpMetrics?.volToLiqH1, 0).toFixed(1)} / ${safeNum(scalpMetrics?.volToLiqH24, 0).toFixed(1)}

🏃 <b>Runner</b>
allow: ${runner?.allow ? 'yes' : 'no'}
score: ${safeNum(runner?.score, 0)}
mode: ${escapeHtml(runner?.primaryMode || '-')}
continuation/demand/pullback: ${runner?.strongContinuation ? 'yes' : 'no'} / ${runner?.demandStrong ? 'yes' : 'no'} / ${runner?.healthyPullback ? 'yes' : 'no'}

🔁 <b>Reversal</b>
allow: ${reversal?.allow ? "yes" : "no"}
score: ${safeNum(reversal?.score, 0)}
mode: ${escapeHtml(reversal?.primaryMode || "-")}
passed: ${escapeHtml((reversal?.passedModes || []).join(", ") || "-")}
flush/base/exhaust/reclaim: ${reversal?.flushDetected ? "yes" : "no"} / ${reversal?.baseForming ? "yes" : "no"} / ${reversal?.sellerExhaustion ? "yes" : "no"} / ${reversal?.reclaimPressure ? "yes" : "no"}
warehouse/faded-old: ${reversal?.warehouseBaseCandidate ? "yes" : "no"} / ${reversal?.forgottenRevivalCandidate ? "yes" : "no"}
mc window / age window: ${reversal?.metrics?.tacticalMcWindow ? "yes" : "no"} / ${reversal?.metrics?.tacticalAgeWindow ? "yes" : "no"}

🧺 <b>Holder accumulation</b>
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

🌊 <b>Migration</b>
pair age min: ${safeNum(migration?.pairAgeMin, 0).toFixed(1)}
survivor score: ${safeNum(migration?.survivorScore, 0)}
liq/mcap %: ${safeNum(migration?.liqToMcapPct, 0).toFixed(1)}
vol/liq %: ${safeNum(migration?.volToLiqPct, 0).toFixed(1)}
passes: ${migration?.passes ? "yes" : "no"}

<b>Narrative summary:</b>
${escapeHtml(candidate?.narrative?.summary || "No narrative available.")}

<b>Plans:</b>
${escapeHtml(planLine)}

<b>Links:</b>
twitter: ${escapeHtml(socials.twitter || "-")}
telegram: ${escapeHtml(socials.telegram || "-")}
website: ${escapeHtml(socials.website || "-")}`;
  }

  async scanCA({ runtime, fetchTokenByCA, ca }) {
    const token = await fetchTokenByCA(ca);
    if (!token) return null;
    if (!isSolanaChain(token?.chainId)) return null;

    const analyzed = this.analyzeToken(token, { discoverySource: "ca_scan", discoveryPrimary: "ca_scan" });
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
