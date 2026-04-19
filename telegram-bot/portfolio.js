let balance = 1.0; // старт: 1 SOL
let position = null;
const tradeHistory = [];

const MIN_RESERVE_SOL = 0.1;
const POSITION_SIZE_FRACTION = 0.2;

// Реалистичные торговые издержки для симуляции
const ENTRY_FEE_PCT = 0.25;
const EXIT_FEE_PCT = 0.25;
const ENTRY_SLIPPAGE_PCT = 0.6;
const EXIT_SLIPPAGE_PCT = 0.6;
const PRIORITY_FEE_SOL = 0.00001;

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pctToFrac(pct) {
  return safeNum(pct, 0) / 100;
}

function round(v, d = 6) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

export function getPortfolio() {
  return {
    balance,
    position: position ? { ...position } : null,
    tradeHistory: [...tradeHistory]
  };
}

export function canEnterTrade() {
  return !position && balance > MIN_RESERVE_SOL;
}

export function estimateRoundTripCostPct() {
  return ENTRY_FEE_PCT + EXIT_FEE_PCT + ENTRY_SLIPPAGE_PCT + EXIT_SLIPPAGE_PCT;
}

export function estimateEntryCostSol(amountSol) {
  const feeSol = amountSol * pctToFrac(ENTRY_FEE_PCT);
  const slippageSol = amountSol * pctToFrac(ENTRY_SLIPPAGE_PCT);
  const prioritySol = PRIORITY_FEE_SOL;

  return {
    feeSol,
    slippageSol,
    prioritySol,
    totalSol: feeSol + slippageSol + prioritySol
  };
}

export function estimateExitCostSol(grossValueSol) {
  const feeSol = grossValueSol * pctToFrac(EXIT_FEE_PCT);
  const slippageSol = grossValueSol * pctToFrac(EXIT_SLIPPAGE_PCT);
  const prioritySol = PRIORITY_FEE_SOL;

  return {
    feeSol,
    slippageSol,
    prioritySol,
    totalSol: feeSol + slippageSol + prioritySol
  };
}

export function enterTrade({
  token,
  intendedHoldMs,
  expectedEdgePct,
  stopLossPct,
  takeProfitPct,
  reason,
  signalScore
}) {
  if (!token?.name || !token?.ca || !safeNum(token.price)) return null;
  if (position) return null;

  const usable = balance - MIN_RESERVE_SOL;
  if (usable <= 0) return null;

  const amountSol = usable * POSITION_SIZE_FRACTION;
  const entryCosts = estimateEntryCostSol(amountSol);

  const totalDebit = amountSol + entryCosts.totalSol;
  if (totalDebit > balance) return null;

  const effectiveEntryPrice =
    token.price * (1 + pctToFrac(ENTRY_SLIPPAGE_PCT));

  const tokenAmount = amountSol / effectiveEntryPrice;

  position = {
    token: token.name,
    ca: token.ca,
    entryReferencePrice: round(token.price, 12),
    entryEffectivePrice: round(effectiveEntryPrice, 12),
    tokenAmount: round(tokenAmount, 8),
    amountSol: round(amountSol, 8),
    entryCosts,
    enteredAt: Date.now(),
    intendedHoldMs: safeNum(intendedHoldMs, 0),
    expectedEdgePct: safeNum(expectedEdgePct, 0),
    stopLossPct: safeNum(stopLossPct, 0),
    takeProfitPct: safeNum(takeProfitPct, 0),
    reason: reason || "",
    signalScore: safeNum(signalScore, 0),
    highWaterMarkPrice: round(token.price, 12),
    lowWaterMarkPrice: round(token.price, 12)
  };

  balance = round(balance - totalDebit, 8);

  return {
    ...position,
    balanceAfterEntry: balance
  };
}

export function updatePositionMarket(currentPrice) {
  if (!position) return null;

  const px = safeNum(currentPrice, 0);
  if (px <= 0) return null;

  position.highWaterMarkPrice = Math.max(position.highWaterMarkPrice, px);
  position.lowWaterMarkPrice = Math.min(position.lowWaterMarkPrice, px);

  return markToMarket(px);
}

export function markToMarket(currentPrice) {
  if (!position) return null;

  const px = safeNum(currentPrice, 0);
  if (px <= 0) return null;

  const grossValueSol = position.tokenAmount * px;
  const exitCosts = estimateExitCostSol(grossValueSol);
  const netValueSol = grossValueSol - exitCosts.totalSol;

  const totalCapitalUsed = position.amountSol + position.entryCosts.totalSol;
  const netPnlSol = netValueSol - totalCapitalUsed;
  const netPnlPct = totalCapitalUsed > 0 ? (netPnlSol / totalCapitalUsed) * 100 : 0;

  const grossPnlSol = grossValueSol - position.amountSol;
  const grossPnlPct = position.amountSol > 0 ? (grossPnlSol / position.amountSol) * 100 : 0;

  return {
    token: position.token,
    ca: position.ca,
    entryReferencePrice: position.entryReferencePrice,
    entryEffectivePrice: position.entryEffectivePrice,
    currentPrice: px,
    grossValueSol: round(grossValueSol, 8),
    netValueSol: round(netValueSol, 8),
    grossPnlSol: round(grossPnlSol, 8),
    grossPnlPct: round(grossPnlPct, 4),
    netPnlSol: round(netPnlSol, 8),
    netPnlPct: round(netPnlPct, 4),
    ageMs: Date.now() - position.enteredAt,
    highWaterMarkPrice: position.highWaterMarkPrice,
    lowWaterMarkPrice: position.lowWaterMarkPrice
  };
}

export function shouldExitPosition(currentPrice) {
  if (!position) return { shouldExit: false, reason: "NO_POSITION" };

  const mtm = markToMarket(currentPrice);
  if (!mtm) return { shouldExit: false, reason: "BAD_MARK" };

  const ageMs = mtm.ageMs;
  const netPnlPct = mtm.netPnlPct;

  if (netPnlPct <= -Math.abs(position.stopLossPct)) {
    return { shouldExit: true, reason: "STOP_LOSS", mtm };
  }

  if (netPnlPct >= Math.abs(position.takeProfitPct)) {
    return { shouldExit: true, reason: "TAKE_PROFIT", mtm };
  }

  if (ageMs >= position.intendedHoldMs && netPnlPct > 0) {
    return { shouldExit: true, reason: "TIME_TAKE", mtm };
  }

  if (ageMs >= position.intendedHoldMs * 1.5) {
    return { shouldExit: true, reason: "TIME_EXIT", mtm };
  }

  return { shouldExit: false, reason: "HOLD", mtm };
}

export function exitTrade(exitReferencePrice, reason = "EXIT") {
  if (!position) return null;

  const px = safeNum(exitReferencePrice, 0);
  if (px <= 0) return null;

  const grossValueSol = position.tokenAmount * px;
  const exitCosts = estimateExitCostSol(grossValueSol);
  const netValueSol = grossValueSol - exitCosts.totalSol;

  const totalCapitalUsed = position.amountSol + position.entryCosts.totalSol;
  const netPnlSol = netValueSol - totalCapitalUsed;
  const netPnlPct = totalCapitalUsed > 0 ? (netPnlSol / totalCapitalUsed) * 100 : 0;

  balance = round(balance + netValueSol, 8);

  const closed = {
    token: position.token,
    ca: position.ca,
    entryReferencePrice: position.entryReferencePrice,
    entryEffectivePrice: position.entryEffectivePrice,
    exitReferencePrice: round(px, 12),
    amountSol: position.amountSol,
    tokenAmount: position.tokenAmount,
    entryCosts: position.entryCosts,
    exitCosts,
    grossValueSol: round(grossValueSol, 8),
    netValueSol: round(netValueSol, 8),
    netPnlSol: round(netPnlSol, 8),
    netPnlPct: round(netPnlPct, 4),
    reason,
    signalScore: position.signalScore,
    expectedEdgePct: position.expectedEdgePct,
    openedAt: position.enteredAt,
    closedAt: Date.now(),
    durationMs: Date.now() - position.enteredAt,
    balance: round(balance, 8)
  };

  tradeHistory.push(closed);
  position = null;

  return closed;
}
