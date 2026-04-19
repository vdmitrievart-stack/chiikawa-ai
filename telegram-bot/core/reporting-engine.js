function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function esc(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function ageText(ms) {
  const total = Math.max(0, Math.floor(safeNum(ms, 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function buildDashboard(runtime, portfolio) {
  const totalClosed = portfolio.closedTrades.length;
  const wins = portfolio.closedTrades.filter(t => t.netPnlPct > 0).length;
  const winrate = totalClosed ? (wins / totalClosed) * 100 : 0;
  const lines = [
    `📊 <b>BOT DASHBOARD</b>`,
    ``,
    `<b>Run ID:</b> ${esc(runtime.runId || "-")}`,
    `<b>Mode:</b> ${esc(String(runtime.mode || "stopped").toUpperCase())}`,
    `<b>Stop requested:</b> ${runtime.stopRequested ? "yes" : "no"}`,
    `<b>Pending config:</b> ${runtime.pendingConfig ? "yes" : "no"}`,
    `<b>Cash:</b> ${round(portfolio.cash, 4)} SOL`,
    `<b>Equity:</b> ${round(portfolio.equity, 4)} SOL`,
    `<b>Realized:</b> ${round(portfolio.realizedPnlSol, 4)} SOL`,
    `<b>Unrealized:</b> ${round(portfolio.unrealizedPnlSol, 4)} SOL`,
    `<b>Open positions:</b> ${portfolio.positions.length}`,
    `<b>Closed trades:</b> ${totalClosed}`,
    `<b>Winrate:</b> ${round(winrate, 2)}%`,
    ``,
    `<b>Strategies</b>`
  ];

  for (const [key, row] of Object.entries(portfolio.byStrategy || {})) {
    lines.push(`• <b>${esc(row.label || key.toUpperCase())}</b> — alloc ${round((row.allocationPct || 0) * 100, 0)}% | available ${round(row.availableSol, 4)} SOL | open ${row.openPositions} | pnl ${round(row.totalPnlSol, 4)} SOL`);
  }

  return lines.join("\n");
}

export function buildBalanceText(portfolio) {
  const lines = [
    `💰 <b>BALANCE</b>`,
    ``,
    `<b>Free SOL:</b> ${round(portfolio.cash, 4)}`,
    `<b>Total equity:</b> ${round(portfolio.equity, 4)}`,
    `<b>Realized:</b> ${round(portfolio.realizedPnlSol, 4)} SOL`,
    `<b>Unrealized:</b> ${round(portfolio.unrealizedPnlSol, 4)} SOL`,
    ``,
    `<b>By strategy</b>`
  ];

  for (const [key, row] of Object.entries(portfolio.byStrategy || {})) {
    lines.push(`• <b>${esc(row.label || key.toUpperCase())}</b> — open ${row.openPositions} | pnl ${round(row.totalPnlPct, 2)}% | pnl SOL ${round(row.totalPnlSol, 4)} | avg age ${ageText(row.avgOpenAgeMs || 0)}`);
  }

  return lines.join("\n");
}

export function buildEntryText(position) {
  return `🚀 <b>ENTRY</b>\n\n<b>Strategy:</b> ${esc(String(position.strategy).toUpperCase())}\n<b>Wallet:</b> ${esc(position.walletId || "simulation")}\n<b>Token:</b> ${esc(position.token)}\n<b>CA:</b> <code>${esc(position.ca)}</code>\n\n<b>Entry mode:</b> ${esc(position.entryMode || "SCALED")}\n<b>Plan:</b> ${esc(position.planName || "trade_plan")}\n<b>Goal:</b> ${esc(position.planObjective || position.thesis || "capture edge")}\n<b>TP:</b> ${position.takeProfitPct ? `${round(position.takeProfitPct, 2)}%` : "runner"}\n<b>SL:</b> ${round(position.stopLossPct, 2)}%\n<b>Size:</b> ${round(position.amountSol, 4)} SOL\n<b>Expected edge:</b> ${round(position.expectedEdgePct, 2)}%\n\n<b>Thesis:</b>\n${esc(position.thesis || "n/a")}`;
}

export function buildPositionUpdateText(position, mark, status, portfolioDelta = null) {
  return `📈 <b>POSITION UPDATE</b>\n\n<b>Strategy:</b> ${esc(String(position.strategy).toUpperCase())}\n<b>Wallet:</b> ${esc(position.walletId || "simulation")}\n<b>Token:</b> ${esc(position.token)}\n<b>Current:</b> ${mark.currentPrice}\n<b>Net PnL:</b> ${round(mark.netPnlPct, 2)}%\n<b>Age:</b> ${ageText(mark.ageMs)}\n<b>Status:</b> ${esc(status)}${portfolioDelta ? `\n<b>Account Δ:</b> ${round(portfolioDelta, 2)}%` : ""}`;
}

export function buildExitText(trade) {
  return `🏁 <b>EXIT</b>\n\n<b>Strategy:</b> ${esc(String(trade.strategy).toUpperCase())}\n<b>Wallet:</b> ${esc(trade.walletId || "simulation")}\n<b>Token:</b> ${esc(trade.token)}\n<b>Net PnL:</b> ${round(trade.netPnlPct, 2)}%\n<b>Net PnL SOL:</b> ${round(trade.netPnlSol, 6)}\n<b>Reason:</b> ${esc(trade.reason)}\n<b>Duration:</b> ${ageText(trade.durationMs)}\n<b>Balance after:</b> ${round(trade.balanceAfter, 4)} SOL`;
}

export function buildPeriodicReport(runtime, portfolio, previousEquity = null) {
  const deltaPct = previousEquity && previousEquity > 0
    ? ((portfolio.equity - previousEquity) / previousEquity) * 100
    : 0;

  const best = [...portfolio.positions].sort((a, b) => (b.lastMark?.netPnlPct || -999) - (a.lastMark?.netPnlPct || -999))[0] || null;
  const worst = [...portfolio.positions].sort((a, b) => (a.lastMark?.netPnlPct || 999) - (b.lastMark?.netPnlPct || 999))[0] || null;

  return `🧾 <b>ACCOUNT REPORT</b>\n\n<b>Mode:</b> ${esc(runtime.mode)}\n<b>Equity:</b> ${round(portfolio.equity, 4)} SOL\n<b>Period Δ:</b> ${round(deltaPct, 2)}%\n<b>Free SOL:</b> ${round(portfolio.cash, 4)}\n<b>In positions:</b> ${round(portfolio.equity - portfolio.cash, 4)}\n<b>Realized:</b> ${round(portfolio.realizedPnlSol, 4)} SOL\n<b>Unrealized:</b> ${round(portfolio.unrealizedPnlSol, 4)} SOL\n${best ? `\n<b>Best open:</b> ${esc(best.token)} ${round(best.lastMark?.netPnlPct || 0, 2)}%` : ""}\n${worst ? `<b>Worst open:</b> ${esc(worst.token)} ${round(worst.lastMark?.netPnlPct || 0, 2)}%` : ""}`;
}
