import { Level6TradingOrchestrator } from "./Level6TradingOrchestrator.js";

const tradingRuntime = {
  enabled: false,
  mode: "safe",
  killSwitch: false,
  buybotAlertMinUsd: 20,
  dryRun: true,
  feeReserveSol: Number(process.env.LEVEL6_FEE_RESERVE_SOL || 0.07),
  maxWalletExposurePct: Number(process.env.LEVEL6_MAX_WALLET_EXPOSURE_PCT || 3.5)
};

let orchestrator = null;

const GIFS = {
  entry: [
    "https://tenor.com/vLMG1KGYUyT.gif",
    "https://tenor.com/pp5GdrEl62Z.gif",
    "https://tenor.com/sooKVCqgZq8.gif"
  ],
  update: [
    "https://tenor.com/ljj380KXDAP.gif",
    "https://tenor.com/fUK8Huu1U7Q.gif",
    "https://tenor.com/g9gHsoSlJt.gif",
    "https://tenor.com/sNFBJfQy31T.gif",
    "https://tenor.com/fMh0VLFKGyX.gif"
  ],
  exit: [
    "https://tenor.com/piMOnfwNEoX.gif",
    "https://tenor.com/iIn3jQbN5XN.gif",
    "https://tenor.com/b1s9E.gif"
  ],
  win: [
    "https://tenor.com/qZRXpxQ9cAd.gif",
    "https://tenor.com/lidNFsvSOfi.gif"
  ],
  loss: [
    "https://tenor.com/rWrXAZPADpT.gif",
    "https://tenor.com/sEo1VH4xE8q.gif"
  ]
};

const gifRotationState = {
  entry: { lastIndex: -1, cursor: 0 },
  update: { lastIndex: -1, cursor: 0 },
  exit: { lastIndex: -1, cursor: 0 },
  win: { lastIndex: -1, cursor: 0 },
  loss: { lastIndex: -1, cursor: 0 }
};

function pickNaturalGif(bucketName) {
  const list = GIFS[bucketName];
  const state = gifRotationState[bucketName];

  if (!Array.isArray(list) || !list.length) return null;

  if (list.length === 1) {
    state.lastIndex = 0;
    state.cursor = 0;
    return list[0];
  }

  let chosenIndex = state.cursor % list.length;
  if (chosenIndex === state.lastIndex) {
    chosenIndex = (chosenIndex + 1) % list.length;
  }

  state.lastIndex = chosenIndex;
  state.cursor = (chosenIndex + 1) % list.length;

  return list[chosenIndex];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureOrchestrator() {
  if (!orchestrator) {
    orchestrator = new Level6TradingOrchestrator({
      dryRun: tradingRuntime.dryRun
    });
  }
  return orchestrator;
}

function summarizeJournal(journal) {
  if (!journal.length) {
    return {
      winRate: 0,
      totalTrades: 0,
      pnl: 0,
      avgEntryScore: 0
    };
  }

  const wins = journal.filter(t => Number(t.pnl || 0) > 0).length;
  const totalPnl = journal.reduce((acc, t) => acc + Number(t.pnl || 0), 0);
  const avgScore =
    journal.reduce((acc, t) => acc + Number(t.score || 0), 0) / journal.length;

  return {
    winRate: wins / journal.length,
    totalTrades: journal.length,
    pnl: Number(totalPnl.toFixed(2)),
    avgEntryScore: Number(avgScore.toFixed(2))
  };
}

export async function initTradingAdmin() {
  console.log("🚀 Trading Admin init");
  ensureOrchestrator();
  return { ok: true };
}

export function getTradingRuntime() {
  return { ...tradingRuntime };
}

export function getLevel6Summary() {
  const journal = ensureOrchestrator().getJournal?.() || [];
  return summarizeJournal(journal);
}

export function getLevel6OpenTrades() {
  return ensureOrchestrator().getOpenTrades?.() || [];
}

export async function handleTradingAdminCallback(data) {
  try {
    if (data === "trade:toggle_enabled") {
      tradingRuntime.enabled = !tradingRuntime.enabled;
      return { ok: true, message: `Trading enabled: ${tradingRuntime.enabled}` };
    }

    if (data === "trade:toggle_kill") {
      tradingRuntime.killSwitch = !tradingRuntime.killSwitch;
      return { ok: true, message: `Kill switch: ${tradingRuntime.killSwitch}` };
    }

    if (data === "trade:cycle_mode") {
      tradingRuntime.mode = tradingRuntime.mode === "safe" ? "aggressive" : "safe";
      return { ok: true, message: `Mode: ${tradingRuntime.mode}` };
    }

    if (data === "trade:dryrun_toggle") {
      tradingRuntime.dryRun = !tradingRuntime.dryRun;
      ensureOrchestrator().dryRun = tradingRuntime.dryRun;
      return { ok: true, message: `Dry run: ${tradingRuntime.dryRun}` };
    }

    return { ok: false, error: "Unknown action" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function handleTradingCommand(text) {
  try {
    ensureOrchestrator();

    if (text.startsWith("/trading_on")) {
      tradingRuntime.enabled = true;
      return { ok: true, message: "✅ Trading enabled" };
    }

    if (text.startsWith("/trading_off")) {
      tradingRuntime.enabled = false;
      return { ok: true, message: "⛔ Trading disabled" };
    }

    if (text.startsWith("/kill_switch")) {
      tradingRuntime.killSwitch = !tradingRuntime.killSwitch;
      return { ok: true, message: `🛑 Kill switch: ${tradingRuntime.killSwitch}` };
    }

    if (text.startsWith("/trade_mode")) {
      tradingRuntime.mode = tradingRuntime.mode === "safe" ? "aggressive" : "safe";
      return { ok: true, message: `⚙️ Mode: ${tradingRuntime.mode}` };
    }

    if (text.startsWith("/dryrun_on")) {
      tradingRuntime.dryRun = true;
      ensureOrchestrator().dryRun = true;
      return { ok: true, message: "🧪 Dry run ON" };
    }

    if (text.startsWith("/dryrun_off")) {
      tradingRuntime.dryRun = false;
      ensureOrchestrator().dryRun = false;
      return { ok: true, message: "💸 Dry run OFF" };
    }

    if (text.startsWith("/setbuy")) {
      const val = Number(text.split(" ")[1]);
      if (!Number.isFinite(val) || val <= 0) {
        return { ok: false, error: "Invalid value" };
      }

      tradingRuntime.buybotAlertMinUsd = val;
      return { ok: true, message: `💰 Buy min set: $${val}` };
    }

    if (text.startsWith("/level6_status")) {
      const s = getLevel6Summary();
      return {
        ok: true,
        message: `📊 Level 6 Summary

WinRate: ${(s.winRate * 100).toFixed(1)}%
Trades: ${s.totalTrades}
PnL: ${s.pnl}%
Score: ${s.avgEntryScore}

Dry run: ${tradingRuntime.dryRun}
Mode: ${tradingRuntime.mode}
Kill switch: ${tradingRuntime.killSwitch}
Fee reserve: ${tradingRuntime.feeReserveSol} SOL
Max wallet exposure: ${tradingRuntime.maxWalletExposurePct}%`
      };
    }

    if (text.startsWith("/level6_open_trades")) {
      const trades = getLevel6OpenTrades();
      if (!trades.length) {
        return { ok: true, message: "No open trades" };
      }

      return {
        ok: true,
        message: trades
          .map(
            (t, i) =>
              `${i + 1}. ${t.token}
Entry: ${t.entry}
Current: ${t.current ?? t.entry}
PnL: ${Number(t.pnl || 0).toFixed(2)}%
Score: ${t.score}`
          )
          .join("\n\n")
      };
    }

    return { ok: false, error: "Unknown command" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function buildUpdateNarrative(trade) {
  const pnl = Number(trade.pnl || 0);

  if (pnl >= 20) return "Momentum strong. Chiikawa is watching for a clean exit ✨";
  if (pnl >= 8) return "Position is healthy. Trend still looks constructive.";
  if (pnl >= 0) return "Trade is alive, but still needs confirmation.";
  if (pnl > -6) return "Small pressure. No panic yet, just watching structure.";
  return "Pressure increasing. Risk control matters here.";
}

function buildFinalNarrative(closed) {
  const pnl = Number(closed.pnl || 0);

  if (pnl > 15) {
    return "Excellent close. Strong structure, good timing, healthy follow-through.";
  }

  if (pnl > 0) {
    return "Profitable close. Not explosive, but disciplined and valid.";
  }

  if (pnl > -8) {
    return "Manageable damage. Exit discipline worked better than hope.";
  }

  return "Bad trade, but cut correctly. The loss matters less than protecting capital.";
}

export async function simulateTradeFlow(sendToTG) {
  const engine = ensureOrchestrator();

  const trade = engine.tryEnter({
    token: "CHI",
    price: 1,
    volumeSpike: true,
    smartWallets: true,
    liquidity: 20000,
    hypeScore: 80
  });

  if (!trade) {
    await sendToTG({
      text: "No entry signal",
      gif: null
    });
    return;
  }

  await sendToTG({
    text: `🚀 <b>ENTRY</b>

Token: ${trade.token}
Price: ${trade.entry}
Score: ${trade.score}
Mode: ${tradingRuntime.mode}
Dry run: ${tradingRuntime.dryRun}
Max wallet exposure: ${tradingRuntime.maxWalletExposurePct}%
Fee reserve: ${tradingRuntime.feeReserveSol} SOL

🧠 Smart entry detected`,
    gif: pickNaturalGif("entry")
  });

  let price = 1;

  for (let i = 0; i < 10; i += 1) {
    await sleep(900);

    price *= 1 + (Math.random() * 0.12 - 0.04);
    engine.updateTrade(trade, price);

    await sendToTG({
      text: `📈 <b>Update</b>

Token: ${trade.token}
PnL: ${Number(trade.pnl || 0).toFixed(2)}%
Price: ${price.toFixed(4)}

${buildUpdateNarrative(trade)}`,
      gif: pickNaturalGif("update")
    });

    const exit = engine.shouldExit(trade);

    if (exit) {
      const closed = engine.closeTrade(trade, exit);

      await sendToTG({
        text: `🏁 <b>EXIT</b>

Token: ${closed.token}
PnL: ${Number(closed.pnl || 0).toFixed(2)}%
Reason: ${exit}`,
        gif: pickNaturalGif("exit")
      });

      await sendToTG({
        text:
          Number(closed.pnl || 0) > 0
            ? `🎉 <b>WIN</b>

+${Number(closed.pnl || 0).toFixed(2)}%

Chiikawa happy 🐹✨

${buildFinalNarrative(closed)}`
            : `💀 <b>LOSS</b>

${Number(closed.pnl || 0).toFixed(2)}%

Market tricky...

${buildFinalNarrative(closed)}`,
        gif:
          Number(closed.pnl || 0) > 0
            ? pickNaturalGif("win")
            : pickNaturalGif("loss")
      });

      return;
    }
  }

  const closed = engine.closeTrade(trade, "TIMEOUT");

  await sendToTG({
    text: `🏁 <b>EXIT</b>

Token: ${closed.token}
PnL: ${Number(closed.pnl || 0).toFixed(2)}%
Reason: TIMEOUT`,
    gif: pickNaturalGif("exit")
  });

  await sendToTG({
    text:
      Number(closed.pnl || 0) > 0
        ? `🎉 <b>WIN</b>

+${Number(closed.pnl || 0).toFixed(2)}%

Chiikawa happy 🐹✨

${buildFinalNarrative(closed)}`
        : `💀 <b>LOSS</b>

${Number(closed.pnl || 0).toFixed(2)}%

Market tricky...

${buildFinalNarrative(closed)}`,
    gif:
      Number(closed.pnl || 0) > 0
        ? pickNaturalGif("win")
        : pickNaturalGif("loss")
  });
}
