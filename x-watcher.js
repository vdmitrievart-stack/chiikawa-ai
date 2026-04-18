// x-watcher.js

import fetch from "node-fetch";

const CHECK_INTERVAL = 60 * 1000;
const STUCK_RESET_MS = 15 * 60 * 1000;

const TARGET_ACCOUNTS = [
  "chiikawa_kouhou"
];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.FORCED_GROUP_CHAT_ID;

const GIFS = [
  "https://tenor.com/vLMG1KGYUyT.gif",
  "https://tenor.com/pp5GdrEl62Z.gif",
  "https://tenor.com/sooKVCqgZq8.gif"
];

let lastSeen = {};
let lastActivity = Date.now();
let isRunning = false;
let gifCursor = 0;

function nextGif() {
  if (!GIFS.length) return null;
  const gif = GIFS[gifCursor % GIFS.length];
  gifCursor = (gifCursor + 1) % GIFS.length;
  return gif;
}

async function sendToTelegram(text, gif) {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TG_CHAT_ID) return;

    if (gif) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAnimation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          animation: gif,
          caption: text,
          parse_mode: "HTML"
        })
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text,
          parse_mode: "HTML"
        })
      });
    }
  } catch (err) {
    console.log("❌ TG send error:", err.message);
  }
}

async function fetchTweets(username) {
  try {
    const url = `https://nitter.net/${username}/rss`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const xml = await res.text();

    const items = [...xml.matchAll(/<item>(.*?)<\/item>/gs)];

    return items.map(item => {
      const block = item[1];
      const title = block.match(/<title>(.*?)<\/title>/)?.[1] || "";
      const link = block.match(/<link>(.*?)<\/link>/)?.[1] || "";
      const guid = block.match(/<guid.*?>(.*?)<\/guid>/)?.[1] || "";

      return {
        id: guid || link,
        text: title,
        url: link
      };
    });
  } catch (err) {
    console.log("❌ fetchTweets error:", err.message);
    return [];
  }
}

async function processAccount(username) {
  const posts = await fetchTweets(username);

  if (!posts.length) {
    console.log(`⚠️ no posts for ${username}`);
    return;
  }

  console.log(`📡 ${username}: ${posts.length} posts fetched`);

  if (!lastSeen[username]) {
    lastSeen[username] = posts[0].id;
    console.log(`🧠 first sync for ${username}`);
    return;
  }

  const ordered = [...posts].reverse();

  for (const post of ordered) {
    if (!post.id || post.id === lastSeen[username]) continue;

    console.log("🚀 NEW POST:", post.text);

    const message = `🐹 <b>Chiikawa detected new post!</b>

${post.text}

🔗 ${post.url}`;

    await sendToTelegram(message, nextGif());

    lastSeen[username] = post.id;
    lastActivity = Date.now();
  }
}

async function loop() {
  if (isRunning) return;
  isRunning = true;

  try {
    for (const acc of TARGET_ACCOUNTS) {
      await processAccount(acc);
    }
  } catch (err) {
    console.log("❌ loop error:", err.message);
  }

  isRunning = false;
}

export function startXWatcher() {
  console.log("👀 X Watcher started");

  loop();

  setInterval(async () => {
    await loop();
  }, CHECK_INTERVAL);

  setInterval(() => {
    const now = Date.now();

    if (now - lastActivity > STUCK_RESET_MS) {
      console.log("♻️ RESETTING WATCHER (stuck detected)");
      lastSeen = {};
      lastActivity = Date.now();
    }
  }, 60 * 1000);
}
