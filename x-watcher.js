import fetch from "node-fetch";

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

const POLL_INTERVAL = 60000;
const BACKOFF_ERROR = 5 * 60 * 1000;
const BACKOFF_CREDITS = 60 * 60 * 1000;

// ================= UTILS =================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(...args) {
  console.log("[X WATCHER]", ...args);
}

// ================= DEBUG =================

log("=== ENV CHECK ===");
log("TOKEN EXISTS:", !!TWITTER_BEARER_TOKEN);
log("TOKEN LENGTH:", TWITTER_BEARER_TOKEN ? TWITTER_BEARER_TOKEN.length : 0);
log("USERNAME:", X_USERNAME);
log("FORWARD URL:", X_FORWARD_URL);

// ================= STATE =================

let lastTweetId = null;
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

  return data?.data || [];
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
        url: `https://x.com/${X_USERNAME}/status/${tweet.id}`
      }
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt);
  }
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

      const ordered = [...tweets].reverse();

      for (const t of ordered) {
        if (!lastTweetId || BigInt(t.id) > BigInt(lastTweetId)) {
          await forwardTweet(t);
          lastTweetId = t.id;

          log("✅ Forwarded:", t.id);
        }
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
