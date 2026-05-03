import fs from "node:fs/promises";
import path from "node:path";

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, safeNum(value, min)));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(value, digits = 1) {
  return `${safeNum(value, 0).toFixed(digits)}%`;
}

function sol(value, digits = 4) {
  return `${safeNum(value, 0).toFixed(digits)} SOL`;
}

function usd(value, digits = 0) {
  return `$${safeNum(value, 0).toFixed(digits)}`;
}

function yesNo(value, language = "ru") {
  const isRu = String(language || "ru").toLowerCase().startsWith("ru");
  return value ? (isRu ? "да" : "yes") : (isRu ? "нет" : "no");
}

function shortCa(value = "") {
  const s = String(value || "").trim();
  if (!s) return "-";
  if (s.length <= 14) return s;
  return `${s.slice(0, 5)}…${s.slice(-5)}`;
}

function bucket(value, ranges) {
  const n = safeNum(value, 0);
  for (const row of ranges) {
    if (n >= row.min && n < row.max) return row.key;
  }
  return ranges[ranges.length - 1]?.key || "unknown";
}

function normalizeEntryMode(mode = "SCALED") {
  const v = String(mode || "SCALED").toUpperCase().trim();
  if (["PROBE", "SCALED", "FULL"].includes(v)) return v;
  return "SCALED";
}

function factorLabel(factor, language = "ru") {
  const isRu = String(language || "ru").toLowerCase().startsWith("ru");
  const mapRu = {
    entry_probe: "probe-вход",
    entry_scaled: "scaled-вход",
    entry_full: "full-вход",
    score_very_low: "низкий общий score",
    score_low: "пограничный общий score",
    score_mid: "средний общий score",
    score_high: "сильный общий score",
    liquidity_tiny: "очень тонкая ликвидность",
    liquidity_low: "низкая ликвидность",
    liquidity_ok: "нормальная ликвидность",
    liquidity_deep: "глубокая ликвидность",
    fdv_micro: "микро FDV",
    fdv_early: "ранний FDV",
    fdv_mid: "средний FDV",
    fdv_high: "высокий FDV",
    volume_dead: "почти нет объёма 1ч",
    volume_low: "слабый объём 1ч",
    volume_ok: "нормальный объём 1ч",
    volume_hot: "горячий объём 1ч",
    no_socials: "нет соцсетей",
    has_socials: "есть соцсети",
    dev_bad: "dev risk: bad",
    dev_unknown: "dev неизвестен",
    dev_ok: "dev без красного флага",
    holder_weak: "слабый holder control",
    holder_mid: "средний holder control",
    holder_strong: "сильный holder control",
    quiet_accumulation: "тихое накопление",
    no_quiet_accumulation: "нет quiet accumulation",
    corpse_risk: "corpse/rug-risk",
    false_bounce_risk: "false bounce risk",
    migration_structure: "migration structure",
    migration_accumulation: "migration accumulation",
    runner_structure: "runner-like структура",
    copy_soft_warning: "copytrade soft warning",
    dex_paid: "DEX paid/boosted",
    dex_not_paid: "DEX not paid",
    exit_stop: "выход по SL/stop",
    exit_tp: "выход по TP",
    exit_time: "time exit",
    exit_trail: "trail exit",
    exit_corpse: "corpse exit",
    exit_false_bounce: "false-bounce exit",
    exit_kill: "kill switch"
  };

  const mapEn = {
    entry_probe: "probe entry",
    entry_scaled: "scaled entry",
    entry_full: "full entry",
    score_very_low: "very low score",
    score_low: "borderline score",
    score_mid: "mid score",
    score_high: "strong score",
    liquidity_tiny: "tiny liquidity",
    liquidity_low: "low liquidity",
    liquidity_ok: "normal liquidity",
    liquidity_deep: "deep liquidity",
    fdv_micro: "micro FDV",
    fdv_early: "early FDV",
    fdv_mid: "mid FDV",
    fdv_high: "high FDV",
    volume_dead: "dead 1h volume",
    volume_low: "low 1h volume",
    volume_ok: "normal 1h volume",
    volume_hot: "hot 1h volume",
    no_socials: "no socials",
    has_socials: "has socials",
    dev_bad: "dev risk: bad",
    dev_unknown: "dev unknown",
    dev_ok: "dev ok",
    holder_weak: "weak holder control",
    holder_mid: "mid holder control",
    holder_strong: "strong holder control",
    quiet_accumulation: "quiet accumulation",
    no_quiet_accumulation: "no quiet accumulation",
    corpse_risk: "corpse/rug risk",
    false_bounce_risk: "false bounce risk",
    migration_structure: "migration structure",
    migration_accumulation: "migration accumulation",
    runner_structure: "runner-like structure",
    copy_soft_warning: "copytrade soft warning",
    dex_paid: "DEX paid/boosted",
    dex_not_paid: "DEX not paid",
    exit_stop: "SL/stop exit",
    exit_tp: "TP exit",
    exit_time: "time exit",
    exit_trail: "trail exit",
    exit_corpse: "corpse exit",
    exit_false_bounce: "false-bounce exit",
    exit_kill: "kill switch"
  };

  return (isRu ? mapRu : mapEn)[factor] || String(factor || "-").replace(/_/g, " ");
}

function reasonFamily(reason = "") {
  const r = String(reason || "").toUpperCase();
  if (r.includes("KILL")) return "exit_kill";
  if (r.includes("STOP")) return "exit_stop";
  if (r.includes("TP")) return "exit_tp";
  if (r.includes("TIME")) return "exit_time";
  if (r.includes("TRAIL")) return "exit_trail";
  if (r.includes("CORPSE")) return "exit_corpse";
  if (r.includes("FALSE")) return "exit_false_bounce";
  return "exit_other";
}

function newStats(key) {
  return {
    key,
    trades: 0,
    wins: 0,
    losses: 0,
    pnlSol: 0,
    pnlPctSum: 0,
    lastSeenAt: 0,
    examples: []
  };
}

function addExample(stats, trade) {
  const row = {
    id: trade.id || `${trade.strategy}:${trade.ca}:${trade.closedAt}`,
    strategy: trade.strategy || "-",
    token: trade.token || trade.symbol || shortCa(trade.ca),
    ca: trade.ca || "",
    pnlPct: safeNum(trade.netPnlPct, 0),
    pnlSol: safeNum(trade.netPnlSol, 0),
    reason: trade.reason || "-",
    closedAt: trade.closedAt || Date.now()
  };

  stats.examples = [row, ...(stats.examples || []).filter((x) => x.id !== row.id)].slice(0, 5);
}

function updateStats(stats, trade) {
  const pnlPct = safeNum(trade.netPnlPct, 0);
  const pnlSolValue = safeNum(trade.netPnlSol, 0);
  stats.trades += 1;
  if (pnlPct > 0 || pnlSolValue > 0) stats.wins += 1;
  else stats.losses += 1;
  stats.pnlSol += pnlSolValue;
  stats.pnlPctSum += pnlPct;
  stats.lastSeenAt = Math.max(safeNum(stats.lastSeenAt, 0), safeNum(trade.closedAt, Date.now()));
  addExample(stats, trade);
  return stats;
}

function finalizeStats(stats) {
  const trades = safeNum(stats?.trades, 0);
  const losses = safeNum(stats?.losses, 0);
  const wins = safeNum(stats?.wins, 0);
  return {
    ...(stats || {}),
    winRate: trades ? wins / trades : 0,
    lossRate: trades ? losses / trades : 0,
    avgPnlPct: trades ? safeNum(stats?.pnlPctSum, 0) / trades : 0,
    avgPnlSol: trades ? safeNum(stats?.pnlSol, 0) / trades : 0
  };
}

function sortWorst(a, b) {
  const fa = finalizeStats(a);
  const fb = finalizeStats(b);
  return (
    fb.lossRate - fa.lossRate ||
    fa.avgPnlPct - fb.avgPnlPct ||
    fb.trades - fa.trades ||
    safeNum(fb.lastSeenAt, 0) - safeNum(fa.lastSeenAt, 0)
  );
}

function sortBest(a, b) {
  const fa = finalizeStats(a);
  const fb = finalizeStats(b);
  return (
    fb.winRate - fa.winRate ||
    fb.avgPnlPct - fa.avgPnlPct ||
    fb.trades - fa.trades ||
    safeNum(fb.lastSeenAt, 0) - safeNum(fa.lastSeenAt, 0)
  );
}

export default class TradeLearningEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.enabled = String(process.env.TRADE_LEARNING_ENABLED || "true") !== "false";
    this.dataFile = path.resolve(
      process.env.TRADE_LEARNING_DATA_FILE || "./runtime-data/trade-learning-memory.json"
    );
    this.minStrategyTrades = safeNum(process.env.TRADE_LEARNING_MIN_STRATEGY_TRADES, 5);
    this.minFactorTrades = safeNum(process.env.TRADE_LEARNING_MIN_FACTOR_TRADES, 3);
    this.minComboTrades = safeNum(process.env.TRADE_LEARNING_MIN_COMBO_TRADES, 4);
    this.warnLossRate = clamp(process.env.TRADE_LEARNING_WARN_LOSS_RATE || 0.6, 0.5, 0.95);
    this.blockLossRate = clamp(process.env.TRADE_LEARNING_BLOCK_LOSS_RATE || 0.78, 0.55, 0.99);
    this.warnAvgPnlPct = safeNum(process.env.TRADE_LEARNING_WARN_AVG_PNL_PCT, -3);
    this.blockAvgPnlPct = safeNum(process.env.TRADE_LEARNING_BLOCK_AVG_PNL_PCT, -8);
    this.maxTrades = safeNum(process.env.TRADE_LEARNING_MAX_TRADES, 600);
    this.state = this.createFreshState();
  }

  createFreshState() {
    return {
      version: 17,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      trades: [],
      tradeIds: {},
      stats: {
        byStrategy: {},
        byFactor: {},
        byStrategyFactor: {},
        byCombo: {},
        byExitReason: {}
      },
      activeCorrections: [],
      lastChanges: [],
      recommendedBudget: null
    };
  }

  async initialize() {
    await this.load();
    return true;
  }

  async load() {
    if (!this.enabled) return this.state;
    try {
      const raw = await fs.readFile(this.dataFile, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        ...this.createFreshState(),
        ...(parsed || {}),
        stats: {
          byStrategy: parsed?.stats?.byStrategy || {},
          byFactor: parsed?.stats?.byFactor || {},
          byStrategyFactor: parsed?.stats?.byStrategyFactor || {},
          byCombo: parsed?.stats?.byCombo || {},
          byExitReason: parsed?.stats?.byExitReason || {}
        },
        tradeIds: parsed?.tradeIds || {}
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.log?.("trade learning load error:", error.message || String(error));
      }
      this.state = this.createFreshState();
    }
    return this.state;
  }

  async save() {
    if (!this.enabled) return false;
    try {
      await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
      await fs.writeFile(this.dataFile, JSON.stringify(this.state, null, 2), "utf8");
      return true;
    } catch (error) {
      this.logger.log?.("trade learning save error:", error.message || String(error));
      return false;
    }
  }

  getState() {
    return clone(this.state);
  }

  normalizeTrade(raw = {}) {
    const ctx = raw?.signalContext || {};
    const market = ctx?.tokenSnapshot || ctx?.market || {};
    const metrics = ctx?.strategyMetrics || {};
    const chosenPlan = ctx?.chosenPlan || {};
    const token = raw?.tokenSnapshot || {};

    return {
      id: String(raw?.id || `${raw?.strategy || "unknown"}:${raw?.ca || ""}:${raw?.closedAt || Date.now()}`),
      strategy: String(raw?.strategy || chosenPlan?.strategyKey || "unknown"),
      token: raw?.token || raw?.symbol || market?.name || "UNKNOWN",
      symbol: raw?.symbol || market?.symbol || "",
      ca: raw?.ca || market?.ca || "",
      entryMode: normalizeEntryMode(raw?.entryMode || chosenPlan?.entryMode || "SCALED"),
      planName: raw?.planName || chosenPlan?.planName || "",
      planObjective: raw?.planObjective || chosenPlan?.objective || "",
      reason: raw?.reason || "EXIT",
      amountSol: safeNum(raw?.amountSol, 0),
      netPnlSol: safeNum(raw?.netPnlSol, 0),
      netPnlPct: safeNum(raw?.netPnlPct, 0),
      durationMs: safeNum(raw?.durationMs, 0),
      openedAt: safeNum(raw?.openedAt, 0),
      closedAt: safeNum(raw?.closedAt, Date.now()),
      score: safeNum(raw?.signalScore, safeNum(metrics?.score, 0)),
      liquidity: safeNum(market?.liquidity, safeNum(token?.liquidity, 0)),
      fdv: safeNum(market?.fdv, safeNum(token?.fdv, 0)),
      volumeH1: safeNum(market?.volumeH1, safeNum(market?.volume1h, safeNum(token?.volumeH1, 0))),
      volumeH24: safeNum(market?.volumeH24, safeNum(market?.volume, safeNum(token?.volumeH24, 0))),
      txnsH1: safeNum(market?.txnsH1, 0),
      devVerdict: String(metrics?.devVerdict || ctx?.developer?.verdict || "Unknown"),
      socialsCount: safeNum(metrics?.socialsCount, Array.isArray(ctx?.socials) ? ctx.socials.length : 0),
      holderControlPct: safeNum(metrics?.holderControlPct, safeNum(ctx?.holderAccumulation?.netControlPct, 0)),
      quietAccumulation: Boolean(metrics?.quietAccumulation || ctx?.holderAccumulation?.quietAccumulationPass),
      corpseRisk: Boolean(metrics?.corpseRisk || ctx?.corpse?.isCorpse),
      falseBounceRisk: Boolean(metrics?.falseBounceRisk || ctx?.falseBounce?.rejected),
      migrationStructure: Boolean(metrics?.migrationStructure || ctx?.migration?.passes),
      migrationAccumulation: Boolean(metrics?.migrationAccumulation || ctx?.migrationAccumulation?.priorityWatch || ctx?.migrationAccumulation?.allow),
      runnerStructure: Boolean(metrics?.runnerStructure || ctx?.runnerLike?.allow),
      copySoftWarning: Boolean(metrics?.copySoftWarning || ctx?.copytradeMeta?.softWarning),
      dexPaid: Boolean(metrics?.dexPaid || ctx?.dexPaid?.paid),
      raw: clone(raw)
    };
  }

  buildFactorsFromTrade(trade = {}) {
    const factors = [];
    const mode = normalizeEntryMode(trade.entryMode);
    factors.push(`entry_${mode.toLowerCase()}`);
    factors.push(bucket(trade.score, [
      { min: -Infinity, max: 55, key: "score_very_low" },
      { min: 55, max: 70, key: "score_low" },
      { min: 70, max: 84, key: "score_mid" },
      { min: 84, max: Infinity, key: "score_high" }
    ]));

    if (trade.liquidity > 0) {
      factors.push(bucket(trade.liquidity, [
        { min: -Infinity, max: 8000, key: "liquidity_tiny" },
        { min: 8000, max: 18000, key: "liquidity_low" },
        { min: 18000, max: 60000, key: "liquidity_ok" },
        { min: 60000, max: Infinity, key: "liquidity_deep" }
      ]));
    }

    if (trade.fdv > 0) {
      factors.push(bucket(trade.fdv, [
        { min: -Infinity, max: 30000, key: "fdv_micro" },
        { min: 30000, max: 150000, key: "fdv_early" },
        { min: 150000, max: 700000, key: "fdv_mid" },
        { min: 700000, max: Infinity, key: "fdv_high" }
      ]));
    }

    if (trade.volumeH1 > 0) {
      factors.push(bucket(trade.volumeH1, [
        { min: -Infinity, max: 1000, key: "volume_dead" },
        { min: 1000, max: 10000, key: "volume_low" },
        { min: 10000, max: 80000, key: "volume_ok" },
        { min: 80000, max: Infinity, key: "volume_hot" }
      ]));
    }

    factors.push(trade.socialsCount > 0 ? "has_socials" : "no_socials");

    const dev = String(trade.devVerdict || "").toLowerCase();
    if (dev.includes("bad")) factors.push("dev_bad");
    else if (!dev || dev.includes("unknown")) factors.push("dev_unknown");
    else factors.push("dev_ok");

    if (trade.holderControlPct >= 45) factors.push("holder_strong");
    else if (trade.holderControlPct >= 18) factors.push("holder_mid");
    else factors.push("holder_weak");

    factors.push(trade.quietAccumulation ? "quiet_accumulation" : "no_quiet_accumulation");
    if (trade.corpseRisk) factors.push("corpse_risk");
    if (trade.falseBounceRisk) factors.push("false_bounce_risk");
    if (trade.migrationStructure) factors.push("migration_structure");
    if (trade.migrationAccumulation) factors.push("migration_accumulation");
    if (trade.runnerStructure) factors.push("runner_structure");
    if (trade.copySoftWarning) factors.push("copy_soft_warning");
    factors.push(trade.dexPaid ? "dex_paid" : "dex_not_paid");
    factors.push(reasonFamily(trade.reason));

    return [...new Set(factors.filter(Boolean))];
  }

  buildFactorsFromCandidate(candidate = {}, plan = {}) {
    const token = candidate?.token || {};
    const factors = [];
    const mode = normalizeEntryMode(plan?.entryMode || "SCALED");
    factors.push(`entry_${mode.toLowerCase()}`);
    factors.push(bucket(candidate?.score, [
      { min: -Infinity, max: 55, key: "score_very_low" },
      { min: 55, max: 70, key: "score_low" },
      { min: 70, max: 84, key: "score_mid" },
      { min: 84, max: Infinity, key: "score_high" }
    ]));

    if (safeNum(token?.liquidity, 0) > 0) {
      factors.push(bucket(token.liquidity, [
        { min: -Infinity, max: 8000, key: "liquidity_tiny" },
        { min: 8000, max: 18000, key: "liquidity_low" },
        { min: 18000, max: 60000, key: "liquidity_ok" },
        { min: 60000, max: Infinity, key: "liquidity_deep" }
      ]));
    }

    if (safeNum(token?.fdv, 0) > 0) {
      factors.push(bucket(token.fdv, [
        { min: -Infinity, max: 30000, key: "fdv_micro" },
        { min: 30000, max: 150000, key: "fdv_early" },
        { min: 150000, max: 700000, key: "fdv_mid" },
        { min: 700000, max: Infinity, key: "fdv_high" }
      ]));
    }

    const volumeH1 = safeNum(token?.volumeH1, safeNum(token?.volume, 0));
    if (volumeH1 > 0) {
      factors.push(bucket(volumeH1, [
        { min: -Infinity, max: 1000, key: "volume_dead" },
        { min: 1000, max: 10000, key: "volume_low" },
        { min: 10000, max: 80000, key: "volume_ok" },
        { min: 80000, max: Infinity, key: "volume_hot" }
      ]));
    }

    const socialsCount = Array.isArray(candidate?.socials) ? candidate.socials.length : 0;
    factors.push(socialsCount > 0 ? "has_socials" : "no_socials");

    const dev = String(candidate?.developer?.verdict || "").toLowerCase();
    if (dev.includes("bad")) factors.push("dev_bad");
    else if (!dev || dev.includes("unknown")) factors.push("dev_unknown");
    else factors.push("dev_ok");

    const holderControlPct = safeNum(candidate?.holderAccumulation?.netControlPct, 0);
    if (holderControlPct >= 45) factors.push("holder_strong");
    else if (holderControlPct >= 18) factors.push("holder_mid");
    else factors.push("holder_weak");

    factors.push(candidate?.holderAccumulation?.quietAccumulationPass ? "quiet_accumulation" : "no_quiet_accumulation");
    if (candidate?.corpse?.isCorpse) factors.push("corpse_risk");
    if (candidate?.falseBounce?.rejected) factors.push("false_bounce_risk");
    if (candidate?.migration?.passes) factors.push("migration_structure");
    if (candidate?.migrationAccumulation?.priorityWatch || candidate?.migrationAccumulation?.allow) factors.push("migration_accumulation");
    if (candidate?.runnerLike?.allow) factors.push("runner_structure");
    if (candidate?.copytradeMeta?.softWarning) factors.push("copy_soft_warning");
    factors.push(candidate?.dexPaid?.paid ? "dex_paid" : "dex_not_paid");

    return [...new Set(factors.filter(Boolean))];
  }

  increment(map, key, trade) {
    if (!key) return;
    const current = map[key] || newStats(key);
    map[key] = updateStats(current, trade);
  }

  makeComboKey(strategy, factors = []) {
    const dangerousCore = factors.filter((f) => [
      "score_very_low", "score_low",
      "liquidity_tiny", "liquidity_low",
      "volume_dead", "volume_low",
      "no_socials", "dev_bad", "dev_unknown",
      "holder_weak", "corpse_risk", "false_bounce_risk",
      "copy_soft_warning", "fdv_high"
    ].includes(f));

    const core = dangerousCore.slice(0, 4);
    if (core.length < 2) return "";
    return `${strategy}::${core.sort().join("+")}`;
  }

  rebuildStats() {
    const stats = {
      byStrategy: {},
      byFactor: {},
      byStrategyFactor: {},
      byCombo: {},
      byExitReason: {}
    };

    for (const trade of this.state.trades || []) {
      const factors = Array.isArray(trade.factors) ? trade.factors : this.buildFactorsFromTrade(trade);
      this.increment(stats.byStrategy, trade.strategy, trade);
      this.increment(stats.byExitReason, reasonFamily(trade.reason), trade);
      for (const factor of factors) {
        this.increment(stats.byFactor, factor, trade);
        this.increment(stats.byStrategyFactor, `${trade.strategy}::${factor}`, trade);
      }
      const combo = this.makeComboKey(trade.strategy, factors);
      if (combo) this.increment(stats.byCombo, combo, trade);
    }

    this.state.stats = stats;
    this.state.activeCorrections = this.deriveCorrections();
    this.state.recommendedBudget = this.deriveRecommendedBudget();
    this.state.updatedAt = new Date().toISOString();
  }

  deriveCorrections() {
    const corrections = [];

    for (const raw of Object.values(this.state.stats.byStrategy || {})) {
      const s = finalizeStats(raw);
      if (s.trades < this.minStrategyTrades) continue;
      if (s.lossRate >= this.warnLossRate && s.avgPnlPct <= this.warnAvgPnlPct) {
        corrections.push({
          type: s.lossRate >= this.blockLossRate && s.avgPnlPct <= this.blockAvgPnlPct ? "strategy_hard" : "strategy_soft",
          scope: "strategy",
          key: s.key,
          strategy: s.key,
          severity: s.lossRate >= this.blockLossRate && s.avgPnlPct <= this.blockAvgPnlPct ? "hard" : "soft",
          action: s.lossRate >= this.blockLossRate && s.avgPnlPct <= this.blockAvgPnlPct ? "probe_or_skip" : "probe_only",
          trades: s.trades,
          winRate: s.winRate,
          lossRate: s.lossRate,
          avgPnlPct: s.avgPnlPct,
          pnlSol: s.pnlSol,
          reason: "strategy_negative_sample"
        });
      }
    }

    for (const raw of Object.values(this.state.stats.byStrategyFactor || {})) {
      const s = finalizeStats(raw);
      if (s.trades < this.minFactorTrades) continue;
      if (s.lossRate >= this.warnLossRate && s.avgPnlPct <= this.warnAvgPnlPct) {
        const [strategy, factor] = String(s.key || "").split("::");
        corrections.push({
          type: s.lossRate >= this.blockLossRate && s.avgPnlPct <= this.blockAvgPnlPct ? "factor_hard" : "factor_soft",
          scope: "strategy_factor",
          key: s.key,
          strategy,
          factor,
          severity: s.lossRate >= this.blockLossRate && s.avgPnlPct <= this.blockAvgPnlPct ? "hard" : "soft",
          action: s.lossRate >= this.blockLossRate && s.avgPnlPct <= this.blockAvgPnlPct ? "tighten_or_skip" : "tighten",
          trades: s.trades,
          winRate: s.winRate,
          lossRate: s.lossRate,
          avgPnlPct: s.avgPnlPct,
          pnlSol: s.pnlSol,
          reason: "factor_negative_sample"
        });
      }
    }

    for (const raw of Object.values(this.state.stats.byCombo || {})) {
      const s = finalizeStats(raw);
      if (s.trades < this.minComboTrades) continue;
      if (s.lossRate >= this.warnLossRate && s.avgPnlPct <= this.warnAvgPnlPct) {
        const [strategy, comboRaw = ""] = String(s.key || "").split("::");
        corrections.push({
          type: s.lossRate >= this.blockLossRate && s.avgPnlPct <= this.blockAvgPnlPct ? "combo_hard" : "combo_soft",
          scope: "combo",
          key: s.key,
          strategy,
          factors: comboRaw.split("+").filter(Boolean),
          severity: s.lossRate >= this.blockLossRate && s.avgPnlPct <= this.blockAvgPnlPct ? "hard" : "soft",
          action: s.lossRate >= this.blockLossRate && s.avgPnlPct <= this.blockAvgPnlPct ? "skip" : "probe_only",
          trades: s.trades,
          winRate: s.winRate,
          lossRate: s.lossRate,
          avgPnlPct: s.avgPnlPct,
          pnlSol: s.pnlSol,
          reason: "combo_negative_sample"
        });
      }
    }

    return corrections
      .sort((a, b) => {
        const hard = Number(b.severity === "hard") - Number(a.severity === "hard");
        if (hard) return hard;
        return b.lossRate - a.lossRate || a.avgPnlPct - b.avgPnlPct || b.trades - a.trades;
      })
      .slice(0, 24);
  }

  deriveRecommendedBudget() {
    const strategies = Object.values(this.state.stats.byStrategy || {})
      .map(finalizeStats)
      .filter((s) => s.trades >= this.minStrategyTrades);

    if (strategies.length < 2) return null;

    const rows = strategies.map((s) => {
      const quality = clamp((s.winRate * 100 + Math.max(-25, Math.min(25, s.avgPnlPct))) / 100, 0.05, 1.4);
      return { strategy: s.key, quality, trades: s.trades, winRate: s.winRate, avgPnlPct: s.avgPnlPct };
    });

    const total = rows.reduce((sum, row) => sum + row.quality, 0) || 1;
    const raw = Object.fromEntries(rows.map((row) => [row.strategy, row.quality / total]));

    const known = ["scalp", "reversal", "runner", "copytrade", "migration_survivor"];
    const budget = {};
    let allocated = 0;
    for (const key of known) {
      const v = clamp(raw[key] || 0.08, 0.08, 0.36);
      budget[key] = v;
      allocated += v;
    }

    for (const key of known) budget[key] = budget[key] / allocated;

    return {
      generatedAt: new Date().toISOString(),
      reason: "based_on_closed_trade_quality",
      budget,
      rows
    };
  }

  async recordClosedTrades(rows = [], meta = {}) {
    if (!this.enabled) return { ok: false, changed: false, reason: "disabled" };
    const input = Array.isArray(rows) ? rows : [];
    const added = [];

    for (const row of input) {
      const trade = this.normalizeTrade(row);
      const uniqueKey = `${trade.id}:${trade.closedAt}`;
      if (this.state.tradeIds[uniqueKey]) continue;
      trade.factors = this.buildFactorsFromTrade(trade);
      trade.learnedAt = Date.now();
      trade.meta = {
        forced: Boolean(meta?.forced),
        runtimeMode: meta?.runtimeConfig?.mode || meta?.runtimeConfig?.tradeMode || ""
      };
      this.state.tradeIds[uniqueKey] = true;
      this.state.trades.push(trade);
      added.push(trade);
    }

    if (!added.length) return { ok: true, changed: false, added: [] };

    this.state.trades = this.state.trades
      .sort((a, b) => safeNum(b.closedAt, 0) - safeNum(a.closedAt, 0))
      .slice(0, this.maxTrades);

    this.state.tradeIds = Object.fromEntries(
      this.state.trades.map((trade) => [`${trade.id}:${trade.closedAt}`, true])
    );

    const beforeKeys = new Set((this.state.activeCorrections || []).map((x) => x.key));
    this.rebuildStats();
    const after = this.state.activeCorrections || [];
    const newCorrections = after.filter((x) => !beforeKeys.has(x.key));

    const change = {
      at: Date.now(),
      addedTrades: added.length,
      newCorrections: newCorrections.slice(0, 8),
      affectedStrategies: [...new Set(added.map((x) => x.strategy))]
    };

    this.state.lastChanges = [change, ...(this.state.lastChanges || [])].slice(0, 20);
    await this.save();

    return { ok: true, changed: true, added, newCorrections, change };
  }

  correctionMatches(correction, strategy, factors) {
    if (!correction || correction.strategy !== strategy) return false;
    if (correction.scope === "strategy") return true;
    if (correction.scope === "strategy_factor") return factors.includes(correction.factor);
    if (correction.scope === "combo") {
      return (correction.factors || []).every((factor) => factors.includes(factor));
    }
    return false;
  }

  evaluatePlan({ plan = {}, candidate = {}, runtimeConfig = {} } = {}) {
    if (!this.enabled || !plan?.strategyKey) {
      return { allow: true, plan: clone(plan), action: "none", reasons: [] };
    }

    const strategy = String(plan.strategyKey || "unknown");
    const factors = this.buildFactorsFromCandidate(candidate, plan);
    const matches = (this.state.activeCorrections || []).filter((correction) =>
      this.correctionMatches(correction, strategy, factors)
    );

    if (!matches.length) {
      return { allow: true, plan: clone(plan), action: "none", factors, matches: [] };
    }

    const nextPlan = clone(plan);
    const hardCombo = matches.find((m) => m.scope === "combo" && m.severity === "hard");
    const hardFactor = matches.find((m) => m.scope === "strategy_factor" && m.severity === "hard");
    const hardStrategy = matches.find((m) => m.scope === "strategy" && m.severity === "hard");
    const soft = matches.find((m) => m.severity !== "hard") || matches[0];

    const candidateScore = safeNum(candidate?.score, 0);
    const holderControl = safeNum(candidate?.holderAccumulation?.netControlPct, 0);
    const hasRescueSignal = candidateScore >= 88 || holderControl >= 55 || candidate?.migrationAccumulation?.priorityWatch;

    if (hardCombo && !hasRescueSignal) {
      return {
        allow: false,
        plan: nextPlan,
        action: "skip",
        severity: "hard",
        factors,
        matches,
        reasons: ["Повторяющаяся минусовая комбинация факторов", hardCombo.key]
      };
    }

    if (hardFactor && !hasRescueSignal) {
      nextPlan.entryMode = "PROBE";
      nextPlan.stopLossPct = Math.min(Math.abs(safeNum(nextPlan.stopLossPct, 7)), 4.5);
      nextPlan.plannedHoldMs = safeNum(nextPlan.plannedHoldMs, 0)
        ? Math.floor(safeNum(nextPlan.plannedHoldMs, 0) * 0.75)
        : nextPlan.plannedHoldMs;
      return {
        allow: true,
        plan: nextPlan,
        action: "tighten_probe",
        severity: "hard",
        factors,
        matches,
        reasons: ["Жёсткая коррекция риска по повторяющемуся фактору", hardFactor.factor]
      };
    }

    if (hardStrategy && !hasRescueSignal) {
      nextPlan.entryMode = "PROBE";
      nextPlan.stopLossPct = Math.min(Math.abs(safeNum(nextPlan.stopLossPct, 7)), 5.5);
      return {
        allow: true,
        plan: nextPlan,
        action: "strategy_probe",
        severity: "hard",
        factors,
        matches,
        reasons: ["Стратегия в минусовой фазе по накопленной статистике", hardStrategy.strategy]
      };
    }

    if (soft) {
      if (normalizeEntryMode(nextPlan.entryMode) === "FULL") nextPlan.entryMode = "SCALED";
      else nextPlan.entryMode = "PROBE";
      if (safeNum(nextPlan.stopLossPct, 0) > 0) {
        nextPlan.stopLossPct = Math.min(Math.abs(safeNum(nextPlan.stopLossPct, 0)), 6.5);
      }
      return {
        allow: true,
        plan: nextPlan,
        action: "soft_adjust",
        severity: "soft",
        factors,
        matches,
        reasons: ["Мягкая коррекция: фактор/стратегия часто давали слабый результат", soft.key]
      };
    }

    return { allow: true, plan: nextPlan, action: "none", factors, matches };
  }

  buildAdjustmentNotice(decision = {}, candidate = {}, plan = {}, { language = "ru" } = {}) {
    const isRu = String(language || "ru").toLowerCase().startsWith("ru");
    const token = candidate?.token || {};
    const matches = Array.isArray(decision.matches) ? decision.matches.slice(0, 4) : [];
    const factorLine = (decision.factors || [])
      .filter((x) => !String(x).startsWith("exit_"))
      .slice(0, 8)
      .map((x) => factorLabel(x, language))
      .join(", ");

    if (!isRu) {
      return `🧠 <b>Strategy learning adjustment</b>

<b>Token:</b> ${escapeHtml(token.name || token.symbol || "UNKNOWN")}
<b>CA:</b> <code>${escapeHtml(token.ca || "-")}</code>
<b>Strategy:</b> ${escapeHtml(plan.strategyKey || "-")}
<b>Action:</b> ${escapeHtml(decision.action || "adjust")}

⚙️ Bot changed entry behavior from accumulated trade memory, not from one loss.
<b>Current factors:</b> ${escapeHtml(factorLine || "-")}

${matches.map((m) => `• ${escapeHtml(m.key)} | trades ${m.trades} | loss ${pct(m.lossRate * 100)} | avg ${pct(m.avgPnlPct)}`).join("\n")}`;
    }

    return `🧠 <b>Корректировка стратегии по памяти сделок</b>

<b>Токен:</b> ${escapeHtml(token.name || token.symbol || "UNKNOWN")}
<b>CA:</b> <code>${escapeHtml(token.ca || "-")}</code>
<b>Стратегия:</b> ${escapeHtml(plan.strategyKey || "-")}
<b>Действие:</b> ${escapeHtml(decision.action || "adjust")}

⚙️ Бот изменил поведение по накопленной статистике, а не из-за одной неудачи.
<b>Текущие факторы:</b> ${escapeHtml(factorLine || "-")}

${matches.map((m) => `• ${escapeHtml(m.key)} | сделок ${m.trades} | loss ${pct(m.lossRate * 100)} | средн. ${pct(m.avgPnlPct)}`).join("\n")}`;
  }

  buildUpdateReport(result = {}, { language = "ru" } = {}) {
    const isRu = String(language || "ru").toLowerCase().startsWith("ru");
    const added = Array.isArray(result.added) ? result.added : [];
    const newCorrections = Array.isArray(result.newCorrections) ? result.newCorrections : [];
    const latest = added.slice(0, 3);

    if (!isRu) {
      return `🧠 <b>Trade memory updated</b>

Closed trades learned: <b>${added.length}</b>
${latest.map((t) => `• ${escapeHtml(t.strategy)} / ${escapeHtml(t.token)}: ${pct(t.netPnlPct, 2)} | ${escapeHtml(t.reason)}`).join("\n") || "• -"}

⚙️ New active corrections: <b>${newCorrections.length}</b>
${newCorrections.slice(0, 5).map((c) => `• ${escapeHtml(c.key)} | ${escapeHtml(c.action)} | ${c.trades} trades | loss ${pct(c.lossRate * 100)}`).join("\n") || "• no new corrections; statistics updated"}`;
    }

    return `🧠 <b>Память сделок обновлена</b>

Закрытых сделок изучено: <b>${added.length}</b>
${latest.map((t) => `• ${escapeHtml(t.strategy)} / ${escapeHtml(t.token)}: <b>${pct(t.netPnlPct, 2)}</b> | ${escapeHtml(t.reason)}`).join("\n") || "• -"}

⚙️ Новых активных корректировок: <b>${newCorrections.length}</b>
${newCorrections.slice(0, 5).map((c) => `• ${escapeHtml(c.key)} | ${escapeHtml(c.action)} | сделок ${c.trades} | loss ${pct(c.lossRate * 100)}`).join("\n") || "• новых корректировок нет; статистика обновлена"}`;
  }

  buildReport({ language = "ru", verbose = true } = {}) {
    const isRu = String(language || "ru").toLowerCase().startsWith("ru");
    const trades = this.state.trades || [];
    const byStrategy = Object.values(this.state.stats.byStrategy || {}).map(finalizeStats);
    const worstFactors = Object.values(this.state.stats.byStrategyFactor || {})
      .map(finalizeStats)
      .filter((s) => s.trades >= this.minFactorTrades)
      .sort(sortWorst)
      .slice(0, 8);
    const bestStrategies = [...byStrategy]
      .filter((s) => s.trades >= Math.max(2, this.minStrategyTrades - 2))
      .sort(sortBest)
      .slice(0, 5);
    const corrections = this.state.activeCorrections || [];
    const budget = this.state.recommendedBudget?.budget || null;
    const last = trades.slice(0, 5);

    if (!isRu) {
      const lines = [
        `🧠 <b>Strategy Learning / Self-Analysis V17</b>`,
        `Closed trades in memory: <b>${trades.length}</b>`,
        `Updated: ${escapeHtml(this.state.updatedAt || "-")}`,
        ``,
        `📊 <b>Strategies</b>`
      ];
      for (const s of byStrategy.sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
        lines.push(`• <b>${escapeHtml(s.key)}</b>: trades ${s.trades} | win ${pct(s.winRate * 100)} | avg ${pct(s.avgPnlPct, 2)} | PnL ${sol(s.pnlSol)}`);
      }
      if (!byStrategy.length) lines.push(`• not enough closed trades yet`);

      lines.push(``, `⚙️ <b>Active corrections</b>`);
      if (corrections.length) {
        for (const c of corrections.slice(0, 10)) {
          lines.push(`• ${c.severity === "hard" ? "🚫" : "🟡"} <b>${escapeHtml(c.key)}</b> → ${escapeHtml(c.action)} | trades ${c.trades} | loss ${pct(c.lossRate * 100)} | avg ${pct(c.avgPnlPct, 2)}`);
        }
      } else {
        lines.push(`• none yet — sample is still forming`);
      }

      lines.push(``, `✅ <b>Currently better patterns</b>`);
      if (bestStrategies.length) {
        for (const s of bestStrategies) lines.push(`• ${escapeHtml(s.key)} — win ${pct(s.winRate * 100)} | avg ${pct(s.avgPnlPct, 2)} | ${s.trades} trades`);
      } else lines.push(`• not enough data`);

      lines.push(``, `🔻 <b>Repeated weak spots</b>`);
      if (worstFactors.length) {
        for (const f of worstFactors) lines.push(`• ${escapeHtml(f.key)} — loss ${pct(f.lossRate * 100)} | avg ${pct(f.avgPnlPct, 2)} | ${f.trades} trades`);
      } else lines.push(`• not enough repeated factors`);

      if (budget) {
        lines.push(``, `🧮 <b>Suggested budget shift</b>`);
        lines.push(`<code>budget ${(budget.scalp * 100).toFixed(0)} ${(budget.reversal * 100).toFixed(0)} ${(budget.runner * 100).toFixed(0)} ${(budget.copytrade * 100).toFixed(0)} ${(budget.migration_survivor * 100).toFixed(0)}</code>`);
        lines.push(`Apply manually only when you want; open positions are not changed automatically.`);
      }

      lines.push(``, `📝 <b>Latest learned trades</b>`);
      if (last.length) for (const t of last) lines.push(`• ${escapeHtml(t.strategy)} / ${escapeHtml(t.token)}: ${pct(t.netPnlPct, 2)} | ${escapeHtml(t.reason)} | ${shortCa(t.ca)}`);
      else lines.push(`• none`);

      return lines.join("\n");
    }

    const lines = [
      `🧠 <b>Обучение стратегий / самоанализ V17</b>`,
      `Сделок в памяти: <b>${trades.length}</b>`,
      `Обновлено: ${escapeHtml(this.state.updatedAt || "-")}`,
      ``,
      `📊 <b>Динамика по стратегиям</b>`
    ];

    for (const s of byStrategy.sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
      const icon = s.trades < this.minStrategyTrades ? "⚪" : s.avgPnlPct > 0 ? "✅" : s.lossRate >= this.warnLossRate ? "⚠️" : "🟡";
      lines.push(`${icon} <b>${escapeHtml(s.key)}</b>: сделок ${s.trades} | win ${pct(s.winRate * 100)} | средн. ${pct(s.avgPnlPct, 2)} | PnL ${sol(s.pnlSol)}`);
    }
    if (!byStrategy.length) lines.push(`⚪ Закрытых сделок пока нет — обучение начнётся после первых выходов.`);

    lines.push(``, `⚙️ <b>Активные корректировки поведения</b>`);
    if (corrections.length) {
      for (const c of corrections.slice(0, 10)) {
        const factorText = c.factor ? ` / ${factorLabel(c.factor, language)}` : Array.isArray(c.factors) ? ` / ${c.factors.map((x) => factorLabel(x, language)).join(" + ")}` : "";
        lines.push(`${c.severity === "hard" ? "🚫" : "🟡"} <b>${escapeHtml(c.strategy || c.key)}</b>${escapeHtml(factorText)} → <b>${escapeHtml(c.action)}</b> | сделок ${c.trades} | loss ${pct(c.lossRate * 100)} | средн. ${pct(c.avgPnlPct, 2)}`);
      }
    } else {
      lines.push(`✅ Активных ограничений пока нет — выборка ещё набирается или паттерны не повторяются.`);
    }

    lines.push(``, `✅ <b>Что сейчас работает лучше</b>`);
    if (bestStrategies.length) {
      for (const s of bestStrategies) lines.push(`• <b>${escapeHtml(s.key)}</b> — win ${pct(s.winRate * 100)} | средн. ${pct(s.avgPnlPct, 2)} | ${s.trades} сделок`);
    } else lines.push(`• пока недостаточно данных`);

    lines.push(``, `🔻 <b>Повторяющиеся слабые места</b>`);
    if (worstFactors.length) {
      for (const f of worstFactors) {
        const [strategy, factor] = String(f.key || "").split("::");
        lines.push(`• <b>${escapeHtml(strategy)}</b> + ${escapeHtml(factorLabel(factor, language))} — loss ${pct(f.lossRate * 100)} | средн. ${pct(f.avgPnlPct, 2)} | ${f.trades} сделок`);
      }
    } else lines.push(`• повторяющихся минусовых факторов пока недостаточно`);

    if (budget) {
      lines.push(``, `🧮 <b>Рекомендованный сдвиг бюджета</b>`);
      lines.push(`<code>budget ${(budget.scalp * 100).toFixed(0)} ${(budget.reversal * 100).toFixed(0)} ${(budget.runner * 100).toFixed(0)} ${(budget.copytrade * 100).toFixed(0)} ${(budget.migration_survivor * 100).toFixed(0)}</code>`);
      lines.push(`⚠️ Это рекомендация. Бот не меняет бюджет сам, чтобы не ломать открытые позиции.`);
    }

    lines.push(``, `📝 <b>Последние изученные сделки</b>`);
    if (last.length) {
      for (const t of last) {
        const sign = safeNum(t.netPnlPct, 0) > 0 ? "✅" : "❌";
        lines.push(`${sign} ${escapeHtml(t.strategy)} / ${escapeHtml(t.token)}: <b>${pct(t.netPnlPct, 2)}</b> | ${escapeHtml(t.reason)} | <code>${escapeHtml(shortCa(t.ca))}</code>`);
      }
    } else lines.push(`• пока нет`);

    lines.push(``, `🛡️ <b>Правило безопасности</b>`);
    lines.push(`Бот не меняет стратегию после одной неудачи. Коррекция включается только когда повторяется динамика: стратегия + фактор + результат.`);

    return lines.join("\n");
  }
}
