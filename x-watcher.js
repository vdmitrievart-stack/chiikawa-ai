import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fetchTweets, filterTweets, formatAlert } from "./x-engine.js";
import { buildXReactionPrompt } from "./personality-engine.js";
import { getMoodState, buildMoodContext } from "./mood-engine.js";
import {
  shouldSuggestRaid,
  buildRaidNudge,
  markRaidSuggested
} from "./raid-engine.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const X_GIF_FILE_IDS = process.env.X_GIF_FILE_IDS || "";
const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";

const LOOP_INTERVAL_MS = Number(process.env.X_LOOP_INTERVAL_MS || 60000);
const MAX_STORED_IDS = Number(process.env.X_MAX_STORED_IDS || 1500);
const STATE_FILE = path.resolve("./x-watcher-state.json");

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALERT_CHAT_ID) {
  console.error("Missing Telegram config");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const X_GIF_POOL = X_GIF_FILE_IDS
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

let lastGifUsed = null;
let warmedUp = false;

// Жёсткий лок против повторной отправки одного и того же твита
const inFlightTweets = new Set();

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
      return { sentTweetIds: [], sentTweetUrls: [] };
    }
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { sentTweetIds: [], sentTweetUrls: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const state = loadState();
const sentTweetIds = new Set(state.sentTweetIds || []);
const sentTweetUrls = new Set(state.sentTweetUrls || []);

function persistTweet(tweet) {
  if (!tweet?.id || !tweet?.url) return;

  // дополнительная защита
  if (sentTweetIds.has(tweet.id) || sentTweetUrls.has(tweet.url)) {
    return;
  }

  sentTweetIds.add(tweet.id);
  sentTweetUrls.add(tweet.url);

  const ids = Array.from(sentTweetIds).slice(-MAX_STORED_IDS);
  const urls = Array.from(sentTweetUrls).slice(-MAX_STORED_IDS);

  state.sentTweetIds = ids;
  state.sentTweetUrls = urls;

  saveState(state);
}

async function tg(method, body = {}) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!data.ok) throw new Error(JSON.stringify(data));
  return data.result;
}

async function sendText(text) {
  return tg("sendMessage", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    text,
    disable_web_page_preview: false
  });
}

async function sendGifWithReply(fileId, caption, replyToMessageId) {
  return tg("sendDocument", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    document: fileId,
    caption,
    reply_parameters: {
      message_id: replyToMessageId
    }
  });
}

async function sendReplyText(text, replyToMessageId) {
  return tg("sendMessage", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    text,
    reply_parameters: {
      message_id: replyToMessageId
    }
  });
}

async function askChiikawaForXReaction(tweet) {
  try {
    const moodState = getMoodState({
      source: "x",
      signal: "normal",
      text: tweet.text,
      now: new Date()
    });
    const moodContext = buildMoodContext(moodState);
    const prompt = buildXReactionPrompt(tweet, moodContext, "");

    const res = await fetch(CHIIKAWA_AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: prompt,
        sessionId: `x_${tweet.id}`,
        mode: "normal",
        source: "x"
      })
    });

    const data = await res.json();
    return (data.reply || "").trim();
  } catch (error) {
    console.error("askChiikawaForXReaction error:", error.message);
    return "🥺✨";
  }
}

async function postTweetAlert(tweet) {
  const post = await sendText(formatAlert(tweet));
  const msgId = post.message_id;

  const gif = pickRandomGif(X_GIF_POOL);
  const reaction = await askChiikawaForXReaction(tweet);

  if (gif) {
    await sendGifWithReply(gif, reaction || "✨", msgId);
  } else {
    await sendReplyText(reaction || "✨", msgId);
  }

  if (shouldSuggestRaid(tweet)) {
    await sendReplyText(buildRaidNudge(tweet), msgId);
    markRaidSuggested(tweet.id);
  }
}

async function loop() {
  console.log("X watcher LEVEL 3 started");

  while (true) {
    try {
      const tweets = await fetchTweets();
      const filtered = filterTweets(tweets, sentTweetIds, sentTweetUrls);

      if (!warmedUp) {
        filtered.forEach(persistTweet);
        warmedUp = true;
        console.log("Warm start complete");
      } else {
        for (const tweet of filtered) {
          if (!tweet?.id || !tweet?.url) continue;

          // Главная антидубль-защита
          if (
            sentTweetIds.has(tweet.id) ||
            sentTweetUrls.has(tweet.url) ||
            inFlightTweets.has(tweet.id)
          ) {
            console.log("Duplicate skipped:", tweet.id);
            continue;
          }

          inFlightTweets.add(tweet.id);

          try {
            await postTweetAlert(tweet);
            persistTweet(tweet);
            console.log("Posted tweet:", tweet.id);
          } catch (err) {
            console.error("Post tweet failed:", err.message);
          } finally {
            inFlightTweets.delete(tweet.id);
          }
        }
      }
    } catch (err) {
      console.error("X watcher error:", err.message);
    }

    await sleep(LOOP_INTERVAL_MS);
  }
}

loop();
