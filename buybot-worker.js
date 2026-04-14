import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;

const PAIR_ID = "ey75tsmuy7gnb3noq7pdcjg8gxczthou6h6xjwccfvh3";

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

let lastVolume = 0;
let lastBuys = 0;

async function tgSend(text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text
    })
  });
}

function formatBuyMessage(amount) {
  if (amount > 1000) {
    return `🐋 HUGE BUY ALERT!!!

Someone just bought BIG...

$${amount}

Chiikawa is shaking with excitement 🥺✨`;
  }

  if (amount > 300) {
    return `🚀 Strong buy!

$${amount}

The community is growing stronger ✨`;
  }

  return `✨ New buy detected

$${amount}

Every friend matters 🥺`;
}

async function checkDex() {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${PAIR_ID}`
    );

    const data = await res.json();

    const pair = data.pair;
    if (!pair) return;

    const volume = pair.volume.h24 || 0;
    const buys = pair.txns.h24?.buys || 0;

    if (lastVolume === 0) {
      lastVolume = volume;
      lastBuys = buys;
      return;
    }

    const volumeDiff = volume - lastVolume;
    const buysDiff = buys - lastBuys;

    if (buysDiff > 0 && volumeDiff > 0) {
      const avgBuy = volumeDiff / buysDiff;

      // фильтр шума
      if (avgBuy > 20) {
        await tgSend(formatBuyMessage(Math.round(avgBuy)));
      }
    }

    lastVolume = volume;
    lastBuys = buys;
  } catch (e) {
    console.log("Dex error:", e.message);
  }
}

async function loop() {
  console.log("Buybot started...");

  while (true) {
    await checkDex();
    await new Promise(r => setTimeout(r, 15000));
  }
}

loop();
