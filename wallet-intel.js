export function analyzeWallets(token) {
  // proxy логика вместо GMGN

  const concentration =
    token.liquidity > 0
      ? (token.fdv / token.liquidity) * 10
      : 100;

  const smartMoney =
    token.txns > 300 && token.volume > 100000 ? 70 : 40;

  let score = 0;

  if (smartMoney > 60) score += 25;
  if (concentration < 40) score += 20;

  return {
    smartMoney,
    concentration,
    score
  };
}
