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
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

const parser = new Parser();

/* =========================
   GIF CONFIG
========================= */

const GIFS = {
  ENTRY: [
    "https://tenor.com/vLMG1KGYUyT.gif",
    "https://tenor.com/pp5GdrEl62Z.gif",
    "https://tenor.com/sooKVCqgZq8.gif"
  ],
  UPDATE: [
    "https://tenor.com/ljj380KXDAP.gif",
    "https://tenor.com/fUK8Huu1U7Q.gif",
    "https://tenor.com/g9gHsoSlJt.gif",
    "https://tenor.com/sNFBJfQy31T.gif",
    "https://tenor.com/fMh0VLFKGyX.gif"
  ],
  EXIT: [
    "https://tenor.com/piMOnfwNEoX.gif",
    "https://tenor.com/iIn3jQbN5XN.gif",
    "https://tenor.com/b1s9E.gif"
  ],
  WIN: [
    "https://tenor.com/qZRXpxQ9cAd.gif",
    "https://tenor.com/lidNFsvSOfi.gif"
  ],
  LOSS: [
    "https://tenor.com/rWrXAZPADpT.gif",
    "https://tenor.com/sEo1VH4xE8q.gif"
  ]
};

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sendGif(type) {
  try {
    const gif = rand(GIFS[type]);
    await bot.sendAnimation(CHAT_ID, gif);
  } catch (e) {
    console.log("GIF error:", e.message);
  }
}

/* =========================
   X WATCHER (OLD STYLE PRO)
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

    console.log(`🚨 NEW POST from ${username}`);

    await bot.sendMessage(
      CHAT_ID,
      `🚨 *NEW POST DETECTED*\n\n${item.title}`,
      { parse_mode: "Markdown" }
    );

    await sendGif("ENTRY");
  }
}

async function watcherLoop() {
  try {
    for (const acc of WATCH_ACCOUNTS) {
      await checkAccount(acc);
    }

    heartbeat();
  } catch (e) {
    console.log("Watcher error:", e.message);
  }
}

/* =========================
   AUTO RESTART WATCHER
========================= */

function startWatcher() {
  if (watcherAlive) return;

  watcherAlive = true;

  console.log("🚀 X WATCHER STARTED (IMMORTAL)");

  setInterval(watcherLoop, 15000);

  // анти-фриз
  setInterval(() => {
    const diff = Date.now() - lastHeartbeat;

    if (diff > 60000) {
      console.log("♻️ WATCHER RESTART (freeze detected)");
      watcherAlive = false;
      startWatcher();
    }
  }, 30000);
}

/* =========================
   BOT COMMANDS
========================= */

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "🚀 Bot is alive");
});

bot.onText(/\/testgif/, async (msg) => {
  await sendGif("WIN");
});

/* =========================
   SAFE POLLING (ANTI 409)
========================= */

bot.on("polling_error", (err) => {
  console.log("Polling error:", err.message);

  if (err.code === "ETELEGRAM") {
    console.log("⚠️ Duplicate bot detected");
  }
});

/* =========================
   START SYSTEM
========================= */

async function bootstrap() {
  console.log("🤖 BOT STARTED");

  startWatcher();
}

bootstrap();
