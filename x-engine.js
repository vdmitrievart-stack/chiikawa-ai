import fetch from "node-fetch";

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;

if (!X_BEARER_TOKEN) {
  console.error("Missing X_BEARER_TOKEN");
}

const SEARCH_QUERY = `
(Chiikawa OR $Chiikawa OR 2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu)
-lang:ru
-is:retweet
`;

const MIN_FOLLOWERS = 1000;

export async function fetchTweets() {
  const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(
    SEARCH_QUERY
  )}&max_results=10&tweet.fields=created_at,author_id,text&expansions=author_id&user.fields=username,public_metrics`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`
    }
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("X API error:", data);
    return [];
  }

  const users = {};
  (data.includes?.users || []).forEach(u => {
    users[u.id] = u;
  });

  const tweets = (data.data || []).map(t => {
    const author = users[t.author_id];

    return {
      id: t.id,
      text: t.text,
      username: author?.username,
      followers: author?.public_metrics?.followers_count || 0
    };
  });

  return tweets;
}

export function filterTweets(tweets, sentSet) {
  return tweets.filter(t => {
    if (!t.username) return false;
    if (t.followers < MIN_FOLLOWERS) return false;
    if (sentSet.has(t.id)) return false;

    if (t.text.length < 20) return false;

    const lower = t.text.toLowerCase();

    if (lower.includes("politic")) return false;

    return true;
  });
}

export function formatAlert(tweet) {
  return `🔥 Chiikawa spotted on X!

👤 @${tweet.username}
👥 Followers: ${tweet.followers}

📝 ${tweet.text.slice(0, 200)}...

🔗 https://twitter.com/${tweet.username}/status/${tweet.id}

✨ Maybe reply with something kind or funny`;
}
