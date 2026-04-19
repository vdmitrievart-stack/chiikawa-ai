export function getSentiment(token) {
  let sentiment = 0;
  const reasons = [];

  if ((token.volume || 0) > 100000) {
    sentiment += 40;
    reasons.push("Strong 24h volume");
  }

  if ((token.txns || 0) > 300) {
    sentiment += 30;
    reasons.push("High transaction participation");
  }

  if ((token.liquidity || 0) > 20000) {
    sentiment += 20;
    reasons.push("Healthy liquidity");
  }

  return {
    sentiment,
    bullish: sentiment > 60,
    reasons
  };
}
