let balance = 1; // 1 SOL
let position = null;

const MIN_RESERVE = 0.1; // SOL всегда оставляем

export function getPortfolio() {
  return { balance, position };
}

export function enterTrade(token) {
  if (position) return null;

  const usable = balance - MIN_RESERVE;
  if (usable <= 0) return null;

  const amount = usable * 0.2;

  position = {
    token: token.name,
    entry: token.price,
    amount
  };

  balance -= amount;

  return position;
}

export function exitTrade(price) {
  if (!position) return null;

  const pnl = (price - position.entry) / position.entry;
  const value = position.amount * (1 + pnl);

  balance += value;

  const result = {
    token: position.token,
    pnl,
    balance
  };

  position = null;

  return result;
}
