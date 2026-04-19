let balance = 1; // 1 SOL старт
let position = null;

export function getPortfolio() {
  return { balance, position };
}

export function enterTrade(token) {
  if (position) return null;

  const amount = balance * 0.2;

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
