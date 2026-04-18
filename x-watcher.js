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

const POLL_INTERVAL = Number(process.env.X_LOOP_INTERVAL_MS || 60000);
const BACKOFF_ERROR = 5 * 60 * 1000;
const BACKOFF_CREDITS = 60 * 60 * 1000;

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "x-watcher-state.json");

// ================= UTILS =================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(...args) {
  console.log("[X WATCHER]", ...args);
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadState() {
  try {
    ensureDirSync(DATA_DIR);

    if (!fs.existsSync(STATE_FILE)) {
      return {
        lastTweetId: null,
        initialized: false,
        updatedAt: new Date().toISOString()
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      lastTweetId: parsed?.lastTweetId || null,
      initialized: Boolean(parsed?.initialized),
      updatedAt: parsed?.updatedAt || new Date().toISOString()
    };
  } catch (error) {
    log("state load error:", error.message);
    return {
      lastTweetId: null,
      initialized: false,
      updatedAt: new Date().toISOString()
    };
  }
}

function saveState() {
  try {
    ensureDirSync(DATA_DIR);
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          lastTweetId: state.lastTweetId,
          initialized: state.initialized,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    log("state save error:", error.message);
  }
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

// ================= DEBUG =================

log("=== ENV CHECK ===");
log("TOKEN EXISTS:", !!TWITTER_BEARER_TOKEN);
log("TOKEN LENGTH:", TWITTER_BEARER_TOKEN ? TWITTER_BEARER_TOKEN.length : 0);
log("USERNAME:", X_USERNAME);
log("FORWARD URL:", X_FORWARD_URL);

// ================= STATE =================

const state = loadState();
let backoffUntil = 0;

// ================= CORE =================

async function getUserId() {
  const url = `https://api.twitter.com/2/users/by/username/${X_USERNAME}`;

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
  const url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=5&tweet.fields=created_at`;

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

async function forwardTweet(tweet) {
  const res = await fetch(X_FORWARD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      secret: ADMIN_SECRET,
      source: "x_watcher",
      tweet: {
        id: tweet.id,
        text: tweet.text,
        createdAt: tweet.created_at || null,
        username: X_USERNAME,
        url: `https://x.com/${X_USERNAME}/status/${tweet.id}`
      }
    })
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
  } catch (e) {
    log("❌ Failed to resolve user:", e.message);
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

      // Warm start: first successful launch after empty state
      if (!state.initialized || !state.lastTweetId) {
        const newest = ordered[ordered.length - 1];
        state.lastTweetId = newest.id;
        state.initialized = true;
        saveState();
        log(`Warm start complete. Anchored at tweet ${state.lastTweetId}`);
        await sleep(POLL_INTERVAL);
        continue;
      }

      let forwardedAny = false;

      for (const t of ordered) {
        if (compareTweetIds(t.id, state.lastTweetId) > 0) {
          await forwardTweet(t);
          state.lastTweetId = t.id;
          state.initialized = true;
          saveState();
          forwardedAny = true;

          log("✅ Forwarded:", t.id);
        }
      }

      if (!forwardedAny) {
        log("No new tweets");
      }
    } catch (err) {
      handleError(err);
    }

    await sleep(POLL_INTERVAL);
  }
}

// ================= START =================

loop().catch(e => {
  log("FATAL:", e);
});
