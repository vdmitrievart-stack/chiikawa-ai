export function getSentiment(token) {
  let score = 0;

  if (token.volume > 100000) score += 40;
  if (token.txns > 300) score += 30;
  if (token.liquidity > 20000) score += 20;

  return {
    sentiment: score,
    bullish: score > 60
  };
}
