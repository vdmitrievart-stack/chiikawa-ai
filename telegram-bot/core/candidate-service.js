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
    this.holderAccumulationEngine = options.holderAccumulationEngine || null;
    this.maxHolderEnrichPerPass = Number(options.maxHolderEnrichPerPass || 8);
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

    let score = baseScore;
    if (scalp.allow) {
      score = Math.max(score, Math.round((baseScore * 0.55) + (safeNum(scalp.score, 0) * 0.45)));
    }
    if (migration.passes) {
      score = Math.max(score, Math.round((score * 0.7) + (safeNum(migration?.survivorScore, 0) * 0.3)));
    }
    score = clamp(score, 0, 99);

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

    return {
      token,
      score,
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
        bottomTouches: safeNum(holder?.bottomTouches, 0)
      }
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
    if (candidate?.migration?.passes) {
      score = Math.max(score, Math.round(score * 0.7 + safeNum(candidate?.migration?.survivorScore, 0) * 0.3));
    }
    candidate.score = clamp(score, 0, 99);
    return candidate;
  }

  async enrichCandidateWithHolderLive(candidate = {}) {
    if (!candidate || !this.holderAccumulationEngine) {
      candidate.reversal = this.buildReversalSignals(candidate);
      return this.recomputeCompositeScore(candidate);
    }

    try {
      const holderAccumulation = await this.holderAccumulationEngine.trackCandidate(candidate);
      candidate.holderAccumulation = holderAccumulation || null;
    } catch (error) {
      this.logger.log('holder enrich failed:', error.message);
    }

    candidate.reversal = this.buildReversalSignals(candidate);
    return this.recomputeCompositeScore(candidate);
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

  buildPlans(candidate, strategyScope = "all") {
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

    if (
      score >= 84 &&
      safeNum(candidate?.delta?.priceH1Pct, 0) > 0 &&
      safeNum(candidate?.absorption?.score, 0) >= 8
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

    if (strategyScope && strategyScope !== "all") {
      return plans.filter((p) => p.strategyKey === strategyScope);
    }

    return plans;
  }

  getRelevantRank(candidate, strategyScope = "all") {
    if (!candidate) return 0;

    if (strategyScope === "scalp") {
      return candidate?.scalp?.allow
        ? safeNum(candidate?.scalp?.score, 0) + safeNum(candidate?.token?.volumeH1, 0) / 2000
        : 0;
    }

    if (strategyScope === "reversal") {
      return candidate?.reversal?.allow
        ? safeNum(candidate?.reversal?.score, 0) + safeNum(candidate?.holderAccumulation?.netControlPct, 0) * 2
        : 0;
    }

    if (strategyScope === "migration_survivor") {
      return candidate?.migration?.passes
        ? safeNum(candidate?.migration?.survivorScore, 0)
        : 0;
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
      safeNum(candidate?.reversal?.score, 0)
    );
  }

  async fetchMarketCandidates() {
    const chunks = await Promise.all(
      this.searchQueries.map((q) => this.fetchDexSearch(q))
    );

    const pairs = dedupeByCA(chunks.flat()).filter((p) => isSolanaChain(p?.chainId));

    return pairs
      .map((pair) => this.analyzePair(pair))
      .filter((candidate) => isSolanaChain(candidate?.token?.chainId))
      .filter((candidate) => {
        return (
          safeNum(candidate?.score, 0) >= 62 ||
          Boolean(candidate?.migration?.passes) ||
          Boolean(candidate?.scalp?.allow) ||
          safeNum(candidate?.accumulation?.score, 0) >= 8
        );
      })
      .sort((a, b) => {
        const bScore = Math.max(
          safeNum(b?.score, 0),
          safeNum(b?.migration?.survivorScore, 0),
          safeNum(b?.scalp?.score, 0),
          safeNum(b?.reversal?.score, 0)
        );
        const aScore = Math.max(
          safeNum(a?.score, 0),
          safeNum(a?.migration?.survivorScore, 0),
          safeNum(a?.scalp?.score, 0),
          safeNum(a?.reversal?.score, 0)
        );
        return (
          bScore - aScore ||
          safeNum(b?.token?.volumeH1, 0) - safeNum(a?.token?.volumeH1, 0) ||
          safeNum(b?.token?.liquidity, 0) - safeNum(a?.token?.liquidity, 0)
        );
      });
  }

  async findBestCandidate({ runtime, openPositions = [], recentlyTraded = [] }) {
    const candidates = await this.fetchMarketCandidates();

    const openCA = new Set(
      (openPositions || []).map((p) => asText(p?.ca)).filter(Boolean)
    );
    const recentCA = new Set(
      (recentlyTraded || []).map((x) => asText(x)).filter(Boolean)
    );

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

    if (this.holderAccumulationEngine && ranked.length) {
      for (const candidate of ranked.slice(0, this.maxHolderEnrichPerPass)) {
        await this.enrichCandidateWithHolderLive(candidate);
      }
      ranked = ranked.sort((a, b) => this.getRelevantRank(b, strategyScope) - this.getRelevantRank(a, strategyScope));
    } else {
      for (const candidate of ranked.slice(0, this.maxHolderEnrichPerPass)) {
        candidate.reversal = this.buildReversalSignals(candidate);
        this.recomputeCompositeScore(candidate);
      }
      ranked = ranked.sort((a, b) => this.getRelevantRank(b, strategyScope) - this.getRelevantRank(a, strategyScope));
    }

    const candidate = ranked.find((row) => {
      const plans = this.buildPlans(row, strategyScope);
      return plans.length > 0;
    }) || null;

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
    return `🧭 <b>${escapeHtml(token.name || token.symbol || "UNKNOWN")}</b>
chain: ${escapeHtml(token.chainId || "-")}
score: ${safeNum(candidate?.score, 0)}
scalp score: ${safeNum(candidate?.scalp?.score, 0)}
scalp mode: ${escapeHtml(candidate?.scalp?.primaryMode || "-")}
reversal score: ${safeNum(candidate?.reversal?.score, 0)}
reversal mode: ${escapeHtml(candidate?.reversal?.primaryMode || "-")}
quiet accumulation: ${candidate?.holderAccumulation?.quietAccumulationPass ? "yes" : "no"}
control pct: ${safeNum(candidate?.holderAccumulation?.netControlPct, 0).toFixed(2)}
migration score: ${safeNum(candidate?.migration?.survivorScore, 0)}
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
    const holder = candidate?.holderAccumulation || {};
    const scalpMetrics = scalp?.metrics || {};
    const reversalMetrics = reversal?.metrics || {};

    return `🔎 <b>ANALYSIS</b>

Token: ${escapeHtml(token.name || token.symbol || "UNKNOWN")}
CA: <code>${escapeHtml(token.ca || "-")}</code>
Chain: ${escapeHtml(token.chainId || "-")}
Score: ${safeNum(candidate?.score, 0)}

Price: ${safeNum(token.price, 0)}
Liquidity: ${safeNum(token.liquidity, 0)}
Volume 1h: ${safeNum(token.volumeH1, 0)}
Volume 24h: ${safeNum(token.volumeH24, token.volume, 0)}
Txns 1h: ${safeNum(token.txnsH1, 0)}
Txns 24h: ${safeNum(token.txnsH24, token.txns, 0)}
FDV: ${safeNum(token.fdv, 0)}

⚠️ Rug: ${safeNum(candidate?.rug?.risk, 0)}
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
