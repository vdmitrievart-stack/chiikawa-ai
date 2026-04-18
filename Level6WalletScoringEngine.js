export default class Level6WalletScoringEngine {
  score(wallet = {}) {
    let score = 0.2;

    if (wallet.winRate > 0.6) score += 0.2;
    if (wallet.winRate > 0.7) score += 0.1;

    if (wallet.medianROI > 1.3) score += 0.15;
    if (wallet.medianROI > 2) score += 0.1;

    if (wallet.maxDrawdown < 0.3) score += 0.1;
    if (wallet.maxDrawdown > 0.6) score -= 0.2;

    if (wallet.tradesCount > 30) score += 0.1;

    if (wallet.earlyEntryScore > 0.7) score += 0.15;

    if (wallet.chasePenalty > 0.3) score -= 0.2;

    return Math.max(0, Math.min(1, score));
  }
}
