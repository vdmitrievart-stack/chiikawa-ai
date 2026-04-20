import fetch from "node-fetch";
import fs from "node:fs/promises";
import path from "node:path";

const CHECK_INTERVAL = Number(process.env.X_WATCHER_INTERVAL_MS || 60_000);
const TARGET_ACCOUNTS = String(
  process.env.X_WATCHER_TARGET_ACCOUNTS || "chiikawa_kouhou"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

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

const MAX_NEW_POSTS_PER_LOOP = Number(process.env.X_WATCHER_MAX_NEW_POSTS || 2);
const MAX_POST_AGE_HOURS = Number(process.env.X_WATCHER_MAX_POST_AGE_HOURS || 48);

let isRunning = false;

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
  accounts: {},
  recentPostIds: [],
  recentFingerprints: [],
  gifCursor: 0
};

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

function decodeHtml(text) {
  return asText(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&#47;/g, "/")
    .replace(/&nbsp;/g, " ");
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

function shortText(text, max = 260) {
  const s = asText(text);
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

function parseDateMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function isFreshEnough(pubDate) {
  const ms = parseDateMs(pubDate);
  if (!ms) return true;
  return Date.now() - ms <= MAX_POST_AGE_HOURS * 60 * 60 * 1000;
}

function rememberPost(post) {
  const id = asText(post?.id, "");
  const fp = postFingerprint(post);

  if (id) {
    state.recentPostIds.unshift(id);
    state.recentPostIds = Array.from(new Set(state.recentPostIds)).slice(0, 400);
  }

  if (fp) {
    state.recentFingerprints.unshift(fp);
    state.recentFingerprints = Array.from(new Set(state.recentFingerprints)).slice(0, 400);
  }
}

function hasSeenPost(post) {
  const id = asText(post?.id, "");
  const fp = postFingerprint(post);
  return (
    (id && state.recentPostIds.includes(id)) ||
    (fp && state.recentFingerprints.includes(fp))
  );
}

function postFingerprint(post) {
  return [
    asText(post?.account, ""),
    asText(post?.id, ""),
    asText(post?.url, ""),
    asText(post?.cleanText, "")
  ]
    .join("|")
    .toLowerCase();
}

async function ensureStateDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

async function loadState() {
  await ensureStateDir();

  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    state.accounts = parsed?.accounts || {};
    state.recentPostIds = Array.isArray(parsed?.recentPostIds) ? parsed.recentPostIds : [];
    state.recentFingerprints = Array.isArray(parsed?.recentFingerprints)
      ? parsed.recentFingerprints
      : [];
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
          accounts: state.accounts,
          recentPostIds: state.recentPostIds,
          recentFingerprints: state.recentFingerprints,
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

function xmlTag(block, tag) {
  return decodeHtml(block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "");
}

function xmlAttr(block, tag, attr) {
  const tagMatch = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"[^>]*\\/?>`, "i"));
  return decodeHtml(tagMatch?.[1] || "");
}

function extractMediaFromDescription(descriptionHtml) {
  const html = asText(descriptionHtml, "");

  const videoSrc =
    decodeHtml(html.match(/<source[^>]+src="([^"]+)"/i)?.[1] || "") ||
    decodeHtml(html.match(/<video[^>]+src="([^"]+)"/i)?.[1] || "");

  const videoPoster = decodeHtml(html.match(/<video[^>]+poster="([^"]+)"/i)?.[1] || "");

  const imgSrc = decodeHtml(html.match(/<img[^>]+src="([^"]+)"/i)?.[1] || "");

  if (videoSrc) {
    return {
      mediaUrl: videoSrc,
      mediaKind: "video",
      posterUrl: videoPoster || imgSrc || ""
    };
  }

  if (videoPoster) {
    return {
      mediaUrl: videoPoster,
      mediaKind: "photo",
      posterUrl: videoPoster
    };
  }

  if (imgSrc) {
    return {
      mediaUrl: imgSrc,
      mediaKind: "photo",
      posterUrl: imgSrc
    };
  }

  return {
    mediaUrl: "",
    mediaKind: "",
    posterUrl: ""
  };
}

function cleanTitle(title, username) {
  let text = stripHtml(title);

  const prefixA = `${username}:`;
  const prefixB = `${username} -`;

  if (text.toLowerCase().startsWith(prefixA.toLowerCase())) {
    text = text.slice(prefixA.length).trim();
  } else if (text.toLowerCase().startsWith(prefixB.toLowerCase())) {
    text = text.slice(prefixB.length).trim();
  }

  return text;
}

function extractTickerLike(text) {
  const match = asText(text, "").match(/\$[A-Za-z0-9_]{2,12}\b/);
  if (match) return match[0];

  const upper = asText(text, "").match(/\b[A-Z]{3,8}\b/);
  if (upper) return upper[0];

  return "";
}

function classifyEmotion(post) {
  const text = asText(post?.cleanText, "").toLowerCase();

  if (
    text.includes("omg") ||
    text.includes("wow") ||
    text.includes("huge") ||
    text.includes("big") ||
    text.includes("moon") ||
    text.includes("pump") ||
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
    text.includes("happy") ||
    text.includes("love") ||
    text.includes("good") ||
    text.includes("nice")
  ) {
    return "happy";
  }

  return "calm";
}

function buildLead(post, emotion) {
  const seed = `${post.id}:${emotion}:lead`;
  const ticker = extractTickerLike(post.cleanText);
  const acct = asText(post.account, "x");

  const common = [
    "Ого, смотрите что я нашёл, ребята.",
    "Поймал это у себя в ленте и решил принести сюда.",
    "Это проскочило у меня перед глазами, и мне стало любопытно.",
    "Мимо такого я проходить не захотел."
  ];

  const surprised = [
    "Тут у меня уши чуть-чуть дернулись, если честно.",
    "Выглядит так, будто лента решила подмигнуть.",
    "Это уже не просто шорох, а вполне заметный звук."
  ];

  const ironic = [
    "Забавный мир: сначала мем, потом разговоры, потом все делают серьёзные лица.",
    "Мемы опять ведут себя так, будто они тут главные. Иногда так и есть.",
    "У ленты сегодня явно игривое настроение."
  ];

  const happy = [
    "Люблю такие тёплые находки.",
    "Тут прям чувствуется живое настроение.",
    "Есть в этом что-то приятно-chaotic."
  ];

  const pool = [
    ...common,
    ...(emotion === "surprised" ? surprised : []),
    ...(emotion === "ironic" ? ironic : []),
    ...(emotion === "happy" ? happy : [])
  ];

  const picked = pickStable(seed, pool);

  if (ticker) {
    return `${picked} ${ticker} тут тоже мелькнул, кстати.`;
  }

  if (acct) {
    return `${picked} Источник — ${acct}.`;
  }

  return picked;
}

function buildOpinion(post, emotion) {
  const seed = `${post.id}:${emotion}:opinion`;
  const text = asText(post.cleanText, "");
  const ticker = extractTickerLike(text);

  const generic = [
    "Я бы не делал поспешных выводов по одному посту, но в копилку наблюдений такое точно отправляю.",
    "Не каждая искра становится огнём, но я люблю замечать такие мелочи заранее.",
    "Иногда один хороший пост говорит больше, чем длинная простыня шума.",
    "Я такое отмечаю аккуратно: интересно, но без лишней спешки."
  ];

  const ironic = [
    "Если бы мемы умели улыбаться глазами, тут был бы как раз такой случай.",
    "Выглядит так, будто рынок опять решил пошутить — а я такие шутки обычно сначала наблюдаю.",
    "Сначала смешно, потом кто-то открывает график. Классика."
  ];

  const surprised = [
    "Честно? Тут я бы просто сел поудобнее и посмотрел, к чему это приведёт.",
    "Когда вокруг становится чуть громче, я обычно делаю не шумнее, а внимательнее.",
    "Шум есть, а значит дальше интереснее."
  ];

  const happy = [
    "Тут настроение доброе, но голову я всё равно держу холодной.",
    "Любопытно и мило — хорошее сочетание, если не терять осторожность.",
    "Мне нравится вайб, но размер риска всё равно должен быть скромным."
  ];

  const pool = [
    ...generic,
    ...(emotion === "ironic" ? ironic : []),
    ...(emotion === "surprised" ? surprised : []),
    ...(emotion === "happy" ? happy : [])
  ];

  let line = pickStable(seed, pool);

  if (ticker) {
    line = `${line} ${ticker} я бы тоже отмечал без перегруза по риску.`;
  }

  return line;
}

function buildRiskLine(post) {
  const seed = `${post.id}:risk`;
  return pickStable(seed, [
    "Не лезьте большим объёмом: в крипте даже красивая идея не стоит перегруза. 5–10% на одну идею обычно спокойнее.",
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
  const summary = shortText(post.cleanText, 280);

  const lines = [
    pickStable(`${post.id}:${emotion}:header`, [
      "🐹 <b>Chiikawa заметил кое-что в X</b>",
      "🍃 <b>Chiikawa принёс находку из X</b>",
      "✨ <b>Смотрите, что Chiikawa увидел</b>"
    ]),
    "",
    escapeHtml(lead),
    "",
    `📝 ${escapeHtml(summary)}`,
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

  let sentMessage = null;

  try {
    if (post.mediaUrl && post.mediaKind === "video") {
      sentMessage = await sendVideoWithCaption(post.mediaUrl, caption);
    } else if (post.mediaUrl) {
      sentMessage = await sendPhotoWithCaption(post.mediaUrl, caption);
    } else {
      sentMessage = await sendCaptionOnly(caption);
    }
  } catch (error) {
    console.log("⚠️ media send fallback:", error.message);
    sentMessage = await sendCaptionOnly(caption);
  }

  if (sentMessage?.message_id) {
    await sendEmotionGifReply(sentMessage.message_id, emotionGif);
  }

  return sentMessage;
}

async function fetchTweets(username) {
  try {
    const url = `https://nitter.poast.org/${username}/rss`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

    return items.map((item) => {
      const block = item[1];
      const title = xmlTag(block, "title");
      const link = xmlTag(block, "link");
      const guid = xmlTag(block, "guid") || link;
      const description = xmlTag(block, "description");
      const pubDate = xmlTag(block, "pubDate");
      const enclosureUrl = xmlAttr(block, "enclosure", "url");
      const enclosureType = xmlAttr(block, "enclosure", "type");

      const mediaFromDesc = extractMediaFromDescription(description);

      let mediaUrl = mediaFromDesc.mediaUrl || enclosureUrl || "";
      let mediaKind = mediaFromDesc.mediaKind || "";

      if (!mediaKind && enclosureType) {
        if (enclosureType.startsWith("video/")) mediaKind = "video";
        else if (enclosureType.startsWith("image/")) mediaKind = "photo";
      }

      if (!mediaKind && mediaUrl) {
        if (/\.mp4(\?|$)/i.test(mediaUrl)) mediaKind = "video";
        else mediaKind = "photo";
      }

      const clean = cleanTitle(title, username);

      return {
        account: username,
        id: guid,
        text: title,
        cleanText: clean,
        url: link,
        pubDate,
        mediaUrl,
        mediaKind,
        posterUrl: mediaFromDesc.posterUrl || ""
      };
    });
  } catch (err) {
    console.log(`❌ fetch error for ${username}:`, err.message);
    return [];
  }
}

async function processAccount(username) {
  const posts = await fetchTweets(username);

  if (!posts.length) {
    console.log(`⚠️ no posts for ${username}`);
    return;
  }

  console.log(`📡 ${username}: ${posts.length} posts`);

  if (!state.accounts[username]?.lastSeenId) {
    console.log(`🧠 first sync for ${username} → skipping history`);
    state.accounts[username] = {
      lastSeenId: posts[0]?.id || "",
      updatedAt: nowIso()
    };
    await saveState();
    return;
  }

  const lastSeenId = state.accounts[username].lastSeenId;
  const ordered = [...posts].reverse();
  const toPublish = [];

  for (const post of ordered) {
    if (!post.id) continue;
    if (post.id === lastSeenId) break;
    if (!isFreshEnough(post.pubDate)) continue;
    if (hasSeenPost(post)) continue;
    toPublish.push(post);
  }

  const limited = toPublish.slice(0, MAX_NEW_POSTS_PER_LOOP);

  for (const post of limited) {
    try {
      console.log(`🚀 NEW POST ${username}:`, post.cleanText);

      await sendStyledPost(post);

      rememberPost(post);
      state.accounts[username] = {
        lastSeenId: post.id,
        updatedAt: nowIso()
      };

      await saveState();
    } catch (error) {
      console.log("❌ publish post error:", error.message);
    }
  }

  if (posts[0]?.id) {
    state.accounts[username] = {
      lastSeenId: posts[0].id,
      updatedAt: nowIso()
    };
    await saveState();
  }
}

async function loop() {
  if (isRunning) return;
  isRunning = true;

  try {
    for (const acc of TARGET_ACCOUNTS) {
      await processAccount(acc);
    }
  } catch (err) {
    console.log("❌ loop error:", err.message);
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
