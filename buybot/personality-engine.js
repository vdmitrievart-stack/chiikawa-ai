export function buildBuyAlert(input = {}) {
  const token = String(input.token || "UNKNOWN");
  const amount = String(input.amount || "");
  const ca = String(input.ca || "");
  const price = String(input.price || "");
  const buyer = String(input.buyer || "");

  return `🚀 CHIIKAWA BUY ALERT

Token: ${token}
Amount: ${amount}
Price: ${price}
Buyer: ${buyer}
CA: ${ca}`;
}

export function buildBuyReaction(input = {}) {
  const token = String(input.token || "UNKNOWN");
  const amount = String(input.amount || "");
  return `Chiikawa noticed a buy on ${token} 🐹💰

Amount: ${amount}`;
}

const personality = {
  buildBuyAlert,
  buildBuyReaction
};

export default personality;
