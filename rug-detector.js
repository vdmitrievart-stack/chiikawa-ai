export function detectRug(token) {
  let risk = 0;

  // ликвидность
  if (token.liquidity < 8000) risk += 25;

  // объем
  if (token.volume < 20000) risk += 20;

  // fdv vs liquidity
  const ratio = token.fdv / token.liquidity;
  if (ratio > 50) risk += 25;

  // txns слабые
  if (token.txns < 120) risk += 15;

  return {
    risk,
    isRug: risk >= 60
  };
}
