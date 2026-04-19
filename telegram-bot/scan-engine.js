/**
 * telegram-bot/scan-engine.js
 *
 * Level 6 scan engine v2
 */

import { buildTokenCandidate } from "./candidate-builder.js";

function safeNum(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function round(v, d = 2) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function stripText(text) {
  return String(text || "").trim();
}

function boolText(v) {
  return v ? "YES" : "NO";
}

function usd(v) {
  return `$${round(v, 2)}`;
}

function pct(v) {
  return `${round(v, 2)}%`;
}

function normalizeInput(input = {}) {
  return {
    ca: stripText(input.ca || input.contractAddress),
    chain: stripText(input.chain || input.chainId || "solana"),
    symbol: stripText(input.symbol || input.ticker || ""),
    name: stripText(input.name || "")
  };
}

function buildCompactScanSummary(result = {}) {
  const market = result.market || {};
  const decision = result.decision || {};
  const rug = result.rugRisk || {};
  const wallet = result.walletIntel || {};
  const social = result.socialIntel || {};

  return [
    `<b>${market.symbol || result.symbol || "UNKNOWN"}</b>`,
    `CA: <code>${result.ca || "-"}</code>`,
    `Decision: ${decision.allowed ? "ALLOW" : "BLOCK"}`,
    `Score: ${safeNum(decision.score, 0)}`,
    `Confidence: ${decision.confidence || "LOW"}`,
    `Liquidity: ${usd(market.liquidityUsd)}`,
    `5m Volume: ${usd(market.volume5mUsd)}`,
    `Rug Score: ${safeNum(rug.score, 0)} (${rug.level || "UNKNOWN"})`,
    `Wallet Score: ${safeNum(wallet.walletScore, 0)}`,
    `Organic Score: ${safeNum(social.organicScore, 0)}`,
    `Bot Score: ${safeNum(social.botPatternScore, 0)}`
  ].join("\n");
}

function buildProposalText(result = {}) {
  const market = result.market || {};
  const decision = result.decision || {};
  const rug = result.rugRisk || {};
  const wallet = result.walletIntel || {};
  const social = result.socialIntel || {};

  const lines = [
    `📄 <b>Level 6 Proposal</b>`,
    ``,
    `<b>Token:</b> ${market.symbol || "UNKNOWN"} ${market.name ? `(${market.name})` : ""}`,
    `<b>CA:</b> <code>${result.ca || "-"}</code>`,
    `<b>Chain:</b> ${result.chain || "-"}`,
    `<b>Dex:</b> ${market.dexId || "-"}`,
    `<b>Pair:</b> <code>${market.pairAddress || "-"}</code>`,
    ``,
    `💹 <b>Market</b>`,
    `Price: ${usd(market.priceUsd)}`,
    `Liquidity: ${usd(market.liquidityUsd)}`,
    `5m Volume: ${usd(market.volume5mUsd)}`,
    `1h Volume: ${usd(market.volume1hUsd)}`,
    `FDV: ${usd(market.fdvUsd)}`,
    `Market Cap: ${usd(market.marketCapUsd)}`,
    `Buys / Sells 5m: ${safeNum(market.buys5m, 0)} / ${safeNum(market.sells5m, 0)}`,
    `Price Change 5m: ${pct(market.priceChange5mPct)}`,
    `Price Change 1h: ${pct(market.priceChange1hPct)}`,
    ``,
    `🧠 <b>Decision</b>`,
    `Allowed: ${boolText(decision.allowed)}`,
    `Score: ${safeNum(decision.score, 0)}`,
    `Confidence: ${decision.confidence || "LOW"}`,
    ``,
    `👛 <b>Wallet Intel</b>`,
    `Smart Money Buys: ${safeNum(wallet.smartMoneyBuys, 0)}`,
    `Smart Money Sells: ${safeNum(wallet.smartMoneySells, 0)}`,
    `Top Holder Share: ${pct(safeNum(wallet.topHolderShare, 0) * 100)}`,
    `Wallet Score: ${safeNum(wallet.walletScore, 0)}`,
    ``,
    `📣 <b>Social Intel</b>`,
    `Unique Authors: ${safeNum(social.uniqueAuthors, 0)}`,
    `Avg Likes: ${safeNum(social.avgLikes, 0)}`,
    `Avg Replies: ${safeNum(social.avgReplies, 0)}`,
    `Bot Pattern Score: ${safeNum(social.botPatternScore, 0)}`,
    `Engagement Diversity: ${safeNum(social.engagementDiversity, 0)}`,
    `Trusted Mentions: ${safeNum(social.trustedMentions, 0)}`,
    `Suspicious Burst: ${boolText(Boolean(social.suspiciousBurst))}`,
    `Organic Score: ${safeNum(social.organicScore, 0)}`,
    ``,
    `🛡 <b>Rug Risk</b>`,
    `Risk Score: ${safeNum(rug.score, 0)}`,
    `Risk Level: ${rug.level || "UNKNOWN"}`
  ];

  if (Array.isArray(decision.reasons) && decision.reasons.length) {
    lines.push("");
    lines.push(`<b>Why it looks interesting:</b>`);
    decision.reasons.forEach(item => lines.push(`• ${item}`));
  }

  if (Array.isArray(decision.blockedReasons) && decision.blockedReasons.length) {
    lines.push("");
    lines.push(`<b>Hard blockers:</b>`);
    decision.blockedReasons.forEach(item => lines.push(`• ${item}`));
  }

  return lines.join("\n");
}

function buildWalletIntelText(result = {}) {
  const wallet = result.walletIntel || {};

  return [
    `👛 <b>Wallet Intel</b>`,
    ``,
    `Smart Money Buys: ${safeNum(wallet.smartMoneyBuys, 0)}`,
    `Smart Money Sells: ${safeNum(wallet.smartMoneySells, 0)}`,
    `Top Holder Share: ${pct(safeNum(wallet.topHolderShare, 0) * 100)}`,
    `Wallet Score: ${safeNum(wallet.walletScore, 0)}`,
    ``,
    wallet.walletScore >= 25
      ? `✅ Wallet layer looks constructive`
      : wallet.walletScore >= 0
      ? `⚠️ Wallet layer is mixed`
      : `⛔ Wallet layer looks weak`
  ].join("\n");
}

function buildSocialText(result = {}) {
  const social = result.socialIntel || {};

  return [
    `📣 <b>Social Intel</b>`,
    ``,
    `Unique Authors: ${safeNum(social.uniqueAuthors, 0)}`,
    `Avg Likes: ${safeNum(social.avgLikes, 0)}`,
    `Avg Replies: ${safeNum(social.avgReplies, 0)}`,
    `Bot Pattern Score: ${safeNum(social.botPatternScore, 0)}`,
    `Engagement Diversity: ${safeNum(social.engagementDiversity, 0)}`,
    `Trusted Mentions: ${safeNum(social.trustedMentions, 0)}`,
    `Suspicious Burst: ${boolText(Boolean(social.suspiciousBurst))}`,
    `Organic Score: ${safeNum(social.organicScore, 0)}`
  ].join("\n");
}

function buildRugRiskText(result = {}) {
  const rug = result.rugRisk || {};
  const reasons = Array.isArray(rug.reasons) ? rug.reasons : [];

  const lines = [
    `🛡 <b>Rug / Scam Review</b>`,
    ``,
    `Risk Score: ${safeNum(rug.score, 0)}`,
    `Risk Level: ${rug.level || "UNKNOWN"}`
  ];

  if (reasons.length) {
    lines.push("");
    lines.push(`<b>Reasons:</b>`);
    reasons.forEach(item => lines.push(`• ${item}`));
  } else {
    lines.push("");
    lines.push(`• No major rug flags detected`);
  }

  return lines.join("\n");
}

function buildFullReportText(result = {}) {
  const market = result.market || {};
  const social = result.socialIntel || {};
  const wallet = result.walletIntel || {};
  const rug = result.rugRisk || {};
  const decision = result.decision || {};

  return [
    `🧾 <b>Full Candidate Report</b>`,
    ``,
    `<b>Identity</b>`,
    `CA: <code>${result.ca || "-"}</code>`,
    `Chain: ${result.chain || "-"}`,
    `Symbol: ${market.symbol || "-"}`,
    `Name: ${market.name || "-"}`,
    `Dex: ${market.dexId || "-"}`,
    `Pair: <code>${market.pairAddress || "-"}</code>`,
    `Source: ${market.source || "-"}`,
    ``,
    `<b>Market</b>`,
    `Price: ${usd(market.priceUsd)}`,
    `Liquidity: ${usd(market.liquidityUsd)}`,
    `Liquidity Base: ${safeNum(market.liquidityBase, 0)}`,
    `Liquidity Quote: ${safeNum(market.liquidityQuote, 0)}`,
    `5m Volume: ${usd(market.volume5mUsd)}`,
    `1h Volume: ${usd(market.volume1hUsd)}`,
    `6h Volume: ${usd(market.volume6hUsd)}`,
    `24h Volume: ${usd(market.volume24hUsd)}`,
    `Buys / Sells 5m: ${safeNum(market.buys5m, 0)} / ${safeNum(market.sells5m, 0)}`,
    `Buys / Sells 1h: ${safeNum(market.buys1h, 0)} / ${safeNum(market.sells1h, 0)}`,
    `FDV: ${usd(market.fdvUsd)}`,
    `Market Cap: ${usd(market.marketCapUsd)}`,
    `Price Change 5m: ${pct(market.priceChange5mPct)}`,
    `Price Change 1h: ${pct(market.priceChange1hPct)}`,
    `Price Change 6h: ${pct(market.priceChange6hPct)}`,
    `Price Change 24h: ${pct(market.priceChange24hPct)}`,
    `Quality Score: ${safeNum(market.qualityScore, 0)}`,
    ``,
    `<b>Wallet Intel</b>`,
    `Smart Money Buys: ${safeNum(wallet.smartMoneyBuys, 0)}`,
    `Smart Money Sells: ${safeNum(wallet.smartMoneySells, 0)}`,
    `Top Holder Share: ${pct(safeNum(wallet.topHolderShare, 0) * 100)}`,
    `Wallet Score: ${safeNum(wallet.walletScore, 0)}`,
    ``,
    `<b>Social Intel</b>`,
    `Unique Authors: ${safeNum(social.uniqueAuthors, 0)}`,
    `Avg Likes: ${safeNum(social.avgLikes, 0)}`,
    `Avg Replies: ${safeNum(social.avgReplies, 0)}`,
    `Bot Pattern Score: ${safeNum(social.botPatternScore, 0)}`,
    `Engagement Diversity: ${safeNum(social.engagementDiversity, 0)}`,
    `Trusted Mentions: ${safeNum(social.trustedMentions, 0)}`,
    `Suspicious Burst: ${boolText(Boolean(social.suspiciousBurst))}`,
    `Organic Score: ${safeNum(social.organicScore, 0)}`,
    ``,
    `<b>Rug Risk</b>`,
    `Score: ${safeNum(rug.score, 0)}`,
    `Level: ${rug.level || "UNKNOWN"}`,
    ...(Array.isArray(rug.reasons) && rug.reasons.length
      ? rug.reasons.map(item => `• ${item}`)
      : [`• No major rug flags detected`]),
    ``,
    `<b>Decision</b>`,
    `Allowed: ${boolText(Boolean(decision.allowed))}`,
    `Score: ${safeNum(decision.score, 0)}`,
    `Confidence: ${decision.confidence || "LOW"}`,
    ...(Array.isArray(decision.reasons) ? decision.reasons.map(item => `• ${item}`) : []),
    ...(Array.isArray(decision.blockedReasons) && decision.blockedReasons.length
      ? [``, `<b>Blocked Reasons</b>`, ...decision.blockedReasons.map(item => `• ${item}`)]
      : [])
  ].join("\n");
}

function buildDryRunText(result = {}) {
  const decision = result.decision || {};
  const market = result.market || {};
  const rug = result.rugRisk || {};

  if (!decision.allowed) {
    return [
      `⛔ <b>Dry-Run Entry Rejected</b>`,
      ``,
      `Token: ${market.symbol || "UNKNOWN"}`,
      `CA: <code>${result.ca || "-"}</code>`,
      `Score: ${safeNum(decision.score, 0)}`,
      `Confidence: ${decision.confidence || "LOW"}`,
      `Rug Risk: ${safeNum(rug.score, 0)} (${rug.level || "UNKNOWN"})`,
      ``,
      ...(Array.isArray(decision.blockedReasons) && decision.blockedReasons.length
        ? decision.blockedReasons.map(item => `• ${item}`)
        : [`• No allow signal from Level 6`])
    ].join("\n");
  }

  return [
    `🧪 <b>Dry-Run Entry Accepted</b>`,
    ``,
    `Token: ${market.symbol || "UNKNOWN"}`,
    `CA: <code>${result.ca || "-"}</code>`,
    `Price: ${usd(market.priceUsd)}`,
    `Liquidity: ${usd(market.liquidityUsd)}`,
    `5m Volume: ${usd(market.volume5mUsd)}`,
    `Score: ${safeNum(decision.score, 0)}`,
    `Confidence: ${decision.confidence || "LOW"}`,
    ``,
    ...(Array.isArray(decision.reasons) && decision.reasons.length
      ? decision.reasons.map(item => `• ${item}`)
      : [`• Candidate passed current Level 6 thresholds`])
  ].join("\n");
}

export async function scanTokenCandidate(input = {}) {
  const normalized = normalizeInput(input);

  if (!normalized.ca) {
    throw new Error("scanTokenCandidate requires ca");
  }

  const candidate = await buildTokenCandidate({
    ca: normalized.ca,
    chain: normalized.chain,
    symbol: normalized.symbol,
    name: normalized.name
  });

  return {
    ok: true,
    ca: normalized.ca,
    chain: normalized.chain,
    symbol: normalized.symbol,
    name: normalized.name,

    market: candidate.market || {},
    socialIntel: candidate.socialIntel || {},
    walletIntel: candidate.walletIntel || {},
    rugRisk: candidate.rugRisk || {},
    decision: candidate.decision || {},

    texts: {
      proposal: buildProposalText(candidate),
      decision: buildProposalText({
        ...candidate,
        market: candidate.market,
        walletIntel: candidate.walletIntel,
        socialIntel: candidate.socialIntel,
        rugRisk: candidate.rugRisk,
        decision: candidate.decision
      }).replace(`📄 <b>Level 6 Proposal</b>`, `🧠 <b>Level 6 Decision</b>`),
      walletIntel: buildWalletIntelText(candidate),
      rugRisk: buildRugRiskText(candidate),
      social: buildSocialText(candidate),
      candidate: buildFullReportText(candidate),
      dryRun: buildDryRunText(candidate)
    }
  };
}

export async function buildScanProposal(input = {}) {
  const result = await scanTokenCandidate(input);

  return {
    ok: true,
    proposal: result,
    decision: result.decision,
    text: result.texts.proposal
  };
}

export async function dryRunEntryFromScan(input = {}) {
  const result = await scanTokenCandidate(input);

  return {
    ok: true,
    accepted: Boolean(result.decision?.allowed),
    candidate: result,
    decision: result.decision,
    text: result.texts.dryRun
  };
}

export { buildCompactScanSummary };
