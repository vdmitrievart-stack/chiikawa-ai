import fetch from "node-fetch";
import { fetchTweets, filterTweets, formatAlert } from "./x-engine.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !CHAT_ID) {
  console.error("Missing Telegram config");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const sentTweets = new Set();

async function sendToTelegram(text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text
    })
  });
}

async function loop() {
  console.log("X watcher started...");

  while (true) {
    try {
      const tweets = await fetchTweets();
      const filtered = filterTweets(tweets, sentTweets);

      for (const t of filtered) {
        sentTweets.add(t.id);

        const msg = formatAlert(t);

        console.log("New tweet:", t.username);
        await sendToTelegram(msg);
      }
    } catch (e) {
      console.error("Watcher error:", e);
    }

    await new Promise(r => setTimeout(r, 60000)); // 1 минута
  }
}

loop();
