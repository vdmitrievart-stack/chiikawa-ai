export const DEFAULT_STRATEGY_BUDGET = Object.freeze({
  scalp: 0.25,
  reversal: 0.25,
  runner: 0.25,
  copytrade: 0.25
});

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 6) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

export function normalizeBudgetConfig(input = DEFAULT_STRATEGY_BUDGET) {
  const raw = {
    scalp: safeNum(input?.scalp, DEFAULT_STRATEGY_BUDGET.scalp),
    reversal: safeNum(input?.reversal, DEFAULT_STRATEGY_BUDGET.reversal),
    runner: safeNum(input?.runner, DEFAULT_STRATEGY_BUDGET.runner),
    copytrade: safeNum(input?.copytrade, DEFAULT_STRATEGY_BUDGET.copytrade)
  };

  const total = raw.scalp + raw.reversal + raw.runner + raw.copytrade;
  if (total <= 0) return { ...DEFAULT_STRATEGY_BUDGET };

  return {
    scalp: round(raw.scalp / total, 6),
    reversal: round(raw.reversal / total, 6),
    runner: round(raw.runner / total, 6),
    copytrade: round(raw.copytrade / total, 6)
  };
}

export function validateBudgetPercents(values = []) {
  if (!Array.isArray(values) || values.length !== 4) {
    return { ok: false, reason: "need_4_values" };
  }

  const nums = values.map((v) => safeNum(v, NaN));
  if (nums.some((x) => !Number.isFinite(x) || x < 0)) {
    return { ok: false, reason: "invalid_numbers" };
  }

  const total = nums.reduce((a, b) => a + b, 0);
  if (Math.round(total) !== 100) {
    return { ok: false, reason: "sum_must_be_100", total };
  }

  return {
    ok: true,
    budget: normalizeBudgetConfig({
      scalp: nums[0] / 100,
      reversal: nums[1] / 100,
      runner: nums[2] / 100,
      copytrade: nums[3] / 100
    })
  };
}

export function formatBudgetLines(budget = DEFAULT_STRATEGY_BUDGET) {
  const b = normalizeBudgetConfig(budget);
  return [
    `• SCALP: ${Math.round(b.scalp * 100)}%`,
    `• REVERSAL: ${Math.round(b.reversal * 100)}%`,
    `• RUNNER: ${Math.round(b.runner * 100)}%`,
    `• COPYTRADE: ${Math.round(b.copytrade * 100)}%`
  ].join("\n");
}

export function queuePendingBudget(runtimeConfig, nextBudget) {
  const normalized = normalizeBudgetConfig(nextBudget);
  return {
    ...(runtimeConfig?.pendingConfig || {}),
    strategyBudget: normalized,
    queuedAt: new Date().toISOString()
  };
}
