/**
 * telegram-bot/x-engine.js
 *
 * Level 6 X / Twitter social-intel engine
 *
 * Purpose:
 * - analyze X discussion around token / CA / ticker / keywords
 * - detect bot-like bursts, template spam, low-quality waves
 * - compute organic vs synthetic attention
 * - return structured social intel for trading engine
 *
 * Requirements:
 * - Node 18+ (global fetch available) OR environment with fetch polyfill
 * - TWITTER_BEARER_TOKEN in env or passed explicitly
 */

const DEFAULTS = {
  maxResultsPerQuery: Number(process.env.X_TOKEN_MAX_RESULTS || 30),
  minTrustedFollowers: Number(process.env.X_TOKEN_MIN_FOLLOWERS_TRUSTED || 1500),
  burstWindowMinutes: Number(process.env.X_TOKEN_WINDOW_MINUTES || 20),
  queryKeywordLimit: Number(process.env.X_TOKEN_QUERY_MAX_KEYWORDS || 8),
  minTextLength: Number(process.env.X_TOKEN_MIN_TEXT_LENGTH || 18),
  similarityHigh: 0.86,
  similarityMedium: 0.72
};

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text) {
  return stripHtml(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#][\p{L}\p{N}_]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeText(text)
    .split(" ")
    .filter(token => token.length >= 2);
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));

  if (!setA.size || !setB.size) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }

  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function nowMs() {
  return Date.now();
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function dedupeById(items) {
  const map = new Map();
  for (const item of items) {
    if (!item?.id) continue;
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()];
}

function isLikelyRaidOrShill(text) {
  const value = normalizeText(text);

  const rejectPatterns = [
    /\braid\b/,
    /\bshill\b/,
    /\bairdrop\b/,
    /\bwhitelist\b/,
    /\bgiveaway\b/,
    /\bretweet to win\b/,
    /\bfollow and retweet\b/,
    /\bjoin telegram\b/,
    /\btag friends\b/,
    /\bdrop your wallet\b/,
    /\bbuy now\b/,
    /\bmoon now\b/,
    /\bgem alert\b/,
    /\bgem call\b/,
    /\b100x\b/,
    /\bcto\b/
  ];

  return rejectPatterns.some(re => re.test(value));
}

function isLowValueText(text, minLen = DEFAULTS.minTextLength) {
  const value = stripHtml(text);
  if (!value) return true;
  if (value.length < minLen) return true;
  if (/^(gm|gn|lol|soon|ok|yes|no|hi|hello)[!\.\s]*$/i.test(value)) return true;
  return false;
}

function calcTemplatePenalty(text) {
  const value = normalizeText(text);
  let penalty = 0;

  if (
    /(follow and retweet|retweet to win|join telegram|giveaway|drop your wallet|tag friends)/i.test(
      value
    )
  ) {
    penalty += 40;
  }

  if (/(buy|pump|moon|100x|gem alert|gem call)/i.test(value)) {
    penalty += 28;
  }

  const words = tokenize(text);
  const uniqueRatio = words.length ? new Set(words).size / words.length : 0;

  if (words.length >= 8 && uniqueRatio < 0.45) {
    penalty += 15;
  }

  return penalty;
}

function buildSearchQueries({ ca = "", symbol = "", keywords = [] }) {
  const queries = [];

  const cleanKeywords = uniq(
    keywords
      .map(v => String(v || "").trim())
      .filter(Boolean)
      .slice(0, DEFAULTS.queryKeywordLimit)
  );

  if (ca) {
    queries.push(`${ca} -is:retweet -is:reply`);
  }

  if (symbol) {
    const ticker = symbol.startsWith("$") ? symbol : `$${symbol}`;
    queries.push(`${ticker} -is:retweet -is:reply`);
    queries.push(`${symbol} token -is:retweet -is:reply`);
  }

  for (const keyword of cleanKeywords) {
    queries.push(`"${keyword}" -is:retweet -is:reply`);
  }

  return uniq(queries);
}

function buildTweetUrl(authorUsername, tweetId) {
  if (!authorUsername || !tweetId) return "";
  return `https://x.com/${authorUsername}/status/${tweetId}`;
}

async function twitterGetJson(url, bearerToken) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitter API ${res.status}: ${text}`);
  }

  return res.json();
}

async function searchRecentTweets(query, bearerToken, maxResults) {
  const params = new URLSearchParams({
    query,
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields":
      "created_at,public_metrics,lang,entities,author_id,conversation_id",
    expansions: "author_id",
    "user.fields":
      "public_metrics,verified,description,name,profile_image_url,username"
  });

  const url = `https://api.twitter.com/2/tweets/search/recent?${params.toString()}`;
  const data = await twitterGetJson(url, bearerToken);

  const tweets = Array.isArray(data?.data) ? data.data : [];
  const users = Array.isArray(data?.includes?.users) ? data.includes.users : [];

  const userMap = new Map();
  for (const user of users) {
    userMap.set(user.id, user);
  }

  return tweets.map(tweet => ({
    ...tweet,
    author: userMap.get(tweet.author_id) || null
  }));
}

function calcSimilarityPenalty(text, neighbors) {
  let maxSim = 0;

  for (const other of neighbors) {
    if (!other?.text) continue;
    const sim = jaccardSimilarity(text, other.text);
    if (sim > maxSim) maxSim = sim;
  }

  if (maxSim >= DEFAULTS.similarityHigh) return { penalty: 35, similarity: maxSim };
  if (maxSim >= DEFAULTS.similarityMedium) return { penalty: 18, similarity: maxSim };
  if (maxSim >= 0.55) return { penalty: 8, similarity: maxSim };

  return { penalty: 0, similarity: maxSim };
}

function calcBurstStats(items, burstWindowMinutes) {
  const cutoff = nowMs() - burstWindowMinutes * 60 * 1000;

  const recent = items.filter(item => new Date(item.created_at).getTime() >= cutoff);
  const authors = new Set(recent.map(item => item.author_id).filter(Boolean));

  let lowFollowerAuthors = 0;
  let templateLikePosts = 0;

  for (const item of recent) {
    const followers = safeNum(item.author?.public_metrics?.followers_count, 0);
    if (followers < 2000) lowFollowerAuthors += 1;
    if (calcTemplatePenalty(item.text) >= 28) templateLikePosts += 1;
  }

  const uniqueAuthors = authors.size;
  const repeatedAuthorRatio =
    recent.length > 0 ? 1 - uniqueAuthors / recent.length : 0;

  let burstPenalty = 0;
  if (recent.length >= 8) burstPenalty += 8;
  if (recent.length >= 15) burstPenalty += 12;
  if (recent.length >= 25) burstPenalty += 16;

  if (lowFollowerAuthors >= 8) burstPenalty += 10;
  if (templateLikePosts >= 6) burstPenalty += 12;
  if (repeatedAuthorRatio >= 0.4) burstPenalty += 10;

  return {
    recentPosts: recent.length,
    uniqueRecentAuthors: uniqueAuthors,
    repeatedAuthorRatio: Number(repeatedAuthorRatio.toFixed(3)),
    lowFollowerAuthors,
    templateLikePosts,
    burstPenalty
  };
}

function scoreTweet(tweet, allTweets, minTrustedFollowers) {
  const author = tweet.author || null;
  const followers = safeNum(author?.public_metrics?.followers_count, 0);
  const verified = Boolean(author?.verified);

  const metrics = tweet.public_metrics || {};
  const likes = safeNum(metrics.like_count);
  const replies = safeNum(metrics.reply_count);
  const reposts = safeNum(metrics.retweet_count);
  const quotes = safeNum(metrics.quote_count);

  const weighted = likes + replies * 2 + reposts * 2.5 + quotes * 3;
  const engagementRate = followers > 0 ? weighted / followers : 0;

  let score = 0;

  if (followers >= minTrustedFollowers) score += 8;
  if (followers >= 5000) score += 8;
  if (followers >= 20000) score += 10;
  if (verified) score += 4;

  if (likes >= 5) score += 4;
  if (likes >= 15) score += 6;
  if (likes >= 50) score += 8;
  if (likes >= 120) score += 10;

  if (replies >= 2) score += 5;
  if (replies >= 6) score += 7;
  if (quotes >= 1) score += 4;
  if (quotes >= 3) score += 6;

  if (engagementRate >= 0.002) score += 6;
  if (engagementRate >= 0.006) score += 8;
  if (engagementRate >= 0.012) score += 10;

  if (stripHtml(tweet.text).length >= 50) score += 4;
  if (/ca|contract|address|0x[a-f0-9]+/i.test(tweet.text)) score += 3;
  if (tweet.lang === "en" || tweet.lang === "ja") score += 2;

  const templatePenalty = calcTemplatePenalty(tweet.text);
  const similarity = calcSimilarityPenalty(
    tweet.text,
    allTweets.filter(item => item.id !== tweet.id)
  );
  const shillPenalty = isLikelyRaidOrShill(tweet.text) ? 100 : 0;
  const lowValuePenalty = isLowValueText(tweet.text) ? 25 : 0;

  score -= templatePenalty;
  score -= similarity.penalty;
  score -= shillPenalty;
  score -= lowValuePenalty;

  return {
    score,
    followers,
    verified,
    likes,
    replies,
    reposts,
    quotes,
    weighted,
    engagementRate: Number((engagementRate * 100).toFixed(3)),
    templatePenalty,
    similarityPenalty: similarity.penalty,
    maxSimilarity: Number(similarity.similarity.toFixed(3)),
    shillPenalty,
    lowValuePenalty
  };
}

function buildTopExamples(scored) {
  return scored
    .slice(0, 5)
    .map(item => ({
      id: item.tweet.id,
      text: stripHtml(item.tweet.text),
      username: item.tweet.author?.username || "unknown",
      score: item.scorePack.score,
      followers: item.scorePack.followers,
      url: buildTweetUrl(item.tweet.author?.username, item.tweet.id)
    }));
}

function buildTemplateGroups(tweets) {
  const groups = [];
  const used = new Set();

  for (let i = 0; i < tweets.length; i += 1) {
    const base = tweets[i];
    if (!base?.id || used.has(base.id)) continue;

    const cluster = [base];
    used.add(base.id);

    for (let j = i + 1; j < tweets.length; j += 1) {
      const other = tweets[j];
      if (!other?.id || used.has(other.id)) continue;

      const sim = jaccardSimilarity(base.text, other.text);
      if (sim >= 0.78) {
        cluster.push(other);
        used.add(other.id);
      }
    }

    if (cluster.length >= 3) {
      groups.push({
        size: cluster.length,
        sample: stripHtml(base.text).slice(0, 160),
        usernames: cluster.map(item => item.author?.username || "unknown").slice(0, 6)
      });
    }
  }

  return groups.sort((a, b) => b.size - a.size).slice(0, 5);
}

function calcTrustedMentions(scored, minTrustedFollowers) {
  return scored.filter(item => {
    const followers = safeNum(item.scorePack.followers, 0);
    return followers >= minTrustedFollowers && item.scorePack.score >= 35;
  }).length;
}

function calcOrganicScore({ avgScore, templateRatio, burstPenalty, trustedMentions }) {
  let organic = avgScore;

  organic += trustedMentions * 2.5;
  organic -= templateRatio * 35;
  organic -= burstPenalty;

  if (MARKET_MODE === "bull") organic += 4;
  if (MARKET_MODE === "bear") organic -= 3;

  return Number(Math.max(0, Math.min(100, organic)).toFixed(2));
}

function calcBotPatternScore({ templateRatio, repeatedAuthorRatio, lowFollowerShare, burstPenalty }) {
  let score = 0;

  score += templateRatio * 45;
  score += repeatedAuthorRatio * 20;
  score += lowFollowerShare * 20;
  score += burstPenalty;

  return Number(Math.max(0, Math.min(100, score)).toFixed(2));
}

/**
 * Main public API
 *
 * Example:
 * const intel = await analyzeTokenSocialIntel({
 *   ca: "ABC123...",
 *   symbol: "CHI",
 *   keywords: ["Chiikawa token", "Chiikawa CTO"],
 *   bearerToken: process.env.TWITTER_BEARER_TOKEN
 * });
 */
export async function analyzeTokenSocialIntel({
  ca = "",
  symbol = "",
  keywords = [],
  bearerToken = process.env.TWITTER_BEARER_TOKEN,
  maxResultsPerQuery = DEFAULTS.maxResultsPerQuery,
  minTrustedFollowers = DEFAULTS.minTrustedFollowers,
  burstWindowMinutes = DEFAULTS.burstWindowMinutes
} = {}) {
  if (!bearerToken) {
    throw new Error("Missing TWITTER_BEARER_TOKEN");
  }

  const queries = buildSearchQueries({ ca, symbol, keywords });

  if (!queries.length) {
    throw new Error("No search queries to analyze");
  }

  const rawTweets = [];

  for (const query of queries) {
    try {
      const result = await searchRecentTweets(query, bearerToken, maxResultsPerQuery);
      rawTweets.push(...result);
    } catch (error) {
      rawTweets.push({
        __error: true,
        query,
        error: error.message
      });
    }
  }

  const errors = rawTweets.filter(item => item.__error);
  const tweets = dedupeById(rawTweets.filter(item => !item.__error));

  const filteredTweets = tweets.filter(tweet => {
    if (!tweet?.author_id) return false;
    if (!tweet?.author?.username) return false;
    if (isLowValueText(tweet.text, DEFAULTS.minTextLength) && !ca) return false;
    return true;
  });

  const scored = filteredTweets.map(tweet => ({
    tweet,
    scorePack: scoreTweet(tweet, filteredTweets, minTrustedFollowers)
  }));

  scored.sort((a, b) => b.scorePack.score - a.scorePack.score);

  const totalPosts = filteredTweets.length;
  const uniqueAuthors = new Set(filteredTweets.map(tweet => tweet.author_id)).size;
  const trustedMentions = calcTrustedMentions(scored, minTrustedFollowers);

  const templateGroups = buildTemplateGroups(filteredTweets);
  const templatePosts = scored.filter(item => item.scorePack.templatePenalty >= 20).length;
  const templateRatio = totalPosts > 0 ? templatePosts / totalPosts : 0;

  const burstStats = calcBurstStats(filteredTweets, burstWindowMinutes);
  const lowFollowerShare =
    burstStats.recentPosts > 0
      ? burstStats.lowFollowerAuthors / burstStats.recentPosts
      : 0;

  const avgScore =
    scored.length > 0
      ? scored.reduce((acc, item) => acc + item.scorePack.score, 0) / scored.length
      : 0;

  const avgLikes =
    scored.length > 0
      ? scored.reduce((acc, item) => acc + item.scorePack.likes, 0) / scored.length
      : 0;

  const avgReplies =
    scored.length > 0
      ? scored.reduce((acc, item) => acc + item.scorePack.replies, 0) / scored.length
      : 0;

  const avgEngagementRate =
    scored.length > 0
      ? scored.reduce((acc, item) => acc + item.scorePack.engagementRate, 0) / scored.length
      : 0;

  const organicScore = calcOrganicScore({
    avgScore,
    templateRatio,
    burstPenalty: burstStats.burstPenalty,
    trustedMentions
  });

  const botPatternScore = calcBotPatternScore({
    templateRatio,
    repeatedAuthorRatio: burstStats.repeatedAuthorRatio,
    lowFollowerShare,
    burstPenalty: burstStats.burstPenalty
  });

  const suspiciousBurst =
    burstStats.burstPenalty >= 20 ||
    templateRatio >= 0.42 ||
    botPatternScore >= 62;

  return {
    ok: true,
    meta: {
      queries,
      queryCount: queries.length,
      errors
    },
    socialIntel: {
      totalPosts,
      uniqueAuthors,
      trustedMentions,
      avgLikes: Number(avgLikes.toFixed(2)),
      avgReplies: Number(avgReplies.toFixed(2)),
      avgEngagementRate: Number(avgEngagementRate.toFixed(3)),
      avgScore: Number(avgScore.toFixed(2)),
      templateRatio: Number(templateRatio.toFixed(3)),
      botPatternScore,
      organicScore,
      suspiciousBurst,
      repeatedAuthorRatio: burstStats.repeatedAuthorRatio,
      lowFollowerShare: Number(lowFollowerShare.toFixed(3)),
      burstPenalty: burstStats.burstPenalty,
      recentPostsInWindow: burstStats.recentPosts,
      uniqueRecentAuthors: burstStats.uniqueRecentAuthors
    },
    templateGroups,
    topExamples: buildTopExamples(scored),
    rawTopScored: scored.slice(0, 10).map(item => ({
      id: item.tweet.id,
      username: item.tweet.author?.username || "unknown",
      text: stripHtml(item.tweet.text),
      score: item.scorePack.score,
      followers: item.scorePack.followers,
      verified: item.scorePack.verified,
      likes: item.scorePack.likes,
      replies: item.scorePack.replies,
      reposts: item.scorePack.reposts,
      quotes: item.scorePack.quotes,
      engagementRate: item.scorePack.engagementRate,
      templatePenalty: item.scorePack.templatePenalty,
      similarityPenalty: item.scorePack.similarityPenalty,
      maxSimilarity: item.scorePack.maxSimilarity,
      url: buildTweetUrl(item.tweet.author?.username, item.tweet.id)
    }))
  };
}

/**
 * Lightweight helper specifically for Level 6 orchestrator:
 * returns only compact metrics, ready to embed into decision flow.
 */
export async function buildLevel6SocialIntel(params = {}) {
  const result = await analyzeTokenSocialIntel(params);

  return {
    uniqueAuthors: result.socialIntel.uniqueAuthors,
    avgLikes: result.socialIntel.avgLikes,
    avgReplies: result.socialIntel.avgReplies,
    botPatternScore: Number((result.socialIntel.botPatternScore / 100).toFixed(2)),
    engagementDiversity: Number(
      Math.max(
        0,
        Math.min(
          1,
          1 -
            result.socialIntel.templateRatio * 0.65 -
            result.socialIntel.repeatedAuthorRatio * 0.35
        )
      ).toFixed(2)
    ),
    trustedMentions: result.socialIntel.trustedMentions,
    suspiciousBurst: result.socialIntel.suspiciousBurst,
    organicScore: result.socialIntel.organicScore
  };
}
