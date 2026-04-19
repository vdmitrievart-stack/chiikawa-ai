export function getSentiment(token) {
  const sentiment = Math.random() * 100;

  return {
    sentiment,
    bullish: sentiment > 60
  };
}
