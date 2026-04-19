export function analyzeWallets(token) {
  const liquidity = token.liquidity || 0;
  const fdv = token.fdv || 0;
  const txns = token.txns || 0;
  const volume = token.volume || 0;

  const concentration = liquidity > 0 ? Math.min(100, (fdv / liquidity) * 10) : 100;
  const smartMoney =
    txns > 300 && volume > 100000
      ? 75
      : txns > 180 && volume > 50000
      ? 60
      : 35;

  let score = 0;
  const reasons = [];

  if (smartMoney > 60) {
    score += 25;
    reasons.push("Smart money proxy looks strong");
  }

  if (concentration < 40) {
    score += 20;
    reasons.push("Holder concentration proxy acceptable");
  } else {
    reasons.push("Holder concentration proxy is elevated");
  }

  return {
    smartMoney,
    concentration,
    score,
    reasons
  };
}
