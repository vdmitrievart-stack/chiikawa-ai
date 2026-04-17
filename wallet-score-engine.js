import { getTrackedWallet, updateTrackedWallet } from "./tracked-wallet-store.js";

function stableHash(text) {
  let hash = 0;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pseudoMetric(address, min, max, salt) {
  const h = stableHash(`${address}:${salt}`);
  const ratio = (h % 10000) / 10000;
  return min + ratio * (max - min);
}

// Stage 1: mock scoring skeleton.
// Later this gets replaced with Birdeye/Helius/Jupiter-backed real metrics.
export function computeWalletScore(address) {
  const winRate = Math.round(pseudoMetric(address, 28, 74, "winRate"));
  const roi = Number(pseudoMetric(address, -12, 185, "roi").toFixed(1));
  const avgHoldMinutes = Math.round(pseudoMetric(address, 3, 280, "hold"));
  const rugExposure = Math.round(pseudoMetric(address, 5, 48, "rug"));
  const consistency = Math.round(pseudoMetric(address, 30, 89, "consistency"));

  let score = 0;
  score += winRate * 0.35;
  score += Math.max(0, Math.min(100, roi)) * 0.20;
  score += consistency * 0.25;
  score += Math.max(0, 100 - rugExposure) * 0.20;

  const finalScore = Math.round(score);

  return {
    address,
    score: finalScore,
    winRate,
    roi,
    avgHoldMinutes,
    rugExposure,
    consistency,
    confidence: "stage1-estimated"
  };
}

export function refreshTrackedWalletScore(address) {
  const wallet = getTrackedWallet(address);
  if (!wallet) {
    return { ok: false, error: "Wallet not found" };
  }

  const metrics = computeWalletScore(address);

  const result = updateTrackedWallet(address, {
    score: metrics.score,
    winRate: metrics.winRate,
    roi: metrics.roi,
    avgHoldMinutes: metrics.avgHoldMinutes,
    rugExposure: metrics.rugExposure,
    consistency: metrics.consistency,
    lastScoredAt: Date.now()
  });

  if (!result.ok) return result;

  return {
    ok: true,
    wallet: result.wallet,
    metrics
  };
}

export function formatWalletScoreReport(metrics) {
  return `🧠 Wallet Score

Address:
${metrics.address}

Score: ${metrics.score}/100
Win rate: ${metrics.winRate}%
ROI: ${metrics.roi}%
Avg hold: ${metrics.avgHoldMinutes} min
Rug exposure: ${metrics.rugExposure}%
Consistency: ${metrics.consistency}%

Confidence:
${metrics.confidence}`;
}
