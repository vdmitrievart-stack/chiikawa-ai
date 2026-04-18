import fetch from "node-fetch";
import fs from "fs";
import path from "path";

// ================= ENV =================

const TWITTER_BEARER_TOKEN =
  process.env.TWITTER_BEARER_TOKEN ||
  process.env.X_BEARER_TOKEN ||
  "";

const X_USERNAME = process.env.X_USERNAME || "Chiikawa_CTO";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";

const AI_BASE = CHIIKAWA_AI_URL.replace(/\/chat$/, "");
const X_FORWARD_URL = process.env.X_FORWARD_URL || `${AI_BASE}/watchers/x`;

const X_GIF_FILE_IDS = String(process.env.X_GIF_FILE_IDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const POLL_INTERVAL = Number(process.env.X_LOOP_INTERVAL_MS || 60000);
const BACKOFF_ERROR = 5 * 60 * 1000;
const BACKOFF_CREDITS = 60 * 60 * 1000;

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "x-watcher-state.json");

// ================= UTILS =================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(...args) {
  console.log("[X WATCHER]", ...args);
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeText(text) {
  return String(text || "").replace(/\r/g, "").trim();
}

function compareTweetIds(a, b) {
  try {
    const aa = BigInt(a);
    const bb = BigInt(b);
    if (aa > bb) return 1;
    if (aa < bb) return -1;
    return 0;
  } catch {
    if (String(a) > String(b)) return 1;
    if (String(a) < String(b)) return -1;
    return 0;
  }
}

function isRetweetText(text) {
  return /^RT\s+@/i.test(normalizeText(text));
}

function isReplyLikeText(text) {
  return /^@\w+/i.test(normalizeText(text));
}

function extractCas(text) {
  const matches = String(text || "").match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  return [...new Set(matches)];
}

function pickRandomGifFileId() {
  if (!X_GIF_FILE_IDS.length) return null;
  const index = Math.floor(Math.random() * X_GIF_FILE_IDS.length);
  return X_GIF_FILE_IDS[index];
}

function loadState() {
  try {
    ensureDirSync(DATA_DIR);

    if (!fs.existsSync(STATE_FILE)) {
      return {
        initialized: false,
        lastTweetId: null,
        recentForwardedIds: [],
        updatedAt: new Date().toISOString()
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      initialized: Boolean(parsed?.initialized),
      lastTweetId: parsed?.lastTweetId || null,
      recentForwardedIds: Array.isArray(parsed?.recentForwardedIds)
        ? parsed.recentForwardedIds
        : [],
      updatedAt: parsed?.updatedAt || new Date().toISOString()
    };
  } catch (error) {
    log("state load error:", error.message);
    return {
      initialized: false,
      lastTweetId: null,
      recentForwardedIds: [],
      updatedAt: new Date().toISOString()
    };
  }
}

function saveState() {
  try {
    ensureDirSync(DATA_DIR);

    const next = {
      initialized: state.initialized,
      lastTweetId: state.lastTweetId,
      recentForwardedIds: state.recentForwardedIds.slice(0, 500),
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
  } catch (error) {
    log("state save error:", error.message);
  }
}

function wasRecentlyForwarded(tweetId) {
  return state.recentForwardedIds.includes(String(tweetId));
}

function markForwarded(tweetId) {
  state.recentForwardedIds.unshift(String(tweetId));
  state.recentForwardedIds = state.recentForwardedIds.slice(0, 500);
  state.lastTweetId = String(tweetId);
  state.initialized = true;
  saveState();
}

function buildOldWatcherComment(tweetText, cas) {
  const lines = [];

  if (cas.length) {
    lines.push("Chiikawa detected a new post ✨");
    lines.push("Something shiny appeared.");
    lines.push(`CA spotted: ${cas[0]}`);
  } else {
    lines.push("Chiikawa detected a new post ✨");
    lines.push("Fresh movement from the nest.");
  }

  return lines.join("\n");
}

function buildStyledCaption({ username, tweetText, tweetId, createdAt, comment, cas }) {
  const url = `https://x.com/${username}/status/${tweetId}`;

  const parts = [
    escapeHtml(comment),
    "",
    `🐦 <b>New X post detected</b>`,
    `<b>@${escapeHtml(username)}</b>`
  ];

  if (createdAt) {
    parts.push(escapeHtml(createdAt));
  }

  parts.push("");

  if (tweetText) {
    parts.push(escapeHtml(tweetText));
    parts.push("");
  }

  if (cas.length) {
    parts.push(`<b>CA:</b> <code>${escapeHtml(cas[0])}</code>`);
    parts.push("");
  }

  parts.push(escapeHtml(url));

  return parts.join("\n").slice(0, 1024);
}

// ================= DEBUG =================

log("=== ENV CHECK ===");
log("TOKEN EXISTS:", !!TWITTER_BEARER_TOKEN);
log("TOKEN LENGTH:", TWITTER_BEARER_TOKEN ? TWITTER_BEARER_TOKEN.length : 0);
log("USERNAME:", X_USERNAME);
log("FORWARD URL:", X_FORWARD_URL);
log("GIF COUNT:", X_GIF_FILE_IDS.length);

// ================= STATE =================

const state = loadState();
let backoffUntil = 0;

// ================= CORE =================

async function getUserId() {
  const url = `https://api.twitter.com/2/users/by/username/${encodeURIComponent(X_USERNAME)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`
    }
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data?.data?.id;
}

async function getTweets(userId) {
  const url =
    `https://api.twitter.com/2/users/${encodeURIComponent(userId)}/tweets` +
    `?max_results=5&tweet.fields=created_at`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`
    }
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }

  return Array.isArray(data?.data) ? data.data : [];
}

async function forwardStyledPost(tweet) {
  const tweetText = normalizeText(tweet.text);
  const cas = extractCas(tweetText);
  const comment = buildOldWatcherComment(tweetText, cas);
  const gifFileId = pickRandomGifFileId();

  const payload = {
    secret: ADMIN_SECRET,
    source: "x_watcher",
    payloadVersion: "old_watcher_style_v1",
    tweet: {
      id: String(tweet.id),
      username: X_USERNAME,
      text: tweetText,
      createdAt: tweet.created_at || null,
      url: `https://x.com/${X_USERNAME}/status/${tweet.id}`
    },
    styledPost: {
      mode: "old_watcher_style",
      gifFileId: gifFileId || null,
      comment,
      caption: buildStyledCaption({
        username: X_USERNAME,
        tweetText,
        tweetId: tweet.id,
        createdAt: tweet.created_at || null,
        comment,
        cas
      })
    }
  };

  const res = await fetch(X_FORWARD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`);
  }

  if (data && data.ok === false) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

// ================= ERROR =================

function handleError(err) {
  const msg = err.message || "";

  if (msg.includes("CreditsDepleted")) {
    log("🚫 Credits depleted → cooldown 1h");
    backoffUntil = Date.now() + BACKOFF_CREDITS;
    return;
  }

  if (!TWITTER_BEARER_TOKEN) {
    log("❌ TOKEN NOT FOUND IN ENV");
    backoffUntil = Date.now() + BACKOFF_ERROR;
    return;
  }

  log("⚠️ API ERROR:", msg);
  backoffUntil = Date.now() + BACKOFF_ERROR;
}

// ================= LOOP =================

async function loop() {
  log("🚀 WATCHER STARTED");

  if (!TWITTER_BEARER_TOKEN) {
    log("❌ FATAL: NO TWITTER_BEARER_TOKEN");
    return;
  }

  let userId;

  try {
    userId = await getUserId();
    log("User ID:", userId);
  } catch (error) {
    log("❌ Failed to resolve user:", error.message);
    return;
  }

  while (true) {
    try {
      if (Date.now() < backoffUntil) {
        const sec = Math.ceil((backoffUntil - Date.now()) / 1000);
        log(`⏳ Backoff (${sec}s)`);
        await sleep(5000);
        continue;
      }

      const tweets = await getTweets(userId);

      if (!tweets.length) {
        log("No tweets");
        await sleep(POLL_INTERVAL);
        continue;
      }

      const ordered = [...tweets].sort((a, b) => compareTweetIds(a.id, b.id));

      // Warm start: do not flush old backlog after a cold boot / empty state
      if (!state.initialized || !state.lastTweetId) {
        const newest = ordered[ordered.length - 1];
        state.lastTweetId = String(newest.id);
        state.initialized = true;
        saveState();
        log(`Warm start complete. Anchored at tweet ${state.lastTweetId}`);
        await sleep(POLL_INTERVAL);
        continue;
      }

      let anyForwarded = false;

      for (const tweet of ordered) {
        const tweetId = String(tweet.id);
        const tweetText = normalizeText(tweet.text);

        if (compareTweetIds(tweetId, state.lastTweetId) <= 0) {
          continue;
        }

        if (wasRecentlyForwarded(tweetId)) {
          continue;
        }

        if (isRetweetText(tweetText)) {
          log("Skipped retweet:", tweetId);
          markForwarded(tweetId);
          continue;
        }

        if (isReplyLikeText(tweetText)) {
          log("Skipped reply-like post:", tweetId);
          markForwarded(tweetId);
          continue;
        }

        await forwardStyledPost(tweet);
        markForwarded(tweetId);
        anyForwarded = true;

        log("✅ Forwarded old-style post:", tweetId);
      }

      if (!anyForwarded) {
        log("No new tweets");
      }
    } catch (error) {
      handleError(error);
    }

    await sleep(POLL_INTERVAL);
  }
}

// ================= START =================

loop().catch(error => {
  log("FATAL:", error);
});
