import { DEFAULT_STRATEGY_BUDGET, normalizeBudgetConfig } from "./budget-manager.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  language: "ru",
  dryRun: true,
  reportIntervalMin: 20,
  strategyBudget: DEFAULT_STRATEGY_BUDGET,
  strategyEnabled: {
    scalp: true,
    reversal: true,
    runner: true,
    copytrade: true
  },
  strategyRouting: {
    scalp: ["wallet_trader_main"],
    reversal: ["wallet_trader_main"],
    runner: ["wallet_runner_main"],
    copytrade: ["wallet_copy_1", "wallet_copy_2"]
  },
  wallets: {
    wallet_trader_main: {
      label: "Trader Main",
      role: "trader",
      executionMode: "dry_run",
      allowedStrategies: ["scalp", "reversal"],
      enabled: true,
      minReserveSol: 0.10,
      maxTradeUsd: 250,
      secretRef: ""
    },
    wallet_runner_main: {
      label: "Runner Main",
      role: "trader",
      executionMode: "dry_run",
      allowedStrategies: ["runner"],
      enabled: true,
      minReserveSol: 0.15,
      maxTradeUsd: 350,
      secretRef: ""
    },
    wallet_copy_1: {
      label: "Copy Follower 1",
      role: "follower",
      executionMode: "dry_run",
      allowedStrategies: ["copytrade"],
      enabled: true,
      minReserveSol: 0.12,
      maxTradeUsd: 200,
      secretRef: ""
    },
    wallet_copy_2: {
      label: "Copy Follower 2",
      role: "follower",
      executionMode: "dry_run",
      allowedStrategies: ["copytrade"],
      enabled: true,
      minReserveSol: 0.12,
      maxTradeUsd: 200,
      secretRef: ""
    }
  },
  copytrade: {
    enabled: true,
    rescoringEnabled: true,
    minLeaderScore: 70,
    cooldownMinutes: 90,
    reactivationScore: 76,
    maxLeaderDrawdownPct: 18,
    maxFollowerSlippageBps: 300,
    gmgnEnabled: false
  },
  gmgn: {
    enabled: false,
    baseUrl: process.env.GMGN_API_BASE_URL || "",
    apiKey: process.env.GMGN_API_KEY || "",
    leadersRefreshMs: 2 * 60 * 1000,
    scannerRefreshMs: 90 * 1000
  }
});

export function createRuntimeState() {
  return {
    mode: "stopped",
    enabled: true,
    stopRequested: false,
    killRequested: false,
    runId: null,
    startedAt: null,
    activeConfig: normalizeConfig(DEFAULT_RUNTIME_CONFIG),
    pendingConfig: null,
    pendingReason: null,
    lastReportAt: 0,
    lastCycleAt: 0,
    lastError: null,
    activeChatId: null,
    activeUserId: null
  };
}

export function normalizeConfig(input = {}) {
  const merged = {
    ...clone(DEFAULT_RUNTIME_CONFIG),
    ...clone(input)
  };

  merged.strategyBudget = normalizeBudgetConfig(merged.strategyBudget);
  merged.strategyEnabled = {
    scalp: merged.strategyEnabled?.scalp !== false,
    reversal: merged.strategyEnabled?.reversal !== false,
    runner: merged.strategyEnabled?.runner !== false,
    copytrade: merged.strategyEnabled?.copytrade !== false
  };

  return merged;
}

export function setPendingConfig(runtime, patch = {}, reason = "manual_update") {
  runtime.pendingConfig = normalizeConfig({
    ...runtime.activeConfig,
    ...clone(patch)
  });
  runtime.pendingReason = reason;
  return runtime.pendingConfig;
}

export function applyPendingConfig(runtime) {
  if (!runtime.pendingConfig) return null;
  runtime.activeConfig = normalizeConfig(runtime.pendingConfig);
  runtime.pendingConfig = null;
  runtime.pendingReason = null;
  return runtime.activeConfig;
}

export function summarizeRuntime(runtime) {
  return {
    mode: runtime.mode,
    enabled: runtime.enabled,
    stopRequested: runtime.stopRequested,
    killRequested: runtime.killRequested,
    runId: runtime.runId,
    startedAt: runtime.startedAt,
    language: runtime.activeConfig.language,
    dryRun: runtime.activeConfig.dryRun,
    hasPendingConfig: Boolean(runtime.pendingConfig),
    reportIntervalMin: runtime.activeConfig.reportIntervalMin
  };
}
