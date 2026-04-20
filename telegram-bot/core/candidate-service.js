import { getBestTrade, analyzeToken } from "../scan-engine.js";
import { buildStrategyPlans } from "../strategy-engine.js";
import { isStrategyAllowed } from "./trading-runtime.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeBool(v) {
  return Boolean(v);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function round(v, d = 4) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function buildLinksText(links = {}) {
  const rows = [];
  if (links.website) rows.push(`🌐 <a href="${escapeHtml(links.website)}">Website</a>`);
  if (links.twitter) rows.push(`🐦 <a href="${escapeHtml(links.twitter)}">Twitter/X</a>`);
  if (links.telegram) rows.push(`✈️ <a href="${escapeHtml(links.telegram)}">Telegram</a>`);
  if (links.instagram) rows.push(`📸 <a href="${escapeHtml(links.instagram)}">Instagram</a>`);
  if (links.facebook) rows.push(`📘 <a href="${escapeHtml(links.facebook)}">Facebook</a>`);
  return rows.length ? rows.join(" | ") : "none";
}

function buildDexText(token) {
  const rows = [];
  if (token?.url) rows.push(`📊 <a href="${escapeHtml(token.url)}">DexScreener</a>`);
  if (token?.chainId) rows.push(`Chain: ${escapeHtml(token.chainId)}`);
  if (token?.dexId) rows.push(`DEX: ${escapeHtml(token.dexId)}`);
  return rows.join(" | ") || "n/a";
}

function derivePriceExtensionPct(candidate) {
  const explicit = safeNum(candidate?.copytradeMeta?.priceExtensionPct, NaN);
  if (Number.isFinite(explicit)) return explicit;

  const deltaPct = safeNum(candidate?.delta?.priceDeltaPct, NaN);
  if (Number.isFinite(deltaPct)) return Math.max(0, deltaPct);

  const momentumPct = safeNum(candidate?.momentum?.priceExtensionPct, NaN);
  if (Number.isFinite(momentumPct)) return Math.max(0, momentumPct);

  return 0;
}

function deriveFollowDelaySec(candidate) {
  const explicit = safeNum(candidate?.copytradeMeta?.followDelaySec, NaN);
  if (Number.isFinite(explicit)) return explicit;

  const leaderBuyTs =
    safeNum(candidate?.copytradeMeta?.leaderBuyTs, 0) ||
    safeNum(candidate?.leaderTrade?.buyTs, 0) ||
    safeNum(candidate?.leaderTrade?.timestamp, 0);

  if (leaderBuyTs > 0) {
    return Math.max(0, Math.round((Date.now() - leaderBuyTs) / 1000));
  }

  return 0;
}

function deriveSocialCount(candidate) {
  const explicit = safeNum(candidate?.socials?.socialCount, NaN);
  if (Number.isFinite(explicit)) return explicit;

  const links = candidate?.socials?.links || {};
  let count = 0;
  if (links.website) count += 1;
  if (links.twitter) count += 1;
  if (links.telegram) count += 1;
  if (links.instagram) count += 1;
  if (links.facebook) count += 1;
  return count;
}

function deriveHolderConcentration(candidate) {
  const values = [
    candidate?.wallet?.concentration,
    candidate?.holders?.concentration,
    candidate?.distribution?.holderConcentration,
    candidate?.risk?.holderConcentration
  ]
    .map((x) => safeNum(x, NaN))
    .filter((x) => Number.isFinite(x));

  return values.length ? values[0] : 0;
}

function deriveRugRisk(candidate) {
  const values = [
    candidate?.rug?.risk,
    candidate?.risk?.rugRisk,
    candidate?.security?.rugRisk
  ]
    .map((x) => safeNum(x, NaN))
    .filter((x) => Number.isFinite(x));

  return values.length ? values[0] : 0;
}

function deriveLiquidityUsd(candidate) {
  const values = [
    candidate?.token?.liquidity,
    candidate?.liquidity?.usd,
    candidate?.market?.liquidityUsd
  ]
    .map((x) => safeNum(x, NaN))
    .filter((x) => Number.isFinite(x));

  return values.length ? values[0] : 0;
}

function deriveBotActivity(candidate) {
  const values = [
    candidate?.bots?.botActivity,
    candidate?.flow?.botActivity,
    candidate?.risk?.botActivity
  ]
    .map((x) => safeNum(x, NaN))
    .filter((x) => Number.isFinite(x));

  return values.length ? values[0] : 0;
}

function deriveDistributionScore(candidate) {
  const values = [
    candidate?.distribution?.score,
    candidate?.risk?.distributionScore
  ]
    .map((x) => safeNum(x, NaN))
    .filter((x) => Number.isFinite(x));

  return values.length ? values[0] : 0;
}

function deriveAccumulationScore(candidate) {
  const values = [
    candidate?.accumulation?.score,
    candidate?.flow?.accumulationScore
  ]
    .map((x) => safeNum(x, NaN))
    .filter((x) => Number.isFinite(x));

  return values.length ? values[0] : 0;
}

function deriveAbsorptionScore(candidate) {
  const values = [
    candidate?.absorption?.score,
    candidate?.flow?.absorptionScore
  ]
    .map((x) => safeNum(x, NaN))
    .filter((x) => Number.isFinite(x));

  return values.length ? values[0] : 0;
}

function buildCopytradeMeta(candidate) {
  const followDelaySec = deriveFollowDelaySec(candidate);
  const priceExtensionPct = derivePriceExtensionPct(candidate);
  const rugRisk = deriveRugRisk(candidate);
  const liquidityUsd = deriveLiquidityUsd(candidate);
  const holderConcentration = deriveHolderConcentration(candidate);
  const botActivity = deriveBotActivity(candidate);
  const distributionScore = deriveDistributionScore(candidate);
  const accumulationScore = deriveAccumulationScore(candidate);
  const absorptionScore = deriveAbsorptionScore(candidate);
  const socialCount = deriveSocialCount(candidate);

  const isLateFollow = followDelaySec > 90;
  const isOverextended = priceExtensionPct > 18;
  const borderline =
    !isLateFollow &&
    !isOverextended &&
    (
      liquidityUsd < 12000 ||
      holderConcentration > 35 ||
      rugRisk > 30 ||
      distributionScore > 18
    );

  return {
    followDelaySec,
    priceExtensionPct,
    isLateFollow,
    isOverextended,
    borderline,
    rugRisk,
    liquidityUsd,
    holderConcentration,
    botActivity,
    distributionScore,
    accumulationScore,
    absorptionScore,
    socialCount,
    leaderBuyTs:
      safeNum(candidate?.copytradeMeta?.leaderBuyTs, 0) ||
      safeNum(candidate?.leaderTrade?.buyTs, 0) ||
      safeNum(candidate?.leaderTrade?.timestamp, 0),
    source:
      candidate?.copytradeMeta?.source ||
      candidate?.leaderTrade?.source ||
      "derived"
  };
}

function buildFollowQuality(candidate) {
  const cm = candidate?.copytradeMeta || {};
  const leader = candidate?.leaderTrade || {};

  const reasons = [];
  let grade = "N/A";

  if (!leader.address) {
    return {
      grade,
      reasons: ["No matched leader trade"],
      hasLeaderEvent: false
    };
  }

  if (cm.isLateFollow) reasons.push("late follow");
  if (cm.isOverextended) reasons.push("price overextended");
  if (cm.borderline) reasons.push("borderline setup");

  if (!cm.isLateFollow && !cm.isOverextended && !cm.borderline) {
    grade = "GOOD";
    reasons.push("timing acceptable");
    reasons.push("extension acceptable");
  } else if (!cm.isOverextended && (cm.isLateFollow || cm.borderline)) {
    grade = "BORDERLINE";
  } else {
    grade = "BAD";
  }

  return {
    grade,
    reasons,
    hasLeaderEvent: true
  };
}

function normalizeCandidate(candidate) {
  const next = clone(candidate || {});
  next.copytradeMeta = buildCopytradeMeta(next);
  next.followQuality = buildFollowQuality(next);
  return next;
}

function formatLeaderBuyTs(ts) {
  const n = safeNum(ts, 0);
  if (!n) return "-";
  try {
    return new Date(n).toISOString();
  } catch {
    return "-";
  }
}

export default class CandidateService {
  constructor(options = {}) {
    this.logger = options.logger || console;
  }

  async findBestCandidate({ runtime, openPositions = [], recentlyTraded = [] }) {
    const excludeCas = [
      ...recentlyTraded,
      ...openPositions.map((p) => p.ca)
    ];

    const rawCandidate = await getBestTrade({ excludeCas });
    if (!rawCandidate) return null;

    const candidate = normalizeCandidate(rawCandidate);

    const plans = buildStrategyPlans(candidate).filter((plan) =>
      isStrategyAllowed(runtime, plan.strategyKey)
    );

    return {
      candidate,
      plans,
      heroImage:
        candidate.token?.headerUrl ||
        candidate.token?.imageUrl ||
        candidate.token?.iconUrl ||
        null
    };
  }

  async scanCA({ runtime, fetchTokenByCA, ca }) {
    const token = await fetchTokenByCA(ca);
    if (!token) return null;

    const analyzed = normalizeCandidate(await analyzeToken(token));

    const plans = buildStrategyPlans(analyzed).filter((plan) =>
      isStrategyAllowed(runtime, plan.strategyKey)
    );

    return {
      analyzed,
      plans,
      heroImage:
        analyzed.token?.headerUrl ||
        analyzed.token?.imageUrl ||
        analyzed.token?.iconUrl ||
        null
    };
  }

  buildHeroCaption(analyzed) {
    const tkn = analyzed.token || {};
    const links = analyzed.socials?.links || {};

    return `🧾 <b>Scanning CA</b>

<b>${escapeHtml(tkn.name || "Unknown")}</b>
<code>${escapeHtml(tkn.ca || "")}</code>

<b>Links:</b> ${buildLinksText(links)}
<b>Dex:</b> ${buildDexText(tkn)}`.slice(0, 1024);
  }

  buildAnalysisText(analyzed, plans) {
    const tkn = analyzed.token || {};
    const reasons = (analyzed.reasons || [])
      .slice(0, 14)
      .map((r) => `• ${escapeHtml(r)}`)
      .join("\n");

    const plansText = plans.length
      ? plans
          .map(
            (p) =>
              `• <b>${escapeHtml(p.strategyKey.toUpperCase())}</b> | edge ${round(
                p.expectedEdgePct,
                2
              )}% | hold ${Math.round(p.plannedHoldMs / 60000)}m | SL ${p.stopLossPct}% | TP ${
                p.takeProfitPct || "runner"
              }`
          )
          .join("\n")
      : "• none";

    const cm = analyzed.copytradeMeta || {};
    const lq = analyzed.followQuality || {};
    const lt = analyzed.leaderTrade || {};

    return `🔎 <b>ANALYSIS</b>

<b>Token:</b> ${escapeHtml(tkn.name || "Unknown")}
<b>Symbol:</b> ${escapeHtml(tkn.symbol || "")}
<b>CA:</b> <code>${escapeHtml(tkn.ca || "")}</code>

<b>Dex:</b> ${buildDexText(tkn)}
<b>DEX Paid:</b> ${escapeHtml(analyzed.dexPaid?.status || "Unknown")}
<b>Token Type:</b> ${escapeHtml(analyzed.mechanics?.tokenType || "Unknown")}
<b>Reward Model:</b> ${escapeHtml(analyzed.mechanics?.rewardModel || "Unknown")}
<b>Beneficiary Signal:</b> ${escapeHtml(analyzed.mechanics?.beneficiarySignal || "Unknown")}
<b>Claim Signal:</b> ${escapeHtml(analyzed.mechanics?.claimSignal || "Unknown")}

<b>Price:</b> ${escapeHtml(tkn.price)}
<b>Liquidity:</b> ${escapeHtml(tkn.liquidity)}
<b>Volume 24h:</b> ${escapeHtml(tkn.volume)}
<b>Txns 24h:</b> ${escapeHtml(tkn.txns)}
<b>FDV:</b> ${escapeHtml(tkn.fdv)}

<b>Narrative:</b> ${escapeHtml(analyzed.narrative?.verdict || "Unknown")}
<b>Links:</b> ${buildLinksText(analyzed.socials?.links || {})}

<b>Leader follow quality</b>
leader: ${escapeHtml(lt.address || "-")}
leader score: ${safeNum(lt.leaderScore, 0)}
leader state: ${escapeHtml(lt.leaderState || "-")}
leader buy ts: ${escapeHtml(formatLeaderBuyTs(lt.buyTs))}
leader buy price: ${safeNum(lt.buyPriceUsd, 0)}
delay: ${safeNum(cm.followDelaySec)}s
extension: ${round(cm.priceExtensionPct, 2)}%
late follow: ${safeBool(cm.isLateFollow) ? "yes" : "no"}
overextended: ${safeBool(cm.isOverextended) ? "yes" : "no"}
borderline: ${safeBool(cm.borderline) ? "yes" : "no"}
grade: ${escapeHtml(lq.grade || "N/A")}
details:
${(lq.reasons || []).map((x) => `• ${escapeHtml(x)}`).join("\n") || "• none"}

<b>Available plans</b>
${plansText}

<b>Reasons:</b>
${reasons || "• none"}`;
  }
}
