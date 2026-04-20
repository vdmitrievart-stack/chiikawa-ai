const DEFAULT_STRATEGY_CONFIG = {
  scalp: { label: "SCALP", allocationPct: 0.2 },
  reversal: { label: "REVERSAL", allocationPct: 0.2 },
  runner: { label: "RUNNER", allocationPct: 0.2 },
  copytrade: { label: "COPYTRADE", allocationPct: 0.2 },
  migration_survivor: { label: "MIGRATION_SURVIVOR", allocationPct: 0.2 }
};

const ENTRY_MODE_MULTIPLIERS = {
  PROBE: 0.22,
  SCALED: 0.55,
  FULL: 0.9
};

const ENTRY_FEE_PCT = 0.25;
const EXIT_FEE_PCT = 0.25;
const ENTRY_SLIPPAGE_PCT = 0.6;
const EXIT_SLIPPAGE_PCT = 0.6;
const PRIORITY_FEE_SOL = 0.00001;

let strategyConfig = cloneConfig(DEFAULT_STRATEGY_CONFIG);
let state = createFreshState(10);

function createFreshState(startBalance = 10) {
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

function cloneConfig(input) {
  return JSON.parse(JSON.stringify(input || DEFAULT_STRATEGY_CONFIG));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeEntryMode(mode) {
  const value = String(mode || "SCALED").toUpperCase().trim();
  if (value === "PROBE" || value === "SCALED" || value === "FULL") return value;
  return "SCALED";
}

function getEntryModeMultiplier(entryMode) {
  return ENTRY_MODE_MULTIPLIERS[normalizeEntryMode(entryMode)] || ENTRY_MODE_MULTIPLIERS.SCALED;
}

function getEntryCosts(amountSol) {
  const feeSol = amountSol * pctToFrac(ENTRY_FEE_PCT);
  const slippageSol = amountSol * pctToFrac(ENTRY_SLIPPAGE_PCT);
  return {
    feeSol: round(feeSol, 8),
    slippageSol: round(slippageSol, 8),
    prioritySol: round(PRIORITY_FEE_SOL, 8),
    totalSol: round(feeSol + slippageSol + PRIORITY_FEE_SOL, 8)
  };
}

function getExitCosts(grossValueSol) {
  const feeSol = grossValueSol * pctToFrac(EXIT_FEE_PCT);
  const slippageSol = grossValueSol * pctToFrac(EXIT_SLIPPAGE_PCT);
  return {
    feeSol: round(feeSol, 8),
    slippageSol: round(slippageSol, 8),
    prioritySol: round(PRIORITY_FEE_SOL, 8),
    totalSol: round(feeSol + slippageSol + PRIORITY_FEE_SOL, 8)
  };
}

function normalizePersistedPositions(rows = []) {
  return clone(Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    strategy: String(row?.strategy || "").trim(),
    runnerTargetsPct: Array.isArray(row?.runnerTargetsPct) ? row.runnerTargetsPct : [],
    runnerTargetIndex: safeNum(row?.runnerTargetIndex, 0),
    partialRealizedSol: safeNum(row?.partialRealizedSol, 0),
    amountSol: safeNum(row?.amountSol, 0),
    tokenAmount: safeNum(row?.tokenAmount, 0),
    entryReferencePrice: safeNum(row?.entryReferencePrice, 0),
    entryEffectivePrice: safeNum(row?.entryEffectivePrice, 0),
    stopLossPct: safeNum(row?.stopLossPct, 0),
    takeProfitPct: safeNum(row?.takeProfitPct, 0),
    openedAt: safeNum(row?.openedAt, Date.now()),
    highestPrice: safeNum(row?.highestPrice, row?.entryReferencePrice || 0),
    lowestPrice: safeNum(row?.lowestPrice, row?.entryReferencePrice || 0),
    lastPrice: safeNum(row?.lastPrice, row?.entryReferencePrice || 0),
    entryCosts: {
      feeSol: safeNum(row?.entryCosts?.feeSol, 0),
      slippageSol: safeNum(row?.entryCosts?.slippageSol, 0),
      prioritySol: safeNum(row?.entryCosts?.prioritySol, PRIORITY_FEE_SOL),
      totalSol: safeNum(row?.entryCosts?.totalSol, 0)
    },
    lastMark: row?.lastMark
      ? {
          currentPrice: safeNum(row.lastMark.currentPrice, 0),
          grossValueSol: safeNum(row.lastMark.grossValueSol, 0),
          netValueSol: safeNum(row.lastMark.netValueSol, 0),
          grossPnlSol: safeNum(row.lastMark.grossPnlSol, 0),
          grossPnlPct: safeNum(row.lastMark.grossPnlPct, 0),
          netPnlSol: safeNum(row.lastMark.netPnlSol, 0),
          netPnlPct: safeNum(row.lastMark.netPnlPct, 0),
          ageMs: safeNum(row.lastMark.ageMs, 0)
        }
      : null
  }));
}

function normalizePersistedClosedTrades(rows = []) {
  return clone(Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    strategy: String(row?.strategy || "").trim(),
    amountSol: safeNum(row?.amountSol, 0),
    entryReferencePrice: safeNum(row?.entryReferencePrice, 0),
    entryEffectivePrice: safeNum(row?.entryEffectivePrice, 0),
    exitReferencePrice: safeNum(row?.exitReferencePrice, 0),
    partialRealizedSol: safeNum(row?.partialRealizedSol, 0),
    netValueSol: safeNum(row?.netValueSol, 0),
    netPnlSol: safeNum(row?.netPnlSol, 0),
    netPnlPct: safeNum(row?.netPnlPct, 0),
    durationMs: safeNum(row?.durationMs, 0),
    openedAt: safeNum(row?.openedAt, 0),
    closedAt: safeNum(row?.closedAt, 0),
    balanceAfter: safeNum(row?.balanceAfter, 0),
    entryCosts: {
      feeSol: safeNum(row?.entryCosts?.feeSol, 0),
      slippageSol: safeNum(row?.entryCosts?.slippageSol, 0),
      prioritySol: safeNum(row?.entryCosts?.prioritySol, PRIORITY_FEE_SOL),
      totalSol: safeNum(row?.entryCosts?.totalSol, 0)
    },
    exitCosts: {
      feeSol: safeNum(row?.exitCosts?.feeSol, 0),
      slippageSol: safeNum(row?.exitCosts?.slippageSol, 0),
      prioritySol: safeNum(row?.exitCosts?.prioritySol, PRIORITY_FEE_SOL),
      totalSol: safeNum(row?.exitCosts?.totalSol, 0)
    }
  }));
}

export function estimateRoundTripCostPct() {
  return ENTRY_FEE_PCT + EXIT_FEE_PCT + ENTRY_SLIPPAGE_PCT + EXIT_SLIPPAGE_PCT;
}

export function setStrategyConfig(nextConfig = DEFAULT_STRATEGY_CONFIG) {
  strategyConfig = cloneConfig(nextConfig);
  return getStrategyConfig();
}

export function getStrategyConfig() {
  return cloneConfig(strategyConfig);
}

export function resetPortfolio(startBalance = 10, nextConfig = strategyConfig) {
  strategyConfig = cloneConfig(nextConfig);
  state = createFreshState(startBalance);
  return getPortfolio();
}

export function hydratePortfolioSnapshot(
  savedSnapshot = {},
  nextConfig = strategyConfig,
  fallbackStartBalance = 10
) {
  const portfolio = savedSnapshot?.portfolio || savedSnapshot || {};

  strategyConfig = cloneConfig(nextConfig || DEFAULT_STRATEGY_CONFIG);

  const startBalance = safeNum(portfolio?.startBalance, fallbackStartBalance);
  const cash = safeNum(portfolio?.cash, startBalance);

  state = {
    startBalance,
    cash,
    positions: normalizePersistedPositions(portfolio?.positions || []),
    closedTrades: normalizePersistedClosedTrades(portfolio?.closedTrades || []),
    runStartedAt: safeNum(portfolio?.runStartedAt, Date.now())
  };

  return getPortfolio();
}

export function getPositions() {
  return state.positions;
}

export function getClosedTrades() {
  return state.closedTrades.map((t) => ({ ...t }));
}

export function hasOpenPositions() {
  return state.positions.length > 0;
}

function getAllocatedCapitalTotal(strategy) {
  const pct = safeNum(strategyConfig?.[strategy]?.allocationPct, 0);
  return round(state.startBalance * pct, 8);
}

function getCurrentlyUsedCapital(strategy) {
  return round(
    state.positions
      .filter((p) => p.strategy === strategy)
      .reduce((sum, p) => sum + p.amountSol + safeNum(p.entryCosts?.totalSol, 0), 0),
    8
  );
}

export function getAvailableCapitalForStrategy(strategy) {
  const total = getAllocatedCapitalTotal(strategy);
  const used = getCurrentlyUsedCapital(strategy);
  const freeInBucket = Math.max(0, total - used);
  return round(Math.min(freeInBucket, state.cash), 8);
}

function deriveTargetPositionSize(strategy, entryMode) {
  const bucketAvailable = getAvailableCapitalForStrategy(strategy);
  const multiplier = getEntryModeMultiplier(entryMode);
  const raw = bucketAvailable * multiplier;
  return round(raw, 8);
}

function getMinimumTradeSize(strategy, entryMode) {
  const mode = normalizeEntryMode(entryMode);

  if (strategy === "copytrade") {
    if (mode === "PROBE") return 0.02;
    if (mode === "SCALED") return 0.04;
    return 0.06;
  }

  if (strategy === "runner") {
    if (mode === "PROBE") return 0.025;
    if (mode === "SCALED") return 0.05;
    return 0.08;
  }

  if (strategy === "migration_survivor") {
    if (mode === "PROBE") return 0.03;
    if (mode === "SCALED") return 0.06;
    return 0.1;
  }

  if (mode === "PROBE") return 0.015;
  if (mode === "SCALED") return 0.035;
  return 0.06;
}

function getMaximumTradeSize(strategy, entryMode) {
  const mode = normalizeEntryMode(entryMode);

  if (strategy === "copytrade") {
    if (mode === "PROBE") return 0.08;
    if (mode === "SCALED") return 0.16;
    return 0.24;
  }

  if (strategy === "runner") {
    if (mode === "PROBE") return 0.1;
    if (mode === "SCALED") return 0.2;
    return 0.35;
  }

  if (strategy === "migration_survivor") {
    if (mode === "PROBE") return 0.12;
    if (mode === "SCALED") return 0.22;
    return 0.4;
  }

  if (mode === "PROBE") return 0.07;
  if (mode === "SCALED") return 0.15;
  return 0.25;
}

function finalizeAmountSol(strategy, entryMode) {
  const target = deriveTargetPositionSize(strategy, entryMode);
  const minSize = getMinimumTradeSize(strategy, entryMode);
  const maxSize = getMaximumTradeSize(strategy, entryMode);
  const clamped = Math.max(minSize, Math.min(maxSize, target));
  const boundedByCash = Math.min(clamped, Math.max(0, state.cash - 0.002));
  return round(boundedByCash, 8);
}

export function getPortfolio() {
  const unrealized = state.positions.reduce((sum, p) => {
    return sum + safeNum(p.lastMark?.netPnlSol, 0);
  }, 0);

  const realized = state.closedTrades.reduce((sum, t) => sum + safeNum(t.netPnlSol, 0), 0);
  const equity =
    state.cash +
    state.positions.reduce((sum, p) => sum + safeNum(p.lastMark?.netValueSol, 0), 0);

  const byStrategy = Object.keys(strategyConfig).reduce((acc, key) => {
    const closed = state.closedTrades.filter((t) => t.strategy === key);
    const open = state.positions.filter((p) => p.strategy === key);
    const wins = closed.filter((t) => safeNum(t.netPnlPct) > 0).length;
    const losses = closed.filter((t) => safeNum(t.netPnlPct) <= 0).length;

    acc[key] = {
      allocationPct: safeNum(strategyConfig[key]?.allocationPct, 0),
      allocatedSol: getAllocatedCapitalTotal(key),
      availableSol: getAvailableCapitalForStrategy(key),
      openPositions: open.length,
      closedTrades: closed.length,
      wins,
      losses,
      realizedPnlSol: round(closed.reduce((s, t) => s + safeNum(t.netPnlSol, 0), 0), 8),
      realizedPnlPctAvg: closed.length
        ? round(closed.reduce((s, t) => s + safeNum(t.netPnlPct, 0), 0) / closed.length, 4)
        : 0,
      avgHoldMinutes: open.length
        ? round(
            open.reduce((s, p) => s + ((Date.now() - safeNum(p.openedAt)) / 60000), 0) / open.length,
            2
          )
        : 0
    };
    return acc;
  }, {});

  return {
    startBalance: round(state.startBalance, 8),
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
  signalContext = {},
  walletId = null,
  entryMode = "SCALED",
  planName = "",
  planObjective = "",
  copytradeExitState = null
}) {
  if (!token?.ca || !token?.name || !safeNum(token.price)) return null;
  if (!strategyConfig[strategy]) return null;

  const normalizedEntryMode = normalizeEntryMode(entryMode);
  const amountSol = finalizeAmountSol(strategy, normalizedEntryMode);

  if (amountSol <= 0) return null;

  const entryCosts = getEntryCosts(amountSol);
  const debit = round(amountSol + entryCosts.totalSol, 8);

  if (debit > state.cash || amountSol <= 0) return null;

  const entryEffectivePrice = safeNum(token.price) * (1 + pctToFrac(ENTRY_SLIPPAGE_PCT));
  const tokenAmount = amountSol / entryEffectivePrice;

  const position = {
    id: `${strategy}-${token.ca}-${Date.now()}`,
    strategy,
    walletId,
    token: token.name,
    symbol: token.symbol || "",
    ca: token.ca,
    dexId: token.dexId || "",
    chainId: token.chainId || "",
    url: token.url || "",
    entryReferencePrice: round(token.price, 12),
    entryEffectivePrice: round(entryEffectivePrice, 12),
    tokenAmount: round(tokenAmount, 8),
    amountSol: round(amountSol, 8),
    entryCosts,
    openedAt: Date.now(),
    plannedHoldMs,
    stopLossPct: safeNum(stopLossPct),
    takeProfitPct: safeNum(takeProfitPct),
    runnerTargetsPct: Array.isArray(runnerTargetsPct) ? runnerTargetsPct : [],
    runnerTargetIndex: 0,
    signalScore: safeNum(signalScore),
    expectedEdgePct: safeNum(expectedEdgePct),
    thesis,
    signalContext,
    entryMode: normalizedEntryMode,
    planName,
    planObjective,
    highestPrice: round(token.price, 12),
    lowestPrice: round(token.price, 12),
    lastPrice: round(token.price, 12),
    lastMark: null,
    partialRealizedSol: 0,
    copytradeExitState: copytradeExitState ? clone(copytradeExitState) : null
  };

  state.cash = round(state.cash - debit, 8);
  state.positions.push(position);

  return { ...position, balanceAfterEntry: state.cash };
}

export function markPosition(position, currentPrice) {
  const px = safeNum(currentPrice, 0);
  if (!px || !position) return null;

  position.highestPrice = Math.max(safeNum(position.highestPrice, px), px);
  position.lowestPrice = Math.min(safeNum(position.lowestPrice, px), px);
  position.lastPrice = round(px, 12);

  const grossValueSol = safeNum(position.tokenAmount) * px;
  const exitCosts = getExitCosts(grossValueSol);
  const netValueSol = grossValueSol - exitCosts.totalSol;

  const totalCapitalUsed = safeNum(position.amountSol) + safeNum(position.entryCosts?.totalSol);
  const netPnlSol =
    netValueSol - totalCapitalUsed + safeNum(position.partialRealizedSol, 0);
  const netPnlPct = totalCapitalUsed > 0 ? (netPnlSol / totalCapitalUsed) * 100 : 0;

  const grossPnlSol = grossValueSol - safeNum(position.amountSol);
  const grossPnlPct =
    safeNum(position.amountSol) > 0
      ? (grossPnlSol / safeNum(position.amountSol)) * 100
      : 0;

  position.lastMark = {
    currentPrice: round(px, 12),
    grossValueSol: round(grossValueSol, 8),
    netValueSol: round(netValueSol, 8),
    grossPnlSol: round(grossPnlSol, 8),
    grossPnlPct: round(grossPnlPct, 4),
    netPnlSol: round(netPnlSol, 8),
    netPnlPct: round(netPnlPct, 4),
    ageMs: Date.now() - safeNum(position.openedAt)
  };

  return position.lastMark;
}

export function maybeTakeRunnerPartial(position, currentPrice) {
  if (!position) return null;
  if (!["runner", "migration_survivor"].includes(String(position.strategy || ""))) return null;
  if (!Array.isArray(position.runnerTargetsPct) || !position.runnerTargetsPct.length) return null;

  const mark = markPosition(position, currentPrice);
  if (!mark) return null;

  const idx = safeNum(position.runnerTargetIndex, 0);
  if (idx >= position.runnerTargetsPct.length) return null;

  const target = safeNum(position.runnerTargetsPct[idx], 0);
  if (mark.grossPnlPct < target) return null;

  const fraction =
    idx === 0 ? 0.3 :
    idx === 1 ? 0.3 :
    0.2;

  const soldTokenAmount = safeNum(position.tokenAmount) * fraction;
  const grossValueSol = soldTokenAmount * safeNum(currentPrice);
  const exitCosts = getExitCosts(grossValueSol);
  const netValueSol = grossValueSol - exitCosts.totalSol;

  position.tokenAmount = round(safeNum(position.tokenAmount) - soldTokenAmount, 8);
  position.partialRealizedSol = round(safeNum(position.partialRealizedSol) + netValueSol, 8);
  position.runnerTargetIndex = idx + 1;
  state.cash = round(state.cash + netValueSol, 8);

  return {
    targetPct: target,
    soldFraction: fraction,
    netValueSol: round(netValueSol, 8),
    realizedPct: round(mark.grossPnlPct, 4),
    remainingTokenAmount: position.tokenAmount
  };
}

export function closePosition(positionId, exitReferencePrice, reason = "EXIT") {
  const idx = state.positions.findIndex((p) => p.id === positionId);
  if (idx === -1) return null;

  const position = state.positions[idx];
  const px = safeNum(exitReferencePrice, 0);
  if (px <= 0) return null;

  const grossValueSol = safeNum(position.tokenAmount) * px;
  const exitCosts = getExitCosts(grossValueSol);
  const netValueSol = grossValueSol - exitCosts.totalSol;

  const totalCapitalUsed = safeNum(position.amountSol) + safeNum(position.entryCosts?.totalSol);
  const netPnlSol =
    netValueSol + safeNum(position.partialRealizedSol, 0) - totalCapitalUsed;
  const netPnlPct = totalCapitalUsed > 0 ? (netPnlSol / totalCapitalUsed) * 100 : 0;

  state.cash = round(state.cash + netValueSol, 8);

  const trade = {
    id: position.id,
    strategy: position.strategy,
    walletId: position.walletId,
    token: position.token,
    symbol: position.symbol || "",
    ca: position.ca,
    dexId: position.dexId || "",
    chainId: position.chainId || "",
    url: position.url || "",
    entryMode: position.entryMode || "SCALED",
    planName: position.planName || "",
    planObjective: position.planObjective || "",
    entryReferencePrice: position.entryReferencePrice,
    entryEffectivePrice: position.entryEffectivePrice,
    exitReferencePrice: round(px, 12),
    amountSol: safeNum(position.amountSol),
    entryCosts: position.entryCosts,
    exitCosts,
    tokenAmount: safeNum(position.tokenAmount),
    partialRealizedSol: round(safeNum(position.partialRealizedSol), 8),
    netValueSol: round(netValueSol, 8),
    netPnlSol: round(netPnlSol, 8),
    netPnlPct: round(netPnlPct, 4),
    reason,
    openedAt: position.openedAt,
    closedAt: Date.now(),
    durationMs: Date.now() - safeNum(position.openedAt),
    balanceAfter: state.cash,
    signalContext: position.signalContext
  };

  state.closedTrades.push(trade);
  state.positions.splice(idx, 1);
  return trade;
}
