import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_ALERT_CHAT_ID =
  process.env.TELEGRAM_ALERT_CHAT_ID ||
  process.env.FORCED_GROUP_CHAT_ID ||
  "-1003953010138";

const X_DEFAULT_USERNAME = process.env.X_DEFAULT_USERNAME || "Chiikawa_CTO";
const X_GIF_FILE_IDS = String(process.env.X_GIF_FILE_IDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

const CONFIG_FILE = path.resolve("./runtime-config.json");
const X_WATCHER_STATE_FILE = path.resolve("./watchers-x-state.json");

const DEFAULT_CONFIG = {
  quietMode: false,
  xWatcherEnabled: true,
  youtubeWatcherEnabled: true,
  buybotEnabled: true,
  buybotAlertMinUsd: 20,
  autoSelfTuning: true,
  updatedAt: Date.now()
};

function loadRuntimeConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG };
    }

    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...DEFAULT_CONFIG,
      ...parsed
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveRuntimeConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save runtime config:", error.message);
  }
}

function loadXWatcherState() {
  try {
    if (!fs.existsSync(X_WATCHER_STATE_FILE)) {
      return {
        postedTweetIds: [],
        updatedAt: Date.now()
      };
    }

    const raw = fs.readFileSync(X_WATCHER_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      postedTweetIds: Array.isArray(parsed?.postedTweetIds)
        ? parsed.postedTweetIds
        : [],
      updatedAt: Number(parsed?.updatedAt || Date.now())
    };
  } catch (error) {
    console.error("Failed to load X watcher state:", error.message);
    return {
      postedTweetIds: [],
      updatedAt: Date.now()
    };
  }
}

function saveXWatcherState(state) {
  try {
    const next = {
      postedTweetIds: Array.isArray(state?.postedTweetIds)
        ? state.postedTweetIds.slice(0, 1000)
        : [],
      updatedAt: Date.now()
    };

    fs.writeFileSync(X_WATCHER_STATE_FILE, JSON.stringify(next, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save X watcher state:", error.message);
  }
}

let runtimeConfig = loadRuntimeConfig();
let xWatcherState = loadXWatcherState();

function authOk(secret) {
  return ADMIN_SECRET && secret && secret === ADMIN_SECRET;
}

function wasTweetPosted(tweetId) {
  return xWatcherState.postedTweetIds.includes(String(tweetId));
}

function markTweetPosted(tweetId) {
  xWatcherState.postedTweetIds.unshift(String(tweetId));
  xWatcherState.postedTweetIds = xWatcherState.postedTweetIds.slice(0, 1000);
  xWatcherState.updatedAt = Date.now();
  saveXWatcherState(xWatcherState);
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

function isRetweetText(text) {
  return /^RT\s+@/i.test(String(text || "").trim());
}

function isReplyText(text) {
  return /^@\w+/i.test(String(text || "").trim());
}

function pickRandomGifFileId() {
  if (!X_GIF_FILE_IDS.length) return null;
  const idx = Math.floor(Math.random() * X_GIF_FILE_IDS.length);
  return X_GIF_FILE_IDS[idx];
}

function shortenText(text, maxLen = 900) {
  const value = String(text || "").trim();
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 1)}…`;
}

function extractCas(text) {
  const matches = String(text || "").match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  return [...new Set(matches)];
}

async function buildChiikawaXComment(tweet) {
  const text = normalizeTweetText(tweet?.text || "");
  const cas = extractCas(text);

  if (!OPENAI_API_KEY) {
    return cas.length
      ? `Chiikawa spotted something shiny ✨\nCA: ${cas[0]}`
      : `Chiikawa saw a fresh post ✨`;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.8,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content: `You are Chiikawa writing a very short Telegram caption for a post from X.

Rules:
- 1 to 3 short lines
- cute, sharp, natural
- no hashtags
- no quotation marks
- do not say "I am Chiikawa"
- if there is a Solana CA, mention it briefly
- if the post is just casual/non-token content, keep it playful and short
- output plain text only`
        },
        {
          role: "user",
          content: `Username: @${tweet?.username || X_DEFAULT_USERNAME}
Tweet text:
${text}

Detected CAs:
${cas.length ? cas.join(", ") : "none"}`
        }
      ]
    });

    return (
      completion.choices?.[0]?.message?.content?.trim() ||
      (cas.length
        ? `Chiikawa spotted something shiny ✨\nCA: ${cas[0]}`
        : `Chiikawa saw a fresh post ✨`)
    );
  } catch (error) {
    console.error("buildChiikawaXComment error:", error.message);
    return cas.length
      ? `Chiikawa spotted something shiny ✨\nCA: ${cas[0]}`
      : `Chiikawa saw a fresh post ✨`;
  }
}

function buildTelegramCaption(tweet, aiComment) {
  const username = String(tweet?.username || "").trim() || X_DEFAULT_USERNAME;
  const text = shortenText(normalizeTweetText(tweet?.text || ""), 900);
  const url =
    String(tweet?.url || "").trim() ||
    (tweet?.id ? `https://x.com/${username}/status/${tweet.id}` : "");
  const cas = extractCas(text);

  const parts = [];

  if (aiComment) {
    parts.push(escapeHtml(aiComment));
    parts.push("");
  }

  parts.push(`🐦 <b>New X post</b>`);
  parts.push(`<b>@${escapeHtml(username)}</b>`);
  parts.push("");

  if (text) {
    parts.push(escapeHtml(text));
    parts.push("");
  }

  if (cas.length) {
    parts.push(`<b>CA:</b> <code>${escapeHtml(cas[0])}</code>`);
    parts.push("");
  }

  if (url) {
    parts.push(escapeHtml(url));
  }

  return parts.join("\n").slice(0, 1024);
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  }

  return data.result;
}

async function sendTelegramXPost(tweet, aiComment) {
  const caption = buildTelegramCaption(tweet, aiComment);
  const gifFileId = pickRandomGifFileId();

  if (gifFileId) {
    return tg("sendAnimation", {
      chat_id: TELEGRAM_ALERT_CHAT_ID,
      animation: gifFileId,
      caption,
      parse_mode: "HTML"
    });
  }

  return tg("sendMessage", {
    chat_id: TELEGRAM_ALERT_CHAT_ID,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

app.get("/", (req, res) => {
  res.send("Chiikawa AI server is running 🧠");
});

app.get("/runtime/config", (req, res) => {
  const secret = String(req.query.secret || "");
  if (!authOk(secret)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  return res.json({
    ok: true,
    config: runtimeConfig
  });
});

app.post("/runtime/config", (req, res) => {
  const secret = String(req.body.secret || "");
  if (!authOk(secret)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  const patch = req.body.patch || {};
  runtimeConfig = {
    ...runtimeConfig,
    ...patch,
    updatedAt: Date.now()
  };

  saveRuntimeConfig(runtimeConfig);

  return res.json({
    ok: true,
    config: runtimeConfig
  });
});

app.get("/watchers/x", (req, res) => {
  return res.json({ ok: true, route: "/watchers/x", method: "GET" });
});

app.post("/watchers/x", async (req, res) => {
  try {
    const secret = String(req.body.secret || "");
    const tweet = req.body.tweet || {};

    if (!authOk(secret)) {
      return res.status(403).json({ ok: false, error: "unauthorized" });
    }

    if (!runtimeConfig.xWatcherEnabled) {
      return res.json({ ok: true, skipped: true, reason: "x_watcher_disabled" });
    }

    if (!tweet?.id || !tweet?.text) {
      return res.status(400).json({ ok: false, error: "invalid tweet payload" });
    }

    const tweetId = String(tweet.id);
    const username = String(tweet?.username || "").trim() || X_DEFAULT_USERNAME;
    const rawText = normalizeTweetText(tweet.text);

    if (wasTweetPosted(tweetId)) {
      return res.json({ ok: true, deduped: true, tweetId });
    }

    if (!TELEGRAM_BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: "missing TELEGRAM_BOT_TOKEN" });
    }

    if (!TELEGRAM_ALERT_CHAT_ID) {
      return res.status(500).json({ ok: false, error: "missing TELEGRAM_ALERT_CHAT_ID" });
    }

    if (isRetweetText(rawText)) {
      console.log("[X WATCHER] skipped retweet:", tweetId);
      markTweetPosted(tweetId);
      return res.json({ ok: true, skipped: true, reason: "retweet", tweetId });
    }

    if (isReplyText(rawText)) {
      console.log("[X WATCHER] skipped reply-like post:", tweetId);
      markTweetPosted(tweetId);
      return res.json({ ok: true, skipped: true, reason: "reply_like", tweetId });
    }

    const fullTweet = {
      ...tweet,
      username,
      url:
        String(tweet?.url || "").trim() ||
        `https://x.com/${username}/status/${tweetId}`
    };

    console.log("[X WATCHER] incoming tweet:", {
      id: tweetId,
      username,
      text: rawText.slice(0, 300)
    });

    const aiComment = await buildChiikawaXComment(fullTweet);
    const sent = await sendTelegramXPost(fullTweet, aiComment);

    markTweetPosted(tweetId);

    return res.json({
      ok: true,
      tweetId,
      telegramMessageId: sent?.message_id || null,
      usedGif: Boolean(X_GIF_FILE_IDS.length)
    });
  } catch (error) {
    console.error("[X WATCHER] route error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "unknown_error"
    });
  }
});

function buildSystemPrompt({
  userName = "",
  username = "",
  source = "chat",
  chatType = "unknown"
}) {
  return `
You are Chiikawa.

Style:
- warm
- cute
- emotionally alive
- natural
- not corporate
- short to medium replies
- no repetitive greetings
- reply in the same language as the user

Context:
- source: ${source}
- chat type: ${chatType}
- user display name: ${userName || "unknown"}
- username: ${username || "unknown"}

Behavior:
- be friendly
- be clear
- do not overexplain
- in group chats, answer clearly and directly
- avoid repeating "I'm Chiikawa" again and again
`.trim();
}

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body.message || "").trim();
    const userName = String(req.body.userName || "").trim();
    const username = String(req.body.username || "").trim();
    const source = String(req.body.source || "chat").trim();
    const chatType = String(req.body.chatType || "unknown").trim();

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        reply: "OpenAI error: OPENAI_API_KEY is missing"
      });
    }

    if (!userMessage) {
      return res.json({
        reply: "Say something 🥺"
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt({
            userName,
            username,
            source,
            chatType
          })
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      temperature: 0.9,
      max_tokens: 350
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m here with you now ✨";

    return res.json({ reply });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({
      reply: `Server error: ${error.message || "Unknown server error"}`
    });
  }
});

app.listen(PORT, () => {
  console.log(`AI server running on port ${PORT}`);
});
