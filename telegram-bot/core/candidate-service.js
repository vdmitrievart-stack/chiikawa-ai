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

    if (
      score >= 78 &&
      safeNum(candidate?.accumulation?.score, 0) >= 8 &&
      !safeNum(candidate?.falseBounce?.rejected, false)
    ) {
      plans.push({
        strategyKey: "reversal",
        thesis: "Reversal continuation on Solana",
        plannedHoldMs: 40 * 60 * 1000,
        stopLossPct: 5.5,
        takeProfitPct: 11,
        runnerTargetsPct: [],
        signalScore: score,
        expectedEdgePct: 10,
        entryMode: "SCALED",
        planName: "Reversal",
        objective: "bounce capture"
      });
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

    if (strategyScope === "migration_survivor") {
      return candidate?.migration?.passes
        ? safeNum(candidate?.migration?.survivorScore, 0)
        : 0;
    }

    if (strategyScope === "runner") {
      return safeNum(candidate?.score, 0) + Math.max(0, safeNum(candidate?.delta?.priceH1Pct, 0));
    }

    if (strategyScope === "reversal") {
      return safeNum(candidate?.score, 0) + safeNum(candidate?.accumulation?.score, 0);
    }

    if (strategyScope === "copytrade") {
      return safeNum(candidate?.score, 0);
    }

    return Math.max(
      safeNum(candidate?.score, 0),
      safeNum(candidate?.migration?.survivorScore, 0),
      safeNum(candidate?.scalp?.score, 0)
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
          Boolean(candidate?.scalp?.allow)
        );
      })
      .sort((a, b) => {
        const bScore = Math.max(
          safeNum(b?.score, 0),
          safeNum(b?.migration?.survivorScore, 0),
          safeNum(b?.scalp?.score, 0)
        );
        const aScore = Math.max(
          safeNum(a?.score, 0),
          safeNum(a?.migration?.survivorScore, 0),
          safeNum(a?.scalp?.score, 0)
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

    const ranked = candidates
      .filter((row) => {
        const ca = asText(row?.token?.ca);
        if (!ca) return false;
        if (!isSolanaChain(row?.token?.chainId)) return false;
        if (openCA.has(ca)) return false;
        if (recentCA.has(ca)) return false;

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
    return `🧭 <b>${escapeHtml(token.name || token.symbol || "UNKNOWN")}</b>
chain: ${escapeHtml(token.chainId || "-")}
score: ${safeNum(candidate?.score, 0)}
scalp score: ${safeNum(candidate?.scalp?.score, 0)}
scalp mode: ${escapeHtml(candidate?.scalp?.primaryMode || "-")}
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
    const scalpMetrics = scalp?.metrics || {};

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

    const plans = this.buildPlans(analyzed, runtime?.strategyScope || "all");

    return {
      analyzed,
      plans,
      heroImage: token?.imageUrl || null
    };
  }
}
