const STRATEGY_CONFIG = {
  scalp: {
    label: "SCALP",
    allocationPct: 0.25
  },
  reversal: {
    label: "REVERSAL",
    allocationPct: 0.45
  },
  runner: {
    label: "RUNNER",
    allocationPct: 0.30
  }
};

const ENTRY_FEE_PCT = 0.25;
const EXIT_FEE_PCT = 0.25;
const ENTRY_SLIPPAGE_PCT = 0.6;
const EXIT_SLIPPAGE_PCT = 0.6;
const PRIORITY_FEE_SOL = 0.00001;

let state = createFreshState(1);

function createFreshState(startBalance = 1) {
  return {
    startBalance,
    cash: startBalance,
    positions: [],
    closedTrades: [],
    runStartedAt: Date.now()
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
    feeSol,
    slippageSol,
    prioritySol: PRIORITY_FEE_SOL,
    totalSol: feeSol + slippageSol + PRIORITY_FEE_SOL
  };
}

function getExitCosts(grossValueSol) {
  const feeSol = grossValueSol * pctToFrac(EXIT_FEE_PCT);
  const slippageSol = grossValueSol * pctToFrac(EXIT_SLIPPAGE_PCT);
  return {
    feeSol,
    slippageSol,
    prioritySol: PRIORITY_FEE_SOL,
    totalSol: feeSol + slippageSol + PRIORITY_FEE_SOL
  };
}

export function estimateRoundTripCostPct() {
  return ENTRY_FEE_PCT + EXIT_FEE_PCT + ENTRY_SLIPPAGE_PCT + EXIT_SLIPPAGE_PCT;
}

export function resetPortfolio(startBalance = 1) {
  state = createFreshState(startBalance);
}

export function getStrategyConfig() {
  return { ...STRATEGY_CONFIG };
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

function getCurrentlyUsedCapital(strategy) {
  return state.positions
    .filter(p => p.strategy === strategy)
    .reduce((sum, p) => sum + p.amountSol + p.entryCosts.totalSol, 0);
}

export function getAvailableCapitalForStrategy(strategy) {
  const total = getAllocatedCapitalTotal(strategy);
  const used = getCurrentlyUsedCapital(strategy);
  const freeInBucket = Math.max(0, total - used);
  return Math.min(freeInBucket, state.cash);
}

export function getPortfolio() {
  const unrealized = state.positions.reduce((sum, p) => {
    const mtm = p.lastMark || null;
    return sum + (mtm?.netPnlSol || 0);
  }, 0);

  const realized = state.closedTrades.reduce((sum, t) => sum + t.netPnlSol, 0);
  const equity = state.cash + state.positions.reduce((sum, p) => sum + (p.lastMark?.netValueSol || 0), 0);

  const byStrategy = Object.keys(STRATEGY_CONFIG).reduce((acc, key) => {
    const closed = state.closedTrades.filter(t => t.strategy === key);
    const open = state.positions.filter(p => p.strategy === key);
    const wins = closed.filter(t => t.netPnlPct > 0).length;
    const losses = closed.filter(t => t.netPnlPct <= 0).length;

    acc[key] = {
      allocationPct: STRATEGY_CONFIG[key].allocationPct,
      allocatedSol: getAllocatedCapitalTotal(key),
      availableSol: getAvailableCapitalForStrategy(key),
      openPositions: open.length,
      closedTrades: closed.length,
      wins,
      losses,
      realizedPnlSol: round(closed.reduce((s, t) => s + t.netPnlSol, 0), 8),
      realizedPnlPctAvg: closed.length
        ? round(closed.reduce((s, t) => s + t.netPnlPct, 0) / closed.length, 4)
        : 0
    };
    return acc;
  }, {});

  return {
    startBalance: state.startBalance,
    cash: round(state.cash, 8),
    equity: round(equity, 8),
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
  if (!token?.ca || !token?.name || !safeNum(token.price)) return null;
  if (!STRATEGY_CONFIG[strategy]) return null;

  const available = getAvailableCapitalForStrategy(strategy);
  if (available <= 0.0001) return null;

  const amountSol = round(available * 0.92, 8);
  const entryCosts = getEntryCosts(amountSol);
  const debit = amountSol + entryCosts.totalSol;

  if (debit > state.cash || amountSol <= 0) return null;

  const entryEffectivePrice = token.price * (1 + pctToFrac(ENTRY_SLIPPAGE_PCT));
  const tokenAmount = amountSol / entryEffectivePrice;

  const position = {
    id: `${strategy}-${token.ca}-${Date.now()}`,
    strategy,
    token: token.name,
    ca: token.ca,
    entryReferencePrice: round(token.price, 12),
    entryEffectivePrice: round(entryEffectivePrice, 12),
    tokenAmount: round(tokenAmount, 8),
    amountSol: round(amountSol, 8),
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

  state.cash = round(state.cash - debit, 8);
  state.positions.push(position);

  return { ...position, balanceAfterEntry: state.cash };
}

export function markPosition(position, currentPrice) {
  const px = safeNum(currentPrice, 0);
  if (!px || !position) return null;

  position.highestPrice = Math.max(position.highestPrice, px);
  position.lowestPrice = Math.min(position.lowestPrice, px);
  position.lastPrice = round(px, 12);

  const grossValueSol = position.tokenAmount * px;
  const exitCosts = getExitCosts(grossValueSol);
  const netValueSol = grossValueSol - exitCosts.totalSol;

  const totalCapitalUsed = position.amountSol + position.entryCosts.totalSol;
  const netPnlSol = netValueSol - totalCapitalUsed + safeNum(position.partialRealizedSol, 0);
  const netPnlPct = totalCapitalUsed > 0 ? (netPnlSol / totalCapitalUsed) * 100 : 0;

  const grossPnlSol = grossValueSol - position.amountSol;
  const grossPnlPct = position.amountSol > 0 ? (grossPnlSol / position.amountSol) * 100 : 0;

  position.lastMark = {
    currentPrice: round(px, 12),
    grossValueSol: round(grossValueSol, 8),
    netValueSol: round(netValueSol, 8),
    grossPnlSol: round(grossPnlSol, 8),
    grossPnlPct: round(grossPnlPct, 4),
    netPnlSol: round(netPnlSol, 8),
    netPnlPct: round(netPnlPct, 4),
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

  const target = position.runnerTargetsPct[idx];
  if (mark.grossPnlPct < target) return null;

  const fraction = idx === 0 ? 0.3 : idx === 1 ? 0.3 : 0.2;
  const soldTokenAmount = position.tokenAmount * fraction;
  const grossValueSol = soldTokenAmount * currentPrice;
  const exitCosts = getExitCosts(grossValueSol);
  const netValueSol = grossValueSol - exitCosts.totalSol;

  position.tokenAmount = round(position.tokenAmount - soldTokenAmount, 8);
  position.partialRealizedSol = round(position.partialRealizedSol + netValueSol, 8);
  position.runnerTargetIndex += 1;
  state.cash = round(state.cash + netValueSol, 8);

  return {
    targetPct: target,
    soldFraction: fraction,
    netValueSol: round(netValueSol, 8),
    remainingTokenAmount: position.tokenAmount
  };
}

export function closePosition(positionId, exitReferencePrice, reason = "EXIT") {
  const idx = state.positions.findIndex(p => p.id === positionId);
  if (idx === -1) return null;

  const position = state.positions[idx];
  const px = safeNum(exitReferencePrice, 0);
  if (px <= 0) return null;

  const grossValueSol = position.tokenAmount * px;
  const exitCosts = getExitCosts(grossValueSol);
  const netValueSol = grossValueSol - exitCosts.totalSol;

  const totalCapitalUsed = position.amountSol + position.entryCosts.totalSol;
  const netPnlSol = netValueSol + safeNum(position.partialRealizedSol, 0) - totalCapitalUsed;
  const netPnlPct = totalCapitalUsed > 0 ? (netPnlSol / totalCapitalUsed) * 100 : 0;

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
    netValueSol: round(netValueSol, 8),
    netPnlSol: round(netPnlSol, 8),
    netPnlPct: round(netPnlPct, 4),
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
