import fetch from "node-fetch";

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;

if (!X_BEARER_TOKEN) {
  console.error("Missing X_BEARER_TOKEN");
}

const SEARCH_QUERY = `
(Chiikawa OR $Chiikawa OR 2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu)
-is:retweet
-is:reply
`;

const MIN_FOLLOWERS = Number(process.env.X_MIN_FOLLOWERS || 1000);
const MAX_RESULTS = Number(process.env.X_MAX_RESULTS || 10);

const BLOCKED_KEYWORDS = [
  "politics",
  "political",
  "election",
  "president",
  "war",
  "government"
];

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function lowerText(text) {
  return normalizeText(text).toLowerCase();
}

function isBlocked(text) {
  const lower = lowerText(text);
  return BLOCKED_KEYWORDS.some(word => lower.includes(word));
}

function looksLowSignal(tweet) {
  const text = lowerText(tweet.text);

  if (!tweet.username) return true;
  if (tweet.followers < MIN_FOLLOWERS) return true;
  if (text.length < 20) return true;
  if (isBlocked(text)) return true;

  return false;
}

export async function fetchTweets() {
  const url =
    `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(SEARCH_QUERY)}` +
    `&max_results=${MAX_RESULTS}` +
    `&tweet.fields=created_at,author_id,text,public_metrics,lang` +
    `&expansions=author_id` +
    `&user.fields=username,name,public_metrics,verified`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`
    }
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("X API error:", JSON.stringify(data));
    return [];
  }

  const usersById = {};
  for (const user of data.includes?.users || []) {
    usersById[user.id] = user;
  }

  return (data.data || []).map(tweet => {
    const author = usersById[tweet.author_id] || {};

    return {
      id: tweet.id,
      text: normalizeText(tweet.text || ""),
      created_at: tweet.created_at || "",
      lang: tweet.lang || "",
      username: author.username || null,
      author_name: author.name || null,
      followers: author.public_metrics?.followers_count || 0,
      verified: Boolean(author.verified),
      url: author.username
        ? `https://twitter.com/${author.username}/status/${tweet.id}`
        : `https://twitter.com/i/web/status/${tweet.id}`,
      like_count: tweet.public_metrics?.like_count || 0,
      retweet_count: tweet.public_metrics?.retweet_count || 0,
      reply_count: tweet.public_metrics?.reply_count || 0
    };
  });
}

export function filterTweets(tweets, alreadySentIds = new Set(), alreadySentUrls = new Set()) {
  const unique = new Map();

  for (const tweet of tweets) {
    if (!tweet?.id || !tweet?.url) continue;
    if (alreadySentIds.has(tweet.id)) continue;
    if (alreadySentUrls.has(tweet.url)) continue;
    if (looksLowSignal(tweet)) continue;

    if (!unique.has(tweet.id)) {
      unique.set(tweet.id, tweet);
    }
  }

  return Array.from(unique.values()).sort((a, b) => {
    const ta = new Date(a.created_at).getTime() || 0;
    const tb = new Date(b.created_at).getTime() || 0;
    return ta - tb;
  });
}

export function formatAlert(tweet) {
  const statsLine =
    `👥 Followers: ${tweet.followers}` +
    (tweet.verified ? " • ✅ Verified" : "");

  const engagementLine =
    `❤️ ${tweet.like_count}   🔁 ${tweet.retweet_count}   💬 ${tweet.reply_count}`;

  return `🔥 Chiikawa spotted on X!

👤 @${tweet.username}
${statsLine}
${engagementLine}

📝 ${tweet.text.slice(0, 500)}

🔗 ${tweet.url}

✨ Maybe reply with something kind, funny, or supportive.`;
}
