import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN || "";
const X_USERNAME = process.env.X_USERNAME || process.env.TWITTER_USERNAME || "";
const X_USER_ID = process.env.X_USER_ID || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const CHIIKAWA_AI_URL =
  process.env.CHIIKAWA_AI_URL || "https://chiikawa-ai.onrender.com/chat";

const AI_SERVER_BASE_URL =
  process.env.AI_SERVER_BASE_URL ||
  (CHIIKAWA_AI_URL || "").replace(/\/chat$/, "") ||
  "https://chiikawa-ai.onrender.com";

const X_FORWARD_URL =
  process.env.X_FORWARD_URL || `${AI_SERVER_BASE_URL}/watchers/x`;

const POLL_INTERVAL_MS = Number(process.env.X_POLL_INTERVAL_MS || 60_000);
const CREDIT_BACKOFF_MS = Number(process.env.X_CREDIT_BACKOFF_MS || 60 * 60 * 1000);
const ERROR_BACKOFF_MS = Number(process.env.X_ERROR_BACKOFF_MS || 5 * 60 * 1000);
const MAX_TWEETS_PER_POLL = Math.max(
  5,
  Math.min(20, Number(process.env.X_MAX_TWEETS_PER_POLL || 10))
);

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "x-watcher-state.json");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function loadState() {
  try {
    ensureDirSync(DATA_DIR);

    if (!fs.existsSync(STATE_FILE)) {
      return {
        resolvedUserId: "",
        lastSeenTweetId: "",
        postedTweetIds: [],
        backoffUntil: 0,
        backoffReason: "",
        lastCreditsErrorAt: 0,
        stats: {
          polls: 0,
          apiCalls: 0,
          tweetsSeen: 0,
          tweetsForwarded: 0,
          forwardFailures: 0,
          apiFailures: 0
        },
        updatedAt: nowIso()
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      resolvedUserId: parsed?.resolvedUserId || "",
      lastSeenTweetId: parsed?.lastSeenTweetId || "",
      postedTweetIds: Array.isArray(parsed?.postedTweetIds) ? parsed.postedTweetIds : [],
      backoffUntil: Number(parsed?.backoffUntil || 0),
      backoffReason: parsed?.backoffReason || "",
      lastCreditsErrorAt: Number(parsed?.lastCreditsErrorAt || 0),
      stats: parsed?.stats && typeof parsed.stats === "object"
        ? parsed.stats
        : {
            polls: 0,
            apiCalls: 0,
            tweetsSeen: 0,
            tweetsForwarded: 0,
            forwardFailures: 0,
            apiFailures: 0
          },
      updatedAt: parsed?.updatedAt || nowIso()
    };
  } catch (error) {
    console.error("loadState error:", error.message);
    return {
      resolvedUserId: "",
      lastSeenTweetId: "",
      postedTweetIds: [],
      backoffUntil: 0,
      backoffReason: "",
      lastCreditsErrorAt: 0,
      stats: {
        polls: 0,
        apiCalls: 0,
        tweetsSeen: 0,
        tweetsForwarded: 0,
        forwardFailures: 0,
        apiFailures: 0
      },
      updatedAt: nowIso()
    };
  }
}

let state = loadState();

function saveState() {
  try {
    ensureDirSync(DATA_DIR);

    state.postedTweetIds = state.postedTweetIds.slice(0, 500);
    state.updatedAt = nowIso();

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("saveState error:", error.message);
  }
}

function incStat(key, amount = 1) {
  state.stats[key] = Number(state.stats[key] || 0) + amount;
}

function shouldBackoff() {
  return Number(state.backoffUntil || 0) > Date.now();
}

function setBackoff(ms, reason) {
  state.backoffUntil = Date.now() + ms;
  state.backoffReason = reason || "unknown";
  saveState();
}

function clearBackoff() {
  state.backoffUntil = 0;
  state.backoffReason = "";
  saveState();
}

function isCreditsDepletedPayload(payload) {
  const title = String(payload?.title || "");
  const type = String(payload?.type || "");
  const detail = String(payload?.detail || "");

  return (
    title.includes("CreditsDepleted") ||
    type.includes("/problems/credits") ||
    detail.toLowerCase().includes("does not have any credits")
  );
}

function buildAuthHeaders() {
  return {
    Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
    "Content-Type": "application/json"
  };
}

async function xFetchJson(url) {
  incStat("apiCalls", 1);

  const res = await fetch(url, {
    method: "GET",
    headers: buildAuthHeaders()
  });

  const text = await res.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const error = new Error(`X API ${res.status}: ${text}`);
    error.status = res.status;
    error.payload = json;
    error.headers = Object.fromEntries(res.headers.entries());
    throw error;
  }

  return {
    ok: true,
    data: json,
    headers: Object.fromEntries(res.headers.entries())
  };
}

async function resolveUserId() {
  if (X_USER_ID) {
    state.resolvedUserId = X_USER_ID;
    saveState();
    return X_USER_ID;
  }

  if (state.resolvedUserId) {
    return state.resolvedUserId;
  }

  if (!X_USERNAME) {
    throw new Error("Missing X_USERNAME or X_USER_ID");
  }

  const url = `https://api.twitter.com/2/users/by/username/${encodeURIComponent(X_USERNAME)}?user.fields=id,name,username`;
  const result = await xFetchJson(url);
  const userId = result?.data?.data?.id;

  if (!userId) {
    throw new Error("Failed to resolve X user id");
  }

  state.resolvedUserId = userId;
  saveState();

  return userId;
}

async function fetchLatestTweets(userId) {
  const params = new URLSearchParams({
    max_results: String(MAX_TWEETS_PER_POLL),
    "tweet.fields": "created_at,public_metrics,conversation_id,author_id",
    exclude: "replies,retweets"
  });

  const url = `https://api.twitter.com/2/users/${encodeURIComponent(userId)}/tweets?${params.toString()}`;
  const result = await xFetchJson(url);
  const tweets = Array.isArray(result?.data?.data) ? result.data.data : [];

  return tweets;
}

function sortTweetsAsc(tweets) {
  return [...tweets].sort((a, b) => {
    const aNum = BigInt(a.id);
    const bNum = BigInt(b.id);
    if (aNum < bNum) return -1;
    if (aNum > bNum) return 1;
    return 0;
  });
}

function isNewTweet(tweetId) {
  if (!state.lastSeenTweetId) return true;

  try {
    return BigInt(tweetId) > BigInt(state.lastSeenTweetId);
  } catch {
    return tweetId !== state.lastSeenTweetId;
  }
}

function wasPosted(tweetId) {
  return state.postedTweetIds.includes(tweetId);
}

function markPosted(tweetId) {
  state.postedTweetIds.unshift(tweetId);
  state.lastSeenTweetId = tweetId;
  saveState();
}

function buildTweetUrl(username, tweetId) {
  if (!username) {
    return `https://x.com/i/web/status/${tweetId}`;
  }
  return `https://x.com/${username}/status/${tweetId}`;
}

async function forwardTweetToBackend(tweet) {
  const payload = {
    secret: ADMIN_SECRET,
    source: "x_watcher",
    platform: "x",
    tweet: {
      id: tweet.id,
      text: tweet.text,
      createdAt: tweet.created_at,
      authorId: tweet.author_id,
      conversationId: tweet.conversation_id,
      publicMetrics: tweet.public_metrics || {},
      url: buildTweetUrl(X_USERNAME, tweet.id),
      username: X_USERNAME
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
  let json = null;

  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const error = new Error(`Forward failed ${res.status}: ${text}`);
    error.status = res.status;
    error.payload = json;
    throw error;
  }

  return json;
}

async function processTweets(tweets) {
  const ordered = sortTweetsAsc(tweets);

  for (const tweet of ordered) {
    if (!tweet?.id) continue;

    incStat("tweetsSeen", 1);

    if (!isNewTweet(tweet.id) && wasPosted(tweet.id)) {
      continue;
    }

    if (wasPosted(tweet.id)) {
      continue;
    }

    try {
      await forwardTweetToBackend(tweet);
      markPosted(tweet.id);
      incStat("tweetsForwarded", 1);

      console.log(
        `[X WATCHER] forwarded tweet ${tweet.id} ${buildTweetUrl(X_USERNAME, tweet.id)}`
      );
    } catch (error) {
      incStat("forwardFailures", 1);
      console.error("[X WATCHER] forward error:", error.message);
    }
  }
}

function maybeApplyApiBackoff(error) {
  incStat("apiFailures", 1);

  const payload = error?.payload || {};
  const headers = error?.headers || {};
  const status = Number(error?.status || 0);

  if (isCreditsDepletedPayload(payload)) {
    const shouldLog =
      !state.lastCreditsErrorAt ||
      Date.now() - state.lastCreditsErrorAt > 15 * 60 * 1000;

    state.lastCreditsErrorAt = Date.now();
    setBackoff(CREDIT_BACKOFF_MS, "credits_depleted");

    if (shouldLog) {
      console.error(
        `[X WATCHER] Credits depleted. Backing off for ${Math.round(
          CREDIT_BACKOFF_MS / 60000
        )} minutes.`
      );
    }

    return;
  }

  if (status === 429) {
    const resetHeader = headers["x-rate-limit-reset"];
    const resetMs = resetHeader ? Math.max(0, Number(resetHeader) * 1000 - Date.now()) : ERROR_BACKOFF_MS;
    setBackoff(Math.max(resetMs, ERROR_BACKOFF_MS), "rate_limited");
    console.error("[X WATCHER] Rate limited. Backoff applied.");
    return;
  }

  setBackoff(ERROR_BACKOFF_MS, "generic_api_error");
  console.error("[X WATCHER] API error. Backoff applied:", error.message);
}

async function runOnce() {
  incStat("polls", 1);

  if (!TWITTER_BEARER_TOKEN) {
    throw new Error("Missing TWITTER_BEARER_TOKEN");
  }

  if (!ADMIN_SECRET) {
    throw new Error("Missing ADMIN_SECRET");
  }

  const userId = await resolveUserId();
  const tweets = await fetchLatestTweets(userId);

  if (!Array.isArray(tweets) || !tweets.length) {
    console.log("[X WATCHER] no new tweets");
    clearBackoff();
    return;
  }

  await processTweets(tweets);
  clearBackoff();
}

async function mainLoop() {
  console.log("[X WATCHER] PRO watcher started");
  console.log("[X WATCHER] base:", AI_SERVER_BASE_URL);
  console.log("[X WATCHER] forward:", X_FORWARD_URL);
  console.log("[X WATCHER] username:", X_USERNAME || "n/a");
  console.log("[X WATCHER] userId:", X_USER_ID || state.resolvedUserId || "auto");

  while (true) {
    try {
      if (shouldBackoff()) {
        const msLeft = state.backoffUntil - Date.now();
        console.log(
          `[X WATCHER] cooldown active: ${state.backoffReason} (${Math.max(
            1,
            Math.ceil(msLeft / 1000)
          )}s left)`
        );
        await sleep(Math.min(msLeft, POLL_INTERVAL_MS));
        continue;
      }

      await runOnce();
    } catch (error) {
      maybeApplyApiBackoff(error);
    }

    saveState();
    await sleep(POLL_INTERVAL_MS);
  }
}

mainLoop().catch(error => {
  console.error("[X WATCHER] fatal error:", error);
  process.exit(1);
});
