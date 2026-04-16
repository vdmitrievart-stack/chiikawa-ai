const RECENT_RAID_MS = 45 * 60 * 1000;

const raidState = {
  lastRaidAt: 0,
  lastRaidTweetId: null
};

function normalize(text = "") {
  return String(text).toLowerCase().trim();
}

export function shouldSuggestRaid(tweet) {
  const followers = Number(tweet.followers || 0);
  const likes = Number(tweet.like_count || 0);
  const reposts = Number(tweet.retweet_count || 0);
  const replies = Number(tweet.reply_count || 0);
  const text = normalize(tweet.text);

  if (!tweet?.id) return false;

  if (Date.now() - raidState.lastRaidAt < RECENT_RAID_MS) {
    return false;
  }

  if (raidState.lastRaidTweetId === tweet.id) {
    return false;
  }

  if (
    text.includes("scam") ||
    text.includes("politics") ||
    text.includes("war") ||
    text.includes("government")
  ) {
    return false;
  }

  let score = 0;

  if (followers >= 1000) score += 1;
  if (followers >= 5000) score += 1;
  if (followers >= 20000) score += 1;

  if (likes >= 20) score += 1;
  if (likes >= 100) score += 1;

  if (reposts >= 10) score += 1;
  if (replies >= 5) score += 1;

  if (text.includes("chiikawa")) score += 1;
  if (text.includes("$chiikawa")) score += 1;
  if (text.includes("meme")) score += 1;

  return score >= 4;
}

export function markRaidSuggested(tweetId) {
  raidState.lastRaidAt = Date.now();
  raidState.lastRaidTweetId = tweetId || null;
}

export function buildRaidNudge(tweet) {
  const variants = [
    "this one feels worthy of a soft hello from the community",
    "a few kind replies here could make this post sparkle more",
    "this looks like a good moment for a tiny friendly wave",
    "a gentle Chiikawa raid here could work really nicely"
  ];

  const line = variants[Math.floor(Math.random() * variants.length)];

  return `📣 Smart raid idea

${line}

Keep it kind, human, and non-spammy.`;
}
