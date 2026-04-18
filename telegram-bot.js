import TelegramBot from "node-telegram-bot-api";
import Parser from "rss-parser";

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 2000,
    autoStart: true
  }
});

const parser = new Parser();

/* =========================
   GIF (через ENV file_id)
========================= */

function getEnvGifs(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

const GIFS = {
  ENTRY: getEnvGifs("GIF_ENTRY"),
  UPDATE: getEnvGifs("GIF_UPDATE"),
  EXIT: getEnvGifs("GIF_EXIT"),
  WIN: getEnvGifs("GIF_WIN"),
  LOSS: getEnvGifs("GIF_LOSS")
};

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sendGif(type) {
  try {
    const gif = rand(GIFS[type]);
    if (!gif) return;
    await bot.sendAnimation(CHAT_ID, gif);
  } catch (e) {
    console.log("GIF error:", e.message);
  }
}

/* =========================
   X WATCHER (встроенный)
========================= */

const WATCH_ACCOUNTS = ["chiikawa_kouhou"];

const lastSeen = {};
let watcherAlive = false;
let lastHeartbeat = Date.now();

function heartbeat() {
  lastHeartbeat = Date.now();
}

async function checkAccount(username) {
  const feed = await parser.parseURL(
    `https://nitter.net/${username}/rss`
  );

  if (!feed.items || feed.items.length === 0) {
    console.log(`⚠️ no posts for ${username}`);
    return;
  }

  for (const item of feed.items.slice(0, 5)) {
    if (lastSeen[item.id]) continue;

    lastSeen[item.id] = true;

    console.log(`🚨 NEW POST: ${item.title}`);

    await bot.sendMessage(
      CHAT_ID,
      `🚨 NEW POST\n\n${item.title}`
    );

    await sendGif("ENTRY");
  }
}

async function watcherLoop() {
  try {
    console.log("👀 watching...");
    for (const acc of WATCH_ACCOUNTS) {
      await checkAccount(acc);
    }
    heartbeat();
  } catch (e) {
    console.log("Watcher error:", e.message);
  }
}

function startWatcher() {
  if (watcherAlive) return;

  watcherAlive = true;

  console.log("🚀 X WATCHER STARTED");

  setInterval(watcherLoop, 15000);

  // анти-фриз
  setInterval(() => {
    const diff = Date.now() - lastHeartbeat;

    if (diff > 60000) {
      console.log("♻️ WATCHER RESTART");
      watcherAlive = false;
      startWatcher();
    }
  }, 30000);
}

/* =========================
   BOT
========================= */

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "🚀 Bot is alive");
});

bot.on("polling_error", (err) => {
  console.log("Polling error:", err.message);
});

/* =========================
   START
========================= */

async function bootstrap() {
  console.log("🤖 BOT STARTED");
  startWatcher();
}

bootstrap();
