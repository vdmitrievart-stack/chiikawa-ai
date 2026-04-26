// candidate-service.js (wallet-age enhanced excerpt)
// NOTE: This is a drop-in that augments display and scoring. It expects
// candidate.holderAccumulation.walletAge to be present (from the engine).

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function applyWalletAgeAntiRug(candidate = {}) {
  const wa = candidate?.holderAccumulation?.walletAge || {};
  const newSupply = safeNum(wa.newWalletSupplyPct, 0);
  const cluster = safeNum(wa.sameDayCluster, 0);
  const priceH1 = safeNum(candidate?.delta?.priceH1Pct, 0);

  // 🚨 Hard red flag condition
  if (newSupply > 45 && cluster >= 5 && priceH1 > 0) {
    candidate.antiRug = candidate.antiRug || {};
    candidate.antiRug.hardVeto = true;
    candidate.antiRug.verdict = "HARD_BLOCK";
    candidate.antiRug.riskScore = Math.max(80, safeNum(candidate.antiRug.riskScore, 0));
  }
}

export function renderWalletAgeBlock(candidate = {}) {
  const wa = candidate?.holderAccumulation?.walletAge;
  if (!wa) return "";

  const b = wa.buckets || {};
  return `👛 <b>Wallet Age</b>
New (&lt;3d): ${safeNum(b.lt3d, 0)} | 3–7d: ${safeNum(b.d3_7, 0)} | 7–30d: ${safeNum(b.d7_30, 0)} | Old: ${safeNum(b.gt30, 0)}
New wallet supply: ${safeNum(wa.newWalletSupplyPct, 0).toFixed(1)}%
Same-day cluster: ${safeNum(wa.sameDayCluster, 0)} | Risk: ${escapeHtml(wa.clusterRisk || "-")}
Avg age: ${safeNum(wa.avgWalletAgeDays, 0).toFixed(1)}d`;
}
