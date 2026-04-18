import Parser from "rss-parser";
import fetch from "node-fetch";
import moodEngine from "./mood-engine.js";
import personality from "./personality-engine.js";

const parser = new Parser();

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  "";

const TELEGRAM_ALERT_CHAT_ID =
  process.env.TELEGRAM_ALERT_CHAT_ID ||
  process.env.CHAT_ID ||
  process.env.FORCED_GROUP_CHAT_ID ||
  "";

const YOUTUBE_RSS_URL =
  process.env.YOUTUBE_RSS_URL ||
  "";

const POLL_INTERVAL_MS = Number(process.env.YOUTUBE_POLL_INTERVAL_MS || 60000);

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
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

async function fetchLatestVideo() {
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

        await sendTelegramMessage(text);

        console.log("New YouTube episode sent:", video.title);
        lastSeenVideoId = video.id;
      } else {
        console.log("No new YouTube episode");
      }
    } catch (error) {
      console.error("youtube watcher error:", error.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

loop().catch(error => {
  console.error("youtube watcher fatal error:", error);
  process.exit(1);
});
