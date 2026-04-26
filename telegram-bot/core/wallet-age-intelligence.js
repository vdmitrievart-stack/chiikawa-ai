// wallet-age-intelligence.js
// Computes wallet age buckets, same-day clusters, and supply held by new wallets.

export function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function buildWalletAgeStats(wallets = []) {
  const now = Date.now();

  const buckets = {
    lt3d: 0,
    d3_7: 0,
    d7_30: 0,
    gt30: 0
  };

  const dates = {}; // dayKey -> count

  let totalSupply = 0;
  let newSupply = 0;
  let ageSumDays = 0;
  let ageCount = 0;

  for (const w of wallets) {
    const firstSeen = safeNum(w.firstSeenAt, now);
    const ageDays = Math.max(0, (now - firstSeen) / (1000 * 60 * 60 * 24));
    const share = safeNum(w.sharePct, 0);

    totalSupply += share;
    ageSumDays += ageDays;
    ageCount += 1;

    if (ageDays <= 3) {
      buckets.lt3d++;
      newSupply += share;
    } else if (ageDays <= 7) {
      buckets.d3_7++;
    } else if (ageDays <= 30) {
      buckets.d7_30++;
    } else {
      buckets.gt30++;
    }

    const dayKey = Math.floor(firstSeen / (1000 * 60 * 60 * 24));
    dates[dayKey] = (dates[dayKey] || 0) + 1;
  }

  const sameDayCluster = Math.max(0, ...Object.values(dates));

  let clusterRisk = "LOW";
  if (sameDayCluster >= 8) clusterRisk = "HIGH";
  else if (sameDayCluster >= 4) clusterRisk = "MEDIUM";

  const newWalletSupplyPct = totalSupply > 0 ? (newSupply / totalSupply) * 100 : 0;
  const avgWalletAgeDays = ageCount > 0 ? ageSumDays / ageCount : 0;

  return {
    buckets,
    newWalletSupplyPct,
    sameDayCluster,
    clusterRisk,
    avgWalletAgeDays
  };
}
