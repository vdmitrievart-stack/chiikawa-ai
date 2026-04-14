import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Плейлист, который ты дал
const YOUTUBE_PLAYLIST_ID = "PLHIKP_Dyl1zwJy0JjSvVV5l8Kyg-8sjdv";

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
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 минут

// Храним уже виденные видео только в памяти процесса.
// Для старта этого достаточно.
const seenVideoIds = new Set();
let initialized = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function buildYoutubeApiUrl() {
  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    playlistId: YOUTUBE_PLAYLIST_ID,
    maxResults: "5",
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
  const publishedAt = item?.contentDetails?.videoPublishedAt || item?.snippet?.publishedAt || "";
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
  const caption = buildAnnouncement(video);

  if (video.thumbnailUrl) {
    try {
      await sendPhoto(video.thumbnailUrl, caption);
      return;
    } catch (error) {
      console.error("sendPhoto failed, falling back to text:", error.message);
    }
  }

  await sendText(caption);
}

async function checkYouTube() {
  const items = await fetchLatestPlaylistItems();
  const videos = items
    .map(mapItem)
    .filter(v => v.videoId && v.videoUrl)
    .sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());

  if (!initialized) {
    for (const video of videos) {
      seenVideoIds.add(video.videoId);
    }
    initialized = true;
    console.log(`YouTube watcher initialized with ${videos.length} known videos`);
    return;
  }

  const newVideos = videos.filter(video => !seenVideoIds.has(video.videoId));

  for (const video of newVideos) {
    seenVideoIds.add(video.videoId);
    console.log(`New YouTube video detected: ${video.title}`);
    await announceVideo(video);
  }
}

async function main() {
  console.log("YouTube watcher started...");
  console.log(`Watching playlist: ${YOUTUBE_PLAYLIST_ID}`);

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
