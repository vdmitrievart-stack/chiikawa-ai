import { buildLevel6Candidate, buildLevel6Proposal } from "./candidate-builder.js";
import { Level6TradingOrchestrator } from "./Level6TradingOrchestrator.js";

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripText(text) {
  return String(text || "").trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round((safeNum(value) + Number.EPSILON) * p) / p;
}

function boolToText(v) {
  return v ? "YES" : "NO";
}

function normalizeInput(input = {}) {
  const ca = stripText(input.ca || input.contractAddress);
  const symbol = stripText(input.symbol || input.ticker);
  const name = stripText(input.name);

  return {
    ...input,
    ca,
    symbol,
    name
  };
}

function buildDecisionText(decision = {}) {
  const blocked = Array.isArray(decision.blockedReasons) ? decision.blockedReasons : [];
  const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];

  const lines = [
    `<b>Decision:</b> ${decision.allowed ? "ALLOW" : "BLOCK"}`,
    `<b>Score:</b> ${safeNum(decision.score, 0)}`,
    `<b>Confidence:</b> ${decision.confidence || "unknown"}`,
    `<b>Safety score:</b> ${safeNum(decision.safety?.safetyScore, 0)}`,
    `<b>Wallet score:</b> ${safeNum(decision.wallets?.score, 0)}`,
    `<b>Volume score:</b> ${safeNum(decision.volume?.score, 0)}`,
    `<b>Social score:</b> ${safeNum(decision.social?.score, 0)}`,
    `<b>Momentum score:</b> ${safeNum(decision.momentum?.score, 0)}`
  ];

  if (blocked.length) {
    lines.push("");
    lines.push("<b>Hard blockers:</b>");
    blocked.forEach(item => lines.push(`• ${item}`));
  }

  if (reasons.length) {
    lines.push("");
    lines.push("<b>Cautions:</b>");
    reasons.forEach(item => lines.push(`• ${item}`));
  }

  return lines.join("\n");
}

function buildCandidateText(candidate = {}) {
  const token = candidate.token || {};
  const walletIntel = candidate.walletIntel || {};
  const volumeIntel = candidate.volumeIntel || {};
  const socialIntel = candidate.socialIntel || {};
  const bubble = candidate.bubbleMapIntel || {};
  const execution = candidate.execution || {};
  const portfolio = candidate.portfolio || {};
  const sizing = candidate.sizingHints || {};
  const flags = candidate.riskFlags || {};

  return [
    `<b>Token</b>`,
    `CA: ${token.ca || "-"}`,
    `Symbol: ${token.symbol || "-"}`,
    `Name: ${token.name || "-"}`,
    `Price: $${safeNum(token.tokenPriceUsd, 0)}`,
    `Liquidity: $${safeNum(token.liquidityUsd, 0)}`,
    `1m Volume: $${safeNum(token.volume1mUsd, 0)}`,
    `FDV: $${safeNum(token.fdvUsd, 0)}`,
    `Market Cap: $${safeNum(token.marketCapUsd, 0)}`,
    ``,
    `<b>Holder / Contract Risk</b>`,
    `Top10 Holder %: ${safeNum(token.top10HolderPct || bubble.top10HolderPct, 0)}%`,
    `Creator Holder %: ${safeNum(token.creatorHolderPct, 0)}%`,
    `LP Locked %: ${safeNum(token.lpLockedPct, 0)}%`,
    `Mint Authority Enabled: ${boolToText(Boolean(token.mintAuthorityEnabled))}`,
    `Freeze Authority Enabled: ${boolToText(Boolean(token.freezeAuthorityEnabled))}`,
    `Bubble Dense Cluster Risk: ${safeNum(bubble.denseClusterRisk, 0)}`,
    `Bubble Links: ${Array.isArray(bubble.links) ? bubble.links.length : 0}`,
    ``,
    `<b>Wallet Intel</b>`,
    `Win Rate: ${safeNum(walletIntel.winRate, 0)}`,
    `Median ROI: ${safeNum(walletIntel.medianROI, 1)}`,
    `Average ROI: ${safeNum(walletIntel.averageROI, 1)}`,
    `Max Drawdown: ${safeNum(walletIntel.maxDrawdown, 0)}`,
    `Trades Count: ${safeNum(walletIntel.tradesCount, 0)}`,
    `Early Entry Score: ${safeNum(walletIntel.earlyEntryScore, 0)}`,
    `Chase Penalty: ${safeNum(walletIntel.chasePenalty, 0)}`,
    `Dump Penalty: ${safeNum(walletIntel.dumpPenalty, 0)}`,
    `Consistency Score: ${safeNum(walletIntel.consistencyScore, 0)}`,
    `Consensus Leaders: ${safeNum(walletIntel.consensusLeaders, 0)}`,
    ``,
    `<b>Volume Intel</b>`,
    `Growth Rate 1m: ${safeNum(volumeIntel.growthRate1m, 0)}`,
    `Buy Pressure: ${safeNum(volumeIntel.buyPressure, 0)}`,
    `Unique Buyers Delta: ${safeNum(volumeIntel.uniqueBuyersDelta, 0)}`,
    `Repeated Buyers: ${safeNum(volumeIntel.repeatedBuyers, 0)}`,
    `Sell Pressure: ${safeNum(volumeIntel.sellPressure, 0)}`,
    `Dump Spike: ${boolToText(Boolean(volumeIntel.dumpSpike))}`,
    `Pump 1m %: ${safeNum(volumeIntel.pump1mPct, 0)}%`,
    ``,
    `<b>Social Intel</b>`,
    `Unique Authors: ${safeNum(socialIntel.uniqueAuthors, 0)}`,
    `Avg Likes: ${safeNum(socialIntel.avgLikes, 0)}`,
    `Avg Replies: ${safeNum(socialIntel.avgReplies, 0)}`,
    `Bot Pattern Score: ${safeNum(socialIntel.botPatternScore, 0)}`,
    `Engagement Diversity: ${safeNum(socialIntel.engagementDiversity, 0)}`,
    `Trusted Mentions: ${safeNum(socialIntel.trustedMentions, 0)}`,
    `Suspicious Burst: ${boolToText(Boolean(socialIntel.suspiciousBurst))}`,
    `Organic Score: ${safeNum(socialIntel.organicScore, 0)}`,
    ``,
    `<b>Execution / Portfolio</b>`,
    `Wallet ID: ${execution.walletId || "wallet_1"}`,
    `Base Desired USD: $${safeNum(execution.baseDesiredUsd, 0)}`,
    `Expected Slippage: ${safeNum(execution.expectedSlippagePct, 0)}%`,
    `Wallet Balance SOL: ${safeNum(portfolio.walletBalanceSol, 0)}`,
    `Fee Reserve SOL: ${safeNum(portfolio.feeReserveSol, 0)}`,
    `Desired Tokens: ${safeNum(sizing.desiredTokens, 0)}`,
    `Wallet % After: ${safeNum(sizing.walletPctAfter, 0)}%`,
    `Aggregate % After: ${safeNum(sizing.aggregatePctAfter, 0)}%`,
    ``,
    `<b>Risk Flags</b>`,
    `Blocked: ${boolToText(Boolean(flags.blocked))}`,
    `Mint Risk: ${boolToText(Boolean(flags.mintRisk))}`,
    `Freeze Risk: ${boolToText(Boolean(flags.freezeRisk))}`,
    `Concentration Risk: ${boolToText(Boolean(flags.concentrationRisk))}`,
    `Creator Risk: ${boolToText(Boolean(flags.creatorRisk))}`,
    `LP Weak Risk: ${boolToText(Boolean(flags.lpWeakRisk))}`,
    `Suspicious Social Risk: ${boolToText(Boolean(flags.suspiciousSocialRisk))}`,
    `Dump Risk: ${boolToText(Boolean(flags.dumpRisk))}`,
    `Chase Risk: ${boolToText(Boolean(flags.chaseRisk))}`,
    `Bubble Cluster Risk: ${boolToText(Boolean(flags.bubbleClusterRisk))}`
  ].join("\n");
}

function buildProposalText(proposal = {}) {
  const hints = proposal.decisionHints || {};
  const warnings = Array.isArray(hints.keyWarnings) ? hints.keyWarnings : [];

  const lines = [
    `<b>Level 6 Proposal</b>`,
    `Blocked By Hard Risk: ${boolToText(Boolean(hints.blockedByHardRisk))}`,
    `Suggested USD: $${safeNum(hints.suggestedUsd, 0)}`,
    `Desired Tokens: ${safeNum(hints.desiredTokens, 0)}`,
    `Wallet % After: ${safeNum(hints.walletPctAfter, 0)}%`,
    `Aggregate % After: ${safeNum(hints.aggregatePctAfter, 0)}%`
  ];

  if (warnings.length) {
    lines.push("");
    lines.push("<b>Warnings:</b>");
    warnings.forEach(item => lines.push(`• ${item}`));
  }

  if (proposal.humanSummary) {
    lines.push("");
    lines.push("<b>Summary:</b>");
    lines.push(proposal.humanSummary);
  }

  return lines.join("\n");
}

function buildEntryReportText(trade, explanation = {}) {
  const positive = Array.isArray(explanation.positive) ? explanation.positive : [];
  const cautions = Array.isArray(explanation.cautions) ? explanation.cautions : [];

  const lines = [
    `<b>Dry-Run Entry Accepted</b>`,
    `Token: ${trade.token || "-"}`,
    `CA: ${trade.ca || "-"}`,
    `Entry: ${safeNum(trade.entry, 0)}`,
    `Score: ${safeNum(trade.score, 0)}`,
    `Confidence: ${trade.confidence || "unknown"}`
  ];

  if (positive.length) {
    lines.push("");
    lines.push("<b>Why it passed:</b>");
    positive.forEach(item => lines.push(`• ${item}`));
  }

  if (cautions.length) {
    lines.push("");
    lines.push("<b>Cautions:</b>");
    cautions.forEach(item => lines.push(`• ${item}`));
  }

  return lines.join("\n");
}

/**
 * Full scan:
 * - build candidate
 * - build proposal
 * - run orchestrator analysis
 */
export async function scanTokenCandidate(input = {}) {
  const normalized = normalizeInput(input);

  if (!normalized.ca && !normalized.symbol && !normalized.name) {
    throw new Error("scanTokenCandidate requires at least ca, symbol, or name");
  }

  const candidate = await buildLevel6Candidate(normalized);
  const proposal = await buildLevel6Proposal(normalized);

  const orchestrator = new Level6TradingOrchestrator({
    dryRun: true
  });

  const analysis = await orchestrator.analyzeOnly(candidate);

  return {
    ok: true,
    mode: "scan",
    candidate,
    proposal,
    decision: analysis.decision,
    explanation: analysis.explanation,
    texts: {
      candidate: buildCandidateText(candidate),
      proposal: buildProposalText(proposal),
      decision: buildDecisionText(analysis.decision)
    }
  };
}

/**
 * Proposal-only helper
 */
export async function buildScanProposal(input = {}) {
  const result = await scanTokenCandidate(input);

  return {
    ok: true,
    proposal: result.proposal,
    decision: result.decision,
    explanation: result.explanation,
    text: [
      result.texts.proposal,
      "",
      result.texts.decision
    ].join("\n")
  };
}

/**
 * Dry-run entry helper
 * - builds candidate
 * - tries orchestrator entry
 * - returns trade if accepted
 */
export async function dryRunEntryFromScan(input = {}) {
  const normalized = normalizeInput(input);

  const candidate = await buildLevel6Candidate(normalized);
  const proposal = await buildLevel6Proposal(normalized);

  const orchestrator = new Level6TradingOrchestrator({
    dryRun: true
  });

  const trade = await orchestrator.tryEnter(candidate);

  if (!trade) {
    const analysis = await orchestrator.analyzeOnly(candidate);

    return {
      ok: false,
      accepted: false,
      candidate,
      proposal,
      decision: analysis.decision,
      explanation: analysis.explanation,
      text: [
        `<b>Dry-Run Entry Rejected</b>`,
        "",
        buildDecisionText(analysis.decision)
      ].join("\n")
    };
  }

  const explanation = orchestrator.buildEntryExplanation(candidate, trade);

  return {
    ok: true,
    accepted: true,
    candidate,
    proposal,
    trade,
    explanation,
    text: buildEntryReportText(trade, explanation)
  };
}

/**
 * Compact Telegram-friendly formatter
 */
export function formatScanForTelegram(result = {}) {
  const parts = [];

  if (result.texts?.proposal) {
    parts.push(result.texts.proposal);
  }

  if (result.texts?.decision) {
    parts.push(result.texts.decision);
  }

  if (result.texts?.candidate) {
    parts.push(result.texts.candidate);
  }

  return parts.join("\n\n");
}

/**
 * Quick summary for admin panel / button callback
 */
export function buildCompactScanSummary(result = {}) {
  const decision = result.decision || {};
  const candidate = result.candidate || {};
  const token = candidate.token || {};
  const social = candidate.socialIntel || {};

  return [
    `<b>${token.symbol || token.name || "UNKNOWN"}</b>`,
    `CA: ${token.ca || "-"}`,
    `Decision: ${decision.allowed ? "ALLOW" : "BLOCK"}`,
    `Score: ${safeNum(decision.score, 0)}`,
    `Confidence: ${decision.confidence || "unknown"}`,
    `Liquidity: $${safeNum(token.liquidityUsd, 0)}`,
    `1m Volume: $${safeNum(token.volume1mUsd, 0)}`,
    `Bot Score: ${safeNum(social.botPatternScore, 0)}`,
    `Organic Score: ${safeNum(social.organicScore, 0)}`
  ].join("\n");
}

/**
 * Build a safe default candidate from CA only
 * Useful when user pastes just contract address
 */
export async function scanFromCAOnly(ca, overrides = {}) {
  const normalizedCA = stripText(ca);

  if (!normalizedCA) {
    throw new Error("CA is required");
  }

  return scanTokenCandidate({
    ca: normalizedCA,
    symbol: overrides.symbol || "",
    name: overrides.name || "",
    tokenPriceUsd: safeNum(overrides.tokenPriceUsd, 0),
    liquidityUsd: safeNum(overrides.liquidityUsd, 0),
    volume1mUsd: safeNum(overrides.volume1mUsd, 0),
    totalSupply: safeNum(overrides.totalSupply, 0),
    top10HolderPct: safeNum(overrides.top10HolderPct, 0),
    creatorHolderPct: safeNum(overrides.creatorHolderPct, 0),
    lpLockedPct: safeNum(overrides.lpLockedPct, 0),
    mintAuthorityEnabled: Boolean(overrides.mintAuthorityEnabled),
    freezeAuthorityEnabled: Boolean(overrides.freezeAuthorityEnabled),
    walletIntel: overrides.walletIntel || {},
    volumeIntel: overrides.volumeIntel || {},
    bubbleMapIntel: overrides.bubbleMapIntel || {},
    socialIntel: overrides.socialIntel || null,
    portfolio: overrides.portfolio || {},
    execution: overrides.execution || {}
  });
}

/**
 * Optional helper for staged simulations
 */
export async function dryRunEntryFromCAOnly(ca, overrides = {}) {
  const normalizedCA = stripText(ca);

  if (!normalizedCA) {
    throw new Error("CA is required");
  }

  return dryRunEntryFromScan({
    ca: normalizedCA,
    symbol: overrides.symbol || "",
    name: overrides.name || "",
    tokenPriceUsd: safeNum(overrides.tokenPriceUsd, 0),
    liquidityUsd: safeNum(overrides.liquidityUsd, 0),
    volume1mUsd: safeNum(overrides.volume1mUsd, 0),
    totalSupply: safeNum(overrides.totalSupply, 0),
    top10HolderPct: safeNum(overrides.top10HolderPct, 0),
    creatorHolderPct: safeNum(overrides.creatorHolderPct, 0),
    lpLockedPct: safeNum(overrides.lpLockedPct, 0),
    mintAuthorityEnabled: Boolean(overrides.mintAuthorityEnabled),
    freezeAuthorityEnabled: Boolean(overrides.freezeAuthorityEnabled),
    walletIntel: overrides.walletIntel || {},
    volumeIntel: overrides.volumeIntel || {},
    bubbleMapIntel: overrides.bubbleMapIntel || {},
    socialIntel: overrides.socialIntel || null,
    portfolio: overrides.portfolio || {},
    execution: overrides.execution || {}
  });
}
