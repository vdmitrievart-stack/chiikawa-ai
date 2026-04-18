import fetch from "node-fetch";
import personality from "./personality-engine.js";

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  "";

const TELEGRAM_ALERT_CHAT_ID =
  process.env.TELEGRAM_ALERT_CHAT_ID ||
  process.env.CHAT_ID ||
  process.env.FORCED_GROUP_CHAT_ID ||
  "";

const BUYBOT_ENABLED =
  String(process.env.BUYBOT_ENABLED || "true").toLowerCase() !== "false";

const POLL_INTERVAL_MS = Number(process.env.BUYBOT_POLL_INTERVAL_MS || 30000);

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!TELEGRAM_ALERT_CHAT_ID) {
  console.error("Missing TELEGRAM_ALERT_CHAT_ID");
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_ALERT_CHAT_ID,
      text: String(text || "").slice(0, 4096)
    })
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }

  return data;
}

async function pollBuyEvents() {
  return [];
}

async function processBuyEvent(event) {
  const alertText = personality.buildBuyAlert({
    token: event.token,
    amount: event.amount,
    ca: event.ca,
    price: event.price,
    buyer: event.buyer
  });

  await sendTelegramMessage(alertText);
}

async function loop() {
  console.log("buybot worker started");

  while (true) {
    try {
      if (!BUYBOT_ENABLED) {
        console.log("buybot disabled");
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const events = await pollBuyEvents();

      for (const event of events) {
        await processBuyEvent(event);
      }
    } catch (error) {
      console.error("buybot loop error:", error.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

loop().catch(error => {
  console.error("buybot fatal error:", error);
  process.exit(1);
});
