// wallet-cluster-intelligence.js
// Detects coordinated holder clusters using first-seen/creation-like dates,
// similar buy sizes, synchronized buy windows, and young-wallet supply.

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function roundNum(v, d = 2) {
  const p = 10 ** d;
  return Math.round((safeNum(v, 0) + Number.EPSILON) * p) / p;
}

function bucketByMs(ts, bucketMs) {
  const t = safeNum(ts, 0);
  if (!t) return 0;
  return Math.floor(t / bucketMs);
}

function maxBucket(rows = [], keyFn = () => '') {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || key === '0') continue;
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }
  let bestKey = '';
  let bestRows = [];
  for (const [key, list] of map.entries()) {
    if (list.length > bestRows.length) {
      bestKey = key;
      bestRows = list;
    }
  }
  return { key: bestKey, count: bestRows.length, rows: bestRows };
}

function coefficientOfVariation(values = []) {
  const nums = values.map((x) => safeNum(x, 0)).filter((x) => x > 0);
  if (nums.length < 2) return 999;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean <= 0) return 999;
  const variance = nums.reduce((acc, x) => acc + ((x - mean) ** 2), 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

function sumShare(rows = []) {
  return rows.reduce((sum, row) => sum + safeNum(row?.trackedSharePct, 0), 0);
}

export function buildWalletClusterStats(walletRows = []) {
  const now = Date.now();
  const rows = Array.isArray(walletRows) ? walletRows : [];
  const meaningful = rows.filter((row) =>
    safeNum(row?.trackedSharePct, 0) > 0 ||
    safeNum(row?.currentTokenAmount, 0) > 0
  );

  const enriched = meaningful.map((row) => {
    const firstSeenAt =
      safeNum(row?.firstSeenAt, 0) ||
      safeNum(row?.firstBuyAt, 0) ||
      safeNum(row?.latestBuyAt, 0) ||
      now;
    const latestBuyAt = safeNum(row?.latestBuyAt, 0);
    const buyAmount =
      safeNum(row?.latestBuyAmount, 0) ||
      safeNum(row?.totalBought, 0) ||
      safeNum(row?.currentTokenAmount, 0);
    const ageDays = Math.max(0, (now - firstSeenAt) / 86400000);
    return {
      ...row,
      firstSeenAt,
      latestBuyAt,
      buyAmount,
      ageDays,
      ageBucketDay: bucketByMs(firstSeenAt, 24 * 60 * 60 * 1000),
      buyBucket15m: latestBuyAt ? bucketByMs(latestBuyAt, 15 * 60 * 1000) : 0,
      trackedSharePct: safeNum(row?.trackedSharePct, 0)
    };
  });

  const youngRows = enriched.filter((row) => row.ageDays <= 7);
  const veryYoungRows = enriched.filter((row) => row.ageDays <= 3);
  const oldRows = enriched.filter((row) => row.ageDays > 30);

  const sameDay = maxBucket(enriched, (row) => String(row.ageBucketDay || ''));
  const sameDayYoung = maxBucket(youngRows, (row) => String(row.ageBucketDay || ''));
  const sameBuyWindow = maxBucket(enriched, (row) => String(row.buyBucket15m || ''));

  const sameDayBuySizeCv = coefficientOfVariation(sameDay.rows.map((row) => row.buyAmount));
  const globalBuySizeCv = coefficientOfVariation(enriched.map((row) => row.buyAmount));

  const youngSupplyPct = sumShare(youngRows);
  const veryYoungSupplyPct = sumShare(veryYoungRows);
  const oldSupplyPct = sumShare(oldRows);
  const sameDayClusterSupplyPct = sumShare(sameDay.rows);
  const sameBuyWindowSupplyPct = sumShare(sameBuyWindow.rows);
  const avgAgeDays = enriched.length ? enriched.reduce((s, r) => s + safeNum(r.ageDays, 0), 0) / enriched.length : 0;
  const avgYoungAgeDays = youngRows.length ? youngRows.reduce((s, r) => s + safeNum(r.ageDays, 0), 0) / youngRows.length : 0;

  let clusterRiskScore = 0;
  const reasons = [];

  if (youngSupplyPct >= 35) { clusterRiskScore += 18; reasons.push('large supply held by <=7d wallets'); }
  if (veryYoungSupplyPct >= 25) { clusterRiskScore += 16; reasons.push('large supply held by <=3d wallets'); }
  if (sameDay.count >= 5) { clusterRiskScore += 18; reasons.push('many holders first seen same day'); }
  if (sameDayYoung.count >= 4) { clusterRiskScore += 16; reasons.push('young same-day holder cluster'); }
  if (sameDayClusterSupplyPct >= 25) { clusterRiskScore += 14; reasons.push('same-day cluster controls meaningful supply'); }
  if (sameBuyWindow.count >= 4) { clusterRiskScore += 12; reasons.push('holders bought in same 15m window'); }
  if (sameBuyWindowSupplyPct >= 20) { clusterRiskScore += 10; reasons.push('same buy-window cluster controls supply'); }
  if (sameDayBuySizeCv <= 0.22 && sameDay.count >= 4) { clusterRiskScore += 14; reasons.push('same-day holders have similar buy sizes'); }
  if (globalBuySizeCv <= 0.25 && enriched.length >= 5) { clusterRiskScore += 10; reasons.push('global holder buy sizes are unusually similar'); }
  if (oldSupplyPct >= 35 && youngSupplyPct < 20) { clusterRiskScore -= 12; reasons.push('older wallets dominate tracked supply'); }

  clusterRiskScore = clamp(Math.round(clusterRiskScore), 0, 100);
  const clusterRisk = clusterRiskScore >= 70 ? 'HIGH' : clusterRiskScore >= 45 ? 'MEDIUM' : clusterRiskScore >= 25 ? 'WATCH' : 'LOW';

  return {
    trackedWallets: enriched.length,
    totalTrackedSharePct: roundNum(sumShare(enriched), 2),
    youngWalletCount7d: youngRows.length,
    veryYoungWalletCount3d: veryYoungRows.length,
    oldWalletCount30d: oldRows.length,
    youngSupplyPct: roundNum(youngSupplyPct, 2),
    veryYoungSupplyPct: roundNum(veryYoungSupplyPct, 2),
    oldSupplyPct: roundNum(oldSupplyPct, 2),
    avgAgeDays: roundNum(avgAgeDays, 2),
    avgYoungAgeDays: roundNum(avgYoungAgeDays, 2),
    sameDayClusterCount: sameDay.count,
    sameDayClusterSupplyPct: roundNum(sameDayClusterSupplyPct, 2),
    sameDayYoungClusterCount: sameDayYoung.count,
    sameBuyWindowClusterCount: sameBuyWindow.count,
    sameBuyWindowSupplyPct: roundNum(sameBuyWindowSupplyPct, 2),
    sameDayBuySizeCv: roundNum(sameDayBuySizeCv, 3),
    globalBuySizeCv: roundNum(globalBuySizeCv, 3),
    clusterRisk,
    clusterRiskScore,
    reasons
  };
}
