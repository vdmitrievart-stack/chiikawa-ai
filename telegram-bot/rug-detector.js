export function detectRug(token) {
  let risk = 0;
  const reasons = [];

  if ((token.liquidity || 0) < 8000) {
    risk += 25;
    reasons.push("Low liquidity");
  }

  if ((token.volume || 0) < 20000) {
    risk += 20;
    reasons.push("Low 24h volume");
  }

  const liq = token.liquidity || 1;
  const fdv = token.fdv || 0;
  const fdvToLiquidity = fdv / liq;

  if (fdvToLiquidity > 50) {
    risk += 25;
    reasons.push("FDV/liquidity ratio too high");
  }

  if ((token.txns || 0) < 120) {
    risk += 15;
    reasons.push("Weak transaction activity");
  }

  return {
    risk,
    reasons,
    isRug: risk >= 60
  };
}
