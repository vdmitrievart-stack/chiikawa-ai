import fetch from "node-fetch";
import fs from "node:fs/promises";
import path from "node:path";

const NITTER_INSTANCE = process.env.NITTER_INSTANCE || "nitter.poast.org";
const CHECK_INTERVAL = Number(process.env.X_WATCHER_INTERVAL_MS || 60_000);

const SEARCH_TERMS = String(
  process.env.X_WATCHER_SEARCH_TERMS ||
    "chiikawa,ちいかわ,$chiikawa,#chiikawa,chiikawa cto"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const MIN_FOLLOWERS = Number(process.env.X_WATCHER_MIN_FOLLOWERS || 1000);
const MAX_POST_AGE_HOURS = Number(process.env.X_WATCHER_MAX_POST_AGE_HOURS || 48);
const MAX_NEW_POSTS_PER_LOOP = Number(process.env.X_WATCHER_MAX_NEW_POSTS || 2);

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "";
const TG_CHAT_ID =
  process.env.FORCED_GROUP_CHAT_ID ||
  process.env.PUBLIC_GROUP_CHAT_ID ||
  "";

const USER_AGENT =
  process.env.X_WATCHER_USER_AGENT || "Mozilla/5.0 (ChiikawaWatcher)";

const STATE_DIR = path.resolve("./runtime-data");
const STATE_FILE = path.join(STATE_DIR, "x-watcher-state.json");

const DEFAULT_EMOTION_GIFS = {
  happy: [
    "https://tenor.com/vLMG1KGYUyT.gif",
    "https://tenor.com/pp5GdrEl62Z.gif"
  ],
  surprised: [
    "https://tenor.com/sooKVCqgZq8.gif",
    "https://tenor.com/vLMG1KGYUyT.gif"
  ],
  ironic: [
    "https://tenor.com/pp5GdrEl62Z.gif",
    "https://tenor.com/sooKVCqgZq8.gif"
  ],
  calm: [
    "https://tenor.com/vLMG1KGYUyT.gif"
  ]
};

const state = {
  seenIds: [],
  seenFingerprints: [],
  profileCache: {},
  lastPublishedAt: "",
  gifCursor: 0
};

let isRunning = false;

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(text) {
  return asText(text).replace(/\s+/g, " ").trim();
}

function decodeHtml(text) {
  return asText(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;/g, "/")
    .replace(/&#47;/g, "/");
}

function stripHtml(text) {
  return decodeHtml(text)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortText(text, max = 280) {
  const s = normalizeWhitespace(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function stableHash(input) {
  const s = asText(input, "seed");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function pickStable(seed, rows = []) {
  if (!rows.length) return "";
  return rows[stableHash(seed) % rows.length];
}

function parseDateMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function isFreshEnough(pubDate) {
  const ms = parseDateMs(pubDate);
  if (!ms) return true;
  return Date.now() - ms <= MAX_POST_AGE_HOURS * 60 * 60 * 1000;
}

function normalizeUrl(url) {
  const raw = asText(url, "");
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return `https://${NITTER_INSTANCE}${raw}`;
  return `https://${NITTER_INSTANCE}/${raw.replace(/^\/+/, "")}`;
}

function profileUrl(username) {
  return `https://${NITTER_INSTANCE}/${username}`;
}

function searchUrl(term) {
  return `https://${NITTER_INSTANCE}/search?f=tweets&q=${encodeURIComponent(term)}`;
}

function compactHandle(handle) {
  const h = asText(handle, "").replace(/^@/, "");
  return h ? `@${h}` : "";
}

function postFingerprint(post) {
  return [
    asText(post?.id, ""),
    asText(post?.url, ""),
    asText(post?.username, ""),
    asText(post?.text, "")
  ]
    .join("|")
    .toLowerCase();
}

function rememberPost(post) {
  const id = asText(post?.id, "");
  const fp = postFingerprint(post);

  if (id) {
    state.seenIds.unshift(id);
    state.seenIds = Array.from(new Set(state.seenIds)).slice(0, 500);
  }

  if (fp) {
    state.seenFingerprints.unshift(fp);
    state.seenFingerprints = Array.from(new Set(state.seenFingerprints)).slice(0, 500);
  }

  state.lastPublishedAt = nowIso();
}

function hasSeenPost(post) {
  const id = asText(post?.id, "");
  const fp = postFingerprint(post);
  return (
    (id && state.seenIds.includes(id)) ||
    (fp && state.seenFingerprints.includes(fp))
  );
}

function shouldPublishByCooldown() {
  const lastMs = parseDateMs(state.lastPublishedAt);
  if (!lastMs) return true;
  return Date.now() - lastMs >= 20 * 60 * 1000;
}

function parseCompactNumber(text) {
  const s = asText(text, "").toUpperCase().replace(/,/g, "").trim();
  if (!s) return 0;

  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)([KMB])?$/);
  if (!m) {
    const plain = Number(s.replace(/[^\d.]/g, ""));
    return Number.isFinite(plain) ? plain : 0;
  }

  const num = Number(m[1]);
  const suffix = m[2] || "";

  if (suffix === "K") return Math.round(num * 1_000);
  if (suffix === "M") return Math.round(num * 1_000_000);
  if (suffix === "B") return Math.round(num * 1_000_000_000);
  return Math.round(num);
}

async function ensureStateDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

async function loadState() {
  await ensureStateDir();

  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    state.seenIds = Array.isArray(parsed?.seenIds) ? parsed.seenIds : [];
    state.seenFingerprints = Array.isArray(parsed?.seenFingerprints)
      ? parsed.seenFingerprints
      : [];
    state.profileCache = parsed?.profileCache || {};
    state.lastPublishedAt = asText(parsed?.lastPublishedAt, "");
    state.gifCursor = safeNum(parsed?.gifCursor, 0);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.log("⚠️ x-watcher state load error:", error.message);
    }
  }
}

async function saveState() {
  try {
    await ensureStateDir();
    await fs.writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          seenIds: state.seenIds,
          seenFingerprints: state.seenFingerprints,
          profileCache: state.profileCache,
          lastPublishedAt: state.lastPublishedAt,
          gifCursor: state.gifCursor,
          updatedAt: nowIso()
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.log("⚠️ x-watcher state save error:", error.message);
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return res.text();
}

function extractTimelineItems(html) {
  const matches = [
    ...html.matchAll(/<div class="timeline-item(?:\s|")([\s\S]*?)<\/table>\s*<\/div>/g),
    ...html.matchAll(/<div class="timeline-item(?:\s|")([\s\S]*?)<\/div>\s*<\/div>/g)
  ];

  const seen = new Set();
  const out = [];

  for (const match of matches) {
    const block = match[0];
    const sig = block.slice(0, 120);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(block);
  }

  return out;
}

function parseSearchResultBlock(block) {
  const statusHref =
    block.match(/href="\/([^"/]+)\/status\/(\d+)"/i)?.[0] || "";
  const hrefMatch = block.match(/href="\/([^"/]+)\/status\/(\d+)"/i);

  const username = asText(hrefMatch?.[1], "");
  const tweetId = asText(hrefMatch?.[2], "");

  if (!username || !tweetId) return null;

  const fullName =
    stripHtml(block.match(/<a[^>]+class="fullname"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "") ||
    "";

  const handle =
    stripHtml(block.match(/<a[^>]+class="username"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "") ||
    username;

  const textHtml =
    block.match(/<div[^>]+class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";

  const text = stripHtml(textHtml);

  const dateTitle =
    decodeHtml(
      block.match(/<a[^>]+title="([^"]+)"[^>]*>\s*<span class="tweet-date"/i)?.[1] || ""
    ) ||
    decodeHtml(
      block.match(/<span class="tweet-date"[\s\S]*?<a[^>]+title="([^"]+)"/i)?.[1] || ""
    );

  const photoUrl =
    normalizeUrl(block.match(/<a[^>]+class="still-image"[^>]+href="([^"]+)"/i)?.[1] || "") ||
    normalizeUrl(block.match(/<img[^>]+src="([^"]+\/pic\/[^"]+)"/i)?.[1] || "");

  const videoSrc =
    normalizeUrl(block.match(/<source[^>]+src="([^"]+)"/i)?.[1] || "") ||
    normalizeUrl(block.match(/<video[^>]+src="([^"]+)"/i)?.[1] || "");

  const poster =
    normalizeUrl(block.match(/<video[^>]+poster="([^"]+)"/i)?.[1] || "");

  const mediaUrl = videoSrc || photoUrl || poster || "";
  const mediaKind = videoSrc ? "video" : mediaUrl ? "photo" : "";

  const replyCount = parseCompactNumber(
    stripHtml(block.match(/icon-comment[\s\S]*?<span[^>]*>([^<]+)<\/span>/i)?.[1] || "")
  );
  const repostCount = parseCompactNumber(
    stripHtml(block.match(/icon-retweet[\s\S]*?<span[^>]*>([^<]+)<\/span>/i)?.[1] || "")
  );
  const likeCount = parseCompactNumber(
    stripHtml(block.match(/icon-heart[\s\S]*?<span[^>]*>([^<]+)<\/span>/i)?.[1] || "")
  );

  return {
    id: tweetId,
    username,
    handle: compactHandle(handle || username),
    fullName,
    text,
    url: `https://x.com/${username}/status/${tweetId}`,
    pubDate: dateTitle,
    mediaUrl,
    mediaKind,
    posterUrl: poster,
    replyCount,
    repostCount,
    likeCount
  };
}

async function searchPosts(term) {
  try {
    const html = await fetchText(searchUrl(term));
    const items = extractTimelineItems(html)
      .map((block) => parseSearchResultBlock(block))
      .filter(Boolean);

    return items;
  } catch (error) {
    console.log(`❌ search error for "${term}":`, error.message);
    return [];
  }
}

function parseFollowersFromProfileHtml(html) {
  const candidates = [
    html.match(/profile-stat[\s\S]*?Followers[\s\S]*?profile-stat-num[^>]*>([^<]+)</i)?.[1],
    html.match(/<a[^>]+href="\/[^"]+\/followers"[\s\S]*?<span[^>]*>([^<]+)<\/span>/i)?.[1],
    html.match(/Followers[\s\S]{0,120}?>([0-9.,KMB]+)</i)?.[1]
  ]
    .map((x) => parseCompactNumber(stripHtml(x || "")))
    .filter((x) => x > 0);

  return candidates[0] || 0;
}

async function fetchProfileMeta(username) {
  const cached = state.profileCache[username];
  const freshEnough =
    cached?.fetchedAt &&
    Date.now() - parseDateMs(cached.fetchedAt) < 6 * 60 * 60 * 1000;

  if (cached && freshEnough) {
    return cached;
  }

  try {
    const html = await fetchText(profileUrl(username));
    const followers = parseFollowersFromProfileHtml(html);

    const row = {
      followers,
      fetchedAt: nowIso()
    };

    state.profileCache[username] = row;
    return row;
  } catch (error) {
    console.log(`⚠️ profile fetch failed for ${username}:`, error.message);

    const fallback = {
      followers: 0,
      fetchedAt: nowIso()
    };

    state.profileCache[username] = fallback;
    return fallback;
  }
}

function relevanceScore(post, term) {
  const text = asText(post?.text, "").toLowerCase();
  const needle = asText(term, "").toLowerCase();

  let score = 0;

  if (needle && text.includes(needle)) score += 8;
  if (text.includes("chiikawa")) score += 8;
  if (text.includes("ちいかわ")) score += 8;
  if (text.includes("$chiikawa")) score += 5;
  if (text.includes("#chiikawa")) score += 4;
  if (text.includes("cto")) score += 2;

  score += Math.min(8, Math.floor(safeNum(post?.likeCount, 0) / 50));
  score += Math.min(6, Math.floor(safeNum(post?.repostCount, 0) / 10));
  score += Math.min(4, Math.floor(safeNum(post?.replyCount, 0) / 10));

  return score;
}

function classifyEmotion(post) {
  const text = asText(post?.text, "").toLowerCase();

  if (
    text.includes("wow") ||
    text.includes("omg") ||
    text.includes("huge") ||
    text.includes("pump") ||
    text.includes("moon") ||
    text.includes("爆") ||
    text.includes("!") ||
    text.includes("!?")
  ) {
    return "surprised";
  }

  if (
    text.includes("meme") ||
    text.includes("lol") ||
    text.includes("lmao") ||
    text.includes("funny") ||
    text.includes("cto")
  ) {
    return "ironic";
  }

  if (
    text.includes("cute") ||
    text.includes("love") ||
    text.includes("good") ||
    text.includes("nice") ||
    text.includes("happy")
  ) {
    return "happy";
  }

  return "calm";
}

function extractTickerLike(text) {
  const match = asText(text, "").match(/\$[A-Za-z0-9_]{2,12}\b/);
  if (match) return match[0];

  const upper = asText(text, "").match(/\b[A-Z]{3,8}\b/);
  if (upper) return upper[0];

  return "";
}

function buildLead(post, emotion) {
  const seed = `${post.id}:${emotion}:lead`;
  const ticker = extractTickerLike(post.text);

  const common = [
    "Ого, смотрите что я нашёл, ребята.",
    "Это проскочило у меня в ленте, и я решил принести сюда.",
    "Любопытный след в X, оставлю его тут.",
    "Мимо такого я решил не проходить."
  ];

  const surprised = [
    "Тут у меня уши чуть-чуть дернулись, если честно.",
    "Выглядит так, будто лента решила подмигнуть.",
    "Это уже не просто шорох, а вполне заметный звук."
  ];

  const ironic = [
    "Мемы опять делают вид, что они тут просто шутят.",
    "Иногда всё начинается с иронии, а потом кто-то открывает график.",
    "У ленты сегодня явно игривое настроение."
  ];

  const happy = [
    "Тут настроение прям тёплое.",
    "Люблю такие аккуратные находки.",
    "Есть в этом что-то приятно-chaotic."
  ];

  const pool = [
    ...common,
    ...(emotion === "surprised" ? surprised : []),
    ...(emotion === "ironic" ? ironic : []),
    ...(emotion === "happy" ? happy : [])
  ];

  const line = pickStable(seed, pool);

  if (ticker) return `${line} ${ticker} тут тоже мелькнул, кстати.`;
  return line;
}

function buildOpinion(post, emotion) {
  const seed = `${post.id}:${emotion}:opinion`;
  const ticker = extractTickerLike(post.text);

  const generic = [
    "Я бы не делал выводы по одному посту, но в копилку наблюдений такое точно уношу.",
    "Не каждый шум становится движением, но замечать такие вещи заранее я люблю.",
    "Иногда один хороший пост говорит больше, чем длинная простыня шума.",
    "Я такое отмечаю спокойно: интересно, но без лишней спешки."
  ];

  const ironic = [
    "Сначала смешно, потом кто-то становится серьёзным. Классика крипто-леса.",
    "Если бы мемы умели улыбаться глазами, это был бы как раз такой случай.",
    "Пока это выглядит забавно. А забавное в крипте иногда внезапно взрослеет."
  ];

  const surprised = [
    "Честно? Тут я бы просто сел поудобнее и посмотрел, что будет дальше.",
    "Когда вокруг становится чуть громче, я обычно делаю не шумнее, а внимательнее.",
    "Шум есть, а значит история как минимум заслуживает взгляда."
  ];

  const happy = [
    "Мне нравится вайб, но голову я всё равно держу холодной.",
    "Тёплая находка — это хорошо. Дисциплина — ещё лучше.",
    "Милый тон, но риск-менеджмент всё равно должен жить рядом."
  ];

  const pool = [
    ...generic,
    ...(emotion === "ironic" ? ironic : []),
    ...(emotion === "surprised" ? surprised : []),
    ...(emotion === "happy" ? happy : [])
  ];

  let line = pickStable(seed, pool);

  if (ticker) {
    line = `${line} ${ticker} я бы тоже смотрел без перегруза по риску.`;
  }

  return line;
}

function buildRiskLine(post) {
  return pickStable(`${post.id}:risk`, [
    "Не лезьте большим объёмом: даже интересная идея не стоит перегруза. 5–10% на одну идею обычно спокойнее.",
    "Если будете смотреть в эту сторону — с умом. Крупный размер позиции тут точно не нужен.",
    "Любопытно — да. Но без олл-инов: риск на одну идею лучше держать умеренным."
  ]);
}

function shouldShowRisk(post) {
  return stableHash(`${post.id}:show:risk`) % 100 < 45;
}

function buildCaption(post) {
  const emotion = classifyEmotion(post);
  const lead = buildLead(post, emotion);
  const opinion = buildOpinion(post, emotion);
  const textPreview = shortText(post.text, 280);
  const followers = safeNum(post.followers, 0);

  const header = pickStable(`${post.id}:${emotion}:header`, [
    "🐹 <b>Chiikawa заметил кое-что в X</b>",
    "🍃 <b>Chiikawa принёс находку из X</b>",
    "✨ <b>Смотрите, что Chiikawa увидел</b>"
  ]);

  const lines = [
    header,
    "",
    escapeHtml(lead),
    "",
    `👤 <b>${escapeHtml(post.fullName || post.handle || "@unknown")}</b> · ${followers} followers`,
    `📝 ${escapeHtml(textPreview)}`,
    "",
    escapeHtml(opinion),
    "",
    `🔗 <a href="${escapeHtml(post.url)}">Ссылка на пост</a>`
  ];

  if (shouldShowRisk(post)) {
    lines.push("");
    lines.push(`🫶 ${escapeHtml(buildRiskLine(post))}`);
  }

  return {
    caption: lines.join("\n"),
    emotion
  };
}

function gifPoolForEmotion(emotion) {
  const key = asText(emotion, "calm");
  const envKey = `X_WATCHER_GIFS_${key.toUpperCase()}`;
  const envValue = asText(process.env[envKey], "");
  if (envValue) {
    const rows = envValue.split(",").map((x) => x.trim()).filter(Boolean);
    if (rows.length) return rows;
  }
  return DEFAULT_EMOTION_GIFS[key] || DEFAULT_EMOTION_GIFS.calm;
}

function nextEmotionGif(emotion = "calm") {
  const pool = gifPoolForEmotion(emotion);
  const gif = pool[state.gifCursor % pool.length];
  state.gifCursor += 1;
  return gif;
}

async function telegramCall(method, payload) {
  if (!TELEGRAM_BOT_TOKEN || !TG_CHAT_ID) return null;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data?.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(data || {})}`);
  }

  return data.result || null;
}

async function sendCaptionOnly(caption) {
  return telegramCall("sendMessage", {
    chat_id: TG_CHAT_ID,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

async function sendPhotoWithCaption(photoUrl, caption) {
  return telegramCall("sendPhoto", {
    chat_id: TG_CHAT_ID,
    photo: photoUrl,
    caption,
    parse_mode: "HTML"
  });
}

async function sendVideoWithCaption(videoUrl, caption) {
  return telegramCall("sendVideo", {
    chat_id: TG_CHAT_ID,
    video: videoUrl,
    caption,
    parse_mode: "HTML",
    supports_streaming: true
  });
}

async function sendEmotionGifReply(replyToMessageId, gifUrl) {
  if (!gifUrl) return null;

  try {
    return await telegramCall("sendAnimation", {
      chat_id: TG_CHAT_ID,
      animation: gifUrl,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true
    });
  } catch (error) {
    console.log("⚠️ emotion gif send failed:", error.message);
    return null;
  }
}

async function sendStyledPost(post) {
  const built = buildCaption(post);
  const caption = built.caption;
  const emotionGif = nextEmotionGif(built.emotion);

  let sent = null;

  try {
    if (post.mediaUrl && post.mediaKind === "video") {
      sent = await sendVideoWithCaption(post.mediaUrl, caption);
    } else if (post.mediaUrl) {
      sent = await sendPhotoWithCaption(post.mediaUrl, caption);
    } else {
      sent = await sendCaptionOnly(caption);
    }
  } catch (error) {
    console.log("⚠️ media send fallback:", error.message);
    sent = await sendCaptionOnly(caption);
  }

  if (sent?.message_id) {
    await sendEmotionGifReply(sent.message_id, emotionGif);
  }

  return sent;
}

async function collectCandidates() {
  const out = [];

  for (const term of SEARCH_TERMS) {
    const posts = await searchPosts(term);

    for (const post of posts) {
      if (!post?.id) continue;
      if (!post?.text) continue;
      if (!isFreshEnough(post.pubDate)) continue;
      out.push({
        ...post,
        matchedTerm: term
      });
    }
  }

  const deduped = new Map();
  for (const post of out) {
    const key = asText(post.id, "") || postFingerprint(post);
    if (!key) continue;

    const prev = deduped.get(key);
    if (!prev) {
      deduped.set(key, post);
      continue;
    }

    const prevScore = relevanceScore(prev, prev.matchedTerm);
    const nextScore = relevanceScore(post, post.matchedTerm);
    if (nextScore > prevScore) {
      deduped.set(key, post);
    }
  }

  return [...deduped.values()];
}

async function enrichWithFollowers(posts) {
  const out = [];

  for (const post of posts) {
    const profile = await fetchProfileMeta(post.username);
    const followers = safeNum(profile?.followers, 0);

    if (followers < MIN_FOLLOWERS) continue;

    out.push({
      ...post,
      followers
    });
  }

  return out;
}

async function loop() {
  if (isRunning) return;
  isRunning = true;

  try {
    if (!shouldPublishByCooldown()) {
      isRunning = false;
      return;
    }

    const candidates = await collectCandidates();
    const enriched = await enrichWithFollowers(candidates);

    const filtered = enriched
      .filter((post) => !hasSeenPost(post))
      .sort((a, b) => {
        const scoreB = relevanceScore(b, b.matchedTerm) + Math.log10(Math.max(1, b.followers));
        const scoreA = relevanceScore(a, a.matchedTerm) + Math.log10(Math.max(1, a.followers));
        return scoreB - scoreA;
      })
      .slice(0, MAX_NEW_POSTS_PER_LOOP);

    for (const post of filtered) {
      try {
        await sendStyledPost(post);
        rememberPost(post);
        await saveState();
        break;
      } catch (error) {
        console.log("❌ publish post error:", error.message);
      }
    }
  } catch (error) {
    console.log("❌ loop error:", error.message);
  }

  isRunning = false;
}

export async function startXWatcher() {
  console.log("👀 X Watcher started");
  await loadState();
  await loop();

  setInterval(() => {
    loop().catch((error) => {
      console.log("❌ watcher interval error:", error.message);
    });
  }, CHECK_INTERVAL);
}
