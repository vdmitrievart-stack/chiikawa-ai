import { buildLevel6SocialIntel } from "./x-engine.js";

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round((safeNum(value) + Number.EPSILON) * p) / p;
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function stripText(text) {
  return String(text || "").trim();
}

function buildSymbolKeywords(symbol = "", name = "") {
  const out = [];

  if (symbol) {
    out.push(symbol);
    out.push(`$${symbol}`);
    out.push(`${symbol} token`);
    out.push(`${symbol} coin`);
  }

  if (name) {
    out.push(name);
    out.push(`${name} token`);
    out.push(`${name} coin`);
  }

  return uniq(out);
}

/**
 * =========================
 * DEFAULT PORTFOLIO RULES
 * =========================
 */

function buildDefaultPortfolio(input = {}) {
  return {
    existingWalletTokenAmount: safeNum(input.existingWalletTokenAmount, 0),
    existingAggregateTokenAmount: safeNum(input.existingAggregateTokenAmount, 0),
    existingWalletUsd: safeNum(input.existingWalletUsd, 0),
    existingAggregateUsd: safeNum(input.existingAggregateUsd, 0),
    walletBalanceSol: safeNum(
      input.walletBalanceSol,
      Number(process.env.DEFAULT_WALLET_BALANCE_SOL || 1.5)
    ),
    feeReserveSol: safeNum(
      input.feeReserveSol,
      Number(process.env.LEVEL6_FEE_RESERVE_SOL || 0.07)
    )
  };
}

function buildDefaultExecution(input = {}) {
  return {
    walletId: stripText(input.walletId) || "wallet_1",
    baseDesiredUsd: safeNum(
      input.baseDesiredUsd,
      Number(process.env.DEFAULT_BASE_DESIRED_USD || 75)
    ),
    expectedSlippagePct: safeNum(
      input.expectedSlippagePct,
      Number(process.env.DEFAULT_EXPECTED_SLIPPAGE_PCT || 4.5)
    )
  };
}

/**
 * =========================
 * TOKEN INTEL
 * =========================
 *
 * This is intentionally adapter-ready.
 * Right now:
 * - supports direct input
 * - normalizes token metadata
 * - estimates missing values safely
 *
 * Later we can swap internals for:
 * - DexScreener
 * - GMGN
 * - Pump.fun
 * - Birdeye
 * - on-chain RPC
 */

export async function buildTokenIntel(input = {}) {
  const ca = stripText(input.ca);
  const symbol = stripText(input.symbol || input.ticker);
  const name = stripText(input.name);

  const tokenPriceUsd = safeNum(input.tokenPriceUsd, safeNum(input.priceUsd, 0));
  const totalSupply = safeNum(input.totalSupply, 0);
  const liquidityUsd = safeNum(input.liquidityUsd, 0);
  const volume1mUsd = safeNum(input.volume1mUsd, 0);
  const top10HolderPct = safeNum(input.top10HolderPct, 0);
  const creatorHolderPct = safeNum(input.creatorHolderPct, 0);
  const lpLockedPct = safeNum(input.lpLockedPct, 0);

  return {
    ca,
    symbol,
    name,
    keywords: uniq([
      ...buildSymbolKeywords(symbol, name),
      ...(Array.isArray(input.keywords) ? input.keywords : [])
    ]),
    totalSupply,
    tokenPriceUsd,
    liquidityUsd,
    volume1mUsd,
    top10HolderPct,
    creatorHolderPct,
    lpLockedPct,
    mintAuthorityEnabled: Boolean(input.mintAuthorityEnabled),
    freezeAuthorityEnabled: Boolean(input.freezeAuthorityEnabled),
    decimals: safeNum(input.decimals, 0),
    fdvUsd: safeNum(input.fdvUsd, totalSupply && tokenPriceUsd ? totalSupply * tokenPriceUsd : 0),
    marketCapUsd: safeNum(
      input.marketCapUsd,
      totalSupply && tokenPriceUsd ? totalSupply * tokenPriceUsd : 0
    )
  };
}

/**
 * =========================
 * WALLET INTEL
 * =========================
 *
 * This is the smart-wallet / leader-tracking layer.
 * Right now it accepts precomputed metrics or falls back safely.
 *
 * Later adapters can pull from:
 * - GMGN
 * - Axiom
 * - custom wallet DB
 * - your own trade history
 */

export async function buildWalletIntel(input = {}) {
  return {
    winRate: safeNum(input.winRate, 0),
    medianROI: safeNum(input.medianROI, 1),
    averageROI: safeNum(input.averageROI, 1),
    maxDrawdown: safeNum(input.maxDrawdown, 0),
    tradesCount: safeNum(input.tradesCount, 0),
    earlyEntryScore: safeNum(input.earlyEntryScore, 0),
    chasePenalty: safeNum(input.chasePenalty, 0),
    dumpPenalty: safeNum(input.dumpPenalty, 0),
    consistencyScore: safeNum(input.consistencyScore, 0),
    consensusLeaders: safeNum(input.consensusLeaders, 0),
    source: stripText(input.source || "manual_or_default")
  };
}

/**
 * =========================
 * VOLUME INTEL
 * =========================
 */

export async function buildVolumeIntel(input = {}) {
  return {
    growthRate1m: safeNum(input.growthRate1m, 0),
    buyPressure: safeNum(input.buyPressure, 0),
    uniqueBuyersDelta: safeNum(input.uniqueBuyersDelta, 0),
    repeatedBuyers: safeNum(input.repeatedBuyers, 0),
    sellPressure: safeNum(input.sellPressure, 0),
    dumpSpike: Boolean(input.dumpSpike),
    pump1mPct: safeNum(input.pump1mPct, 0),
    source: stripText(input.source || "manual_or_default")
  };
}

/**
 * =========================
 * BUBBLE MAP / HOLDER GRAPH INTEL
 * =========================
 *
 * For now:
 * - supports direct input
 * - normalizes link density
 * - derives compact risk hints
 *
 * Later we can connect:
 * - BubbleMaps
 * - on-chain cluster heuristics
 * - wallet relation graph
 */

export async function buildBubbleMapIntel(input = {}) {
  const holders = Array.isArray(input.holders) ? input.holders : [];
  const links = Array.isArray(input.links) ? input.links : [];

  const top10HolderPct = safeNum(
    input.top10HolderPct,
    holders
      .sort((a, b) => safeNum(b.pct) - safeNum(a.pct))
      .slice(0, 10)
      .reduce((acc, item) => acc + safeNum(item.pct), 0)
  );

  const denseClusterRisk =
    links.length >= 12 ? 0.9 :
    links.length >= 8 ? 0.7 :
    links.length >= 4 ? 0.4 :
    0.1;

  return {
    top10HolderPct,
    holders: holders.map(item => ({
      address: stripText(item.address),
      pct: safeNum(item.pct, 0),
      rank: safeNum(item.rank, 0)
    })),
    links: links.map(item => ({
      from: stripText(item.from),
      to: stripText(item.to)
    })),
    denseClusterRisk: round(denseClusterRisk, 2),
    source: stripText(input.source || "manual_or_default")
  };
}

/**
 * =========================
 * SOCIAL INTEL
 * =========================
 *
 * Main difference:
 * - if socialIntel is given directly -> normalize it
 * - otherwise build from x-engine using CA/symbol/keywords
 */

export async function buildSocialIntel(input = {}) {
  if (input.socialIntel && typeof input.socialIntel === "object") {
    return {
      uniqueAuthors: safeNum(input.socialIntel.uniqueAuthors, 0),
      avgLikes: safeNum(input.socialIntel.avgLikes, 0),
      avgReplies: safeNum(input.socialIntel.avgReplies, 0),
      botPatternScore: safeNum(input.socialIntel.botPatternScore, 0),
      engagementDiversity: safeNum(input.socialIntel.engagementDiversity, 0),
      trustedMentions: safeNum(input.socialIntel.trustedMentions, 0),
      suspiciousBurst: Boolean(input.socialIntel.suspiciousBurst),
      organicScore: safeNum(input.socialIntel.organicScore, 0)
    };
  }

  const ca = stripText(input.ca);
  const symbol = stripText(input.symbol || input.ticker);
  const name = stripText(input.name);
  const keywords = uniq([
    ...buildSymbolKeywords(symbol, name),
    ...(Array.isArray(input.keywords) ? input.keywords : [])
  ]);

  try {
    return await buildLevel6SocialIntel({
      ca,
      symbol,
      keywords
    });
  } catch (error) {
    return {
      uniqueAuthors: 0,
      avgLikes: 0,
      avgReplies: 0,
      botPatternScore: 1,
      engagementDiversity: 0,
      trustedMentions: 0,
      suspiciousBurst: false,
      organicScore: 0,
      error: error.message
    };
  }
}

/**
 * =========================
 * RISK FLAGS
 * =========================
 */

export function buildRiskFlags(candidate = {}) {
  const token = candidate.token || {};
  const social = candidate.socialIntel || {};
  const bubble = candidate.bubbleMapIntel || {};
  const volume = candidate.volumeIntel || {};

  const flags = {
    mintRisk: Boolean(token.mintAuthorityEnabled),
    freezeRisk: Boolean(token.freezeAuthorityEnabled),
    concentrationRisk: safeNum(token.top10HolderPct || bubble.top10HolderPct, 0) >= 48,
    creatorRisk: safeNum(token.creatorHolderPct, 0) >= 8,
    lpWeakRisk: safeNum(token.lpLockedPct, 0) < 85,
    suspiciousSocialRisk:
      Boolean(social.suspiciousBurst) ||
      safeNum(social.botPatternScore, 0) >= 0.65,
    dumpRisk:
      Boolean(volume.dumpSpike) ||
      safeNum(volume.sellPressure, 0) >= 0.52,
    chaseRisk: safeNum(volume.pump1mPct, 0) >= 40,
    bubbleClusterRisk: safeNum(bubble.denseClusterRisk, 0) >= 0.7
  };

  flags.blocked =
    flags.mintRisk ||
    flags.freezeRisk ||
    flags.concentrationRisk ||
    flags.creatorRisk ||
    flags.lpWeakRisk;

  return flags;
}

/**
 * =========================
 * ENTRY SIZING HINTS
 * =========================
 */

export function buildSizingHints(candidate = {}) {
  const token = candidate.token || {};
  const execution = candidate.execution || {};
  const portfolio = candidate.portfolio || {};

  const totalSupply = safeNum(token.totalSupply, 0);
  const tokenPriceUsd = safeNum(token.tokenPriceUsd, 0);
  const desiredUsd = safeNum(execution.baseDesiredUsd, 0);

  const desiredTokens =
    tokenPriceUsd > 0 ? desiredUsd / tokenPriceUsd : 0;

  const walletPctAfter =
    totalSupply > 0
      ? pct(
          safeNum(portfolio.existingWalletTokenAmount, 0) + desiredTokens,
          totalSupply
        )
      : 0;

  const aggregatePctAfter =
    totalSupply > 0
      ? pct(
          safeNum(portfolio.existingAggregateTokenAmount, 0) + desiredTokens,
          totalSupply
        )
      : 0;

  return {
    desiredTokens: round(desiredTokens, 4),
    walletPctAfter: round(walletPctAfter, 4),
    aggregatePctAfter: round(aggregatePctAfter, 4)
  };
}

function pct(a, b) {
  if (!b) return 0;
  return (a / b) * 100;
}

/**
 * =========================
 * HUMAN SUMMARY
 * =========================
 */

export function buildCandidateSummary(candidate = {}) {
  const token = candidate.token || {};
  const walletIntel = candidate.walletIntel || {};
  const volumeIntel = candidate.volumeIntel || {};
  const socialIntel = candidate.socialIntel || {};
  const bubble = candidate.bubbleMapIntel || {};
  const execution = candidate.execution || {};
  const portfolio = candidate.portfolio || {};
  const riskFlags = candidate.riskFlags || {};
  const sizingHints = candidate.sizingHints || {};

  return {
    headline: `${token.symbol || token.name || "UNKNOWN"} candidate`,
    token: {
      ca: token.ca || "",
      symbol: token.symbol || "",
      priceUsd: safeNum(token.tokenPriceUsd, 0),
      liquidityUsd: safeNum(token.liquidityUsd, 0),
      volume1mUsd: safeNum(token.volume1mUsd, 0),
      top10HolderPct: safeNum(token.top10HolderPct || bubble.top10HolderPct, 0),
      creatorHolderPct: safeNum(token.creatorHolderPct, 0),
      lpLockedPct: safeNum(token.lpLockedPct, 0)
    },
    walletIntel: {
      winRate: safeNum(walletIntel.winRate, 0),
      medianROI: safeNum(walletIntel.medianROI, 1),
      consistencyScore: safeNum(walletIntel.consistencyScore, 0),
      consensusLeaders: safeNum(walletIntel.consensusLeaders, 0)
    },
    volumeIntel: {
      buyPressure: safeNum(volumeIntel.buyPressure, 0),
      uniqueBuyersDelta: safeNum(volumeIntel.uniqueBuyersDelta, 0),
      sellPressure: safeNum(volumeIntel.sellPressure, 0),
      pump1mPct: safeNum(volumeIntel.pump1mPct, 0)
    },
    socialIntel: {
      uniqueAuthors: safeNum(socialIntel.uniqueAuthors, 0),
      avgLikes: safeNum(socialIntel.avgLikes, 0),
      avgReplies: safeNum(socialIntel.avgReplies, 0),
      botPatternScore: safeNum(socialIntel.botPatternScore, 0),
      engagementDiversity: safeNum(socialIntel.engagementDiversity, 0),
      trustedMentions: safeNum(socialIntel.trustedMentions, 0),
      suspiciousBurst: Boolean(socialIntel.suspiciousBurst),
      organicScore: safeNum(socialIntel.organicScore, 0)
    },
    bubbleMapIntel: {
      denseClusterRisk: safeNum(bubble.denseClusterRisk, 0),
      linkCount: Array.isArray(bubble.links) ? bubble.links.length : 0
    },
    execution: {
      walletId: execution.walletId || "wallet_1",
      baseDesiredUsd: safeNum(execution.baseDesiredUsd, 0),
      expectedSlippagePct: safeNum(execution.expectedSlippagePct, 0)
    },
    portfolio: {
      walletBalanceSol: safeNum(portfolio.walletBalanceSol, 0),
      feeReserveSol: safeNum(portfolio.feeReserveSol, 0)
    },
    sizingHints,
    riskFlags
  };
}

/**
 * =========================
 * MAIN BUILDER
 * =========================
 *
 * Example:
 * const candidate = await buildLevel6Candidate({
 *   ca: "...",
 *   symbol: "TEST",
 *   totalSupply: 1_000_000_000,
 *   tokenPriceUsd: 0.00012,
 *   liquidityUsd: 18000,
 *   volume1mUsd: 4200,
 *   top10HolderPct: 42,
 *   creatorHolderPct: 6,
 *   lpLockedPct: 95,
 *   mintAuthorityEnabled: false,
 *   freezeAuthorityEnabled: false,
 *   walletIntel: {...},
 *   volumeIntel: {...},
 *   bubbleMapIntel: {...},
 *   portfolio: {...},
 *   execution: {...}
 * });
 */

export async function buildLevel6Candidate(input = {}) {
  const token = await buildTokenIntel(input);
  const walletIntel = await buildWalletIntel(input.walletIntel || input);
  const volumeIntel = await buildVolumeIntel(input.volumeIntel || input);
  const bubbleMapIntel = await buildBubbleMapIntel(input.bubbleMapIntel || input);
  const socialIntel = await buildSocialIntel({
    ...input,
    ca: token.ca,
    symbol: token.symbol,
    name: token.name,
    keywords: token.keywords
  });

  const portfolio = buildDefaultPortfolio(input.portfolio || {});
  const execution = buildDefaultExecution(input.execution || {});

  const candidate = {
    token,
    walletIntel,
    volumeIntel,
    socialIntel,
    bubbleMapIntel,
    portfolio,
    execution
  };

  candidate.riskFlags = buildRiskFlags(candidate);
  candidate.sizingHints = buildSizingHints(candidate);
  candidate.summary = buildCandidateSummary(candidate);

  return candidate;
}

/**
 * =========================
 * PROPOSAL LAYER
 * =========================
 *
 * Human-friendly layer for Telegram UI / admin panel
 */

export async function buildLevel6Proposal(input = {}) {
  const candidate = await buildLevel6Candidate(input);
  const summary = candidate.summary || {};
  const riskFlags = candidate.riskFlags || {};
  const sizingHints = candidate.sizingHints || {};

  const proposal = {
    ok: true,
    candidate,
    decisionHints: {
      blockedByHardRisk: Boolean(riskFlags.blocked),
      keyWarnings: Object.entries(riskFlags)
        .filter(([key, value]) => key !== "blocked" && Boolean(value))
        .map(([key]) => key),
      suggestedUsd: safeNum(candidate.execution?.baseDesiredUsd, 0),
      desiredTokens: safeNum(sizingHints.desiredTokens, 0),
      walletPctAfter: safeNum(sizingHints.walletPctAfter, 0),
      aggregatePctAfter: safeNum(sizingHints.aggregatePctAfter, 0)
    },
    humanSummary: [
      `${summary.headline || "Candidate"}`,
      `Liquidity: $${safeNum(summary.token?.liquidityUsd, 0)}`,
      `1m volume: $${safeNum(summary.token?.volume1mUsd, 0)}`,
      `Top10: ${safeNum(summary.token?.top10HolderPct, 0)}%`,
      `Creator: ${safeNum(summary.token?.creatorHolderPct, 0)}%`,
      `LP locked: ${safeNum(summary.token?.lpLockedPct, 0)}%`,
      `Social organic score: ${safeNum(summary.socialIntel?.organicScore, 0)}`,
      `Social bot score: ${safeNum(summary.socialIntel?.botPatternScore, 0)}`,
      `Desired size: $${safeNum(summary.execution?.baseDesiredUsd, 0)}`,
      `Wallet after entry: ${safeNum(summary.sizingHints?.walletPctAfter, 0)}%`
    ].join("\n")
  };

  return proposal;
}
