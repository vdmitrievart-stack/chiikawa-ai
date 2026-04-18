export function buildBuyAlert(input = {}) {
  const token = String(input.token || "UNKNOWN");
  const amount = String(input.amount || "");
  const ca = String(input.ca || "");
  return `🚀 CHIIKAWA BUY ALERT\n\nToken: ${token}\nAmount: ${amount}\nCA: ${ca}`;
}

export function buildBuyReaction(input = {}) {
  const token = String(input.token || "UNKNOWN");
  return `Chiikawa noticed a buy on ${token} 🐹💰`;
}

export default {
  buildBuyAlert,
  buildBuyReaction
};
