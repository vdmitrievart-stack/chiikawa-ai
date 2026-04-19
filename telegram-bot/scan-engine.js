import { buildLevel6Candidate, buildLevel6Proposal } from "./candidate-builder.js";
import { Level6TradingOrchestrator } from "./Level6TradingOrchestrator.js";

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripText(text) {
  return String(text || "").trim();
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

function formatPct(value, digits = 2) {
  return `${round(safeNum(value, 0), digits)}%`;
}

function formatUsd(value) {
  return `$${round(safeNum(value, 0), 2)}`;
}

function buildDecisionText(decision = {}) {
  const blocked = Array.isArray(decision.blockedReasons) ? decision.blockedReasons : [];
  const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];

  const lines = [
    `🧠 <b>Level 6 Decision</b>`,
    ``,
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
    lines.push(`<b>Hard blockers:</b>`);
    blocked.forEach(item => lines.push(`• ${item}`));
  }

  if (reasons.length) {
    lines.push("");
    lines.push(`<b>Cautions:</b>`);
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
  const rug = candidate.rugScamIntel || {};

  const leaderLines = Array.isArray(walletIntel.leaders) && walletIntel.leaders.length
    ? walletIntel.leaders.slice(0, 5).map((leader, index) => {
        const name = leader.name || leader.address || `leader_${index + 1}`;
        return `${index + 1}. ${name}
   winRate=${safeNum(leader.winRate, 0)} | medianROI=${safeNum(leader.medianROI, 1)} | trades=${safeNum(leader.tradesCount, 0)}`;
      })
    : ["No GMGN leaders found"];

  const rugReasons = Array.isArray(rug.reasons) && rug.reasons.length
    ? rug.reasons.map(item => `• ${item}`)
    : ["• No major rug flags detected"];

  return [
    `🧾 <b>Candidate Full Report</b>`,
    ``,
    `<b>Token</b>`,
    `CA: <code>${token.ca || "-"}</code>`,
    `Chain: ${token.chainId || "-"}`,
    `Symbol: ${token.symbol || "-"}`,
    `Name: ${token.name || "-"}`,
    `Price: ${formatUsd(token.tokenPriceUsd)}`,
    `Liquidity: ${formatUsd(token.liquidityUsd)}`,
    `5m Volume: ${formatUsd(token.volume1mUsd)}`,
    `FDV: ${formatUsd(token.fdvUsd)}`,
    `Market Cap: ${formatUsd(token.marketCapUsd)}`,
    `Dex: ${token.dexId || "-"}`,
    `Pair: <code>${token.pairAddress || "-"}</code>`,
    ``,
    `<b>Holder / Contract Risk</b>`,
    `Top10 Holder %: ${formatPct(token.top10HolderPct || bubble.top10HolderPct, 2)}`,
    `Creator Holder %: ${formatPct(token.creatorHolderPct, 2)}`,
    `LP Locked %: ${formatPct(token.lpLockedPct, 2)}`,
    `Mint Authority Enabled: ${boolToText(Boolean(token.mintAuthorityEnabled))}`,
    `Freeze Authority Enabled: ${boolToText(Boolean(token.freezeAuthorityEnabled))}`,
    `Bubble Dense Cluster Risk: ${safeNum(bubble.denseClusterRisk, 0)}`,
    `Bubble Links: ${Array.isArray(bubble.links) ? bubble.links.length : 0}`,
    ``,
    `🛡 <b>Rug / Scam Intel</b>`,
    `Blocked: ${boolToText(Boolean(rug.blocked))}`,
    `Risk Score: ${safeNum(rug.riskScore, 0)}`,
    ...rugReasons,
    ``,
    `👛 <b>GMGN Wallet Intel</b>`,
    `Source: ${walletIntel.source || "-"}`,
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
    `<b>Top Leaders</b>`,
    ...leaderLines,
    ``,
    `📈 <b>Volume Intel</b>`,
    `Growth Rate 1m: ${safeNum(volumeIntel.growthRate1m, 0)}`,
    `Buy Pressure: ${safeNum(volumeIntel.buyPressure, 0)}`,
    `Unique Buyers Delta: ${safeNum(volumeIntel.uniqueBuyersDelta, 0)}`,
    `Repeated Buyers: ${safeNum(volumeIntel.repeatedBuyers, 0)}`,
    `Sell Pressure: ${safeNum(volumeIntel.sellPressure, 0)}`,
    `Dump Spike: ${boolToText(Boolean(volumeIntel.dumpSpike))}`,
    `Pump 1m %: ${formatPct(volumeIntel.pump1mPct, 2)}`,
    `Buys 5m: ${safeNum(volumeIntel.buys5m, 0)}`,
    `Sells 5m: ${safeNum(volumeIntel.sells5m, 0)}`,
    ``,
    `📣 <b>Social Intel</b>`,
    `Unique Authors: ${safeNum(socialIntel.uniqueAuthors, 0)}`,
    `Avg Likes: ${safeNum(socialIntel.avgLikes, 0)}`,
    `Avg Replies: ${safeNum(socialIntel.avgReplies, 0)}`,
    `Bot Pattern Score: ${safeNum(socialIntel.botPatternScore, 0)}`,
    `Engagement Diversity: ${safeNum(socialIntel.engagementDiversity, 0)}`,
    `Trusted Mentions: ${safeNum(socialIntel.trustedMentions, 0)}`,
    `Suspicious Burst: ${boolToText(Boolean(socialIntel.suspiciousBurst))}`,
    `Organic Score: ${safeNum(socialIntel.organicScore, 0)}`,
    ``,
    `💼 <b>Execution / Portfolio</b>`,
    `Wallet ID: ${execution.walletId || "wallet_1"}`,
    `Base Desired USD: ${formatUsd(execution.baseDesiredUsd)}`,
    `Expected Slippage: ${formatPct(execution.expectedSlippagePct, 2)}`,
    `Wallet Balance SOL: ${safeNum(portfolio.walletBalanceSol, 0)}`,
    `Fee Reserve SOL: ${safeNum(portfolio.feeReserveSol, 0)}`,
    `Desired Tokens: ${safeNum(sizing.desiredTokens, 0)}`,
    `Wallet % After: ${formatPct(sizing.walletPctAfter, 4)}`,
    `Aggregate % After: ${formatPct(sizing.aggregatePctAfter, 4)}`,
    ``,
    `🚨 <b>Risk Flags</b>`,
    `Blocked: ${boolToText(Boolean(flags.blocked))}`,
    `Mint Risk: ${boolToText(Boolean(flags.mintRisk))}`,
    `Freeze Risk: ${boolToText(Boolean(flags.freezeRisk))}`,
    `Concentration Risk: ${boolToText(Boolean(flags.concentrationRisk))}`,
    `Creator Risk: ${boolToText(Boolean(flags.creatorRisk))}`,
    `LP Weak Risk: ${boolToText(Boolean(flags.lpWeakRisk))}`,
    `Suspicious Social Risk: ${boolToText(Boolean(flags.suspiciousSocialRisk))}`,
    `Dump Risk: ${boolToText(Boolean(flags.dumpRisk))}`,
    `Chase Risk: ${boolToText(Boolean(flags.chaseRisk))}`,
    `Bubble Cluster Risk: ${boolToText(Boolean(flags.bubbleClusterRisk))}`,
    `Rug Risk: ${boolToText(Boolean(flags.rugRisk))}`,
    `Rug Score High: ${boolToText(Boolean(flags.rugScoreHigh))}`
  ].join("\n");
}

function buildProposalText(proposal = {}) {
  const hints = proposal.decisionHints || {};
  const warnings = Array.isArray(hints.keyWarnings) ? hints.keyWarnings : [];
  const candidate = proposal.candidate || {};
  const token = candidate.token || {};
  const walletIntel = candidate.walletIntel || {};
  const rug = candidate.rugScamIntel || {};
  const social = candidate.socialIntel || {};
  const volume = candidate.volumeIntel || {};

  const lines = [
    `📄 <b>Level 6 Proposal</b>`,
    ``,
    `<b>Token:</b> ${token.symbol || token.name || "UNKNOWN"}`,
    `<b>CA:</b> <code>${token.ca || "-"}</code>`,
    `<b>Liquidity:</b> ${formatUsd(token.liquidityUsd)}`,
    `<b>5m Volume:</b> ${formatUsd(token.volume1mUsd)}`,
    `<b>Price:</b> ${formatUsd(token.tokenPriceUsd)}`,
    `<b>FDV:</b> ${formatUsd(token.fdvUsd)}`,
    `<b>Market Cap:</b> ${formatUsd(token.marketCapUsd)}`,
    ``,
    `👛 <b>Wallet Intel</b>`,
    `WinRate: ${safeNum(walletIntel.winRate, 0)}`,
    `Median ROI: ${safeNum(walletIntel.medianROI, 1)}`,
    `Consistency: ${safeNum(walletIntel.consistencyScore, 0)}`,
    `Consensus Leaders: ${safeNum(walletIntel.consensusLeaders, 0)}`,
    `Trades Count: ${safeNum(walletIntel.tradesCount, 0)}`,
    ``,
    `🛡 <b>Rug Risk</b>`,
    `Blocked By Hard Risk: ${boolToText(Boolean(hints.blockedByHardRisk))}`,
    `Rug Risk Score: ${safeNum(rug.riskScore, 0)}`,
    `Rug Blocked: ${boolToText(Boolean(rug.blocked))}`,
    ``,
    `📣 <b>Social</b>`,
    `Organic Score: ${safeNum(social.organicScore, 0)}`,
    `Bot Score: ${safeNum(social.botPatternScore, 0)}`,
    `Trusted Mentions: ${safeNum(social.trustedMentions, 0)}`,
    `Suspicious Burst: ${boolToText(Boolean(social.suspiciousBurst))}`,
    ``,
    `📈 <b>Flow</b>`,
    `Buy Pressure: ${safeNum(volume.buyPressure, 0)}`,
    `Sell Pressure: ${safeNum(volume.sellPressure, 0)}`,
    `Pump 1m: ${formatPct(volume.pump1mPct, 2)}`,
    ``,
    `💰 <b>Sizing</b>`,
    `Suggested USD: ${formatUsd(hints.suggestedUsd)}`,
    `Desired Tokens: ${safeNum(hints.desiredTokens, 0)}`,
    `Wallet % After: ${formatPct(hints.walletPctAfter, 4)}`,
    `Aggregate % After: ${formatPct(hints.aggregatePctAfter, 4)}`
  ];

  if (warnings.length) {
    lines.push("");
    lines.push(`<b>Warnings:</b>`);
    warnings.forEach(item => lines.push(`• ${item}`));
  }

  if (proposal.humanSummary) {
    lines.push("");
    lines.push(`<b>Summary:</b>`);
    lines.push(proposal.humanSummary);
  }

  return lines.join("\n");
}

function buildWalletIntelText(candidate = {}) {
  const walletIntel = candidate.walletIntel || {};
  const leaders = Array.isArray(walletIntel.leaders) ? walletIntel.leaders : [];

  const lines = [
    `👛 <b>GMGN Wallet Intel</b>`,
    ``,
    `<b>Source:</b> ${walletIntel.source || "-"}`,
    `<b>Win Rate:</b> ${safeNum(walletIntel.winRate, 0)}`,
    `<b>Median ROI:</b> ${safeNum(walletIntel.medianROI, 1)}`,
    `<b>Average ROI:</b> ${safeNum(walletIntel.averageROI, 1)}`,
    `<b>Max Drawdown:</b> ${safeNum(walletIntel.maxDrawdown, 0)}`,
    `<b>Trades Count:</b> ${safeNum(walletIntel.tradesCount, 0)}`,
    `<b>Early Entry Score:</b> ${safeNum(walletIntel.earlyEntryScore, 0)}`,
    `<b>Chase Penalty:</b> ${safeNum(walletIntel.chasePenalty, 0)}`,
    `<b>Dump Penalty:</b> ${safeNum(walletIntel.dumpPenalty, 0)}`,
    `<b>Consistency Score:</b> ${safeNum(walletIntel.consistencyScore, 0)}`,
    `<b>Consensus Leaders:</b> ${safeNum(walletIntel.consensusLeaders, 0)}`
  ];

  if (leaders.length) {
    lines.push("");
    lines.push(`<b>Leaders:</b>`);
    leaders.slice(0, 8).forEach((leader, index) => {
      lines.push(
        `${index + 1}. ${leader.name || leader.address || "unknown"} | winRate=${safeNum(
          leader.winRate,
          0
        )} | medianROI=${safeNum(leader.medianROI, 1)} | trades=${safeNum(leader.tradesCount, 0)}`
      );
    });
  }

  return lines.join("\n");
}

function buildRugRiskText(candidate = {}) {
  const rug = candidate.rugScamIntel || {};
  const reasons = Array.isArray(rug.reasons) ? rug.reasons : [];

  const lines = [
    `🛡 <b>Rug / Scam Review</b>`,
    ``,
    `<b>Blocked:</b> ${boolToText(Boolean(rug.blocked))}`,
    `<b>Risk Score:</b> ${safeNum(rug.riskScore, 0)}`
  ];

  if (reasons.length) {
    lines.push("");
    lines.push(`<b>Reasons:</b>`);
    reasons.forEach(item => lines.push(`• ${item}`));
  }

  const checks = rug.checks || {};
  const checkKeys = Object.keys(checks);

  if (checkKeys.length) {
    lines.push("");
    lines.push(`<b>Checks:</b>`);
    for (const key of checkKeys) {
      lines.push(`• ${key}: ${checks[key]}`);
    }
  }

  return lines.join("\n");
}

function buildEntryReportText(trade, explanation = {}) {
  const positive = Array.isArray(explanation.positive) ? explanation.positive : [];
  const cautions = Array.isArray(explanation.cautions) ? explanation.cautions : [];

  const lines = [
    `🧪 <b>Dry-Run Entry Accepted</b>`,
    `Token: ${trade.token || "-"}`,
    `CA: <code>${trade.ca || "-"}</code>`,
    `Entry: ${safeNum(trade.entry, 0)}`,
    `Score: ${safeNum(trade.score, 0)}`,
    `Confidence: ${trade.confidence || "unknown"}`
  ];

  if (positive.length) {
    lines.push("");
    lines.push(`<b>Why it passed:</b>`);
    positive.forEach(item => lines.push(`• ${item}`));
  }

  if (cautions.length) {
    lines.push("");
    lines.push(`<b>Cautions:</b>`);
    cautions.forEach(item => lines.push(`• ${item}`));
  }

  return lines.join("\n");
}

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
      proposal: buildProposalText(proposal),
      decision: buildDecisionText(analysis.decision),
      candidate: buildCandidateText(candidate),
      walletIntel: buildWalletIntelText(candidate),
      rugRisk: buildRugRiskText(candidate)
    }
  };
}

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
        `⛔ <b>Dry-Run Entry Rejected</b>`,
        "",
        buildDecisionText(analysis.decision),
        "",
        buildRugRiskText(candidate)
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

export function formatScanForTelegram(result = {}) {
  const parts = [];

  if (result.texts?.proposal) {
    parts.push(result.texts.proposal);
  }

  if (result.texts?.decision) {
    parts.push(result.texts.decision);
  }

  if (result.texts?.walletIntel) {
    parts.push(result.texts.walletIntel);
  }

  if (result.texts?.rugRisk) {
    parts.push(result.texts.rugRisk);
  }

  if (result.texts?.candidate) {
    parts.push(result.texts.candidate);
  }

  return parts.join("\n\n");
}

export function buildCompactScanSummary(result = {}) {
  const decision = result.decision || {};
  const candidate = result.candidate || {};
  const token = candidate.token || {};
  const social = candidate.socialIntel || {};
  const wallet = candidate.walletIntel || {};
  const rug = candidate.rugScamIntel || {};

  return [
    `<b>${token.symbol || token.name || "UNKNOWN"}</b>`,
    `CA: <code>${token.ca || "-"}</code>`,
    `Decision: ${decision.allowed ? "ALLOW" : "BLOCK"}`,
    `Score: ${safeNum(decision.score, 0)}`,
    `Confidence: ${decision.confidence || "unknown"}`,
    `Liquidity: ${formatUsd(token.liquidityUsd)}`,
    `5m Volume: ${formatUsd(token.volume1mUsd)}`,
    `Wallet WinRate: ${safeNum(wallet.winRate, 0)}`,
    `Wallet Consensus: ${safeNum(wallet.consensusLeaders, 0)}`,
    `Bot Score: ${safeNum(social.botPatternScore, 0)}`,
    `Organic Score: ${safeNum(social.organicScore, 0)}`,
    `Rug Score: ${safeNum(rug.riskScore, 0)}`,
    `Rug Blocked: ${boolToText(Boolean(rug.blocked))}`
  ].join("\n");
}

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
