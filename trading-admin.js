// trading-admin.js

import { Level6TradingOrchestrator } from "./Level6TradingOrchestrator.js";

// ==============================
// STATE
// ==============================

const tradingRuntime = {
  enabled: false,
  mode: "safe",
  killSwitch: false,
  buybotAlertMinUsd: 20
};

let orchestrator = null;

// ==============================
// INIT
// ==============================

export async function initTradingAdmin() {
  console.log("🚀 Trading Admin init");

  orchestrator = new Level6TradingOrchestrator({
    dryRun: true
  });
}

// ==============================
// GETTERS
// ==============================

export function getTradingRuntime() {
  return tradingRuntime;
}

// ==============================
// TRADE REPORT FLOW
// ==============================

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const GIFS = {
  entry: [
    "https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif",
    "https://media.giphy.com/media/l0HlNaQ6gWfllcjDO/giphy.gif"
  ],
  update: [
    "https://media.giphy.com/media/3o7aCTfyhYawdOXcFW/giphy.gif"
  ],
  win: [
    "https://media.giphy.com/media/111ebonMs90YLu/giphy.gif"
  ],
  loss: [
    "https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif"
  ]
};

// ==============================
// SIMULATION (CORE)
// ==============================

export async function simulateTradeFlow(sendToTG) {
  const trade = await orchestrator.tryEnter({
    token: "CHI",
    price: 1,
    volumeSpike: true,
    smartWallets: true,
    liquidity: 20000,
    hypeScore: 80
  });

  if (!trade) return;

  await sendToTG({
    text: `🚀 ENTRY

Token: ${trade.token}
Price: ${trade.entry}
Score: ${trade.score}`,
    gif: pick(GIFS.entry)
  });

  let price = 1;

  for (let i = 0; i < 10; i++) {
    await sleep(800);

    price *= 1 + (Math.random() * 0.12 - 0.04);

    orchestrator.updateTrade(trade, price);

    await sendToTG({
      text: `📈 Update

PnL: ${trade.pnl.toFixed(2)}%
Price: ${price.toFixed(4)}`,
      gif: pick(GIFS.update)
    });

    const exit = orchestrator.shouldExit(trade);

    if (exit) {
      const closed = orchestrator.closeTrade(trade, exit);

      await sendToTG({
        text: `🏁 EXIT

PnL: ${closed.pnl.toFixed(2)}%
Reason: ${exit}`,
      });

      await sendToTG({
        text:
          closed.pnl > 0
            ? `🎉 WIN\n+${closed.pnl.toFixed(2)}%\nChiikawa happy 🐹✨`
            : `💀 LOSS\n${closed.pnl.toFixed(2)}%\nMarket tricky...`,
        gif: closed.pnl > 0 ? pick(GIFS.win) : pick(GIFS.loss)
      });

      return;
    }
  }
}

// ==============================
// HELPERS
// ==============================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
