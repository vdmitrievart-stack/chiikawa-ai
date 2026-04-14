import fetch from "node-fetch";
import { fetchTweets, filterTweets, formatAlert } from "./x-engine.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const X_GIF_FILE_IDS = process.env.X_GIF_FILE_IDS || "";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALERT_CHAT_ID) {
  console.error("Missing Telegram config");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const sentTweets = new Set();

const X_GIF_POOL = X_GIF_FILE_IDS
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

let lastGifUsed = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pickRandomGif(pool) {
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0];

  const candidates = pool.filter(gif => gif !== lastGifUsed);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  lastGifUsed = chosen;
  return chosen;
}

async function tg(method, body = {}) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram API error in ${method}: ${JSON.stringify(data)}`);
  }

  return data.result;
}

async function sendToTelegram(text) {
  return tg("sendMessage", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    text,
    disable_web_page_preview: false
  });
}

async function sendAnimation(animation, caption = "") {
  return tg("sendAnimation", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    animation,
    caption
  });
}

async function sendStartupMessageOnce() {
  try {
    await sendToTelegram(
      `🐦 X watcher is live

I’m watching X for Chiikawa mentions and will post notable finds here ✨`
    );
  } catch (error) {
    console.error("Failed to send startup message:", error.message);
  }
}

async function postTweetAlert(tweet) {
  const msg = formatAlert(tweet);
  const randomGif = pickRandomGif(X_GIF_POOL);

  console.log("GIF pool size:", X_GIF_POOL.length);
  console.log("Chosen GIF:", randomGif);

  if (randomGif) {
    try {
      await sendAnimation(randomGif, "✨ Chiikawa spotted something on X ✨");
    } catch (error) {
      console.error("GIF send error:", error.message);
    }
  }

  await sendToTelegram(msg);
}

async function loop() {
  console.log("X watcher started...");
  console.log("Loaded GIF ids:", X_GIF_POOL);

  await sendStartupMessageOnce();

  while (true) {
    try {
      const tweets = await fetchTweets();
      const filtered = filterTweets(tweets, sentTweets);

      console.log(`Fetched ${tweets.length} tweets, ${filtered.length} passed filters`);

      for (const tweet of filtered) {
        sentTweets.add(tweet.id);
        console.log(`New tweet from @${tweet.username}`);
        await postTweetAlert(tweet);
      }
    } catch (error) {
      console.error("Watcher error:", error.message);
    }

    await sleep(60000);
  }
}

loop();
