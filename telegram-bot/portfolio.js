const STRATEGY_CONFIG = {
  scalp: { label: "SCALP", allocationPct: 0.25 },
  reversal: { label: "REVERSAL", allocationPct: 0.45 },
  runner: { label: "RUNNER", allocationPct: 0.30 }
};

const ENTRY_FEE_PCT = 0.25;
const EXIT_FEE_PCT = 0.25;
const ENTRY_SLIPPAGE_PCT = 0.6;
const EXIT_SLIPPAGE_PCT = 0.6;
const PRIORITY_FEE_SOL = 0.00001;

let state = createState(1);

function createState(startBalance = 1) {
  return {
    startBalance,
    cash: startBalance,
    positions: [],
    closedTrades: []
  };
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 8) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function pctToFrac(pct) {
  return safeNum(pct) / 100;
}

function getEntryCosts(amountSol) {
  const feeSol = amountSol * pctToFrac(ENTRY_FEE_PCT);
  const slippageSol = amountSol * pctToFrac(ENTRY_SLIPPAGE_PCT);
  return {
    feeSol: round(feeSol, 8),
    slippageSol: round(slippageSol, 8),
    prioritySol: PRIORITY_FEE_SOL,
    totalSol: round(feeSol + slippageSol + PRIORITY_FEE_SOL, 8)
  };
}

function getExitCosts(grossValueSol) {
  const feeSol = grossValueSol * pctToFrac(EXIT_FEE_PCT);
  const slippageSol = grossValueSol * pctToFrac(EXIT_SLIPPAGE_PCT);
  return {
    feeSol: round(feeSol, 8),
    slippageSol: round(slippageSol, 8),
    prioritySol: PRIORITY_FEE_SOL,
    totalSol: round(feeSol + slippageSol + PRIORITY_FEE_SOL, 8)
  };
}

export function estimateRoundTripCostPct() {
  return ENTRY_FEE_PCT + EXIT_FEE_PCT + ENTRY_SLIPPAGE_PCT + EXIT_SLIPPAGE_PCT;
}

export function getStrategyConfig() {
  return { ...STRATEGY_CONFIG };
}

export function resetPortfolio(startBalance = 1) {
  state = createState(startBalance);
}

export function getPositions() {
  return state.positions.map(p => ({ ...p }));
}

export function getClosedTrades() {
  return state.closedTrades.map(t => ({ ...t }));
}

function getAllocatedCapitalTotal(strategy) {
  const cfg = STRATEGY_CONFIG[strategy];
  if (!cfg) return 0;
  return state.startBalance * cfg.allocationPct;
}

function getUsedCapital(strategy) {
  return state.positions
    .filter(p => p.strategy === strategy)
    .reduce((sum, p) => sum + p.amountSol + p.entryCosts.totalSol, 0);
}

export function getAvailableCapitalForStrategy(strategy) {
  const allocated = getAllocatedCapitalTotal(strategy);
  const used = getUsedCapital(strategy);
  return Math.min(Math.max(0, allocated - used), state.cash);
}

export function getPortfolio() {
  const realized = state.closedTrades.reduce((sum, t) => sum + safeNum(t.netPnlSol), 0);
  const unrealized = state.positions.reduce((sum, p) => sum + safeNum(p.lastMark?.netPnlSol), 0);
  const openValue = state.positions.reduce((sum, p) => sum + safeNum(p.lastMark?.netValueSol), 0);

  const byStrategy = Object.keys(STRATEGY_CONFIG).reduce((acc, key) => {
    const closed = state.closedTrades.filter(t => t.strategy === key);
    const open = state.positions.filter(t => t.strategy === key);
    const wins = closed.filter(t => safeNum(t.netPnlPct) > 0).length;
    const losses = closed.length - wins;

    acc[key] = {
      allocationPct: STRATEGY_CONFIG[key].allocationPct,
      allocatedSol: round(getAllocatedCapitalTotal(key), 8),
      availableSol: round(getAvailableCapitalForStrategy(key), 8),
      openPositions: open.length,
      closedTrades: closed.length,
      wins,
      losses,
      realizedPnlSol: round(closed.reduce((s, t) => s + safeNum(t.netPnlSol), 0), 8)
    };
    return acc;
  }, {});

  return {
    startBalance: round(state.startBalance, 8),
    cash: round(state.cash, 8),
    equity: round(state.cash + openValue, 8),
    realizedPnlSol: round(realized, 8),
    unrealizedPnlSol: round(unrealized, 8),
    positions: getPositions(),
    closedTrades: getClosedTrades(),
    byStrategy
  };
}

export function openPosition({
  strategy,
  token,
  thesis = "",
  plannedHoldMs = 0,
  stopLossPct = 0,
  takeProfitPct = 0,
  runnerTargetsPct = [],
  signalScore = 0,
  expectedEdgePct = 0,
  signalContext = {}
}) {
  if (!token?.ca || !token?.name || !safeNum(token.price) || !STRATEGY_CONFIG[strategy]) return null;

  const available = getAvailableCapitalForStrategy(strategy);
  if (available <= 0.0001) return null;

  const amountSol = round(available * 0.92, 8);
  if (amountSol <= 0) return null;

  const entryCosts = getEntryCosts(amountSol);
  const totalDebit = round(amountSol + entryCosts.totalSol, 8);
  if (totalDebit > state.cash) return null;

  const entryEffectivePrice = token.price * (1 + pctToFrac(ENTRY_SLIPPAGE_PCT));
  const tokenAmount = round(amountSol / entryEffectivePrice, 8);

  const position = {
    id: `${strategy}-${token.ca}-${Date.now()}`,
    strategy,
    token: token.name,
    ca: token.ca,
    entryReferencePrice: round(token.price, 12),
    entryEffectivePrice: round(entryEffectivePrice, 12),
    tokenAmount,
    amountSol,
    entryCosts,
    openedAt: Date.now(),
    plannedHoldMs,
    stopLossPct,
    takeProfitPct,
    runnerTargetsPct: Array.isArray(runnerTargetsPct) ? runnerTargetsPct : [],
    runnerTargetIndex: 0,
    signalScore,
    expectedEdgePct,
    thesis,
    signalContext,
    highestPrice: round(token.price, 12),
    lowestPrice: round(token.price, 12),
    lastPrice: round(token.price, 12),
    lastMark: null,
    partialRealizedSol: 0
  };

  state.cash = round(state.cash - totalDebit, 8);
  state.positions.push(position);

  return { ...position, balanceAfterEntry: state.cash };
}

export function markPosition(position, currentPrice) {
  const px = safeNum(currentPrice, 0);
  if (!position || px <= 0) return null;

  position.highestPrice = Math.max(position.highestPrice, px);
  position.lowestPrice = Math.min(position.lowestPrice, px);
  position.lastPrice = round(px, 12);

  const grossValueSol = round(position.tokenAmount * px, 8);
  const exitCosts = getExitCosts(grossValueSol);
  const netValueSol = round(grossValueSol - exitCosts.totalSol, 8);

  const totalCapitalUsed = round(position.amountSol + position.entryCosts.totalSol, 8);
  const netPnlSol = round(netValueSol + safeNum(position.partialRealizedSol) - totalCapitalUsed, 8);
  const netPnlPct = totalCapitalUsed > 0 ? round((netPnlSol / totalCapitalUsed) * 100, 4) : 0;

  const grossPnlSol = round(grossValueSol - position.amountSol, 8);
  const grossPnlPct = position.amountSol > 0 ? round((grossPnlSol / position.amountSol) * 100, 4) : 0;

  position.lastMark = {
    currentPrice: round(px, 12),
    grossValueSol,
    netValueSol,
    grossPnlSol,
    grossPnlPct,
    netPnlSol,
    netPnlPct,
    ageMs: Date.now() - position.openedAt
  };

  return position.lastMark;
}

export function maybeTakeRunnerPartial(position, currentPrice) {
  if (!position || position.strategy !== "runner") return null;
  if (!position.runnerTargetsPct?.length) return null;

  const mark = markPosition(position, currentPrice);
  if (!mark) return null;

  const idx = safeNum(position.runnerTargetIndex, 0);
  if (idx >= position.runnerTargetsPct.length) return null;

  const targetPct = position.runnerTargetsPct[idx];
  if (mark.grossPnlPct < targetPct) return null;

  const fraction = idx === 0 ? 0.3 : idx === 1 ? 0.3 : 0.2;
  const soldTokenAmount = round(position.tokenAmount * fraction, 8);
  const grossValueSol = round(soldTokenAmount * currentPrice, 8);
  const exitCosts = getExitCosts(grossValueSol);
  const netValueSol = round(grossValueSol - exitCosts.totalSol, 8);

  position.tokenAmount = round(position.tokenAmount - soldTokenAmount, 8);
  position.partialRealizedSol = round(position.partialRealizedSol + netValueSol, 8);
  position.runnerTargetIndex += 1;
  state.cash = round(state.cash + netValueSol, 8);

  return {
    targetPct,
    soldFraction: fraction,
    netValueSol,
    remainingTokenAmount: position.tokenAmount
  };
}

export function closePosition(positionId, exitReferencePrice, reason = "EXIT") {
  const idx = state.positions.findIndex(p => p.id === positionId);
  if (idx === -1) return null;

  const position = state.positions[idx];
  const px = safeNum(exitReferencePrice, 0);
  if (px <= 0) return null;

  const grossValueSol = round(position.tokenAmount * px, 8);
  const exitCosts = getExitCosts(grossValueSol);
  const netValueSol = round(grossValueSol - exitCosts.totalSol, 8);

  const totalCapitalUsed = round(position.amountSol + position.entryCosts.totalSol, 8);
  const netPnlSol = round(netValueSol + safeNum(position.partialRealizedSol) - totalCapitalUsed, 8);
  const netPnlPct = totalCapitalUsed > 0 ? round((netPnlSol / totalCapitalUsed) * 100, 4) : 0;

  state.cash = round(state.cash + netValueSol, 8);

  const trade = {
    id: position.id,
    strategy: position.strategy,
    token: position.token,
    ca: position.ca,
    entryReferencePrice: position.entryReferencePrice,
    entryEffectivePrice: position.entryEffectivePrice,
    exitReferencePrice: round(px, 12),
    amountSol: position.amountSol,
    entryCosts: position.entryCosts,
    exitCosts,
    tokenAmount: position.tokenAmount,
    partialRealizedSol: round(position.partialRealizedSol, 8),
    netValueSol,
    netPnlSol,
    netPnlPct,
    signalScore: position.signalScore,
    expectedEdgePct: position.expectedEdgePct,
    thesis: position.thesis,
    signalContext: position.signalContext,
    reason,
    openedAt: position.openedAt,
    closedAt: Date.now(),
    durationMs: Date.now() - position.openedAt,
    balanceAfter: state.cash
  };

  state.closedTrades.push(trade);
  state.positions.splice(idx, 1);

  return trade;
}
