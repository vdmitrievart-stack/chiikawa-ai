import Parser from "rss-parser";
import fetch from "node-fetch";
import moodEngine from "./mood-engine.js";
import personality from "./personality-engine.js";

const parser = new Parser();

const TELEGRAM_SEND_BOT_TOKEN =
  process.env.TELEGRAM_SEND_BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  "";

const TELEGRAM_ALERT_CHAT_ID =
  process.env.TELEGRAM_ALERT_CHAT_ID ||
  process.env.CHAT_ID ||
  process.env.FORCED_GROUP_CHAT_ID ||
  "";

const YOUTUBE_RSS_URL = (process.env.YOUTUBE_RSS_URL || "").trim();
const POLL_INTERVAL_MS = Number(process.env.YOUTUBE_POLL_INTERVAL_MS || 60000);

function getEnvList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map(v => v.trim()).filter(Boolean);
}

const YOUTUBE_GIF_FILE_IDS = getEnvList("YOUTUBE_GIF_FILE_IDS");

if (!TELEGRAM_SEND_BOT_TOKEN) {
  console.error("Missing TELEGRAM_SEND_BOT_TOKEN");
  process.exit(1);
}

if (!TELEGRAM_ALERT_CHAT_ID) {
  console.error("Missing TELEGRAM_ALERT_CHAT_ID");
  process.exit(1);
}

if (!YOUTUBE_RSS_URL) {
  console.error("Missing YOUTUBE_RSS_URL");
  process.exit(1);
}

let lastSeenVideoId = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rand(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_SEND_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_ALERT_CHAT_ID,
      text: String(text || "").slice(0, 4096),
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }

  return data;
}

async function sendTelegramAnimation(caption) {
  const fileId = rand(YOUTUBE_GIF_FILE_IDS);
  if (!fileId) {
    await sendTelegramMessage(caption);
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_SEND_BOT_TOKEN}/sendAnimation`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_ALERT_CHAT_ID,
      animation: fileId,
      caption: String(caption || "").slice(0, 1024),
      parse_mode: "HTML"
    })
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram animation error: ${JSON.stringify(data)}`);
  }

  return data;
}

async function fetchLatestVideo() {
  console.log("Using YOUTUBE_RSS_URL:", YOUTUBE_RSS_URL);

  const feed = await parser.parseURL(YOUTUBE_RSS_URL);

  if (!feed.items || !feed.items.length) {
    return null;
  }

  const item = feed.items[0];

  return {
    id: item.id || item.guid || item.link || "",
    title: item.title || "New video",
    url: item.link || ""
  };
}

async function loop() {
  console.log("youtube watcher started");

  while (true) {
    try {
      const video = await fetchLatestVideo();

      if (!video) {
        console.log("No YouTube videos found");
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (!lastSeenVideoId) {
        lastSeenVideoId = video.id;
        console.log("YouTube first sync completed");
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (video.id && video.id !== lastSeenVideoId) {
        const mood = moodEngine.pickMood();
        const emoji = moodEngine.moodEmoji(mood);
        const moodLine = moodEngine.buildMoodLine(mood);

        const text = personality.buildYouTubeAnnouncement({
          title: `${emoji} ${video.title}`,
          url: video.url,
          moodLine
        });

        await sendTelegramAnimation(text);

        console.log("New YouTube episode sent:", video.title);
        lastSeenVideoId = video.id;
      } else {
        console.log("No new YouTube episode");
      }
    } catch (error) {
      console.error("youtube watcher error:", error.message || error);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

loop().catch(error => {
  console.error("youtube watcher fatal error:", error);
  process.exit(1);
});
