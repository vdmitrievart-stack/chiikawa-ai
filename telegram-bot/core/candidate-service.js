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

export default class CandidateService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.searchQueries = options.searchQueries || [
      "solana meme",
      "pumpfun solana",
      "cto solana",
      "memecoin solana"
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
      buys: safeNum(pair?.txns?.h24?.buys, 0),
      sells: safeNum(pair?.txns?.h24?.sells, 0),
      txns:
        safeNum(pair?.txns?.h24?.buys, 0) +
        safeNum(pair?.txns?.h24?.sells, 0),
      fdv: safeNum(pair?.fdv, 0),
      pairCreatedAt: safeNum(pair?.pairCreatedAt, 0),
      url: asText(pair?.url, ""),
      imageUrl: pair?.info?.imageUrl || null,
      description: asText(pair?.info?.description || pair?.info?.header, ""),
      links
    };
  }

  computeScore(token, extra = {}) {
    let score = 0;

    const liquidity = safeNum(token?.liquidity, 0);
    const volume = safeNum(token?.volume, 0);
    const txns = safeNum(token?.txns, 0);
    const fdv = safeNum(token?.fdv, 0);
    const socialCount = safeNum(extra?.socialCount, 0);
    const priceDeltaPct = safeNum(extra?.priceDeltaPct, 0);

    if (liquidity >= 5000) score += 12;
    if (liquidity >= 12000) score += 12;
    if (liquidity >= 30000) score += 10;

    if (volume >= 5000) score += 10;
    if (volume >= 15000) score += 10;
    if (volume >= 50000) score += 10;

    if (txns >= 40) score += 10;
    if (txns >= 100) score += 8;
    if (txns >= 250) score += 7;

    if (socialCount >= 1) score += 6;
    if (socialCount >= 2) score += 6;
    if (socialCount >= 3) score += 5;

    if (fdv > 0 && liquidity > 0) {
      const ratio = fdv / Math.max(liquidity, 1);
      if (ratio <= 8) score += 8;
      else if (ratio <= 15) score += 4;
      else score -= 6;
    }

    if (priceDeltaPct > 0 && priceDeltaPct <= 35) score += 5;
    if (priceDeltaPct > 60) score -= 8;

    return Math.max(0, Math.min(99, Math.round(score)));
  }

  buildMigrationSignals(token, extra = {}) {
    const now = Date.now();
    const pairCreatedAt = safeNum(token?.pairCreatedAt, 0);
    const pairAgeMin = pairCreatedAt > 0 ? Math.max(0, (now - pairCreatedAt) / 60000) : 99999;

    const liquidity = safeNum(token?.liquidity, 0);
    const volume = safeNum(token?.volume, 0);
    const txns = safeNum(token?.txns, 0);
    const fdv = safeNum(token?.fdv, 0);
    const socialCount = safeNum(extra?.socialCount, 0);
    const buyPressure = safeNum(extra?.buyPressure, 0);
    const priceDeltaPct = safeNum(extra?.priceDeltaPct, 0);

    const fdvLiquidityRatio = liquidity > 0 ? fdv / Math.max(liquidity, 1) : 999;
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

  analyzeToken(token) {
    const links = Array.isArray(token?.links) ? token.links : [];
    const linksMap = this.buildLinksMap(links);
    const socialCount = Object.values(linksMap).filter(Boolean).length;

    const txns = safeNum(token?.txns, 0);
    const volume = safeNum(token?.volume, 0);
    const liquidity = safeNum(token?.liquidity, 0);
    const fdv = safeNum(token?.fdv, 0);
    const buys = safeNum(token?.buys, 0);
    const sells = safeNum(token?.sells, 0);

    const buyPressure = buys + sells > 0 ? (buys / (buys + sells)) * 100 : 0;
    const priceDeltaPct = 0;

    const score = this.computeScore(token, {
      socialCount,
      priceDeltaPct
    });

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
        80,
        Math.round(
          (liquidity < 10000 ? 18 : 8) +
            (socialCount === 0 ? 12 : 0) +
            (fdv > liquidity * 20 ? 12 : 0)
        )
      )
    );

    const corpseScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          (volume < 3000 ? 25 : 5) +
            (txns < 25 ? 20 : 0) +
            (buyPressure < 45 ? 10 : 0)
        )
      )
    );

    const isCorpse = corpseScore >= 70;
    const falseBounceRejected =
      buyPressure < 42 && txns < 40 && volume < 4000;

    const distributionScore = Math.max(
      0,
      Math.min(100, Math.round(proxyConcentration / 2))
    );

    const accumulationScore =
      buyPressure >= 58 ? 18 : buyPressure >= 52 ? 10 : 0;

    const absorptionScore =
      txns >= 80 && volume >= 10000 ? 12 : txns >= 40 ? 6 : 0;

    const botActivity = 0;
    const developerVerdict =
      socialCount === 0 && liquidity < 10000 ? "Risky" : "Neutral";

    const tokenType = "meme";
    const rewardModel = "None";

    const migration = this.buildMigrationSignals(token, {
      socialCount,
      buyPressure,
      priceDeltaPct
    });

    const reasons = [
      "solana chain only",
      liquidity >= 12000 ? "liquidity acceptable" : "liquidity moderate",
      socialCount > 0 ? "socials detected" : "no socials",
      buyPressure >= 50 ? "buy pressure acceptable" : "buy pressure weak"
    ];

    if (migration.passes) {
      reasons.push("post-migration survivor profile");
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
        volumeDeltaPct: 0,
        txnsDeltaPct: 0,
        liquidityDeltaPct: 0,
        buyPressureDelta: 0
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

    const priceDeltaPct =
      safeNum(pair?.priceChange?.m5, 0) ||
      safeNum(pair?.priceChange?.h1, 0) ||
      safeNum(pair?.priceChange?.h6, 0) ||
      safeNum(pair?.priceChange?.h24, 0);

    analyzed.delta.priceDeltaPct = priceDeltaPct;
    analyzed.copytradeMeta.priceExtensionPct = Math.max(0, priceDeltaPct);

    analyzed.score = this.computeScore(token, {
      socialCount: safeNum(analyzed?.socials?.socialCount, 0),
      priceDeltaPct
    });

    const boostsActive = safeNum(pair?.boosts?.active, 0);
    analyzed.dexPaid = boostsActive > 0;

    if (boostsActive > 0) {
      analyzed.reasons.push(`dex boost active ${boostsActive}`);
    }

    analyzed.migration = this.buildMigrationSignals(token, {
      socialCount: safeNum(analyzed?.socials?.socialCount, 0),
      buyPressure:
        safeNum(token?.buys, 0) + safeNum(token?.sells, 0) > 0
          ? (safeNum(token?.buys, 0) / Math.max(safeNum(token?.buys, 0) + safeNum(token?.sells, 0), 1)) * 100
          : 0,
      priceDeltaPct
    });

    return analyzed;
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
        entryMode: "NORMAL",
        planName: "Copytrade Follow",
        objective: "follow"
      });
    }

    if (score >= 76) {
      plans.push({
        strategyKey: "scalp",
        thesis: "Fast Solana scalp",
        plannedHoldMs: 20 * 60 * 1000,
        stopLossPct: 5,
        takeProfitPct: 10,
        runnerTargetsPct: [],
        signalScore: score,
        expectedEdgePct: 9,
        entryMode: "NORMAL",
        planName: "Scalp",
        objective: "quick profit"
      });
    }

    if (score >= 80) {
      plans.push({
        strategyKey: "reversal",
        thesis: "Reversal continuation on Solana",
        plannedHoldMs: 45 * 60 * 1000,
        stopLossPct: 6,
        takeProfitPct: 14,
        runnerTargetsPct: [],
        signalScore: score,
        expectedEdgePct: 12,
        entryMode: "NORMAL",
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
        entryMode: "NORMAL",
        planName: "Migration Survivor",
        objective: "post-migration expansion"
      });
    }

    if (score >= 86) {
      plans.push({
        strategyKey: "runner",
        thesis: "Strong Solana runner",
        plannedHoldMs: 4 * 60 * 60 * 1000,
        stopLossPct: 7,
        takeProfitPct: 24,
        runnerTargetsPct: [12, 22, 35],
        signalScore: score,
        expectedEdgePct: 18,
        entryMode: "NORMAL",
        planName: "Runner",
        objective: "trend expansion"
      });
    }

    if (strategyScope && strategyScope !== "all") {
      return plans.filter((p) => p.strategyKey === strategyScope);
    }

    return plans;
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
          safeNum(candidate?.score, 0) >= 65 ||
          Boolean(candidate?.migration?.passes)
        );
      })
      .sort((a, b) => {
        const bScore = Math.max(
          safeNum(b?.score, 0),
          safeNum(b?.migration?.survivorScore, 0)
        );
        const aScore = Math.max(
          safeNum(a?.score, 0),
          safeNum(a?.migration?.survivorScore, 0)
        );
        return (
          bScore - aScore ||
          safeNum(b?.token?.liquidity, 0) - safeNum(a?.token?.liquidity, 0) ||
          safeNum(b?.token?.volume, 0) - safeNum(a?.token?.volume, 0)
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

    const candidate = candidates.find((row) => {
      const ca = asText(row?.token?.ca);
      if (!ca) return false;
      if (!isSolanaChain(row?.token?.chainId)) return false;
      if (openCA.has(ca)) return false;
      if (recentCA.has(ca)) return false;
      return true;
    });

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
migration score: ${safeNum(candidate?.migration?.survivorScore, 0)}
price: ${safeNum(token.price, 0)}
liquidity: ${safeNum(token.liquidity, 0)}
volume 24h: ${safeNum(token.volume, 0)}
txns 24h: ${safeNum(token.txns, 0)}
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

    return `🔎 <b>ANALYSIS</b>

Token: ${escapeHtml(token.name || token.symbol || "UNKNOWN")}
CA: <code>${escapeHtml(token.ca || "-")}</code>
Chain: ${escapeHtml(token.chainId || "-")}
Score: ${safeNum(candidate?.score, 0)}

Price: ${safeNum(token.price, 0)}
Liquidity: ${safeNum(token.liquidity, 0)}
Volume 24h: ${safeNum(token.volume, 0)}
Txns 24h: ${safeNum(token.txns, 0)}
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
