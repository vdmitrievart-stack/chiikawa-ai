import { DEFAULT_STRATEGY_BUDGET, normalizeBudgetConfig } from "./budget-manager.js";

const STRATEGY_LABELS = {
  scalp: "SCALP",
  reversal: "REVERSAL",
  runner: "RUNNER",
  copytrade: "COPYTRADE"
};

const ENTRY_FEE_PCT = 0.25;
const EXIT_FEE_PCT = 0.25;
const ENTRY_SLIPPAGE_PCT = 0.6;
const EXIT_SLIPPAGE_PCT = 0.6;
const PRIORITY_FEE_SOL = 0.00001;

let strategyBudget = normalizeBudgetConfig(DEFAULT_STRATEGY_BUDGET);
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

export function setStrategyConfig(nextBudget = DEFAULT_STRATEGY_BUDGET) {
  strategyBudget = normalizeBudgetConfig(nextBudget);
  return getStrategyConfig();
}

export function resetPortfolio(startBalance = 1, nextBudget = strategyBudget) {
  strategyBudget = normalizeBudgetConfig(nextBudget);
  state = createFreshState(startBalance);
}

export function getStrategyConfig() {
  return Object.fromEntries(
    Object.keys(strategyBudget).map((key) => [
      key,
      {
        label: STRATEGY_LABELS[key] || key.toUpperCase(),
        allocationPct: strategyBudget[key]
      }
    ])
  );
}

export function getPositions() {
  return state.positions;
}

export function getClosedTrades() {
  return state.closedTrades.map(t => ({ ...t }));
}

export function hasOpenPositions() {
  return state.positions.length > 0;
}

function getAllocatedCapitalTotal(strategy) {
  return state.startBalance * safeNum(strategyBudget[strategy], 0);
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
  const unrealized = state.positions.reduce((sum, p) => sum + (p.lastMark?.netPnlSol || 0), 0);
  const realized = state.closedTrades.reduce((sum, t) => sum + t.netPnlSol, 0);
  const openValue = state.positions.reduce((sum, p) => sum + (p.lastMark?.netValueSol || p.amountSol || 0), 0);
  const equity = state.cash + openValue;

  const byStrategy = Object.keys(strategyBudget).reduce((acc, key) => {
    const cfg = getStrategyConfig()[key];
    const closed = state.closedTrades.filter(t => t.strategy === key);
    const open = state.positions.filter(p => p.strategy === key);
    const realizedPnlSol = closed.reduce((s, t) => s + t.netPnlSol, 0);
    const unrealizedPnlSol = open.reduce((s, p) => s + (p.lastMark?.netPnlSol || 0), 0);
    const totalPnlSol = realizedPnlSol + unrealizedPnlSol;
    const totalCapital = closed.reduce((s, t) => s + t.amountSol, 0) + open.reduce((s, p) => s + p.amountSol, 0);
    const totalPnlPct = totalCapital > 0 ? (totalPnlSol / totalCapital) * 100 : 0;
    const avgOpenAgeMs = open.length
      ? open.reduce((s, p) => s + (p.lastMark?.ageMs || (Date.now() - p.openedAt)), 0) / open.length
      : 0;

    acc[key] = {
      label: cfg.label,
      allocationPct: cfg.allocationPct,
      allocatedSol: getAllocatedCapitalTotal(key),
      availableSol: getAvailableCapitalForStrategy(key),
      openPositions: open.length,
      closedTrades: closed.length,
      realizedPnlSol: round(realizedPnlSol, 8),
      unrealizedPnlSol: round(unrealizedPnlSol, 8),
      totalPnlSol: round(totalPnlSol, 8),
      totalPnlPct: round(totalPnlPct, 4),
      avgOpenAgeMs: round(avgOpenAgeMs, 0)
    };
    return acc;
  }, {});

  return {
    startBalance: state.startBalance,
    cash: round(state.cash, 8),
    equity: round(equity, 8),
    realizedPnlSol: round(realized, 8),
    unrealizedPnlSol: round(unrealized, 8),
    positions: state.positions,
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
  signalContext = {},
  walletId = null,
  entryMode = "SCALED",
  planName = "trade_plan",
  planObjective = "capture edge"
}) {
  if (!token?.ca || !token?.name || !safeNum(token.price)) return null;
  if (!strategyBudget[strategy]) return null;

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
    walletId,
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
    entryMode,
    planName,
    planObjective,
    highestPrice: round(token.price, 12),
    lowestPrice: round(token.price, 12),
    lastPrice: round(token.price, 12),
    lastMark: null,
    partialRealizedSol: 0
  };

  state.cash = round(state.cash - debit, 8);
  state.positions.push(position);
  return position;
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
    walletId: position.walletId,
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
    planName: position.planName,
    planObjective: position.planObjective,
    entryMode: position.entryMode,
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
