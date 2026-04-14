import fetch from "node-fetch";
import fs from "fs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const X_GIF_FILE_IDS = process.env.X_GIF_FILE_IDS || "";

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// 👉 файл состояния
const STATE_FILE = "./state.json";

let state = {
  sentTweets: [],
  lastStartupMessage: 0
};

// загрузка состояния
if (fs.existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE));
  } catch {}
}

// сохранить
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// 👉 GIF
const GIFS = X_GIF_FILE_IDS.split(",").map(x => x.trim()).filter(Boolean);
let lastGif = null;

function getGif() {
  if (!GIFS.length) return null;

  const filtered = GIFS.filter(g => g !== lastGif);
  const gif = filtered[Math.floor(Math.random() * filtered.length)];

  lastGif = gif;
  return gif;
}

// 👉 Telegram
async function sendMessage(text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_ALERT_CHAT_ID,
      text
    })
  });
}

async function sendGif(fileId) {
  await fetch(`${TG_API}/sendAnimation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_ALERT_CHAT_ID,
      animation: fileId
    })
  });
}

// 👉 анти-спам старта (раз в 6 часов максимум)
async function sendStartup() {
  const now = Date.now();

  if (now - state.lastStartupMessage < 6 * 60 * 60 * 1000) {
    return;
  }

  state.lastStartupMessage = now;
  saveState();

  await sendMessage("🐦 X watcher is live");
}

// 👉 X API
const BEARER = process.env.X_BEARER_TOKEN;

async function fetchTweets() {
  const url =
    "https://api.twitter.com/2/tweets/search/recent?query=chiikawa&max_results=5&tweet.fields=author_id";

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${BEARER}`
    }
  });

  const data = await res.json();

  return data.data || [];
}

// 👉 анти-дубли
function isDuplicate(id) {
  return state.sentTweets.includes(id);
}

function remember(id) {
  state.sentTweets.push(id);

  // лимит
  if (state.sentTweets.length > 200) {
    state.sentTweets = state.sentTweets.slice(-200);
  }

  saveState();
}

// 👉 основной цикл
async function loop() {
  console.log("X watcher started");

  await sendStartup();

  while (true) {
    try {
      const tweets = await fetchTweets();

      for (const t of tweets) {
        if (isDuplicate(t.id)) continue;

        console.log("NEW:", t.id);

        const gif = getGif();

        if (gif) {
          await sendGif(gif);
        }

        await sendMessage(
          `🔥 Chiikawa on X\n\nhttps://twitter.com/i/web/status/${t.id}`
        );

        remember(t.id);
      }
    } catch (e) {
      console.log("error", e.message);
    }

    await new Promise(r => setTimeout(r, 60000));
  }
}

loop();
