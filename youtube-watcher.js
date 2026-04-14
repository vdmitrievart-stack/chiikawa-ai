import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_GIF_FILE_IDS = process.env.YOUTUBE_GIF_FILE_IDS || "";
const SEND_YT_STARTUP_MESSAGE = String(process.env.SEND_YT_STARTUP_MESSAGE || "false").toLowerCase() === "true";
const YT_STARTUP_COOLDOWN_HOURS = Number(process.env.YT_STARTUP_COOLDOWN_HOURS || 12);

const YOUTUBE_PLAYLIST_ID = "PLHIKP_Dyl1zwJy0JjSvVV5l8Kyg-8sjdv";
const CHECK_INTERVAL_MS = Number(process.env.YOUTUBE_CHECK_INTERVAL_MS || 5 * 60 * 1000);
const MAX_STORED_VIDEO_IDS = Number(process.env.YOUTUBE_MAX_STORED_VIDEO_IDS || 200);
const STATE_FILE = path.resolve("./youtube-watcher-state.json");

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!TELEGRAM_ALERT_CHAT_ID) {
  console.error("Missing TELEGRAM_ALERT_CHAT_ID");
  process.exit(1);
}

if (!YOUTUBE_API_KEY) {
  console.error("Missing YOUTUBE_API_KEY");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const GIF_POOL = YOUTUBE_GIF_FILE_IDS
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

let lastGifUsed = null;
let initialized = false;

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
        seenVideoIds: [],
        lastStartupMessageAt: 0
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      seenVideoIds: Array.isArray(parsed.seenVideoIds) ? parsed.seenVideoIds : [],
      lastStartupMessageAt: Number(parsed.lastStartupMessageAt || 0)
    };
  } catch (error) {
    console.error("Failed to load youtube state:", error.message);
    return {
      seenVideoIds: [],
      lastStartupMessageAt: 0
    };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save youtube state:", error.message);
  }
}

const state = loadState();
const seenVideoIds = new Set(state.seenVideoIds);

function persistVideoId(videoId) {
  if (!videoId) return;

  if (seenVideoIds.has(videoId)) {
    console.log("YouTube duplicate prevented:", videoId);
    return;
  }

  seenVideoIds.add(videoId);

  const trimmed = Array.from(seenVideoIds).slice(-MAX_STORED_VIDEO_IDS);
  state.seenVideoIds = trimmed;

  seenVideoIds.clear();
  for (const id of trimmed) seenVideoIds.add(id);

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

async function sendText(text) {
  return tg("sendMessage", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    text,
    disable_web_page_preview: false
  });
}

async function sendPhoto(photoUrl, caption) {
  return tg("sendPhoto", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    photo: photoUrl,
    caption
  });
}

async function sendGif(fileId, caption = "") {
  return tg("sendDocument", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    document: fileId,
    caption
  });
}

async function maybeSendStartupMessage() {
  if (!SEND_YT_STARTUP_MESSAGE) return;

  const now = Date.now();
  const cooldownMs = YT_STARTUP_COOLDOWN_HOURS * 60 * 60 * 1000;

  if (now - state.lastStartupMessageAt < cooldownMs) {
    return;
  }

  try {
    await sendText(
      `📺 YouTube watcher is live

Watching playlist:
https://www.youtube.com/playlist?list=${YOUTUBE_PLAYLIST_ID}

I will announce new Chiikawa episodes here ✨`
    );

    state.lastStartupMessageAt = now;
    saveState(state);
  } catch (error) {
    console.error("Failed to send startup message:", error.message);
  }
}

function buildYoutubeApiUrl() {
  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    playlistId: YOUTUBE_PLAYLIST_ID,
    maxResults: "10",
    key: YOUTUBE_API_KEY
  });

  return `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`;
}

async function fetchLatestPlaylistItems() {
  const url = buildYoutubeApiUrl();
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`YouTube API error: ${JSON.stringify(data)}`);
  }

  return Array.isArray(data.items) ? data.items : [];
}

function mapItem(item) {
  const videoId = item?.contentDetails?.videoId;
  const title = item?.snippet?.title || "New episode";
  const publishedAt =
    item?.contentDetails?.videoPublishedAt ||
    item?.snippet?.publishedAt ||
    "";

  const thumbnails = item?.snippet?.thumbnails || {};
  const thumbnailUrl =
    thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    null;

  return {
    videoId,
    title,
    publishedAt,
    thumbnailUrl,
    videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null
  };
}

function buildAnnouncement(video) {
  return `🎬 New Chiikawa episode detected!

${video.title}

▶️ ${video.videoUrl}

✨ A new episode just appeared in the playlist.`;
}

async function announceVideo(video) {
  const randomGif = pickRandomGif(GIF_POOL);

  if (randomGif) {
    try {
      await sendGif(randomGif, "✨ New episode energy ✨");
    } catch (error) {
      console.error("YouTube GIF send error:", error.message);
    }
  }

  const caption = buildAnnouncement(video);

  if (video.thumbnailUrl) {
    try {
      await sendPhoto(video.thumbnailUrl, caption);
      return;
    } catch (error) {
      console.error("sendPhoto failed, fallback to text:", error.message);
    }
  }

  await sendText(caption);
}

async function checkYouTube() {
  const items = await fetchLatestPlaylistItems();

  const videos = items
    .map(mapItem)
    .filter(video => video.videoId && video.videoUrl)
    .sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());

  console.log(`Fetched ${videos.length} videos from playlist`);

  if (!initialized) {
    for (const video of videos) {
      persistVideoId(video.videoId);
    }

    initialized = true;
    console.log(`Initialized with ${videos.length} known videos`);
    return;
  }

  const newVideos = videos.filter(video => !seenVideoIds.has(video.videoId));

  for (const video of newVideos) {
    console.log(`New YouTube video detected: ${video.title}`);
    await announceVideo(video);
    persistVideoId(video.videoId);
  }
}

async function main() {
  console.log("YouTube watcher PRO MAX started...");
  console.log(`Watching playlist: ${YOUTUBE_PLAYLIST_ID}`);
  console.log(`GIF pool size: ${GIF_POOL.length}`);
  console.log(`Seen video ids loaded: ${seenVideoIds.size}`);

  await maybeSendStartupMessage();

  while (true) {
    try {
      await checkYouTube();
    } catch (error) {
      console.error("YouTube watcher error:", error.message);
    }

    await sleep(CHECK_INTERVAL_MS);
  }
}

main();
