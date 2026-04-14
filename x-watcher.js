import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fetchTweets, filterTweets, formatAlert } from "./x-engine.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const X_GIF_FILE_IDS = process.env.X_GIF_FILE_IDS || "";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALERT_CHAT_ID) {
  console.error("Missing Telegram config");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const STATE_FILE = path.resolve("./x-watcher-state.json");
const LOOP_INTERVAL_MS = 60 * 1000;
const MAX_STORED_IDS = 1000;
const STARTUP_WARM_SKIP = true;

const X_GIF_POOL = X_GIF_FILE_IDS
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

let lastGifUsed = null;
let startupMessageSent = false;
let warmedUp = false;

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

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        sentTweetIds: []
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      sentTweetIds: Array.isArray(parsed.sentTweetIds) ? parsed.sentTweetIds : []
    };
  } catch (error) {
    console.error("Failed to load x-watcher state:", error.message);
    return {
      sentTweetIds: []
    };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save x-watcher state:", error.message);
  }
}

const state = loadState();
const sentTweets = new Set(state.sentTweetIds);

function persistSentTweetId(tweetId) {
  if (!tweetId) return;

  sentTweets.add(tweetId);

  const trimmed = Array.from(sentTweets).slice(-MAX_STORED_IDS);
  state.sentTweetIds = trimmed;

  // пересобираем Set чтобы не пух бесконечно
  sentTweets.clear();
  for (const id of trimmed) {
    sentTweets.add(id);
  }

  saveState(state);
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
  if (startupMessageSent) return;

  startupMessageSent = true;

  try {
    await sendToTelegram(
      `🐦 X watcher is live

I’m watching X for Chiikawa mentions and posting only higher-signal finds here ✨`
    );
  } catch (error) {
    console.error("Failed to send startup message:", error.message);
  }
}

async function postTweetAlert(tweet) {
  const randomGif = pickRandomGif(X_GIF_POOL);

  if (randomGif) {
    try {
      await sendAnimation(randomGif, "✨ Chiikawa spotted something on X ✨");
    } catch (error) {
      console.error("GIF send error:", error.message);
    }
  }

  await sendToTelegram(formatAlert(tweet));
}

async function loop() {
  console.log("X watcher started...");
  console.log("Loaded sent tweet ids:", sentTweets.size);
  console.log("Loaded GIF ids:", X_GIF_POOL.length);

  await sendStartupMessageOnce();

  while (true) {
    try {
      const tweets = await fetchTweets();
      const filtered = filterTweets(tweets, sentTweets);

      console.log(
        `Fetched ${tweets.length} tweets, ${filtered.length} new tweets passed filters`
      );

      // На первом цикле можно только прогреться и не постить старое
      if (!warmedUp && STARTUP_WARM_SKIP) {
        for (const tweet of filtered) {
          persistSentTweetId(tweet.id);
        }
        warmedUp = true;
        console.log(`Warm start complete, cached ${filtered.length} tweet ids`);
      } else {
        warmedUp = true;

        for (const tweet of filtered) {
          console.log(`Posting tweet ${tweet.id} from @${tweet.username}`);
          await postTweetAlert(tweet);
          persistSentTweetId(tweet.id);
        }
      }
    } catch (error) {
      console.error("Watcher error:", error.message);
    }

    await sleep(LOOP_INTERVAL_MS);
  }
}

loop();
