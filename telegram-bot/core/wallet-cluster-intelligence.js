// wallet-cluster-intelligence.js
// Detects coordinated holder clusters:
// - real wallet age from owner wallet history / same-day creation cluster
// - same 15m buy-window cluster
// - similar buy sizes
// - funding-source hints when available from wallet records

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

function coefficientOfVariation(values = []) {
  const nums = values.map((x) => safeNum(x, 0)).filter((x) => x > 0);
  if (nums.length < 2) return 999;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean <= 0) return 999;
  const variance = nums.reduce((acc, x) => acc + ((x - mean) ** 2), 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

function maxBucket(rows = [], keyFn = () => "") {
  const map = new Map();

  for (const row of rows) {
    const key = String(keyFn(row) || "");
    if (!key || key === "0") continue;
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }

  let bestKey = "";
  let bestRows = [];

  for (const [key, list] of map.entries()) {
    if (list.length > bestRows.length) {
      bestKey = key;
      bestRows = list;
    }
  }

  return {
    key: bestKey,
    count: bestRows.length,
    rows: bestRows
  };
}

function supply(rows = []) {
  return rows.reduce((sum, row) => sum + safeNum(row?.trackedSharePct, 0), 0);
}

export function buildWalletClusterStats(walletRows = []) {
  const now = Date.now();
  const rows = Array.isArray(walletRows) ? walletRows : [];

  const enriched = rows
    .filter((row) => safeNum(row?.trackedSharePct, 0) > 0 || safeNum(row?.currentTokenAmount, 0) > 0)
    .map((row) => {
      const tokenFirstSeenAt =
        safeNum(row?.firstSeenAt, 0) ||
        safeNum(row?.firstBuyAt, 0) ||
        safeNum(row?.latestBuyAt, 0) ||
        now;

      const walletFirstActivityAt = safeNum(row?.walletFirstActivityAt, 0);
      const walletFirstActivityComplete = row?.walletFirstActivityComplete === true;
      const latestBuyAt = safeNum(row?.latestBuyAt, 0);
      const buyAmount =
        safeNum(row?.latestBuyAmount, 0) ||
        safeNum(row?.totalBought, 0) ||
        safeNum(row?.currentTokenAmount, 0);

      const tokenAgeDays = Math.max(0, (now - tokenFirstSeenAt) / 86400000);
      const walletAgeDays = walletFirstActivityAt > 0 && walletFirstActivityComplete
        ? Math.max(0, (now - walletFirstActivityAt) / 86400000)
        : 0;

      return {
        ...row,
        firstSeenAt: tokenFirstSeenAt,
        tokenFirstSeenAt,
        walletFirstActivityAt,
        walletFirstActivityComplete,
        latestBuyAt,
        buyAmount,
        tokenAgeDays,
        ageDays: walletAgeDays,
        ageBucketDay: walletFirstActivityComplete ? bucketByMs(walletFirstActivityAt, 24 * 60 * 60 * 1000) : 0,
        tokenAgeBucketDay: bucketByMs(tokenFirstSeenAt, 24 * 60 * 60 * 1000),
        buyBucket15m: latestBuyAt ? bucketByMs(latestBuyAt, 15 * 60 * 1000) : 0,
        trackedSharePct: safeNum(row?.trackedSharePct, 0),
        fundingSource: String(row?.fundingSource || row?.firstFundingSource || "")
      };
    });

  const walletAgeKnownRows = enriched.filter((row) => row.walletFirstActivityComplete && safeNum(row?.walletFirstActivityAt, 0) > 0);
  const walletAgeUnknownRows = enriched.filter((row) => !row.walletFirstActivityComplete || safeNum(row?.walletFirstActivityAt, 0) <= 0);
  const youngRows = walletAgeKnownRows.filter((row) => row.ageDays <= 7);
  const veryYoungRows = walletAgeKnownRows.filter((row) => row.ageDays <= 3);
  const oldRows = walletAgeKnownRows.filter((row) => row.ageDays > 30);

  const sameDay = maxBucket(walletAgeKnownRows, (row) => row.ageBucketDay);
  const sameDayYoung = maxBucket(youngRows, (row) => row.ageBucketDay);
  const sameBuyWindow = maxBucket(enriched, (row) => row.buyBucket15m);
  const sameFunding = maxBucket(enriched, (row) => row.fundingSource);

  const youngSupplyPct = supply(youngRows);
  const veryYoungSupplyPct = supply(veryYoungRows);
  const oldSupplyPct = supply(oldRows);
  const sameDayClusterSupplyPct = supply(sameDay.rows);
  const sameBuyWindowSupplyPct = supply(sameBuyWindow.rows);
  const sameFundingSupplyPct = supply(sameFunding.rows);

  const sameDayBuySizeCv = coefficientOfVariation(sameDay.rows.map((row) => row.buyAmount));
  const sameBuyWindowBuySizeCv = coefficientOfVariation(sameBuyWindow.rows.map((row) => row.buyAmount));
  const globalBuySizeCv = coefficientOfVariation(enriched.map((row) => row.buyAmount));

  const avgAgeDays = walletAgeKnownRows.length
    ? walletAgeKnownRows.reduce((sum, row) => sum + safeNum(row.ageDays, 0), 0) / walletAgeKnownRows.length
    : 0;

  const avgYoungAgeDays = youngRows.length
    ? youngRows.reduce((sum, row) => sum + safeNum(row.ageDays, 0), 0) / youngRows.length
    : 0;

  const avgTokenInteractionAgeDays = enriched.length
    ? enriched.reduce((sum, row) => sum + safeNum(row.tokenAgeDays, 0), 0) / enriched.length
    : 0;

  let clusterRiskScore = 0;
  const reasons = [];

  if (youngSupplyPct >= 35) {
    clusterRiskScore += 18;
    reasons.push("много supply у кошельков младше 7 дней");
  }

  if (veryYoungSupplyPct >= 25) {
    clusterRiskScore += 16;
    reasons.push("много supply у кошельков младше 3 дней");
  }

  if (sameDay.count >= 5) {
    clusterRiskScore += 18;
    reasons.push("много кошельков впервые активировались в один день");
  }

  if (sameDayYoung.count >= 4) {
    clusterRiskScore += 16;
    reasons.push("молодой same-day кластер кошельков");
  }

  if (sameDayClusterSupplyPct >= 25) {
    clusterRiskScore += 14;
    reasons.push("same-day кластер контролирует заметную долю");
  }

  if (sameBuyWindow.count >= 4) {
    clusterRiskScore += 12;
    reasons.push("кошельки покупали в одном 15м окне");
  }

  if (sameBuyWindowSupplyPct >= 20) {
    clusterRiskScore += 10;
    reasons.push("15м buy-window кластер контролирует supply");
  }

  if (sameDayBuySizeCv <= 0.22 && sameDay.count >= 4) {
    clusterRiskScore += 14;
    reasons.push("same-day кошельки покупали похожими размерами");
  }

  if (sameBuyWindowBuySizeCv <= 0.25 && sameBuyWindow.count >= 4) {
    clusterRiskScore += 12;
    reasons.push("кошельки в одном 15м окне имеют похожий размер покупки");
  }

  if (globalBuySizeCv <= 0.25 && enriched.length >= 5) {
    clusterRiskScore += 10;
    reasons.push("размеры покупок по группе необычно похожи");
  }

  if (sameFunding.count >= 4) {
    clusterRiskScore += 20;
    reasons.push("несколько кошельков имеют общий funding source");
  }

  if (sameFundingSupplyPct >= 20) {
    clusterRiskScore += 16;
    reasons.push("общий funding source контролирует заметную долю");
  }

  if (oldSupplyPct >= 35 && youngSupplyPct < 20) {
    clusterRiskScore -= 12;
    reasons.push("старые кошельки доминируют в отслеживаемой базе");
  }

  clusterRiskScore = clamp(Math.round(clusterRiskScore), 0, 100);

  const clusterRisk =
    clusterRiskScore >= 70 ? "HIGH" :
    clusterRiskScore >= 45 ? "MEDIUM" :
    clusterRiskScore >= 25 ? "WATCH" :
    "LOW";

  return {
    trackedWallets: enriched.length,
    totalTrackedSharePct: roundNum(supply(enriched), 2),
    walletAgeKnownCount: walletAgeKnownRows.length,
    walletAgeUnknownCount: walletAgeUnknownRows.length,
    walletAgeSource: "owner_wallet_history_v2",
    walletAgeBasis: "owner_first_onchain_activity",
    youngWalletCount7d: youngRows.length,
    veryYoungWalletCount3d: veryYoungRows.length,
    oldWalletCount30d: oldRows.length,
    youngSupplyPct: roundNum(youngSupplyPct, 2),
    veryYoungSupplyPct: roundNum(veryYoungSupplyPct, 2),
    oldSupplyPct: roundNum(oldSupplyPct, 2),
    avgAgeDays: roundNum(avgAgeDays, 2),
    avgWalletAgeDays: roundNum(avgAgeDays, 2),
    avgYoungAgeDays: roundNum(avgYoungAgeDays, 2),
    avgTokenInteractionAgeDays: roundNum(avgTokenInteractionAgeDays, 2),
    sameDayClusterCount: sameDay.count,
    sameDayClusterSupplyPct: roundNum(sameDayClusterSupplyPct, 2),
    sameDayYoungClusterCount: sameDayYoung.count,
    sameBuyWindowClusterCount: sameBuyWindow.count,
    sameBuyWindowSupplyPct: roundNum(sameBuyWindowSupplyPct, 2),
    sameFundingClusterCount: sameFunding.count,
    sameFundingSupplyPct: roundNum(sameFundingSupplyPct, 2),
    sameFundingSource: sameFunding.key || "",
    sameDayBuySizeCv: roundNum(sameDayBuySizeCv, 3),
    sameBuyWindowBuySizeCv: roundNum(sameBuyWindowBuySizeCv, 3),
    globalBuySizeCv: roundNum(globalBuySizeCv, 3),
    clusterRisk,
    clusterRiskScore,
    reasons
  };
}
