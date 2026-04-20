export const DEFAULT_STRATEGY_BUDGET = {
  scalp: 0.2,
  reversal: 0.2,
  runner: 0.2,
  copytrade: 0.2,
  migration_survivor: 0.2
};

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pctLine(label, value) {
  return `• ${label}: ${(safeNum(value, 0) * 100).toFixed(1)}%`;
}

export function validateBudgetPercents(values = []) {
  const arr = Array.isArray(values) ? values.map((x) => safeNum(x, NaN)) : [];
  if (![4, 5].includes(arr.length)) {
    return {
      ok: false,
      reason: "Expected 4 or 5 values"
    };
  }

  if (arr.some((x) => !Number.isFinite(x) || x < 0)) {
    return {
      ok: false,
      reason: "Invalid number"
    };
  }

  const total = arr.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 100) > 0.001) {
    return {
      ok: false,
      reason: "Sum must be 100"
    };
  }

  const [scalp, reversal, runner, copytrade, migration = 0] = arr;

  return {
    ok: true,
    budget: {
      scalp: scalp / 100,
      reversal: reversal / 100,
      runner: runner / 100,
      copytrade: copytrade / 100,
      migration_survivor: migration / 100
    }
  };
}

export function formatBudgetLines(budget = DEFAULT_STRATEGY_BUDGET) {
  return [
    pctLine("scalp", budget?.scalp),
    pctLine("reversal", budget?.reversal),
    pctLine("runner", budget?.runner),
    pctLine("copytrade", budget?.copytrade),
    pctLine("migration_survivor", budget?.migration_survivor)
  ].join("\n");
}
