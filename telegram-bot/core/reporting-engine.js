function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function reportLang(options = {}) {
  const raw = typeof options === "string" ? options : (options?.language || options?.lang || "en");
  const lang = String(raw || "en").toLowerCase().trim();
  return lang.startsWith("ru") ? "ru" : "en";
}

function isRu(options = {}) {
  return reportLang(options) === "ru";
}

function yesNo(value, options = {}) {
  return isRu(options) ? (value ? "да" : "нет") : (value ? "yes" : "no");
}

function fmtPct(v, digits = 2) {
  const n = safeNum(v);
  return `${round(n, digits)}%`;
}

function fmtSol(v, digits = 4) {
  return `${round(v, digits)} SOL`;
}

function fmtAgeMs(ms, options = {}) {
  const ru = isRu(options);
  const totalSec = Math.max(0, Math.round(safeNum(ms, 0) / 1000));
  if (totalSec < 60) return ru ? `${totalSec}с` : `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return ru ? `${mins}м` : `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return ru ? `${h}ч ${m}м` : `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return ru ? `${d}д ${hh}ч` : `${d}d ${hh}h`;
}

function strategyName(key, options = {}) {
  const raw = String(key || "-");
  if (!isRu(options)) return raw.toUpperCase();
  const map = {
    scalp: "SCALP / быстрый вход",
    reversal: "REVERSAL / разворот",
    runner: "RUNNER / тренд",
    copytrade: "COPYTRADE",
    migration_survivor: "MIGRATION / survivor"
  };
  return map[raw] || raw.toUpperCase();
}

function buildStrategyLine(key, row, options = {}) {
  if (!isRu(options)) {
    return `• <b>${escapeHtml(String(key).toUpperCase())}</b> | alloc ${fmtPct(
      safeNum(row?.allocationPct) * 100,
      0
    )} | avail ${fmtSol(row?.availableSol)} | open ${safeNum(
      row?.openPositions,
      0
    )} | realized ${fmtSol(row?.realizedPnlSol)} | avg ${fmtPct(
      row?.realizedPnlPctAvg,
      2
    )}`;
  }

  const pnl = safeNum(row?.realizedPnlSol, 0);
  const pnlEmoji = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
  return `• ${pnlEmoji} <b>${escapeHtml(strategyName(key, options))}</b> | доля ${fmtPct(
    safeNum(row?.allocationPct) * 100,
    0
  )} | доступно ${fmtSol(row?.availableSol)} | открыто ${safeNum(
    row?.openPositions,
    0
  )} | реализованный PnL ${fmtSol(row?.realizedPnlSol)} | средний PnL ${fmtPct(
    row?.realizedPnlPctAvg,
    2
  )}`;
}

function summarizeOpenPositions(portfolio, options = {}) {
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  if (!positions.length) return isRu(options) ? "Открытых позиций нет" : "No open positions";

  return positions
    .slice(0, 8)
    .map((p, idx) => {
      const mark = p?.lastMark || {};
      const pnl = safeNum(mark?.netPnlPct, 0);
      const pnlEmoji = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
      if (!isRu(options)) {
        return `${idx + 1}. <b>${escapeHtml(p?.token || "Unknown")}</b> | ${escapeHtml(
          String(p?.strategy || "").toUpperCase()
        )} | ${escapeHtml(p?.entryMode || "SCALED")} | ${fmtPct(
          mark?.netPnlPct,
          2
        )} | age ${fmtAgeMs(mark?.ageMs || Date.now() - safeNum(p?.openedAt), options)}`;
      }
      return `${idx + 1}. ${pnlEmoji} <b>${escapeHtml(p?.token || "Unknown")}</b> | ${escapeHtml(strategyName(p?.strategy, options))} | ${escapeHtml(p?.entryMode || "SCALED")} | PnL <b>${fmtPct(
        mark?.netPnlPct,
        2
      )}</b> | возраст ${fmtAgeMs(mark?.ageMs || Date.now() - safeNum(p?.openedAt), options)}`;
    })
    .join("\n");
}

function buildHolderPanel(holderSummary = null, options = {}) {
  if (!holderSummary) {
    return isRu(options) ? `<b>🧺 Тихое накопление</b>\nнет данных` : `<b>Quiet accumulation</b>\nnone`;
  }

  if (!isRu(options)) {
    return `<b>Quiet accumulation</b>\n` +
      `token: ${escapeHtml(holderSummary?.tokenName || holderSummary?.mint || "-")}\n` +
      `fresh cohort: ${safeNum(holderSummary?.freshWalletBuyCount, 0)}\n` +
      `retention 30m / 2h: ${fmtPct(holderSummary?.retention30mPct)} / ${fmtPct(holderSummary?.retention2hPct)}\n` +
      `net accumulation: ${fmtPct(holderSummary?.netAccumulationPct)}\n` +
      `net control: ${fmtPct(holderSummary?.netControlPct)}\n` +
      `reload count: ${safeNum(holderSummary?.reloadCount, 0)}\n` +
      `dip-buy ratio: ${round(holderSummary?.dipBuyRatio, 2)}\n` +
      `bottom touches: ${safeNum(holderSummary?.bottomTouches, 0)}\n` +
      `quiet pass: ${yesNo(holderSummary?.quietAccumulationPass, options)}\n` +
      `bottom-pack reversal: ${yesNo(holderSummary?.bottomPackReversalPass, options)}\n` +
      `phase age h: ${round(holderSummary?.accumulationPhaseAgeHours, 2)} | basis: ${escapeHtml(holderSummary?.historicalRetentionBasis || "live_only")}`;
  }

  return `<b>🧺 Тихое накопление</b>\n` +
    `Токен: ${escapeHtml(holderSummary?.tokenName || holderSummary?.mint || "-")}\n` +
    `Новая когорта: ${safeNum(holderSummary?.freshWalletBuyCount, 0)}\n` +
    `Удержание 30м / 2ч: <b>${fmtPct(holderSummary?.retention30mPct)}</b> / <b>${fmtPct(holderSummary?.retention2hPct)}</b>\n` +
    `Чистое накопление: <b>${fmtPct(holderSummary?.netAccumulationPct)}</b>\n` +
    `Контроль когорты: <b>${fmtPct(holderSummary?.netControlPct)}</b>\n` +
    `Reload count: ${safeNum(holderSummary?.reloadCount, 0)}\n` +
    `Dip-buy ratio: ${round(holderSummary?.dipBuyRatio, 2)}\n` +
    `Касания дна: ${safeNum(holderSummary?.bottomTouches, 0)}\n` +
    `Тихое накопление подтверждено: ${yesNo(holderSummary?.quietAccumulationPass, options)}\n` +
    `Bottom-pack reversal: ${yesNo(holderSummary?.bottomPackReversalPass, options)}\n` +
    `Возраст фазы: ${round(holderSummary?.accumulationPhaseAgeHours, 2)}ч | база: ${escapeHtml(holderSummary?.historicalRetentionBasis || "live_only")}`;
}

export function buildBalanceText(portfolio = {}, holderSummary = null, options = {}) {
  const byStrategy = portfolio?.byStrategy || {};
  const strategyLines = Object.keys(byStrategy).length
    ? Object.entries(byStrategy).map(([key, row]) => buildStrategyLine(key, row, options)).join("\n")
    : isRu(options) ? "Стратегий пока нет" : "No strategies";

  if (!isRu(options)) {
    return `💰 <b>BALANCE</b>\n\n<b>Free cash:</b> ${fmtSol(portfolio?.cash)}\n<b>Total equity:</b> ${fmtSol(portfolio?.equity)}\n<b>Realized PnL:</b> ${fmtSol(portfolio?.realizedPnlSol)}\n<b>Unrealized PnL:</b> ${fmtSol(portfolio?.unrealizedPnlSol)}\n<b>Open positions:</b> ${safeNum(portfolio?.positions?.length, 0)}\n<b>Closed trades:</b> ${safeNum(portfolio?.closedTrades?.length, 0)}\n\n<b>By strategy</b>\n${strategyLines}\n\n<b>Open positions</b>\n${summarizeOpenPositions(portfolio, options)}\n\n${buildHolderPanel(holderSummary, options)}`;
  }

  return `💰 <b>БАЛАНС</b>\n\n<b>Свободный баланс:</b> <b>${fmtSol(portfolio?.cash)}</b>\n<b>Общая equity:</b> <b>${fmtSol(portfolio?.equity)}</b>\n<b>Реализованный PnL:</b> ${fmtSol(portfolio?.realizedPnlSol)}\n<b>Нереализованный PnL:</b> ${fmtSol(portfolio?.unrealizedPnlSol)}\n<b>Открытых позиций:</b> ${safeNum(portfolio?.positions?.length, 0)}\n<b>Закрытых сделок:</b> ${safeNum(portfolio?.closedTrades?.length, 0)}\n\n<b>📊 По стратегиям</b>\n${strategyLines}\n\n<b>📍 Открытые позиции</b>\n${summarizeOpenPositions(portfolio, options)}\n\n${buildHolderPanel(holderSummary, options)}`;
}

export function buildDashboard(runtime = {}, portfolio = {}, holderSummary = null) {
  const options = { language: runtime?.activeConfig?.language || "en" };
  const byStrategy = portfolio?.byStrategy || {};
  const strategyLines = Object.keys(byStrategy).length
    ? Object.entries(byStrategy).map(([key, row]) => buildStrategyLine(key, row, options)).join("\n")
    : isRu(options) ? "Стратегий пока нет" : "No strategies";

  const mode = String(runtime?.mode || "stopped").toUpperCase();
  const lang = runtime?.activeConfig?.language || "ru";
  const dryRun = runtime?.activeConfig?.dryRun !== false;
  const startedAt = runtime?.startedAt ? new Date(runtime.startedAt).toISOString() : "-";
  const pending = runtime?.pendingConfig ? yesNo(true, options) : yesNo(false, options);

  if (!isRu(options)) {
    return `📊 <b>STATUS</b>\n\n<b>Mode:</b> ${escapeHtml(mode)}\n<b>Language:</b> ${escapeHtml(String(lang).toUpperCase())}\n<b>Dry run:</b> ${dryRun ? "yes" : "no"}\n<b>Run ID:</b> ${escapeHtml(runtime?.runId || "-")}\n<b>Started:</b> ${escapeHtml(startedAt)}\n<b>Stop requested:</b> ${runtime?.stopRequested ? "yes" : "no"}\n<b>Pending config:</b> ${pending}\n\n<b>Free cash:</b> ${fmtSol(portfolio?.cash)}\n<b>Total equity:</b> ${fmtSol(portfolio?.equity)}\n<b>Realized PnL:</b> ${fmtSol(portfolio?.realizedPnlSol)}\n<b>Unrealized PnL:</b> ${fmtSol(portfolio?.unrealizedPnlSol)}\n\n<b>Strategy buckets</b>\n${strategyLines}\n\n<b>Open positions</b>\n${summarizeOpenPositions(portfolio, options)}\n\n${buildHolderPanel(holderSummary, options)}`;
  }

  return `📊 <b>СТАТУС</b>\n\n<b>Режим:</b> ${escapeHtml(mode)}\n<b>Язык:</b> ${escapeHtml(String(lang).toUpperCase())}\n<b>Dry run:</b> ${dryRun ? "да" : "нет"}\n<b>Run ID:</b> ${escapeHtml(runtime?.runId || "-")}\n<b>Старт:</b> ${escapeHtml(startedAt)}\n<b>Запрошена остановка:</b> ${runtime?.stopRequested ? "да" : "нет"}\n<b>Отложенная конфигурация:</b> ${pending}\n\n<b>Свободный баланс:</b> <b>${fmtSol(portfolio?.cash)}</b>\n<b>Общая equity:</b> <b>${fmtSol(portfolio?.equity)}</b>\n<b>Реализованный PnL:</b> ${fmtSol(portfolio?.realizedPnlSol)}\n<b>Нереализованный PnL:</b> ${fmtSol(portfolio?.unrealizedPnlSol)}\n\n<b>📊 Бюджеты стратегий</b>\n${strategyLines}\n\n<b>📍 Открытые позиции</b>\n${summarizeOpenPositions(portfolio, options)}\n\n${buildHolderPanel(holderSummary, options)}`;
}

export function buildPeriodicReport(runtime = {}, portfolio = {}, previousEquity = null, holderSummary = null) {
  const options = { language: runtime?.activeConfig?.language || "en" };
  const equity = safeNum(portfolio?.equity);
  const deltaSol = previousEquity == null ? 0 : equity - safeNum(previousEquity);
  const deltaPct = previousEquity > 0 ? (deltaSol / previousEquity) * 100 : 0;

  const byStrategy = portfolio?.byStrategy || {};
  const strategyLines = Object.keys(byStrategy).length
    ? Object.entries(byStrategy)
        .map(([key, row]) => isRu(options)
          ? `• <b>${escapeHtml(strategyName(key, options))}</b>: реализованный PnL ${fmtSol(row?.realizedPnlSol)}, открыто ${safeNum(row?.openPositions, 0)}, доступно ${fmtSol(row?.availableSol)}`
          : `• ${escapeHtml(String(key).toUpperCase())}: realized ${fmtSol(row?.realizedPnlSol)}, open ${safeNum(row?.openPositions, 0)}, avail ${fmtSol(row?.availableSol)}`
        )
        .join("\n")
    : isRu(options) ? "Нет данных по стратегиям" : "No strategy data";

  const openPositions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const longest = openPositions.length
    ? openPositions
        .map((p) => ({
          token: p?.token || "Unknown",
          strategy: p?.strategy || "-",
          ageMs: p?.lastMark?.ageMs || (Date.now() - safeNum(p?.openedAt))
        }))
        .sort((a, b) => safeNum(b.ageMs) - safeNum(a.ageMs))[0]
    : null;

  const closed = Array.isArray(portfolio?.closedTrades) ? portfolio.closedTrades : [];
  let best = isRu(options) ? "нет" : "none";
  let worst = isRu(options) ? "нет" : "none";
  if (closed.length) {
    const sorted = [...closed].sort((a, b) => safeNum(b?.netPnlPct) - safeNum(a?.netPnlPct));
    best = `${sorted[0]?.token || "Unknown"} ${fmtPct(sorted[0]?.netPnlPct)} (${sorted[0]?.strategy || "-"})`;
    worst = `${sorted[sorted.length - 1]?.token || "Unknown"} ${fmtPct(sorted[sorted.length - 1]?.netPnlPct)} (${sorted[sorted.length - 1]?.strategy || "-"})`;
  }

  if (!isRu(options)) {
    return `🧠 <b>PERIODIC REPORT</b>\n\n<b>Mode:</b> ${escapeHtml(String(runtime?.mode || "stopped").toUpperCase())}\n<b>Equity:</b> ${fmtSol(equity)}\n<b>Period Δ:</b> ${fmtSol(deltaSol)} (${fmtPct(deltaPct)})\n<b>Free cash:</b> ${fmtSol(portfolio?.cash)}\n<b>Realized:</b> ${fmtSol(portfolio?.realizedPnlSol)}\n<b>Unrealized:</b> ${fmtSol(portfolio?.unrealizedPnlSol)}\n<b>Open positions:</b> ${safeNum(openPositions.length, 0)}\n\n<b>By strategy</b>\n${strategyLines}\n\n<b>Best closed:</b> ${escapeHtml(best)}\n<b>Worst closed:</b> ${escapeHtml(worst)}\n<b>Longest open:</b> ${longest ? `${escapeHtml(longest.token)} | ${escapeHtml(String(longest.strategy).toUpperCase())} | ${fmtAgeMs(longest.ageMs, options)}` : "none"}\n\n${buildHolderPanel(holderSummary, options)}`;
  }

  const deltaEmoji = deltaSol > 0 ? "🟢" : deltaSol < 0 ? "🔴" : "⚪";
  return `🧠 <b>ПЕРИОДИЧЕСКИЙ ОТЧЁТ</b>\n\n<b>Режим:</b> ${escapeHtml(String(runtime?.mode || "stopped").toUpperCase())}\n<b>Equity:</b> <b>${fmtSol(equity)}</b>\n<b>Изменение за период:</b> ${deltaEmoji} <b>${fmtSol(deltaSol)}</b> (${fmtPct(deltaPct)})\n<b>Свободный баланс:</b> ${fmtSol(portfolio?.cash)}\n<b>Реализованный PnL:</b> ${fmtSol(portfolio?.realizedPnlSol)}\n<b>Нереализованный PnL:</b> ${fmtSol(portfolio?.unrealizedPnlSol)}\n<b>Открытых позиций:</b> ${safeNum(openPositions.length, 0)}\n\n<b>📊 По стратегиям</b>\n${strategyLines}\n\n<b>Лучшая закрытая сделка:</b> ${escapeHtml(best)}\n<b>Худшая закрытая сделка:</b> ${escapeHtml(worst)}\n<b>Самая долгая открытая:</b> ${longest ? `${escapeHtml(longest.token)} | ${escapeHtml(strategyName(longest.strategy, options))} | ${fmtAgeMs(longest.ageMs, options)}` : "нет"}\n\n${buildHolderPanel(holderSummary, options)}`;
}

export function buildEntryText(position = {}, options = {}) {
  const links = position?.signalContext?.socials?.links || {};
  const website = links.website ? `\n<b>${isRu(options) ? "Сайт" : "Website"}:</b> ${escapeHtml(links.website)}` : "";
  const twitter = links.twitter ? `\n<b>Twitter/X:</b> ${escapeHtml(links.twitter)}` : "";
  const telegram = links.telegram ? `\n<b>Telegram:</b> ${escapeHtml(links.telegram)}` : "";

  if (!isRu(options)) {
    return `🚀 <b>ENTRY</b>\n\n<b>Strategy:</b> ${escapeHtml(String(position?.strategy || "").toUpperCase())}\n<b>Entry mode:</b> ${escapeHtml(position?.entryMode || "SCALED")}\n<b>Wallet:</b> ${escapeHtml(position?.walletId || "default")}\n<b>Plan:</b> ${escapeHtml(position?.planName || "-")}\n<b>Objective:</b> ${escapeHtml(position?.planObjective || "-")}\n\n<b>Token:</b> ${escapeHtml(position?.token || "Unknown")}\n<b>CA:</b> <code>${escapeHtml(position?.ca || "")}</code>\n<b>Entry ref:</b> ${safeNum(position?.entryReferencePrice)}\n<b>Entry effective:</b> ${safeNum(position?.entryEffectivePrice)}\n<b>Size:</b> ${fmtSol(position?.amountSol)}\n<b>Expected edge:</b> ${fmtPct(position?.expectedEdgePct)}\n\n<b>Stop:</b> ${fmtPct(-Math.abs(safeNum(position?.stopLossPct)))}\n<b>TP:</b> ${safeNum(position?.takeProfitPct) > 0 ? fmtPct(position?.takeProfitPct) : Array.isArray(position?.runnerTargetsPct) && position.runnerTargetsPct.length ? `runner ${position.runnerTargetsPct.join(" / ")}%` : "runner"}\n\n<b>Thesis:</b>\n${escapeHtml(position?.thesis || "-")}\n\n<b>Entry costs:</b> ${fmtSol(position?.entryCosts?.totalSol, 6)}${website}${twitter}${telegram}`;
  }

  return `🚀 <b>ВХОД В СДЕЛКУ</b>\n\n<b>Стратегия:</b> ${escapeHtml(strategyName(position?.strategy, options))}\n<b>Режим входа:</b> ${escapeHtml(position?.entryMode || "SCALED")}\n<b>Кошелёк:</b> ${escapeHtml(position?.walletId || "default")}\n<b>План:</b> ${escapeHtml(position?.planName || "-")}\n<b>Цель:</b> ${escapeHtml(position?.planObjective || "-")}\n\n<b>Токен:</b> ${escapeHtml(position?.token || "Unknown")}\n<b>CA:</b> <code>${escapeHtml(position?.ca || "")}</code>\n<b>Цена входа ref:</b> ${safeNum(position?.entryReferencePrice)}\n<b>Цена входа effective:</b> ${safeNum(position?.entryEffectivePrice)}\n<b>Размер:</b> <b>${fmtSol(position?.amountSol)}</b>\n<b>Ожидаемый edge:</b> ${fmtPct(position?.expectedEdgePct)}\n\n<b>SL:</b> ${fmtPct(-Math.abs(safeNum(position?.stopLossPct)))}\n<b>TP:</b> ${safeNum(position?.takeProfitPct) > 0 ? fmtPct(position?.takeProfitPct) : Array.isArray(position?.runnerTargetsPct) && position.runnerTargetsPct.length ? `runner ${position.runnerTargetsPct.join(" / ")}%` : "runner"}\n\n<b>Тезис:</b>\n${escapeHtml(position?.thesis || "-")}\n\n<b>Комиссии входа:</b> ${fmtSol(position?.entryCosts?.totalSol, 6)}${website}${twitter}${telegram}`;
}

export function buildPositionUpdateText(position = {}, mark = {}, status = "HOLD", options = {}) {
  if (!isRu(options)) {
    return `📈 <b>POSITION UPDATE</b>\n\n<b>Strategy:</b> ${escapeHtml(String(position?.strategy || "").toUpperCase())}\n<b>Entry mode:</b> ${escapeHtml(position?.entryMode || "SCALED")}\n<b>Wallet:</b> ${escapeHtml(position?.walletId || "default")}\n<b>Token:</b> ${escapeHtml(position?.token || "Unknown")}\n<b>CA:</b> <code>${escapeHtml(position?.ca || "")}</code>\n\n<b>Entry ref:</b> ${safeNum(position?.entryReferencePrice)}\n<b>Current:</b> ${safeNum(mark?.currentPrice)}\n<b>Gross PnL:</b> ${fmtPct(mark?.grossPnlPct)}\n<b>Net PnL:</b> ${fmtPct(mark?.netPnlPct)}\n<b>Net PnL SOL:</b> ${fmtSol(mark?.netPnlSol)}\n<b>Age:</b> ${fmtAgeMs(mark?.ageMs, options)}\n<b>Status:</b> ${escapeHtml(status)}`;
  }

  const pnl = safeNum(mark?.netPnlPct, 0);
  const pnlEmoji = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
  return `📈 <b>ОБНОВЛЕНИЕ ПОЗИЦИИ</b>\n\n<b>Стратегия:</b> ${escapeHtml(strategyName(position?.strategy, options))}\n<b>Режим входа:</b> ${escapeHtml(position?.entryMode || "SCALED")}\n<b>Кошелёк:</b> ${escapeHtml(position?.walletId || "default")}\n<b>Токен:</b> ${escapeHtml(position?.token || "Unknown")}\n<b>CA:</b> <code>${escapeHtml(position?.ca || "")}</code>\n\n<b>Цена входа ref:</b> ${safeNum(position?.entryReferencePrice)}\n<b>Текущая цена:</b> ${safeNum(mark?.currentPrice)}\n<b>Gross PnL:</b> ${fmtPct(mark?.grossPnlPct)}\n<b>Net PnL:</b> ${pnlEmoji} <b>${fmtPct(mark?.netPnlPct)}</b>\n<b>Net PnL SOL:</b> ${fmtSol(mark?.netPnlSol)}\n<b>Возраст:</b> ${fmtAgeMs(mark?.ageMs, options)}\n<b>Статус:</b> ${escapeHtml(status)}`;
}

export function buildExitText(trade = {}, options = {}) {
  if (!isRu(options)) {
    return `🏁 <b>EXIT</b>\n\n<b>Strategy:</b> ${escapeHtml(String(trade?.strategy || "").toUpperCase())}\n<b>Entry mode:</b> ${escapeHtml(trade?.entryMode || "SCALED")}\n<b>Wallet:</b> ${escapeHtml(trade?.walletId || "default")}\n<b>Plan:</b> ${escapeHtml(trade?.planName || "-")}\n\n<b>Token:</b> ${escapeHtml(trade?.token || "Unknown")}\n<b>CA:</b> <code>${escapeHtml(trade?.ca || "")}</code>\n\n<b>Entry ref:</b> ${safeNum(trade?.entryReferencePrice)}\n<b>Entry effective:</b> ${safeNum(trade?.entryEffectivePrice)}\n<b>Exit ref:</b> ${safeNum(trade?.exitReferencePrice)}\n\n<b>Net PnL:</b> ${fmtPct(trade?.netPnlPct)}\n<b>Net PnL SOL:</b> ${fmtSol(trade?.netPnlSol, 6)}\n<b>Duration:</b> ${fmtAgeMs(trade?.durationMs, options)}\n<b>Reason:</b> ${escapeHtml(trade?.reason || "-")}\n<b>Balance after:</b> ${fmtSol(trade?.balanceAfter)}`;
  }

  const pnl = safeNum(trade?.netPnlPct, 0);
  const pnlEmoji = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
  return `🏁 <b>ВЫХОД ИЗ СДЕЛКИ</b>\n\n<b>Стратегия:</b> ${escapeHtml(strategyName(trade?.strategy, options))}\n<b>Режим входа:</b> ${escapeHtml(trade?.entryMode || "SCALED")}\n<b>Кошелёк:</b> ${escapeHtml(trade?.walletId || "default")}\n<b>План:</b> ${escapeHtml(trade?.planName || "-")}\n\n<b>Токен:</b> ${escapeHtml(trade?.token || "Unknown")}\n<b>CA:</b> <code>${escapeHtml(trade?.ca || "")}</code>\n\n<b>Цена входа ref:</b> ${safeNum(trade?.entryReferencePrice)}\n<b>Цена входа effective:</b> ${safeNum(trade?.entryEffectivePrice)}\n<b>Цена выхода ref:</b> ${safeNum(trade?.exitReferencePrice)}\n\n<b>Net PnL:</b> ${pnlEmoji} <b>${fmtPct(trade?.netPnlPct)}</b>\n<b>Net PnL SOL:</b> ${fmtSol(trade?.netPnlSol, 6)}\n<b>Длительность:</b> ${fmtAgeMs(trade?.durationMs, options)}\n<b>Причина:</b> ${escapeHtml(trade?.reason || "-")}\n<b>Баланс после:</b> ${fmtSol(trade?.balanceAfter)}`;
}
