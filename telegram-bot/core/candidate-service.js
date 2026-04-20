import { getBestTrade, analyzeToken } from "../scan-engine.js";
import { buildStrategyPlans } from "../strategy-engine.js";
import { isStrategyAllowed } from "./trading-runtime.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

export default class CandidateService {
  constructor(options = {}) {
    this.logger = options.logger || console;
  }

  async findBestCandidate({ runtime, openPositions = [], recentlyTraded = [] }) {
    const excludeCas = [
      ...recentlyTraded,
      ...openPositions.map((p) => p.ca)
    ];

    const candidate = await getBestTrade({ excludeCas });
    if (!candidate) return null;

    const plans = buildStrategyPlans(candidate).filter((plan) =>
      isStrategyAllowed(runtime, plan.strategyKey)
    );

    return {
      candidate,
      plans,
      heroImage:
        candidate.token.headerUrl ||
        candidate.token.imageUrl ||
        candidate.token.iconUrl ||
        null
    };
  }

  async scanCA({ runtime, fetchTokenByCA, ca }) {
    const token = await fetchTokenByCA(ca);
    if (!token) return null;

    const analyzed = await analyzeToken(token);
    const plans = buildStrategyPlans(analyzed).filter((plan) =>
      isStrategyAllowed(runtime, plan.strategyKey)
    );

    return {
      analyzed,
      plans,
      heroImage:
        analyzed.token.headerUrl ||
        analyzed.token.imageUrl ||
        analyzed.token.iconUrl ||
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

<b>Available plans</b>
${plansText}

<b>Reasons:</b>
${reasons || "• none"}`;
  }
}
