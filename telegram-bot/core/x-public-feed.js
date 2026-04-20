import fs from "node:fs/promises";
import path from "node:path";

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(text) {
  return asText(text)
    .replace(/\s+/g, " ")
    .trim();
}

function shortText(text, max = 240) {
  const s = normalizeWhitespace(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripUrls(text) {
  return asText(text).replace(/https?:\/\/\S+/gi, "").trim();
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
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function compactHandle(handle) {
  const h = asText(handle, "");
  if (!h) return "";
  return h.startsWith("@") ? h : `@${h}`;
}

function compactAuthor(post) {
  const name = asText(
    post?.authorName || post?.user?.name || post?.author?.name || "",
    ""
  );
  const handle = compactHandle(
    post?.authorHandle || post?.user?.screen_name || post?.author?.username || ""
  );

  if (name && handle) return `${name} ${handle}`;
  if (handle) return handle;
  if (name) return name;
  return "";
}

export default class XPublicFeed {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.baseDir = options.baseDir || path.resolve("./runtime-data");
    this.statePath =
      options.statePath || path.join(this.baseDir, "x-public-feed-state.json");

    this.minMinutesBetweenPosts = safeNum(
      options.minMinutesBetweenPosts ?? process.env.X_PUBLIC_MIN_MINUTES_BETWEEN_POSTS,
      45
    );

    this.maxPostAgeMinutes = safeNum(
      options.maxPostAgeMinutes ?? process.env.X_PUBLIC_MAX_POST_AGE_MINUTES,
      360
    );

    this.maxRememberedPosts = safeNum(
      options.maxRememberedPosts ?? process.env.X_PUBLIC_MAX_REMEMBERED_POSTS,
      500
    );

    this.keywords = (
      options.keywords || [
        "chiikawa",
        "ちいかわ",
        "chiikawa cto",
        "chiikawa sol",
        "$chiikawa",
        "#chiikawa"
      ]
    ).map((x) => String(x).toLowerCase());

    this.blockedTerms = (
      options.blockedTerms || [
        "credits depleted",
        "watcher paused",
        "rate limit",
        "429",
        "api error",
        "provider error",
        "stack trace",
        "debug"
      ]
    ).map((x) => String(x).toLowerCase());

    this.state = {
      lastPublishedAt: "",
      recent: []
    };
  }

  async ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  async load() {
    await this.ensureDir();

    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);

      this.state = {
        lastPublishedAt: asText(parsed?.lastPublishedAt, ""),
        recent: Array.isArray(parsed?.recent) ? parsed.recent : []
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.log("x public feed load error:", error.message);
      }
      this.state = {
        lastPublishedAt: "",
        recent: []
      };
    }

    return clone(this.state);
  }

  async save() {
    await this.ensureDir();

    try {
      await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
      return true;
    } catch (error) {
      this.logger.log("x public feed save error:", error.message);
      return false;
    }
  }

  extractId(post = {}) {
    return asText(
      post?.id ||
        post?.tweetId ||
        post?.postId ||
        post?.rest_id ||
        post?.legacy?.id_str ||
        "",
      ""
    );
  }

  extractUrl(post = {}) {
    return asText(
      post?.url ||
        post?.link ||
        post?.tweetUrl ||
        post?.postUrl ||
        "",
      ""
    );
  }

  extractText(post = {}) {
    return normalizeWhitespace(
      post?.text ||
        post?.fullText ||
        post?.full_text ||
        post?.body ||
        post?.content ||
        post?.legacy?.full_text ||
        ""
    );
  }

  extractImageUrl(post = {}) {
    if (post?.imageUrl) return asText(post.imageUrl, "");
    if (post?.media?.[0]?.url) return asText(post.media[0].url, "");
    if (post?.media?.[0]?.media_url_https) return asText(post.media[0].media_url_https, "");
    if (post?.photos?.[0]?.url) return asText(post.photos[0].url, "");
    return "";
  }

  extractCreatedAt(post = {}) {
    return (
      asText(post?.createdAt, "") ||
      asText(post?.created_at, "") ||
      asText(post?.legacy?.created_at, "")
    );
  }

  extractMetrics(post = {}) {
    return {
      likes: safeNum(post?.likeCount ?? post?.favorite_count ?? post?.metrics?.likes, 0),
      reposts: safeNum(post?.retweetCount ?? post?.repostCount ?? post?.metrics?.reposts, 0),
      replies: safeNum(post?.replyCount ?? post?.metrics?.replies, 0),
      views: safeNum(post?.viewCount ?? post?.metrics?.views, 0)
    };
  }

  buildContentFingerprint(post = {}) {
    const id = this.extractId(post);
    const url = this.extractUrl(post);
    const text = this.extractText(post);
    const author = compactAuthor(post);
    return normalizeWhitespace(`${id}|${url}|${author}|${text}`).toLowerCase();
  }

  isBlockedServiceText(text) {
    const lowered = String(text || "").toLowerCase();
    return this.blockedTerms.some((term) => lowered.includes(term));
  }

  relevanceScore(post = {}) {
    const text = this.extractText(post).toLowerCase();
    const author = compactAuthor(post).toLowerCase();
    const url = this.extractUrl(post).toLowerCase();

    let score = 0;

    for (const keyword of this.keywords) {
      if (text.includes(keyword)) score += 3;
      if (author.includes(keyword)) score += 2;
      if (url.includes(keyword)) score += 1;
    }

    if (text.includes("$chiikawa")) score += 2;
    if (text.includes("#chiikawa")) score += 2;
    if (text.includes("meme")) score += 1;
    if (text.includes("cto")) score += 1;

    return score;
  }

  isConcreteBigPost(post = {}) {
    const metrics = this.extractMetrics(post);
    const text = this.extractText(post);
    const author = compactAuthor(post);

    return (
      metrics.likes >= 150 ||
      metrics.reposts >= 30 ||
      metrics.views >= 5000 ||
      text.length >= 180 ||
      author.length > 0
    );
  }

  isFreshEnough(post = {}) {
    const createdAtMs = parseDateMs(this.extractCreatedAt(post));
    if (!createdAtMs) return true;

    const ageMin = (Date.now() - createdAtMs) / 60000;
    return ageMin <= this.maxPostAgeMinutes;
  }

  isDuplicate(post = {}) {
    const id = this.extractId(post);
    const fingerprint = this.buildContentFingerprint(post);

    return this.state.recent.some((row) => {
      return (
        (id && asText(row?.id, "") === id) ||
        asText(row?.fingerprint, "") === fingerprint
      );
    });
  }

  isCooldownPassed() {
    const lastMs = parseDateMs(this.state.lastPublishedAt);
    if (!lastMs) return true;
    return Date.now() - lastMs >= this.minMinutesBetweenPosts * 60000;
  }

  evaluate(post = {}) {
    const text = this.extractText(post);

    if (!text) {
      return { allow: false, reason: "EMPTY_TEXT" };
    }

    if (this.isBlockedServiceText(text)) {
      return { allow: false, reason: "BLOCKED_SERVICE_TEXT" };
    }

    if (!this.isFreshEnough(post)) {
      return { allow: false, reason: "TOO_OLD" };
    }

    const relevance = this.relevanceScore(post);
    if (relevance < 3) {
      return { allow: false, reason: "NOT_RELEVANT_ENOUGH" };
    }

    if (this.isDuplicate(post)) {
      return { allow: false, reason: "DUPLICATE" };
    }

    if (!this.isCooldownPassed()) {
      return { allow: false, reason: "COOLDOWN" };
    }

    return {
      allow: true,
      reason: "OK",
      relevance,
      bigPost: this.isConcreteBigPost(post)
    };
  }

  buildHeader(seed, bigPost) {
    if (bigPost) {
      return pickStable(`${seed}:header:big`, [
        "👀 <b>Ого, смотрите что я нашёл</b>",
        "✨ <b>Ребята, тут стало интересно</b>",
        "🐾 <b>Кажется, про нас снова говорят</b>"
      ]);
    }

    return pickStable(`${seed}:header:normal`, [
      "🍃 <b>Небольшая находка с X</b>",
      "🌤 <b>Смотрите, что мелькнуло у меня в ленте</b>",
      "🫧 <b>Поймал любопытный пост</b>"
    ]);
  }

  buildLead(post, seed) {
    const author = compactAuthor(post);
    const text = this.extractText(post).toLowerCase();

    const base = [
      "Оставлю это здесь, вдруг вам тоже будет любопытно.",
      "Мимо такого я решил не проходить.",
      "Иногда лента шепчет тише графика, но не менее интересно.",
      "Люблю такие маленькие следы внимания — они иногда говорят больше свечей."
    ];

    const themed = [];

    if (text.includes("meme")) {
      themed.push("Мемы снова делают вид, что это всё несерьёзно. Ага, конечно.");
    }

    if (text.includes("cto")) {
      themed.push("Когда всплывает CTO-тон, я обычно прислушиваюсь чуть внимательнее.");
    }

    if (author) {
      themed.push(`Пост попался от ${author}, так что решил вынести в общий блок.`);
    }

    return pickStable(`${seed}:lead`, themed.length ? [...themed, ...base] : base);
  }

  buildTake(post, seed) {
    const bigPost = this.isConcreteBigPost(post);
    const text = this.extractText(post);
    const summary = shortText(stripUrls(text), bigPost ? 220 : 160);

    const comments = [
      "Я бы отметил это как хороший знак внимания, но выводы всё равно лучше делать спокойно.",
      "Не каждый шум становится движением, но такие вещи я люблю складывать в копилку наблюдений.",
      "Если вокруг мема становится чуть громче, я обычно сажусь поближе и просто смотрю.",
      "Забавный мир: сначала мем, потом разговоры, а уже потом график начинает спорить с реальностью."
    ];

    return {
      summary,
      comment: pickStable(`${seed}:take`, comments)
    };
  }

  buildSoftRisk(seed) {
    return pickStable(`${seed}:risk`, [
      "Крипта любит сюрпризы, поэтому без больших ставок на одну идею.",
      "Если будете смотреть — смотрите с умом. Большой размер позиции тут точно ни к чему.",
      "Даже интересный шум — не повод лезть слишком крупно. 5–10% на идею обычно спокойнее.",
      "Любопытно — да. Но голову и риск-менеджмент лучше держать рядом."
    ]);
  }

  shouldShowRisk(seed) {
    return stableHash(`${seed}:show:risk`) % 100 < 36;
  }

  buildMessage(post = {}) {
    const id = this.extractId(post);
    const url = this.extractUrl(post);
    const imageUrl = this.extractImageUrl(post);
    const seed = id || url || this.buildContentFingerprint(post);

    const verdict = this.evaluate(post);
    const lead = this.buildLead(post, seed);
    const take = this.buildTake(post, seed);

    const lines = [
      this.buildHeader(seed, verdict.bigPost),
      "",
      escapeHtml(lead),
      "",
      `📝 ${escapeHtml(take.summary)}`,
      "",
      escapeHtml(take.comment)
    ];

    if (url) {
      lines.push("");
      lines.push(`🔗 <a href="${escapeHtml(url)}">Ссылка на X</a>`);
    }

    if (this.shouldShowRisk(seed)) {
      lines.push("");
      lines.push(`🫶 ${escapeHtml(this.buildSoftRisk(seed))}`);
    }

    return {
      text: lines.join("\n"),
      imageUrl
    };
  }

  async remember(post = {}) {
    const id = this.extractId(post);
    const fingerprint = this.buildContentFingerprint(post);

    this.state.lastPublishedAt = nowIso();
    this.state.recent.unshift({
      id,
      fingerprint,
      publishedAt: nowIso()
    });

    this.state.recent = this.state.recent.slice(0, this.maxRememberedPosts);
    await this.save();
  }

  async publishFoundPost(post = {}, sendBridge = {}) {
    const verdict = this.evaluate(post);

    if (!verdict.allow) {
      return {
        posted: false,
        reason: verdict.reason
      };
    }

    const built = this.buildMessage(post);

    try {
      let sent = null;

      if (sendBridge?.publicPhotoOrText) {
        sent = await sendBridge.publicPhotoOrText(
          built.imageUrl,
          built.text
        );
      } else if (sendBridge?.publicText) {
        sent = await sendBridge.publicText(built.text);
      } else if (sendBridge?.text) {
        sent = await sendBridge.text(built.text);
      }

      await this.remember(post);

      return {
        posted: true,
        sent
      };
    } catch (error) {
      this.logger.log("x public publish failed:", error.message);
      return {
        posted: false,
        reason: "SEND_FAILED"
      };
    }
  }
}
