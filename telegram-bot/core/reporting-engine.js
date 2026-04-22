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

function fmtPct(v, digits = 2) {
  const n = safeNum(v);
  return `${round(n, digits)}%`;
}

function fmtSol(v, digits = 4) {
  return `${round(v, digits)} SOL`;
}

function fmtAgeMs(ms) {
  const totalSec = Math.max(0, Math.round(safeNum(ms, 0) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return `${d}d ${hh}h`;
}

function buildStrategyLine(key, row) {
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

function summarizeOpenPositions(portfolio) {
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  if (!positions.length) return "No open positions";

  return positions
    .slice(0, 8)
    .map((p, idx) => {
      const mark = p?.lastMark || {};
      return `${idx + 1}. <b>${escapeHtml(p?.token || "Unknown")}</b> | ${escapeHtml(
        String(p?.strategy || "").toUpperCase()
      )} | ${escapeHtml(p?.entryMode || "SCALED")} | ${fmtPct(
        mark?.netPnlPct,
        2
      )} | age ${fmtAgeMs(mark?.ageMs || Date.now() - safeNum(p?.openedAt))}`;
    })
    .join("\n");
}

function buildHolderPanel(holderSummary = null) {
  if (!holderSummary) {
    return `<b>Quiet accumulation</b>\nnone`;
  }

  return `<b>Quiet accumulation</b>\n` +
    `token: ${escapeHtml(holderSummary?.tokenName || holderSummary?.mint || "-")}\n` +
    `fresh cohort: ${safeNum(holderSummary?.freshWalletBuyCount, 0)}\n` +
    `retention 30m / 2h: ${fmtPct(holderSummary?.retention30mPct)} / ${fmtPct(holderSummary?.retention2hPct)}\n` +
    `net accumulation: ${fmtPct(holderSummary?.netAccumulationPct)}\n` +
    `net control: ${fmtPct(holderSummary?.netControlPct)}\n` +
    `reload count: ${safeNum(holderSummary?.reloadCount, 0)}\n` +
    `dip-buy ratio: ${round(holderSummary?.dipBuyRatio, 2)}\n` +
    `bottom touches: ${safeNum(holderSummary?.bottomTouches, 0)}\n` +
    `quiet pass: ${holderSummary?.quietAccumulationPass ? "yes" : "no"}\n` +
    `bottom-pack reversal: ${holderSummary?.bottomPackReversalPass ? "yes" : "no"}`;
}

export function buildBalanceText(portfolio = {}, holderSummary = null) {
  const byStrategy = portfolio?.byStrategy || {};
  const strategyLines = Object.keys(byStrategy).length
    ? Object.entries(byStrategy).map(([key, row]) => buildStrategyLine(key, row)).join("\n")
    : "No strategies";

  return `💰 <b>BALANCE</b>

<b>Virtual base:</b> ${fmtSol(portfolio?.virtualBase ?? portfolio?.startBalance)}
<b>Virtual base:</b> ${fmtSol(portfolio?.virtualBase ?? portfolio?.startBalance)}
<b>Free cash:</b> ${fmtSol(portfolio?.cash)}
<b>Total equity:</b> ${fmtSol(portfolio?.equity)}
<b>Realized PnL:</b> ${fmtSol(portfolio?.realizedPnlSol)}
<b>Unrealized PnL:</b> ${fmtSol(portfolio?.unrealizedPnlSol)}
<b>Open positions:</b> ${safeNum(portfolio?.positions?.length, 0)}
<b>Closed trades:</b> ${safeNum(portfolio?.closedTrades?.length, 0)}

<b>By strategy</b>
${strategyLines}

<b>Open positions</b>
${summarizeOpenPositions(portfolio)}

${buildHolderPanel(holderSummary)}`;
}

export function buildDashboard(runtime = {}, portfolio = {}, holderSummary = null) {
  const byStrategy = portfolio?.byStrategy || {};
  const strategyLines = Object.keys(byStrategy).length
    ? Object.entries(byStrategy).map(([key, row]) => buildStrategyLine(key, row)).join("\n")
    : "No strategies";

  const mode = String(runtime?.mode || "stopped").toUpperCase();
  const lang = runtime?.activeConfig?.language || "ru";
  const dryRun = runtime?.activeConfig?.dryRun !== false;
  const startedAt = runtime?.startedAt ? new Date(runtime.startedAt).toISOString() : "-";
  const pending = runtime?.pendingConfig ? "yes" : "no";

  return `📊 <b>STATUS</b>

<b>Mode:</b> ${escapeHtml(mode)}
<b>Language:</b> ${escapeHtml(String(lang).toUpperCase())}
<b>Dry run:</b> ${dryRun ? "yes" : "no"}
<b>Run ID:</b> ${escapeHtml(runtime?.runId || "-")}
<b>Started:</b> ${escapeHtml(startedAt)}
<b>Stop requested:</b> ${runtime?.stopRequested ? "yes" : "no"}
<b>Pending config:</b> ${pending}

<b>Virtual base:</b> ${fmtSol(portfolio?.virtualBase ?? portfolio?.startBalance)}
<b>Virtual base:</b> ${fmtSol(portfolio?.virtualBase ?? portfolio?.startBalance)}
<b>Free cash:</b> ${fmtSol(portfolio?.cash)}
<b>Total equity:</b> ${fmtSol(portfolio?.equity)}
<b>Realized PnL:</b> ${fmtSol(portfolio?.realizedPnlSol)}
<b>Unrealized PnL:</b> ${fmtSol(portfolio?.unrealizedPnlSol)}

<b>Strategy buckets</b>
${strategyLines}

<b>Open positions</b>
${summarizeOpenPositions(portfolio)}

${buildHolderPanel(holderSummary)}`;
}

export function buildPeriodicReport(runtime = {}, portfolio = {}, previousEquity = null, holderSummary = null) {
  const equity = safeNum(portfolio?.equity);
  const deltaSol = previousEquity == null ? 0 : equity - safeNum(previousEquity);
  const deltaPct = previousEquity > 0 ? (deltaSol / previousEquity) * 100 : 0;

  const byStrategy = portfolio?.byStrategy || {};
  const strategyLines = Object.keys(byStrategy).length
    ? Object.entries(byStrategy)
        .map(
          ([key, row]) =>
            `• ${escapeHtml(String(key).toUpperCase())}: realized ${fmtSol(
              row?.realizedPnlSol
            )}, open ${safeNum(row?.openPositions, 0)}, avail ${fmtSol(row?.availableSol)}`
        )
        .join("\n")
    : "No strategy data";

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
  let best = "none";
  let worst = "none";
  if (closed.length) {
    const sorted = [...closed].sort((a, b) => safeNum(b?.netPnlPct) - safeNum(a?.netPnlPct));
    best = `${sorted[0]?.token || "Unknown"} ${fmtPct(sorted[0]?.netPnlPct)} (${sorted[0]?.strategy || "-"})`;
    worst = `${sorted[sorted.length - 1]?.token || "Unknown"} ${fmtPct(sorted[sorted.length - 1]?.netPnlPct)} (${sorted[sorted.length - 1]?.strategy || "-"})`;
  }

  return `🧠 <b>PERIODIC REPORT</b>

<b>Mode:</b> ${escapeHtml(String(runtime?.mode || "stopped").toUpperCase())}
<b>Virtual base:</b> ${fmtSol(portfolio?.virtualBase ?? portfolio?.startBalance)}
<b>Equity:</b> ${fmtSol(equity)}
<b>Period Δ:</b> ${fmtSol(deltaSol)} (${fmtPct(deltaPct)})
<b>Virtual base:</b> ${fmtSol(portfolio?.virtualBase ?? portfolio?.startBalance)}
<b>Free cash:</b> ${fmtSol(portfolio?.cash)}
<b>Realized:</b> ${fmtSol(portfolio?.realizedPnlSol)}
<b>Unrealized:</b> ${fmtSol(portfolio?.unrealizedPnlSol)}
<b>Open positions:</b> ${safeNum(openPositions.length, 0)}

<b>By strategy</b>
${strategyLines}

<b>Best closed:</b> ${escapeHtml(best)}
<b>Worst closed:</b> ${escapeHtml(worst)}
<b>Longest open:</b> ${
    longest
      ? `${escapeHtml(longest.token)} | ${escapeHtml(String(longest.strategy).toUpperCase())} | ${fmtAgeMs(longest.ageMs)}`
      : "none"
  }

${buildHolderPanel(holderSummary)}`;
}

export function buildEntryText(position = {}) {
  const links = position?.signalContext?.socials?.links || {};
  const website = links.website ? `\n<b>Website:</b> ${escapeHtml(links.website)}` : "";
  const twitter = links.twitter ? `\n<b>Twitter/X:</b> ${escapeHtml(links.twitter)}` : "";
  const telegram = links.telegram ? `\n<b>Telegram:</b> ${escapeHtml(links.telegram)}` : "";

  return `🚀 <b>ENTRY</b>

<b>Strategy:</b> ${escapeHtml(String(position?.strategy || "").toUpperCase())}
<b>Entry mode:</b> ${escapeHtml(position?.entryMode || "SCALED")}
<b>Wallet:</b> ${escapeHtml(position?.walletId || "default")}
<b>Plan:</b> ${escapeHtml(position?.planName || "-")}
<b>Objective:</b> ${escapeHtml(position?.planObjective || "-")}

<b>Token:</b> ${escapeHtml(position?.token || "Unknown")}
<b>CA:</b> <code>${escapeHtml(position?.ca || "")}</code>
<b>Entry ref:</b> ${safeNum(position?.entryReferencePrice)}
<b>Entry effective:</b> ${safeNum(position?.entryEffectivePrice)}
<b>Size:</b> ${fmtSol(position?.amountSol)}
<b>Expected edge:</b> ${fmtPct(position?.expectedEdgePct)}

<b>Stop:</b> ${fmtPct(-Math.abs(safeNum(position?.stopLossPct)))}
<b>TP:</b> ${
    safeNum(position?.takeProfitPct) > 0
      ? fmtPct(position?.takeProfitPct)
      : Array.isArray(position?.runnerTargetsPct) && position.runnerTargetsPct.length
      ? `runner ${position.runnerTargetsPct.join(" / ")}%`
      : "runner"
  }

<b>Thesis:</b>
${escapeHtml(position?.thesis || "-")}

<b>Entry costs:</b> ${fmtSol(position?.entryCosts?.totalSol, 6)}${website}${twitter}${telegram}`;
}

export function buildPositionUpdateText(position = {}, mark = {}, status = "HOLD") {
  return `📈 <b>POSITION UPDATE</b>

<b>Strategy:</b> ${escapeHtml(String(position?.strategy || "").toUpperCase())}
<b>Entry mode:</b> ${escapeHtml(position?.entryMode || "SCALED")}
<b>Wallet:</b> ${escapeHtml(position?.walletId || "default")}
<b>Token:</b> ${escapeHtml(position?.token || "Unknown")}
<b>CA:</b> <code>${escapeHtml(position?.ca || "")}</code>

<b>Entry ref:</b> ${safeNum(position?.entryReferencePrice)}
<b>Current:</b> ${safeNum(mark?.currentPrice)}
<b>Gross PnL:</b> ${fmtPct(mark?.grossPnlPct)}
<b>Net PnL:</b> ${fmtPct(mark?.netPnlPct)}
<b>Net PnL SOL:</b> ${fmtSol(mark?.netPnlSol)}
<b>Age:</b> ${fmtAgeMs(mark?.ageMs)}
<b>Status:</b> ${escapeHtml(status)}`;
}

export function buildExitText(trade = {}) {
  return `🏁 <b>EXIT</b>

<b>Strategy:</b> ${escapeHtml(String(trade?.strategy || "").toUpperCase())}
<b>Entry mode:</b> ${escapeHtml(trade?.entryMode || "SCALED")}
<b>Wallet:</b> ${escapeHtml(trade?.walletId || "default")}
<b>Plan:</b> ${escapeHtml(trade?.planName || "-")}

<b>Token:</b> ${escapeHtml(trade?.token || "Unknown")}
<b>CA:</b> <code>${escapeHtml(trade?.ca || "")}</code>

<b>Entry ref:</b> ${safeNum(trade?.entryReferencePrice)}
<b>Entry effective:</b> ${safeNum(trade?.entryEffectivePrice)}
<b>Exit ref:</b> ${safeNum(trade?.exitReferencePrice)}

<b>Net PnL:</b> ${fmtPct(trade?.netPnlPct)}
<b>Net PnL SOL:</b> ${fmtSol(trade?.netPnlSol, 6)}
<b>Duration:</b> ${fmtAgeMs(trade?.durationMs)}
<b>Reason:</b> ${escapeHtml(trade?.reason || "-")}
<b>Balance after:</b> ${fmtSol(trade?.balanceAfter)}`;
}
