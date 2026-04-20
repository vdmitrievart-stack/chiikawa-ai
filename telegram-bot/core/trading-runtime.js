function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const DEFAULT_STRATEGY_KEYS = [
  "scalp",
  "reversal",
  "runner",
  "copytrade",
  "migration_survivor"
];

export function buildDefaultRuntimeConfig(overrides = {}) {
  return {
    language: overrides.language || "ru",
    dryRun: overrides.dryRun !== false,
    startBalanceSol: safeNum(overrides.startBalanceSol, 10),
    strategyBudget: {
      scalp: safeNum(overrides.strategyBudget?.scalp, 0.2),
      reversal: safeNum(overrides.strategyBudget?.reversal, 0.2),
      runner: safeNum(overrides.strategyBudget?.runner, 0.2),
      copytrade: safeNum(overrides.strategyBudget?.copytrade, 0.2),
      migration_survivor: safeNum(overrides.strategyBudget?.migration_survivor, 0.2)
    },
    strategyEnabled: {
      scalp: overrides.strategyEnabled?.scalp !== false,
      reversal: overrides.strategyEnabled?.reversal !== false,
      runner: overrides.strategyEnabled?.runner !== false,
      copytrade: overrides.strategyEnabled?.copytrade !== false,
      migration_survivor: overrides.strategyEnabled?.migration_survivor !== false
    },
    wallets: clone(overrides.wallets || {}),
    strategyRouting: clone(overrides.strategyRouting || {}),
    copytrade: clone(
      overrides.copytrade || {
        enabled: true,
        rescoringEnabled: true,
        minLeaderScore: 70,
        cooldownMinutes: 180,
        leaders: []
      }
    )
  };
}

export function createTradingRuntime(initialConfig = {}) {
  return {
    mode: "stopped",
    runId: null,
    startedAt: null,
    activeChatId: null,
    activeUserId: null,

    activeConfig: buildDefaultRuntimeConfig(initialConfig),
    pendingConfig: null,
    pendingReason: null,
    pendingQueuedAt: null,

    strategyScope: "all",
    stopRequested: false,
    killRequested: false,
    cycleCount: 0,
    lastCycleAt: 0,
    lastStatusAt: 0
  };
}

export function startRuntime(runtime, options = {}) {
  runtime.mode = options.mode || "infinite";
  runtime.runId = `run-${Date.now()}`;
  runtime.startedAt = Date.now();
  runtime.activeChatId = options.chatId ?? null;
  runtime.activeUserId = options.userId ?? null;
  runtime.strategyScope = options.strategyScope || "all";
  runtime.stopRequested = false;
  runtime.killRequested = false;
  runtime.cycleCount = 0;
  runtime.lastCycleAt = 0;
  return runtime;
}

export function requestStop(runtime) {
  runtime.stopRequested = true;
  runtime.killRequested = false;
  return runtime;
}

export function requestKill(runtime) {
  runtime.killRequested = true;
  runtime.stopRequested = true;
  return runtime;
}

export function finishRuntime(runtime) {
  runtime.mode = "stopped";
  runtime.strategyScope = "all";
  runtime.stopRequested = false;
  runtime.killRequested = false;
  return runtime;
}

export function queuePendingConfig(runtime, patch = {}, reason = "manual_update") {
  const base = clone(runtime.pendingConfig || runtime.activeConfig);
  runtime.pendingConfig = deepMerge(base, patch);
  runtime.pendingReason = reason;
  runtime.pendingQueuedAt = new Date().toISOString();
  return runtime.pendingConfig;
}

export function hasPendingConfig(runtime) {
  return Boolean(runtime.pendingConfig);
}

export function canApplyPendingConfig(runtime, openPositionsCount = 0) {
  return hasPendingConfig(runtime) && safeNum(openPositionsCount) === 0;
}

export function applyPendingConfig(runtime) {
  if (!runtime.pendingConfig) return null;
  runtime.activeConfig = buildDefaultRuntimeConfig(runtime.pendingConfig);
  runtime.pendingConfig = null;
  runtime.pendingReason = null;
  runtime.pendingQueuedAt = null;
  return runtime.activeConfig;
}

export function isRunStopped(runtime) {
  return runtime.mode === "stopped";
}

export function isStrategyAllowed(runtime, strategyKey) {
  if (!runtime?.activeConfig?.strategyEnabled?.[strategyKey]) return false;
  if (runtime.strategyScope === "all") return true;
  return runtime.strategyScope === strategyKey;
}

export function listAllowedStrategies(runtime) {
  return DEFAULT_STRATEGY_KEYS.filter((key) => isStrategyAllowed(runtime, key));
}

export function canOpenNewPositions(runtime) {
  return !runtime.stopRequested && !runtime.killRequested && runtime.mode !== "stopped";
}

export function summarizeRuntime(runtime) {
  return {
    mode: runtime.mode,
    runId: runtime.runId,
    strategyScope: runtime.strategyScope,
    stopRequested: runtime.stopRequested,
    killRequested: runtime.killRequested,
    startedAt: runtime.startedAt,
    hasPendingConfig: Boolean(runtime.pendingConfig),
    pendingReason: runtime.pendingReason,
    pendingQueuedAt: runtime.pendingQueuedAt
  };
}

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function deepMerge(target, patch) {
  const out = clone(target);
  for (const [key, value] of Object.entries(patch || {})) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}
