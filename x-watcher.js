// x-watcher.js

import fetch from "node-fetch";

const CHECK_INTERVAL = 60000;
const TARGET_ACCOUNTS = ["chiikawa_kouhou"];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.FORCED_GROUP_CHAT_ID;

let lastSeen = {};
let isRunning = false;
let gifCursor = 0;

const GIFS = [
  "https://tenor.com/vLMG1KGYUyT.gif",
  "https://tenor.com/pp5GdrEl62Z.gif",
  "https://tenor.com/sooKVCqgZq8.gif"
];

function nextGif() {
  const gif = GIFS[gifCursor % GIFS.length];
  gifCursor++;
  return gif;
}

// ==============================
// TELEGRAM SEND
// ==============================

async function sendToTelegram(text, gif) {
  if (!TELEGRAM_BOT_TOKEN || !TG_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAnimation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        animation: gif,
        caption: text,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.log("❌ TG error:", err.message);
  }
}

// ==============================
// FETCH
// ==============================

async function fetchTweets(username) {
  try {
    const url = `https://nitter.poast.org/${username}/rss`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const xml = await res.text();

    const items = [...xml.matchAll(/<item>(.*?)<\/item>/gs)];

    return items.map(item => {
      const block = item[1];

      return {
        id: block.match(/<guid.*?>(.*?)<\/guid>/)?.[1],
        text: block.match(/<title>(.*?)<\/title>/)?.[1],
        url: block.match(/<link>(.*?)<\/link>/)?.[1]
      };
    });
  } catch (err) {
    console.log("❌ fetch error:", err.message);
    return [];
  }
}

// ==============================
// PROCESS
// ==============================

async function processAccount(username) {
  const posts = await fetchTweets(username);

  if (!posts.length) {
    console.log(`⚠️ no posts for ${username}`);
    return;
  }

  console.log(`📡 ${username}: ${posts.length} posts`);

  // 🧠 FIRST SYNC
  if (!lastSeen[username]) {
    console.log("🧠 first sync → skipping history");
    lastSeen[username] = posts[0]?.id;
    return;
  }

  const ordered = [...posts].reverse().slice(-3); // 🔥 максимум 3

  for (const post of ordered) {
    if (!post.id) continue;

    if (post.id === lastSeen[username]) break;

    console.log("🚀 NEW POST:", post.text);

    await sendToTelegram(
      `🐹 <b>Chiikawa detected new post!</b>

${post.text}

🔗 ${post.url}`,
      nextGif()
    );

    lastSeen[username] = post.id;
  }
}

// ==============================
// LOOP
// ==============================

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

// ==============================
// START
// ==============================

export function startXWatcher() {
  console.log("👀 X Watcher started");

  loop();

  setInterval(loop, CHECK_INTERVAL);
}
