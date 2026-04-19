export function detectRug(token) {
  let risk = 0;

  if (token.liquidity < 5000) risk += 30;
  if (token.volume < 10000) risk += 20;
  if (token.txns < 100) risk += 15;
  if (token.fdv > 5000000) risk += 10;

  return {
    risk,
    isRug: risk >= 50
  };
}
