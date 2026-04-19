let balance = 1; // стартовый виртуальный баланс: 1 SOL
let position = null;
let tradeHistory = [];

const MIN_RESERVE = 0.1; // всегда оставляем немного SOL
const POSITION_SIZE_FRACTION = 0.2; // 20% доступного баланса на сделку

export function getPortfolio() {
  return {
    balance,
    position,
    tradeHistory: [...tradeHistory]
  };
}

export function canEnterTrade() {
  return !position && balance > MIN_RESERVE;
}

export function enterTrade(token) {
  if (!token?.name || !Number.isFinite(token?.price) || token.price <= 0) {
    return null;
  }

  if (position) return null;

  const usable = balance - MIN_RESERVE;
  if (usable <= 0) return null;

  const amountSol = usable * POSITION_SIZE_FRACTION;
  const tokenAmount = amountSol / token.price;

  position = {
    token: token.name,
    ca: token.ca || "",
    entry: token.price,
    amountSol,
    tokenAmount,
    enteredAt: Date.now(),
    meta: {
      liquidity: token.liquidity || 0,
      volume: token.volume || 0,
      txns: token.txns || 0,
      fdv: token.fdv || 0,
      score: token.score || 0
    }
  };

  balance -= amountSol;
  return { ...position };
}

export function markToMarket(currentPrice) {
  if (!position || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return null;
  }

  const currentValueSol = position.tokenAmount * currentPrice;
  const pnlFraction = (currentPrice - position.entry) / position.entry;

  return {
    token: position.token,
    ca: position.ca,
    entry: position.entry,
    currentPrice,
    amountSol: position.amountSol,
    currentValueSol,
    pnlFraction,
    pnlPercent: pnlFraction * 100
  };
}

export function exitTrade(exitPrice, reason = "SIM_EXIT") {
  if (!position) return null;
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return null;

  const currentValueSol = position.tokenAmount * exitPrice;
  const pnlFraction = (exitPrice - position.entry) / position.entry;

  balance += currentValueSol;

  const closed = {
    token: position.token,
    ca: position.ca,
    entry: position.entry,
    exit: exitPrice,
    amountSol: position.amountSol,
    receivedSol: currentValueSol,
    pnlFraction,
    pnlPercent: pnlFraction * 100,
    reason,
    openedAt: position.enteredAt,
    closedAt: Date.now()
  };

  tradeHistory.push(closed);
  position = null;

  return {
    ...closed,
    balance
  };
}
