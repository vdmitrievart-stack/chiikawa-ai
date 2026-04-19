let runtime = {
  enabled: true,
  dryRun: true,
  killSwitch: false,
  mode: "safe",
  buybotAlertMinUsd: 20
};

let level6 = {
  trades: [],
  totalTrades: 0,
  pnl: 0,
  avgEntryScore: 0,
  winRate: 0
};

export async function initTradingAdmin() {
  console.log("Trading admin initialized");
}

export function getTradingRuntime() {
  return runtime;
}

export function getLevel6Summary() {
  return {
    totalTrades: level6.totalTrades,
    pnl: level6.pnl,
    avgEntryScore: level6.avgEntryScore,
    winRate: level6.winRate
  };
}

export function getLevel6OpenTrades() {
  return level6.trades.filter(t => !t.closed);
}

export async function handleTradingCommand(cmd) {
  if (cmd === "/trading_on") {
    runtime.enabled = true;
    return { ok: true, message: "Trading enabled" };
  }

  if (cmd === "/trading_off") {
    runtime.enabled = false;
    return { ok: true, message: "Trading disabled" };
  }

  if (cmd === "/dryrun_on") {
    runtime.dryRun = true;
    return { ok: true, message: "DryRun enabled" };
  }

  if (cmd === "/dryrun_off") {
    runtime.dryRun = false;
    return { ok: true, message: "DryRun disabled" };
  }

  if (cmd === "/kill_switch") {
    runtime.killSwitch = !runtime.killSwitch;
    return { ok: true, message: "Kill switch toggled" };
  }

  if (cmd === "/trade_mode") {
    runtime.mode = runtime.mode === "safe" ? "aggressive" : "safe";
    return { ok: true, message: `Mode: ${runtime.mode}` };
  }

  return { error: "Unknown command" };
}

// 🔥 ФИКС simulateTradeFlow
export async function simulateTradeFlow(userSend, groupSend) {
  const token = "TEST_TOKEN"; // ← фикс

  const trade = {
    token,
    entry: 1.01,
    current: 1.0159,
    pnl: 0,
    score: 72,
    closed: false
  };

  level6.trades.push(trade);

  await userSend({
    text: `🚀 ENTRY

Token: ${token}
Price: ${trade.entry}
Score: ${trade.score}`
  });

  await userSend({
    text: `📈 Update

Token: ${token}
PnL: ${trade.pnl}%
Price: ${trade.current}`
  });

  await userSend({
    text: `🏁 EXIT

Token: ${token}
PnL: ${trade.pnl}%
Reason: TIME_EXIT`
  });

  trade.closed = true;
  level6.totalTrades += 1;
}
