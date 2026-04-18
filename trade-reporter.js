// trade-reporter.js

export function reportEntry(trade) {
  return `🚀 <b>ENTRY</b>

Token: ${trade.token}
Price: ${trade.entry}
Score: ${trade.score}

🧠 Smart entry detected`;
}

export function reportUpdate(trade) {
  return `📈 Update

Token: ${trade.token}
PnL: ${trade.pnl.toFixed(2)}%
Price: ${trade.current}`;
}

export function reportExit(trade) {
  return `🏁 EXIT

Token: ${trade.token}
PnL: ${trade.pnl.toFixed(2)}%
Reason: ${trade.reason}`;
}

export function reportFinal(trade) {
  const positive = trade.pnl > 0;

  return positive
    ? `🎉 <b>WIN</b>

+${trade.pnl.toFixed(2)}%

Chiikawa happy 🐹✨

📊 Good entry, momentum confirmed`
    : `💀 <b>LOSS</b>

${trade.pnl.toFixed(2)}%

Market tricky...

📊 Lesson: weak momentum or bad timing`;
}
