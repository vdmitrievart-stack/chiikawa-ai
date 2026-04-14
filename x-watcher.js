import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fetchTweets, filterTweets, formatAlert } from "./x-engine.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const X_GIF_FILE_IDS = process.env.X_GIF_FILE_IDS || "";
const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";

const SEND_X_STARTUP_MESSAGE =
  String(process.env.SEND_X_STARTUP_MESSAGE || "false").toLowerCase() === "true";
const X_STARTUP_COOLDOWN_HOURS = Number(process.env.X_STARTUP_COOLDOWN_HOURS || 12);
const LOOP_INTERVAL_MS = Number(process.env.X_LOOP_INTERVAL_MS || 60000);
const MAX_STORED_IDS = Number(process.env.X_MAX_STORED_IDS || 1500);
const STATE_FILE = path.resolve("./x-watcher-state.json");
const STARTUP_WARM_SKIP = true;

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
        sentTweetIds: [],
        sentTweetUrls: [],
        lastStartupMessageAt: 0
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      sentTweetIds: Array.isArray(parsed.sentTweetIds) ? parsed.sentTweetIds : [],
      sentTweetUrls: Array.isArray(parsed.sentTweetUrls) ? parsed.sentTweetUrls : [],
      lastStartupMessageAt: Number(parsed.lastStartupMessageAt || 0)
    };
  } catch (error) {
    console.error("Failed to load x-watcher state:", error.message);
    return {
      sentTweetIds: [],
      sentTweetUrls: [],
      lastStartupMessageAt: 0
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
const sentTweetIds = new Set(state.sentTweetIds);
const sentTweetUrls = new Set(state.sentTweetUrls);

function persistTweet(tweet) {
  if (!tweet?.id || !tweet?.url) return;

  if (sentTweetIds.has(tweet.id) || sentTweetUrls.has(tweet.url)) {
    console.log("Duplicate prevented:", tweet.id, tweet.url);
    return;
  }

  sentTweetIds.add(tweet.id);
  sentTweetUrls.add(tweet.url);

  const trimmedIds = Array.from(sentTweetIds).slice(-MAX_STORED_IDS);
  const trimmedUrls = Array.from(sentTweetUrls).slice(-MAX_STORED_IDS);

  state.sentTweetIds = trimmedIds;
  state.sentTweetUrls = trimmedUrls;

  sentTweetIds.clear();
  sentTweetUrls.clear();

  for (const id of trimmedIds) sentTweetIds.add(id);
  for (const url of trimmedUrls) sentTweetUrls.add(url);

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

async function sendText(text, replyToMessageId = null) {
  const body = {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    text,
    disable_web_page_preview: false
  };

  if (replyToMessageId) {
    body.reply_parameters = {
      message_id: replyToMessageId
    };
  }

  return tg("sendMessage", body);
}

async function sendGif(fileId, caption = "", replyToMessageId = null) {
  const body = {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    document: fileId,
    caption
  };

  if (replyToMessageId) {
    body.reply_parameters = {
      message_id: replyToMessageId
    };
  }

  return tg("sendDocument", body);
}

async function maybeSendStartupMessage() {
  if (!SEND_X_STARTUP_MESSAGE) return;

  const now = Date.now();
  const cooldownMs = X_STARTUP_COOLDOWN_HOURS * 60 * 60 * 1000;

  if (now - state.lastStartupMessageAt < cooldownMs) {
    return;
  }

  try {
    await sendText(
      `🐦 X watcher is live

I’m watching X for Chiikawa mentions and posting only higher-signal finds here ✨`
    );

    state.lastStartupMessageAt = now;
    saveState(state);
  } catch (error) {
    console.error("Failed to send startup message:", error.message);
  }
}

async function askChiikawaForXReaction(tweet) {
  try {
    const prompt = `
You are reacting to a post from X as Chiikawa.

Rules:
- Reply in the SAME language as the tweet.
- Keep it short: 1 or 2 lines maximum.
- No greeting.
- No self introduction.
- Do not say who you are.
- Do not say "Hi", "Hello", or "I'm Chiikawa".
- Do not restate the whole post.
- React to the meaning of the post.
- Be playful, perceptive, and slightly humorous when appropriate.
- Be warm, not toxic.
- No hashtags.
- No links.
- Sound like a natural direct reaction under the post in Telegram.

Context:
Author: @${tweet.username}
Followers: ${tweet.followers}
Tweet text:
${tweet.text}
`;

    const res = await fetch(CHIIKAWA_AI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: prompt,
        sessionId: `xwatcher_${tweet.id}`,
        mode: "normal"
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(`Chiikawa backend error: ${JSON.stringify(data)}`);
    }

    const reply = String(data.reply || "").trim();
    return reply || null;
  } catch (error) {
    console.error("AI reaction error:", error.message);
    return null;
  }
}

async function postTweetAlert(tweet) {
  // 1. Сначала публикуем сам X-пост
  const postMessage = await sendText(formatAlert(tweet));
  const replyToId = postMessage?.message_id || null;

  // 2. Потом reply-gif именно к этому посту
  const randomGif = pickRandomGif(X_GIF_POOL);

  if (randomGif && replyToId) {
    try {
      await sendGif(randomGif, "✨", replyToId);
    } catch (error) {
      console.error("GIF send error:", error.message);
    }
  }

  // 3. Потом AI-реакция тоже reply к этому посту
  const aiReaction = await askChiikawaForXReaction(tweet);

  if (aiReaction && replyToId) {
    await sendText(aiReaction, replyToId);
  }
}

async function loop() {
  console.log("X watcher PRO MAX started...");
  console.log("Loaded sent tweet ids:", sentTweetIds.size);
  console.log("Loaded sent tweet urls:", sentTweetUrls.size);
  console.log("Loaded GIF ids:", X_GIF_POOL.length);
  console.log("AI backend:", CHIIKAWA_AI_URL);

  await maybeSendStartupMessage();

  while (true) {
    try {
      const tweets = await fetchTweets();
      const filtered = filterTweets(tweets, sentTweetIds, sentTweetUrls);

      console.log(
        `Fetched ${tweets.length} tweets, ${filtered.length} new tweets passed filters`
      );

      if (!warmedUp && STARTUP_WARM_SKIP) {
        for (const tweet of filtered) {
          persistTweet(tweet);
        }
        warmedUp = true;
        console.log(`Warm start complete, cached ${filtered.length} tweet ids`);
      } else {
        warmedUp = true;

        for (const tweet of filtered) {
          if (sentTweetIds.has(tweet.id) || sentTweetUrls.has(tweet.url)) {
            console.log("Skipped duplicate during loop:", tweet.id);
            continue;
          }

          console.log(`Posting tweet ${tweet.id} from @${tweet.username}`);
          await postTweetAlert(tweet);
          persistTweet(tweet);
        }
      }
    } catch (error) {
      console.error("Watcher error:", error.message);
    }

    await sleep(LOOP_INTERVAL_MS);
  }
}

loop();
