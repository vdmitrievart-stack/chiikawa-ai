export function detectBots(token) {
  let botActivity = 0;
  const reasons = [];

  if ((token.txns || 0) > 500 && (token.volume || 0) < 20000) {
    botActivity += 40;
    reasons.push("Too many txns for weak volume");
  }

  if ((token.volume || 0) > 200000 && (token.txns || 0) < 100) {
    botActivity += 30;
    reasons.push("Volume spike without broad activity");
  }

  if ((token.liquidity || 0) < 5000 && (token.txns || 0) > 250) {
    botActivity += 20;
    reasons.push("Suspicious activity on thin liquidity");
  }

  return {
    botActivity,
    reasons,
    isBotted: botActivity > 50
  };
}
