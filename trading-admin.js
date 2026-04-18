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
// GIF ROTATION
// ==============================

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

  const start = state.cursor % list.length;
  let chosenIndex = start;

  if (chosenIndex === state.lastIndex) {
    chosenIndex = (chosenIndex + 1) % list.length;
  }

  state.lastIndex = chosenIndex;
  state.cursor = (chosenIndex + 1) % list.length;

  return list[chosenIndex];
}

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
    text: `🚀 <b>ENTRY</b>

Token: ${trade.token}
Price: ${trade.entry}
Score: ${trade.score}

🧠 Smart entry detected`,
    gif: pickNaturalGif("entry")
  });

  let price = 1;

  for (let i = 0; i < 10; i++) {
    await sleep(800);

    price *= 1 + (Math.random() * 0.12 - 0.04);
    orchestrator.updateTrade(trade, price);

    await sendToTG({
      text: `📈 <b>Update</b>

Token: ${trade.token}
PnL: ${trade.pnl.toFixed(2)}%
Price: ${price.toFixed(4)}`,
      gif: pickNaturalGif("update")
    });

    const exit = orchestrator.shouldExit(trade);

    if (exit) {
      const closed = orchestrator.closeTrade(trade, exit);

      await sendToTG({
        text: `🏁 <b>EXIT</b>

Token: ${closed.token}
PnL: ${closed.pnl.toFixed(2)}%
Reason: ${exit}`,
        gif: pickNaturalGif("exit")
      });

      await sendToTG({
        text:
          closed.pnl > 0
            ? `🎉 <b>WIN</b>

+${closed.pnl.toFixed(2)}%

Chiikawa happy 🐹✨

📊 Good entry, momentum confirmed`
            : `💀 <b>LOSS</b>

${closed.pnl.toFixed(2)}%

Market tricky...

📊 Lesson: weak momentum or bad timing`,
        gif: closed.pnl > 0 ? pickNaturalGif("win") : pickNaturalGif("loss")
      });

      return;
    }
  }

  const closed = orchestrator.closeTrade(trade, "TIMEOUT");

  await sendToTG({
    text: `🏁 <b>EXIT</b>

Token: ${closed.token}
PnL: ${closed.pnl.toFixed(2)}%
Reason: TIMEOUT`,
    gif: pickNaturalGif("exit")
  });

  await sendToTG({
    text:
      closed.pnl > 0
        ? `🎉 <b>WIN</b>

+${closed.pnl.toFixed(2)}%

Chiikawa happy 🐹✨

📊 Good entry, momentum confirmed`
        : `💀 <b>LOSS</b>

${closed.pnl.toFixed(2)}%

Market tricky...

📊 Lesson: weak momentum or bad timing`,
    gif: closed.pnl > 0 ? pickNaturalGif("win") : pickNaturalGif("loss")
  });
}

// ==============================
// HELPERS
// ==============================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
