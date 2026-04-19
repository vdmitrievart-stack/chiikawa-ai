function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 6) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

export const DEFAULT_STRATEGY_BUDGET = Object.freeze({
  scalp: 0.25,
  reversal: 0.25,
  runner: 0.25,
  copytrade: 0.25
});

export function normalizeBudgetConfig(input = {}) {
  const merged = {
    ...DEFAULT_STRATEGY_BUDGET,
    ...(input || {})
  };

  const normalized = {};
  for (const key of Object.keys(DEFAULT_STRATEGY_BUDGET)) {
    normalized[key] = Math.max(0, safeNum(merged[key], DEFAULT_STRATEGY_BUDGET[key]));
  }

  const total = Object.values(normalized).reduce((sum, x) => sum + x, 0);
  if (total <= 0) {
    return { ...DEFAULT_STRATEGY_BUDGET };
  }

  for (const key of Object.keys(normalized)) {
    normalized[key] = round(normalized[key] / total, 8);
  }

  const fixedTotal = Object.values(normalized).reduce((sum, x) => sum + x, 0);
  const drift = round(1 - fixedTotal, 8);
  if (drift !== 0) {
    normalized.copytrade = round((normalized.copytrade || 0) + drift, 8);
  }

  return normalized;
}

export function validateBudgetConfig(input = {}) {
  const keys = Object.keys(DEFAULT_STRATEGY_BUDGET);
  const errors = [];
  const normalized = {};

  for (const key of keys) {
    const raw = input[key];
    const value = safeNum(raw, NaN);
    if (!Number.isFinite(value)) {
      errors.push(`${key}: invalid_number`);
      continue;
    }
    if (value < 0) {
      errors.push(`${key}: negative_value`);
    }
    normalized[key] = value;
  }

  const total = keys.reduce((sum, key) => sum + safeNum(normalized[key], 0), 0);
  if (Math.abs(total - 1) > 0.0001 && Math.abs(total - 100) > 0.0001) {
    errors.push(`total_must_equal_1_or_100: got ${total}`);
  }

  if (Math.abs(total - 100) <= 0.0001) {
    for (const key of keys) normalized[key] = normalized[key] / 100;
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: errors.length ? null : normalizeBudgetConfig(normalized)
  };
}

export function buildBudgetSummary(activeBudget = {}, pendingBudget = null) {
  const active = normalizeBudgetConfig(activeBudget);
  const lines = [
    `SCALP ${Math.round(active.scalp * 100)}%`,
    `REVERSAL ${Math.round(active.reversal * 100)}%`,
    `RUNNER ${Math.round(active.runner * 100)}%`,
    `COPYTRADE ${Math.round(active.copytrade * 100)}%`
  ];

  if (!pendingBudget) {
    return {
      active,
      pending: null,
      text: `Active budget\n${lines.map(x => `• ${x}`).join("\n")}`
    };
  }

  const pending = normalizeBudgetConfig(pendingBudget);
  return {
    active,
    pending,
    text: `Active budget\n${lines.map(x => `• ${x}`).join("\n")}\n\nPending budget\n• SCALP ${Math.round(pending.scalp * 100)}%\n• REVERSAL ${Math.round(pending.reversal * 100)}%\n• RUNNER ${Math.round(pending.runner * 100)}%\n• COPYTRADE ${Math.round(pending.copytrade * 100)}%`
  };
}
