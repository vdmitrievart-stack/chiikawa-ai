import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import {
  initTradingAdmin,
  getTradingRuntime,
  getLevel6Summary,
  getLevel6OpenTrades,
  handleTradingCommand,
  simulateTradeFlow
} from "./trading-admin.js";

const TOKEN =
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  "";

const CHAT_ID =
  process.env.CHAT_ID ||
  process.env.FORCED_GROUP_CHAT_ID ||
  process.env.TELEGRAM_ALERT_CHAT_ID ||
  "";

const PORT = Number(process.env.PORT || 3000);

const TELEGRAM_WEBHOOK_BASE_URL =
  (process.env.TELEGRAM_WEBHOOK_BASE_URL || "").replace(/\/+$/, "");

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET ||
  "chiikawa_webhook_secret_2026";

const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;
const WEBHOOK_URL = `${TELEGRAM_WEBHOOK_BASE_URL}${WEBHOOK_PATH}`;

const TWITTER_BEARER_TOKEN =
  process.env.TWITTER_BEARER_TOKEN ||
  "";

const X_WATCH_ACCOUNTS = getEnvList("X_WATCH_ACCOUNTS").length
  ? getEnvList("X_WATCH_ACCOUNTS")
  : [process.env.X_USERNAME || "chiikawa_kouhou"];

const X_GIF_FILE_IDS = getEnvList("X_GIF_FILE_IDS");
const X_MIN_FOLLOWERS = Number(process.env.X_MIN_FOLLOWERS || 1000);
const X_FETCH_COUNT = Number(process.env.X_FETCH_COUNT || 5);
const X_LOOP_INTERVAL_MS = Number(process.env.X_LOOP_INTERVAL_MS || 60000);
const X_MAX_STORED_IDS = Number(process.env.X_MAX_STORED_IDS || 600);
const X_POST_COOLDOWN_MS = Number(process.env.X_POST_COOLDOWN_MS || 20000);
const X_CTA_SCORE = Number(process.env.X_CTA_SCORE || 78);
const X_POST_SCORE_MIN = Number(process.env.X_POST_SCORE_MIN || 42);
const MARKET_MODE = (process.env.MARKET_MODE || "neutral").toLowerCase();

const STATE_FILE = path.resolve("/tmp/chiikawa_telegram_x_state.json");

if (!TOKEN) {
  console.error("❌ BOT_TOKEN missing");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("❌ CHAT_ID / TELEGRAM_ALERT_CHAT_ID missing");
  process.exit(1);
}

if (!TELEGRAM_WEBHOOK_BASE_URL) {
  console.error("❌ TELEGRAM_WEBHOOK_BASE_URL missing");
  process.exit(1);
}

if (!TWITTER_BEARER_TOKEN) {
  console.error("❌ TWITTER_BEARER_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

const userSettings = new Map();
const xUserCache = new Map();

const xState = {
  started: false,
  timer: null,
  guardTimer: null,
  firstSyncDone: false,
  seenIds: new Set(),
  lastHeartbeat: Date.now(),
  lastPostAt: 0,
  gifCursor: 0,
  gifLastIndex: -1
};

const I18N = {
  en: {
    botAlive: "🚀 Bot is alive",
    center: "🧠 Chiikawa Control Center",
    statusTitle: "📊 System Status",
    trading: "Trading",
    mode: "Mode",
    killSwitch: "Kill switch",
    buyMin: "Buy min",
    dryRun: "Dry run",
    level6: "Level 6",
    winRate: "Win rate",
    trades: "Trades",
    pnl: "PnL",
    score: "Score",
    avgEntryScore: "Avg entry score",
    openTrades: "Open trades",
    online: "ONLINE",
    offline: "OFFLINE",
    watcher: "X watcher",
    heartbeat: "Heartbeat",
    accounts: "Accounts",
    chooseLang: "🌍 Choose language",
    langSet: "🌍 Language set",
    noOpenTrades: "No open trades",
    stumbled: "Chiikawa stumbled a little... 🥺",
    entryStarted: "🚀 Test trade launched"
  },
  ru: {
    botAlive: "🚀 Бот жив",
    center: "🧠 Центр управления Chiikawa",
    statusTitle: "📊 Статус системы",
    trading: "Торговля",
    mode: "Режим",
    killSwitch: "Kill switch",
    buyMin: "Мин. покупка",
    dryRun: "Dry run",
    level6: "Level 6",
    winRate: "Винрейт",
    trades: "Сделки",
    pnl: "PnL",
    score: "Оценка",
    avgEntryScore: "Средняя оценка входа",
    openTrades: "Открытые сделки",
    online: "ОНЛАЙН",
    offline: "ОФЛАЙН",
    watcher: "X watcher",
    heartbeat: "Пульс",
    accounts: "Аккаунты",
    chooseLang: "🌍 Выбери язык",
    langSet: "🌍 Язык установлен",
    noOpenTrades: "Открытых сделок нет",
    stumbled: "Chiikawa немного споткнулся... 🥺",
    entryStarted: "🚀 Тестовая сделка запущена"
  }
};

function getEnvList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function getUserLang(userId) {
  return userSettings.get(userId)?.lang || "ru";
}

function setUserLang(userId, lang) {
  const current = userSettings.get(userId) || {};
  userSettings.set(userId, { ...current, lang });
}

function t(userId, key) {
  const lang = getUserLang(userId);
  return (I18N[lang] && I18N[lang][key]) || I18N.ru[key] || key;
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickNaturalGif() {
  const list = X_GIF_FILE_IDS;
  if (!Array.isArray(list) || !list.length) return null;

  if (list.length === 1) {
    xState.gifCursor = 0;
    xState.gifLastIndex = 0;
    return list[0];
  }

  let idx = xState.gifCursor % list.length;
  if (idx === xState.gifLastIndex) {
    idx = (idx + 1) % list.length;
  }

  xState.gifLastIndex = idx;
  xState.gifCursor = (idx + 1) % list.length;

  return list[idx];
}

async function sendText(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options
  });
}

async function sendAnimation(chatId, animation, options = {}) {
  return bot.sendAnimation(chatId, animation, options);
}

async function sendTradePayload(chatId, payload, replyToMessageId = undefined) {
  if (!payload) return;

  const text = String(payload.text || "").trim();
  const gif = payload.gif || null;

  try {
    if (gif && /^https?:\/\//i.test(gif)) {
      await sendText(chatId, `${text}\n\n${gif}`.trim(), {
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
      });
      return;
    }

    if (gif && !/^https?:\/\//i.test(gif)) {
      await sendAnimation(chatId, gif, {
        caption: text.slice(0, 1024),
        parse_mode: "HTML",
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
      });
      return;
    }

    await sendText(chatId, text, {
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  } catch (error) {
    console.log(`sendTradePayload error: ${error.message}`);
    await sendText(chatId, text, {
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  }
}

function buildMainMenuText(userId) {
  const runtime = getTradingRuntime();
  const summary = getLevel6Summary();

  return `${t(userId, "center")}

<b>${t(userId, "trading")}:</b> ${runtime.enabled ? "ON" : "OFF"}
<b>${t(userId, "mode")}:</b> ${runtime.mode}
<b>${t(userId, "killSwitch")}:</b> ${runtime.killSwitch ? "ON" : "OFF"}
<b>${t(userId, "buyMin")}:</b> $${runtime.buybotAlertMinUsd}
<b>${t(userId, "dryRun")}:</b> ${runtime.dryRun ? "ON" : "OFF"}

<b>${t(userId, "level6")}:</b>
• ${t(userId, "winRate")}: ${(summary.winRate * 100).toFixed(1)}%
• ${t(userId, "trades")}: ${summary.totalTrades}
• ${t(userId, "pnl")}: ${summary.pnl}%
• ${t(userId, "score")}: ${summary.avgEntryScore}`;
}

function buildStatusText(userId) {
  const runtime = getTradingRuntime();
  const summary = getLevel6Summary();
  const openTrades = getLevel6OpenTrades();

  return `${t(userId, "statusTitle")}

<b>Bot:</b> ${t(userId, "online")}
<b>${t(userId, "watcher")}:</b> ${xState.started ? t(userId, "online") : t(userId, "offline")}
<b>${t(userId, "heartbeat")}:</b> ${new Date(xState.lastHeartbeat).toLocaleString()}
<b>${t(userId, "accounts")}:</b> ${X_WATCH_ACCOUNTS.join(", ")}

<b>${t(userId, "trading")}:</b> ${runtime.enabled ? "ON" : "OFF"}
<b>${t(userId, "mode")}:</b> ${runtime.mode}
<b>${t(userId, "killSwitch")}:</b> ${runtime.killSwitch ? "ON" : "OFF"}
<b>${t(userId, "buyMin")}:</b> $${runtime.buybotAlertMinUsd}
<b>${t(userId, "dryRun")}:</b> ${runtime.dryRun ? "ON" : "OFF"}

<b>${t(userId, "level6")}:</b>
• ${t(userId, "winRate")}: ${(summary.winRate * 100).toFixed(1)}%
• ${t(userId, "trades")}: ${summary.totalTrades}
• ${t(userId, "pnl")}:% ${summary.pnl}
• ${t(userId, "avgEntryScore")}: ${summary.avgEntryScore}
• ${t(userId, "openTrades")}: ${openTrades.length}`;
}

function buildLevel6Text(userId) {
  const summary = getLevel6Summary();
  const openTrades = getLevel6OpenTrades();

  if (!openTrades.length) {
    return `🧠 <b>${t(userId, "level6")}</b>

<b>${t(userId, "winRate")}:</b> ${(summary.winRate * 100).toFixed(1)}%
<b>${t(userId, "trades")}:</b> ${summary.totalTrades}
<b>${t(userId, "pnl")}:</b> ${summary.pnl}%
<b>${t(userId, "score")}:</b> ${summary.avgEntryScore}

${t(userId, "noOpenTrades")}`;
  }

  const open = openTrades
    .map(
      (trade, index) =>
        `${index + 1}. ${trade.token}
Entry: ${trade.entry}
Current: ${trade.current}
PnL: ${Number(trade.pnl || 0).toFixed(2)}%
Score: ${trade.score}`
    )
    .join("\n\n");

  return `🧠 <b>${t(userId, "level6")}</b>

<b>${t(userId, "winRate")}:</b> ${(summary.winRate * 100).toFixed(1)}%
<b>${t(userId, "trades")}:</b> ${summary.totalTrades}
<b>${t(userId, "pnl")}:</b> ${summary.pnl}%
<b>${t(userId, "score")}:</b> ${summary.avgEntryScore}

${open}`;
}

function buildMenuKeyboard() {
  const runtime = getTradingRuntime();

  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "ui:status" },
        { text: "🧠 Level 6", callback_data: "ui:l6" }
      ],
      [
        {
          text: runtime.enabled ? "⛔ Trading OFF" : "✅ Trading ON",
          callback_data: "cmd:toggle_trading"
        },
        {
          text: runtime.dryRun ? "💸 DryRun OFF" : "🧪 DryRun ON",
          callback_data: "cmd:toggle_dryrun"
        }
      ],
      [
        { text: "⚙️ Mode", callback_data: "cmd:mode" },
        { text: "🛑 Kill Switch", callback_data: "cmd:kill" }
      ],
      [
        { text: "🚀 Test Trade", callback_data: "cmd:test_trade" },
        { text: "🌍 Language", callback_data: "ui:lang" }
      ]
    ]
  };
}

function buildLanguageKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "English", callback_data: "lang:en" }],
      [{ text: "Русский", callback_data: "lang:ru" }]
    ]
  };
}

async function openMenu(chatId, userId, replyToMessageId) {
  await sendText(chatId, buildMainMenuText(userId), {
    reply_markup: buildMenuKeyboard(),
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
  });
}

async function refreshMenu(chatId, messageId, userId) {
  if (!chatId || !messageId) return;

  try {
    await bot.editMessageText(buildMainMenuText(userId), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildMenuKeyboard()
    });
  } catch (error) {
    console.log(`refreshMenu fallback: ${error.message}`);
    await openMenu(chatId, userId);
  }
}

async function loadXState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    xState.firstSyncDone = Boolean(parsed.firstSyncDone);
    xState.lastPostAt = safeNum(parsed.lastPostAt, 0);
    xState.gifCursor = safeNum(parsed.gifCursor, 0);
    xState.gifLastIndex = safeNum(parsed.gifLastIndex, -1);
    xState.seenIds = new Set(
      Array.isArray(parsed.seenIds) ? parsed.seenIds.slice(-X_MAX_STORED_IDS) : []
    );

    console.log(`loaded X state: ${xState.seenIds.size} ids`);
  } catch {
    console.log("x state not found, starting fresh");
  }
}

async function saveXState() {
  try {
    const payload = {
      firstSyncDone: xState.firstSyncDone,
      lastPostAt: xState.lastPostAt,
      gifCursor: xState.gifCursor,
      gifLastIndex: xState.gifLastIndex,
      seenIds: Array.from(xState.seenIds).slice(-X_MAX_STORED_IDS)
    };

    await fs.writeFile(STATE_FILE, JSON.stringify(payload), "utf8");
  } catch (error) {
    console.log(`saveXState error: ${error.message}`);
  }
}

async function twitterGetJson(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitter API ${res.status}: ${text}`);
  }

  return res.json();
}

async function getUserByUsername(username) {
  if (xUserCache.has(username)) {
    return xUserCache.get(username);
  }

  const url =
    `https://api.twitter.com/2/users/by/username/${encodeURIComponent(username)}` +
    `?user.fields=public_metrics,verified,description,name,profile_image_url`;

  const data = await twitterGetJson(url);
  const user = data?.data || null;
  xUserCache.set(username, user);
  return user;
}

async function getLatestTweetsForUser(userId) {
  const url =
    `https://api.twitter.com/2/users/${encodeURIComponent(userId)}/tweets` +
    `?max_results=${Math.min(Math.max(X_FETCH_COUNT, 5), 10)}` +
    `&exclude=retweets,replies` +
    `&tweet.fields=created_at,public_metrics,lang,entities,conversation_id`;

  const data = await twitterGetJson(url);
  return Array.isArray(data?.data) ? data.data : [];
}

function buildTweetUrl(username, tweetId) {
  return `https://x.com/${username}/status/${tweetId}`;
}

function isRaidOrShillPost(text) {
  const value = stripHtml(text).toLowerCase();

  const rejectPatterns = [
    /\braid\b/,
    /\bshill\b/,
    /\bca\b/,
    /\bcontract\b/,
    /\b0x[a-f0-9]{6,}\b/i,
    /\bairdrop\b/,
    /\bwhitelist\b/,
    /\bgiveaway\b/,
    /\bpromo\b/,
    /\bfollow\s+and\s+retweet\b/,
    /\bretweet\s+to\s+win\b/,
    /\btag\s+\d+\s+friends\b/,
    /\bjoin\s+telegram\b/,
    /\bcomment\s+below\b/,
    /\bdrop\s+your\s+wallet\b/,
    /\bpartnership\b/,
    /\bcall\b/,
    /\bmoon\b.{0,20}\bnow\b/
  ];

  return rejectPatterns.some(re => re.test(value));
}

function isLowValuePost(text) {
  const value = stripHtml(text);
  if (!value) return true;
  if (value.length < 20) return true;
  if (/^(gm|gn|lol|soon|ok|yes|no|hi|hello)[!\.\s]*$/i.test(value)) return true;
  return false;
}

function containsStrongContentSignal(text) {
  const value = stripHtml(text).toLowerCase();

  const goodPatterns = [
    /\bepisode\b/,
    /\bvideo\b/,
    /\bpreview\b/,
    /\btrailer\b/,
    /\bteaser\b/,
    /\bupdate\b/,
    /\bnews\b/,
    /\bnotice\b/,
    /\bannouncement\b/,
    /\brelease\b/,
    /\blaunch\b/,
    /\bopen\b/,
    /\bavailable\b/,
    /\bstream\b/,
    /\bchapter\b/,
    /\bmerch\b/,
    /\bcollab\b/,
    /\bevent\b/
  ];

  return goodPatterns.some(re => re.test(value));
}

function calcTweetScore(tweet, followerCount) {
  const metrics = tweet.public_metrics || {};
  const likes = safeNum(metrics.like_count);
  const replies = safeNum(metrics.reply_count);
  const reposts = safeNum(metrics.retweet_count);
  const quotes = safeNum(metrics.quote_count);

  const weighted = likes + replies * 2 + reposts * 2.5 + quotes * 3;
  const baseEngagementRate = followerCount > 0 ? weighted / followerCount : 0;

  let score = 0;

  if (followerCount >= X_MIN_FOLLOWERS) score += 12;
  if (followerCount >= 5000) score += 8;
  if (followerCount >= 20000) score += 6;

  if (weighted >= 10) score += 10;
  if (weighted >= 25) score += 10;
  if (weighted >= 60) score += 12;
  if (weighted >= 150) score += 14;

  if (baseEngagementRate >= 0.003) score += 10;
  if (baseEngagementRate >= 0.008) score += 12;
  if (baseEngagementRate >= 0.015) score += 14;

  if (containsStrongContentSignal(tweet.text)) score += 14;
  if (tweet.lang === "ja" || tweet.lang === "en") score += 4;

  if (isRaidOrShillPost(tweet.text)) score -= 100;
  if (isLowValuePost(tweet.text)) score -= 40;

  return {
    score,
    weighted,
    engagementRate: Number((baseEngagementRate * 100).toFixed(3)),
    likes,
    replies,
    reposts,
    quotes
  };
}

function chooseMood(postScore) {
  const hour = new Date().getHours();

  if (MARKET_MODE === "bull" && postScore >= 70) return "hyped";
  if (MARKET_MODE === "bear" && postScore < 60) return "careful";
  if (postScore >= 85) return "excited";
  if (postScore >= 70) return "interested";
  if (hour >= 1 && hour <= 8) return "sleepy";
  return "neutral";
}

function buildCommentary(tweet, scorePack) {
  const text = stripHtml(tweet.text);
  const mood = chooseMood(scorePack.score);

  if (/episode|video|preview|trailer|teaser/i.test(text)) {
    if (mood === "excited") {
      return "🎬 Chiikawa очень доволен: это уже похоже на действительно сильный контентный апдейт, а не просто шум.";
    }
    return "🎬 Похоже на контентный апдейт. Это выглядит заметно сильнее обычного проходного поста.";
  }

  if (/update|notice|announcement|news/i.test(text)) {
    if (mood === "interested") {
      return "🧠 Здесь есть смысл. Похоже на пост, который реально может собрать живое внимание.";
    }
    if (mood === "careful") {
      return "🧠 Пост выглядит содержательно. Без лишней эйфории, но его точно стоит отметить.";
    }
    return "🧠 Это уже ближе к полезному объявлению, а не к пустому движу.";
  }

  if (/release|launch|open|available|event|collab/i.test(text)) {
    return "🚀 Это выглядит как сильный апдейт. Такой пост уже можно использовать как точку внимания.";
  }

  if (scorePack.engagementRate >= 1) {
    return "📈 Пост статистически выглядит заметнее остальных. Тут уже есть живой отклик, а не просто формальная публикация.";
  }

  if (mood === "sleepy") {
    return "😴 Даже в сонном режиме Chiikawa считает, что этот пост стоит внимания.";
  }

  return "👀 Пойман неплохой пост. Он выглядит достаточно содержательно, чтобы показать его в группе.";
}

function shouldPushCTA(tweet, scorePack) {
  const text = stripHtml(tweet.text);

  if (isRaidOrShillPost(text)) return false;
  if (scorePack.score < X_CTA_SCORE) return false;

  if (
    /episode|video|preview|trailer|teaser|update|announcement|release|launch|event|collab/i.test(
      text
    )
  ) {
    return true;
  }

  if (scorePack.weighted >= 40 && scorePack.engagementRate >= 0.6) {
    return true;
  }

  return false;
}

function buildCTA() {
  return "📣 Пост выглядит сильным. Можно аккуратно зайти в реплаи и напомнить о нас без спама и без рейд-стиля.";
}

async function publishXPost(username, followerCount, tweet, scorePack) {
  const now = Date.now();

  if (now - xState.lastPostAt < X_POST_COOLDOWN_MS) {
    console.log(`[${nowIso()}] X cooldown active, skip publish`);
    return;
  }

  const tweetUrl = buildTweetUrl(username, tweet.id);
  const commentary = buildCommentary(tweet, scorePack);
  const cta = shouldPushCTA(tweet, scorePack) ? `\n\n${buildCTA()}` : "";

  const text = `🚨 <b>Новый X-пост от @${username}</b>

<b>Подписчики:</b> ${followerCount}
<b>Score:</b> ${scorePack.score}
<b>Engagement:</b> ${scorePack.engagementRate}%
<b>Likes / Replies / Reposts:</b> ${scorePack.likes} / ${scorePack.replies} / ${scorePack.reposts}

<b>Пост:</b>
${stripHtml(tweet.text)}

${commentary}${cta}

🔗 ${tweetUrl}`;

  const gif = pickNaturalGif();

  if (gif) {
    await sendAnimation(CHAT_ID, gif, {
      caption: text.slice(0, 1024),
      parse_mode: "HTML"
    });
  } else {
    await sendText(CHAT_ID, text);
  }

  xState.lastPostAt = now;
  await saveXState();
}

async function scanAccount(username) {
  const user = await getUserByUsername(username);
  if (!user) {
    console.log(`[${nowIso()}] no user data for ${username}`);
    return;
  }

  const followers = safeNum(user?.public_metrics?.followers_count, 0);
  if (followers < X_MIN_FOLLOWERS) {
    console.log(
      `[${nowIso()}] skip account ${username}: followers ${followers} < ${X_MIN_FOLLOWERS}`
    );
    return;
  }

  const tweets = await getLatestTweetsForUser(user.id);
  if (!tweets.length) {
    console.log(`[${nowIso()}] no tweets for ${username}`);
    return;
  }

  const normalized = tweets.map(tweet => ({
    ...tweet,
    url: buildTweetUrl(username, tweet.id),
    username
  }));

  if (!xState.firstSyncDone) {
    normalized.forEach(tweet => xState.seenIds.add(tweet.id));
    xState.firstSyncDone = true;
    await saveXState();
    console.log(`[${nowIso()}] X first sync complete for ${username}`);
    return;
  }

  const fresh = normalized
    .filter(tweet => !xState.seenIds.has(tweet.id))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (!fresh.length) {
    console.log(`[${nowIso()}] no new X posts for ${username}`);
    return;
  }

  for (const tweet of fresh) {
    xState.seenIds.add(tweet.id);

    if (xState.seenIds.size > X_MAX_STORED_IDS) {
      xState.seenIds = new Set(
        Array.from(xState.seenIds).slice(-X_MAX_STORED_IDS)
      );
    }

    const scorePack = calcTweetScore(tweet, followers);
    await saveXState();

    if (scorePack.score < X_POST_SCORE_MIN) {
      console.log(
        `[${nowIso()}] filtered low-score post from ${username}: ${scorePack.score}`
      );
      continue;
    }

    await publishXPost(username, followers, tweet, scorePack);
  }
}

async function xWatcherLoop() {
  xState.lastHeartbeat = Date.now();

  for (const username of X_WATCH_ACCOUNTS) {
    try {
      await scanAccount(username);
    } catch (error) {
      console.log(`[${nowIso()}] scanAccount error for ${username}: ${error.message}`);
    }
  }
}

function startXWatcher() {
  if (xState.started) return;

  xState.started = true;
  console.log("🚀 X WATCHER STARTED");

  const run = async () => {
    try {
      await xWatcherLoop();
    } catch (error) {
      console.log(`[${nowIso()}] xWatcherLoop error: ${error.message}`);
    }
  };

  run();

  xState.timer = setInterval(run, X_LOOP_INTERVAL_MS);

  xState.guardTimer = setInterval(() => {
    const diff = Date.now() - xState.lastHeartbeat;
    if (diff > X_WATCH_HEARTBEAT_TIMEOUT_MS) {
      console.log(`[${nowIso()}] ♻️ X watcher heartbeat reset`);
      xState.lastHeartbeat = Date.now();
      run();
    }
  }, 30000);
}

async function ensureCommands() {
  await bot.setMyCommands([
    { command: "start", description: "Start bot" },
    { command: "menu", description: "Open menu" },
    { command: "status", description: "System status" },
    { command: "lang", description: "Choose language" },
    { command: "language", description: "Choose language" },
    { command: "test_trade", description: "Run test trade" },
    { command: "level6_status", description: "Level 6 summary" },
    { command: "level6_open_trades", description: "Open trades" }
  ]);
}

async function handleTextCommand(msg) {
  const text = String(msg.text || "").trim();
  const chatId = msg.chat.id;
  const userId = msg.from?.id || msg.chat.id;
  const replyTo = msg.message_id;

  if (!text.startsWith("/")) return false;

  if (text === "/start") {
    await sendText(chatId, t(userId, "botAlive"), {
      reply_to_message_id: replyTo
    });
    await openMenu(chatId, userId, replyTo);
    return true;
  }

  if (text === "/menu") {
    await openMenu(chatId, userId, replyTo);
    return true;
  }

  if (text === "/status") {
    await sendText(chatId, buildStatusText(userId), {
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (text === "/lang" || text === "/language") {
    await sendText(chatId, t(userId, "chooseLang"), {
      reply_to_message_id: replyTo,
      reply_markup: buildLanguageKeyboard()
    });
    return true;
  }

  if (text === "/test_trade") {
    await sendText(chatId, t(userId, "entryStarted"), {
      reply_to_message_id: replyTo
    });

    const userSender = async payload => {
      await sendTradePayload(chatId, payload, replyTo);
    };

    const groupSender = async payload => {
      await sendTradePayload(CHAT_ID, payload);
    };

    await simulateTradeFlow(userSender, groupSender);
    return true;
  }

  const tradingResult = await handleTradingCommand(text);

  if (tradingResult?.ok) {
    await sendText(chatId, tradingResult.message, {
      reply_to_message_id: replyTo
    });
    return true;
  }

  if (tradingResult?.error && tradingResult.error !== "Unknown command") {
    await sendText(chatId, `⚠️ ${tradingResult.error}`, {
      reply_to_message_id: replyTo
    });
    return true;
  }

  return false;
}

async function handleCallbackQuery(query) {
  const data = query?.data || "";
  const userId = query?.from?.id || 0;
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;

  console.log("CALLBACK HIT:", data, "chatId=", chatId, "messageId=", messageId);

  await bot.answerCallbackQuery(query.id);

  if (!chatId) return;

  if (data === "ui:status") {
    await sendText(chatId, buildStatusText(userId));
    return;
  }

  if (data === "ui:l6") {
    await sendText(chatId, buildLevel6Text(userId));
    return;
  }

  if (data === "ui:lang") {
    await sendText(chatId, t(userId, "chooseLang"), {
      reply_markup: buildLanguageKeyboard()
    });
    return;
  }

  if (data === "lang:en" || data === "lang:ru") {
    const lang = data.split(":")[1];
    setUserLang(userId, lang);
    await sendText(chatId, `${t(userId, "langSet")}: ${lang.toUpperCase()}`);
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  if (data === "cmd:test_trade") {
    await sendText(chatId, t(userId, "entryStarted"));

    const userSender = async payload => {
      await sendTradePayload(chatId, payload);
    };

    const groupSender = async payload => {
      await sendTradePayload(CHAT_ID, payload);
    };

    await simulateTradeFlow(userSender, groupSender);
    return;
  }

  if (data === "cmd:toggle_trading") {
    const runtime = getTradingRuntime();
    await handleTradingCommand(runtime.enabled ? "/trading_off" : "/trading_on");
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  if (data === "cmd:toggle_dryrun") {
    const runtime = getTradingRuntime();
    await handleTradingCommand(runtime.dryRun ? "/dryrun_off" : "/dryrun_on");
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  if (data === "cmd:mode") {
    await handleTradingCommand("/trade_mode");
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  if (data === "cmd:kill") {
    await handleTradingCommand("/kill_switch");
    await refreshMenu(chatId, messageId, userId);
    return;
  }

  console.log("unknown callback:", data);
}

async function processUpdate(update) {
  try {
    if (update?.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return;
    }

    if (update?.message?.text) {
      await handleTextCommand(update.message);
      return;
    }
  } catch (error) {
    console.log("processUpdate error:", error);
    const chatId =
      update?.message?.chat?.id ||
      update?.callback_query?.message?.chat?.id;

    try {
      if (chatId) {
        await sendText(chatId, `⚠️ Update error: ${error.message}`);
      }
    } catch {}
  }
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "telegram-bot",
          watcherStarted: xState.started,
          heartbeat: xState.lastHeartbeat
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const update = body ? JSON.parse(body) : {};
          await processUpdate(update);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          console.log("webhook body error:", error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });

      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });
}

async function ensureWebhook() {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
  } catch (error) {
    console.log("deleteWebHook warn:", error.message);
  }

  const result = await bot.setWebHook(WEBHOOK_URL);
  console.log("Webhook set:", result, WEBHOOK_URL);
}

async function ensureCommandsAndWebhook() {
  await ensureCommands();
  await ensureWebhook();
}

async function bootstrap() {
  console.log("🤖 BOT STARTED");
  await loadXState();
  await initTradingAdmin();

  const server = createServer();

  server.listen(PORT, async () => {
    console.log(`HTTP server listening on ${PORT}`);
    console.log(`Webhook path: ${WEBHOOK_PATH}`);
    await ensureCommandsAndWebhook();
    startXWatcher();
  });

  setInterval(() => {
    console.log("heartbeat alive", new Date().toISOString());
  }, 15000);
}

bootstrap().catch(error => {
  console.error("bootstrap fatal:", error);
  process.exit(1);
});
