import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const router = express.Router();

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "watchers-x-state.json");

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadState() {
  try {
    ensureDirSync(DATA_DIR);

    if (!fs.existsSync(STATE_FILE)) {
      return {
        postedTweetIds: [],
        updatedAt: new Date().toISOString()
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      postedTweetIds: Array.isArray(parsed?.postedTweetIds)
        ? parsed.postedTweetIds
        : [],
      updatedAt: parsed?.updatedAt || new Date().toISOString()
    };
  } catch (error) {
    console.error("[watchers-x-route] loadState error:", error.message);
    return {
      postedTweetIds: [],
      updatedAt: new Date().toISOString()
    };
  }
}

let state = loadState();

function saveState() {
  try {
    ensureDirSync(DATA_DIR);
    state.postedTweetIds = state.postedTweetIds.slice(0, 500);
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("[watchers-x-route] saveState error:", error.message);
  }
}

function wasPosted(tweetId) {
  return state.postedTweetIds.includes(String(tweetId));
}

function markPosted(tweetId) {
  state.postedTweetIds.unshift(String(tweetId));
  saveState();
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeTweetText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .trim();
}

function buildTelegramMessage(tweet) {
  const username = tweet?.username || "unknown";
  const text = normalizeTweetText(tweet?.text || "");
  const url = tweet?.url || "";
  const createdAt = tweet?.createdAt || "";

  const parts = [
    `🐦 <b>New X post</b>`,
    "",
    `<b>@${escapeHtml(username)}</b>`
  ];

  if (createdAt) {
    parts.push(escapeHtml(createdAt));
  }

  parts.push("");

  if (text) {
    parts.push(escapeHtml(text));
    parts.push("");
  }

  if (url) {
    parts.push(escapeHtml(url));
  }

  return parts.join("\n");
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
  }

  return data.result;
}

router.post("/watchers/x", async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SECRET || "";
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
    const telegramChatId =
      process.env.TELEGRAM_ALERT_CHAT_ID ||
      process.env.FORCED_GROUP_CHAT_ID ||
      "-1003953010138";

    const { secret, tweet } = req.body || {};

    if (!adminSecret) {
      return res.status(500).json({ ok: false, error: "missing ADMIN_SECRET on server" });
    }

    if (secret !== adminSecret) {
      return res.status(403).json({ ok: false, error: "unauthorized" });
    }

    if (!tweet || !tweet.id || !tweet.text) {
      return res.status(400).json({ ok: false, error: "invalid tweet payload" });
    }

    const tweetId = String(tweet.id);

    if (wasPosted(tweetId)) {
      return res.json({
        ok: true,
        deduped: true,
        tweetId
      });
    }

    if (!telegramBotToken) {
      return res.status(500).json({ ok: false, error: "missing TELEGRAM_BOT_TOKEN on server" });
    }

    const message = buildTelegramMessage(tweet);
    const sent = await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: telegramChatId,
      text: message
    });

    markPosted(tweetId);

    console.log("[watchers-x-route] posted tweet to telegram:", {
      tweetId,
      username: tweet?.username || null,
      telegramMessageId: sent?.message_id || null
    });

    return res.json({
      ok: true,
      tweetId,
      telegramMessageId: sent?.message_id || null
    });
  } catch (error) {
    console.error("[watchers-x-route] route error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "unknown_error"
    });
  }
});

export default router;
