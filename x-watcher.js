// x-watcher.js

import fetch from "node-fetch";

const CHECK_INTERVAL = 60 * 1000; // 60 сек
const STUCK_RESET_MS = 15 * 60 * 1000; // 15 минут

// 👉 сюда вставь кого отслеживать
const TARGET_ACCOUNTS = [
  "chiikawa_kouhou"
];

// 👉 твой telegram bot api
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.FORCED_GROUP_CHAT_ID;

// 👉 гифки (можешь заменить)
const GIFS = [
  "https://media.giphy.com/media/3oriO0OEd9QIDdllqo/giphy.gif",
  "https://media.giphy.com/media/l0HlNaQ6gWfllcjDO/giphy.gif",
  "https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif"
];

// =======================
// STATE
// =======================

let lastSeen = {};
let lastActivity = Date.now();
let isRunning = false;

// =======================
// TELEGRAM
// =======================

async function sendToTelegram(text, gif) {
  try {
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

// =======================
// FETCH POSTS (NITTER)
// =======================

async function fetchTweets(username) {
  try {
    const url = `https://nitter.net/${username}/rss`;

    const res = await fetch(url);
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

// =======================
// PROCESS
// =======================

async function processAccount(username) {
  const posts = await fetchTweets(username);

  if (!posts.length) {
    console.log(`⚠️ no posts for ${username}`);
    return;
  }

  console.log(`📡 ${username}: ${posts.length} posts fetched`);

  if (!lastSeen[username]) {
    lastSeen[username] = posts[0].id;
    console.log("🧠 First run — syncing");
    return;
  }

  for (const post of posts.reverse()) {
    if (post.id === lastSeen[username]) continue;

    console.log("🚀 NEW POST:", post.text);

    const gif = GIFS[Math.floor(Math.random() * GIFS.length)];

    const message = `🐹 <b>Chiikawa detected new post!</b>

${post.text}

🔗 ${post.url}`;

    await sendToTelegram(message, gif);

    lastSeen[username] = post.id;
    lastActivity = Date.now();
  }
}

// =======================
// MAIN LOOP
// =======================

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

// =======================
// SELF-HEAL
// =======================

setInterval(async () => {
  await loop();
}, CHECK_INTERVAL);

// 👉 авто-реанимация если завис
setInterval(() => {
  const now = Date.now();

  if (now - lastActivity > STUCK_RESET_MS) {
    console.log("♻️ RESETTING WATCHER (stuck detected)");

    lastSeen = {};
    lastActivity = Date.now();
  }
}, 60 * 1000);

// =======================
// START
// =======================

export function startXWatcher() {
  console.log("👀 X Watcher started");

  loop(); // сразу первый запуск
}
