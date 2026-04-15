import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import http from "http";
import { buildBuybotReactionPrompt } from "./personality-engine.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";

// Dexscreener pair
const PAIR_ID =
  process.env.DEXSCREENER_PAIR_ID ||
  "ey75tsmuy7gnb3noq7pdcjg8gxczthou6h6xjwccfvh3";

const PORT = Number(process.env.PORT || 10000);
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const STATE_FILE = path.resolve("./buybot-state.json");

// Config
const LOOP_INTERVAL_MS = Number(process.env.BUYBOT_LOOP_INTERVAL_MS || 15000);
const ALERT_MIN_USD = Number(process.env.BUYBOT_ALERT_MIN_USD || 20);
const STRONG_BUY_USD = Number(process.env.BUYBOT_STRONG_BUY_USD || 300);
const WHALE_BUY_USD = Number(process.env.BUYBOT_WHALE_BUY_USD || 1000);
const COOLDOWN_MS = Number(process.env.BUYBOT_COOLDOWN_MS || 60000);
const BUYBOT_GIF_FILE_IDS = process.env.BUYBOT_GIF_FILE_IDS || "";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALERT_CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID");
  process.exit(1);
}

const GIF_POOL = BUYBOT_GIF_FILE_IDS
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

let lastGifUsed = null;

function pickRandomGif(pool) {
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0];

  const candidates = pool.filter(gif => gif !== lastGifUsed);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  lastGifUsed = chosen;
  return chosen;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        baseline: null,
        lastAlertAt: 0,
        lastSignature: null
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      baseline: parsed.baseline || null,
      lastAlertAt: Number(parsed.lastAlertAt || 0),
      lastSignature: parsed.lastSignature || null
    };
  } catch (error) {
    console.error("Failed to load buybot state:", error.message);
    return {
      baseline: null,
      lastAlertAt: 0,
      lastSignature: null
    };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save buybot state:", error.message);
  }
}

const state = loadState();

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

async function sendGif(fileId, caption = "") {
  return tg("sendDocument", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    document: fileId,
    caption
  });
}

function buildDexUrl() {
  return `https://api.dexscreener.com/latest/dex/pairs/solana/${PAIR_ID}`;
}

async function fetchPairData() {
  const res = await fetch(buildDexUrl());
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Dexscreener API error: ${JSON.stringify(data)}`);
  }

  const pair = data.pair || (Array.isArray(data.pairs) ? data.pairs[0] : null);

  if (!pair) {
    throw new Error("Dexscreener pair not found");
  }

  return {
    pairId: pair.pairAddress || PAIR_ID,
    url: pair.url || `https://dexscreener.com/solana/${PAIR_ID}`,
    priceUsd: Number(pair.priceUsd || 0),
    fdv: Number(pair.fdv || 0),
    marketCap: Number(pair.marketCap || 0),
    volumeM5: Number(pair.volume?.m5 || 0),
    volumeH1: Number(pair.volume?.h1 || 0),
    buysM5: Number(pair.txns?.m5?.buys || 0),
    sellsM5: Number(pair.txns?.m5?.sells || 0),
    buysH1: Number(pair.txns?.h1?.buys || 0),
    sellsH1: Number(pair.txns?.h1?.sells || 0),
    liquidityUsd: Number(pair.liquidity?.usd || 0),
    pairName: `${pair.baseToken?.symbol || "TOKEN"}/${pair.quoteToken?.symbol || "SOL"}`
  };
}

function buildBaselineSignature(snapshot) {
  return [
    snapshot.volumeM5,
    snapshot.buysM5,
    snapshot.sellsM5,
    snapshot.priceUsd
  ].join("|");
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "$0";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function classifyBuy(avgBuyUsd) {
  if (avgBuyUsd >= WHALE_BUY_USD) return "whale";
  if (avgBuyUsd >= STRONG_BUY_USD) return "strong";
  return "normal";
}

function buildBuyMessage(snapshot, avgBuyUsd, buysDelta, reaction) {
  const type = classifyBuy(avgBuyUsd);

  if (type === "whale") {
    return `🐋 HUGE BUY ALERT!!!

Estimated buy size:
${formatUsd(avgBuyUsd)}

Buys detected:
${buysDelta}

${reaction ? `💭 ${reaction}\n` : ""}Pair:
${snapshot.pairName}

Price:
$${snapshot.priceUsd}

Dex:
${snapshot.url}

Chiikawa is shaking with excitement 🥺✨`;
  }

  if (type === "strong") {
    return `🚀 Strong buy detected

Estimated buy size:
${formatUsd(avgBuyUsd)}

Buys detected:
${buysDelta}

${reaction ? `💭 ${reaction}\n` : ""}Pair:
${snapshot.pairName}

Price:
$${snapshot.priceUsd}

Dex:
${snapshot.url}

The community is getting stronger ✨`;
  }

  return `✨ New buy detected

Estimated buy size:
${formatUsd(avgBuyUsd)}

Buys detected:
${buysDelta}

${reaction ? `💭 ${reaction}\n` : ""}Pair:
${snapshot.pairName}

Price:
$${snapshot.priceUsd}

Dex:
${snapshot.url}

Every friend matters 🥺`;
}

async function askChiikawaForBuyReaction(kind, amountUsd) {
  try {
    const prompt = buildBuybotReactionPrompt(kind, amountUsd);

    const res = await fetch(CHIIKAWA_AI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: prompt,
        sessionId: `buy_${kind}_${amountUsd}`,
        mode: "normal"
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(`Chiikawa backend error: ${JSON.stringify(data)}`);
    }

    const reply = String(data.reply || "").trim();
    return reply || null;
  } catch (error) {
    console.error("Buybot AI reaction error:", error.message);
    return null;
  }
}

async function maybeSendBuyAlert(snapshot) {
  const currentSignature = buildBaselineSignature(snapshot);

  if (!state.baseline) {
    state.baseline = snapshot;
    state.lastSignature = currentSignature;
    saveState(state);
    console.log("Buybot baseline initialized");
    return;
  }

  const previous = state.baseline;

  const buysDelta = snapshot.buysM5 - previous.buysM5;
  const volumeDelta = snapshot.volumeM5 - previous.volumeM5;
  const now = Date.now();

  state.baseline = snapshot;

  if (buysDelta <= 0 || volumeDelta <= 0) {
    state.lastSignature = currentSignature;
    saveState(state);
    return;
  }

  const avgBuyUsd = volumeDelta / buysDelta;

  if (!Number.isFinite(avgBuyUsd) || avgBuyUsd < ALERT_MIN_USD) {
    state.lastSignature = currentSignature;
    saveState(state);
    return;
  }

  if (state.lastSignature === currentSignature) {
    console.log("Buybot duplicate prevented by signature");
    saveState(state);
    return;
  }

  if (now - state.lastAlertAt < COOLDOWN_MS) {
    console.log("Buybot cooldown active");
    state.lastSignature = currentSignature;
    saveState(state);
    return;
  }

  const kind = classifyBuy(avgBuyUsd);
  const reaction = await askChiikawaForBuyReaction(kind, Math.round(avgBuyUsd));
  const gif = pickRandomGif(GIF_POOL);

  if (gif) {
    try {
      await sendGif(gif, reaction || "✨");
    } catch (error) {
      console.error("Buybot GIF send error:", error.message);
    }
  }

  const message = buildBuyMessage(snapshot, avgBuyUsd, buysDelta, reaction);
  await sendText(message);

  state.lastAlertAt = now;
  state.lastSignature = currentSignature;
  saveState(state);
}

async function loop() {
  console.log("Buybot PRO MAX started...");
  console.log("Pair ID:", PAIR_ID);
  console.log("GIF pool size:", GIF_POOL.length);
  console.log("AI backend:", CHIIKAWA_AI_URL);

  while (true) {
    try {
      const snapshot = await fetchPairData();
      await maybeSendBuyAlert(snapshot);
    } catch (error) {
      console.error("Buybot error:", error.message);
    }

    await sleep(LOOP_INTERVAL_MS);
  }
}

// Health server for Render Web Service
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "chiikawa-buybot" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Chiikawa buybot is running");
});

server.listen(PORT, () => {
  console.log(`Buybot health server listening on port ${PORT}`);
  loop().catch(error => {
    console.error("Fatal buybot loop error:", error.message);
    process.exit(1);
  });
});
