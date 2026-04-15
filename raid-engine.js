export function shouldSuggestRaid(tweet) {
  const followers = Number(tweet.followers || 0);
  const likes = Number(tweet.like_count || 0);
  const reposts = Number(tweet.retweet_count || 0);
  const replies = Number(tweet.reply_count || 0);
  const text = String(tweet.text || "").toLowerCase();

  if (text.includes("scam") || text.includes("politics")) return false;

  const score =
    (followers >= 1000 ? 1 : 0) +
    (followers >= 5000 ? 1 : 0) +
    (likes >= 20 ? 1 : 0) +
    (likes >= 100 ? 1 : 0) +
    (reposts >= 10 ? 1 : 0) +
    (replies >= 5 ? 1 : 0);

  return score >= 3;
}

export function buildRaidNudge(tweet) {
  const lines = [
    "this one might be worth a soft hello from the community",
    "maybe a few kind replies could make this post sparkle more",
    "this feels like a nice place for a gentle Chiikawa wave",
    "a small friendly raid here could be cute and effective"
  ];

  const line = lines[Math.floor(Math.random() * lines.length)];
  return `📣 Smart raid idea

${line}

Please keep it kind, human, and non-spammy.`;
}
