const PUBLIC_ENTRY_STRATEGIES = new Set([
  "reversal",
  "runner",
  "migration_survivor",
  "copytrade"
]);

const PUBLIC_EXIT_STRATEGIES = new Set([
  "reversal",
  "runner",
  "migration_survivor",
  "copytrade"
]);

export function isPublicEntryStrategy(strategy) {
  return PUBLIC_ENTRY_STRATEGIES.has(String(strategy || "").trim());
}

export function isPublicExitStrategy(strategy) {
  return PUBLIC_EXIT_STRATEGIES.has(String(strategy || "").trim());
}

export function isPublicEntry(position) {
  return Boolean(position) && isPublicEntryStrategy(position.strategy);
}

export function isPublicExit(closedTrade) {
  return Boolean(closedTrade) && isPublicExitStrategy(closedTrade.strategy);
}

export function isRiskierPublicStrategy(strategy) {
  return String(strategy || "").trim() === "copytrade";
}

export function publicStrategyLabel(strategy) {
  const key = String(strategy || "").trim();

  if (key === "reversal") return "разворот";
  if (key === "runner") return "runner";
  if (key === "migration_survivor") return "после миграции";
  if (key === "copytrade") return "идея повышенного риска";
  return "идея";
}
