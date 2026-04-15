import fs from "fs";
import path from "path";

const STATE_FILE = path.resolve("./memory-state.json");
const MAX_RECENT_MESSAGES = 8;
const MAX_TOPIC_COUNT = 12;

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, value) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    console.error("memory-engine save error:", error.message);
  }
}

const state = safeReadJson(STATE_FILE, {
  users: {}
});

function ensureUser(userId) {
  const id = String(userId || "unknown");
  if (!state.users[id]) {
    state.users[id] = {
      userId: id,
      displayName: null,
      username: null,
      firstSeenAt: Date.now(),
      lastSeenAt: 0,
      preferredLanguage: null,
      chatsSeen: [],
      topics: [],
      recentMessages: [],
      notes: []
    };
  }
  return state.users[id];
}

function save() {
  safeWriteJson(STATE_FILE, state);
}

function detectLanguage(text = "") {
  const s = String(text);
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(s)) return "ja";
  if (/[\u4e00-\u9fff]/.test(s)) return "zh";
  if (/[а-яёіїєґ]/i.test(s)) return "ru";
  if (/[áéíóúñ¿¡]/i.test(s)) return "es";
  return "en";
}

function extractTopics(text = "") {
  const lower = String(text || "").toLowerCase();

  const topicRules = [
    ["x", ["twitter", "x ", " x", "tweet", "post"]],
    ["youtube", ["youtube", "episode", "video", "playlist"]],
    ["buybot", ["buy", "whale", "dex", "volume", "pair"]],
    ["music", ["music", "dj", "playlist", "song", "radio", "mood"]],
    ["website", ["website", "site", "link"]],
    ["contract", ["ca", "contract", "token address"]],
    ["community", ["community", "friends", "raid", "telegram"]],
    ["meme", ["meme", "funny", "joke"]],
    ["scam_safety", ["scam", "spam", "fraud", "fake", "phishing"]],
    ["anime", ["anime", "episode", "chiikawa"]]
  ];

  const topics = [];
  for (const [name, needles] of topicRules) {
    if (needles.some(n => lower.includes(n))) topics.push(name);
  }

  return topics;
}

function pushLimited(arr, value, max) {
  arr.push(value);
  while (arr.length > max) arr.shift();
}

function uniquePush(arr, value, max) {
  if (!value) return;
  if (!arr.includes(value)) arr.push(value);
  while (arr.length > max) arr.shift();
}

export function rememberInteraction({
  userId,
  displayName,
  username,
  chatId,
  chatType,
  text
}) {
  const user = ensureUser(userId);

  user.lastSeenAt = Date.now();
  if (displayName) user.displayName = displayName;
  if (username) user.username = username;
  if (text) user.preferredLanguage = detectLanguage(text);

  if (chatId) {
    uniquePush(
      user.chatsSeen,
      `${chatType || "unknown"}:${String(chatId)}`,
      20
    );
  }

  const topics = extractTopics(text);
  for (const topic of topics) {
    uniquePush(user.topics, topic, MAX_TOPIC_COUNT);
  }

  if (text) {
    pushLimited(
      user.recentMessages,
      {
        at: Date.now(),
        text: String(text).slice(0, 280)
      },
      MAX_RECENT_MESSAGES
    );
  }

  save();
}

export function addUserNote(userId, note) {
  const user = ensureUser(userId);
  if (!note) return;
  pushLimited(
    user.notes,
    {
      at: Date.now(),
      note: String(note).slice(0, 240)
    },
    12
  );
  save();
}

export function getUserMemory(userId) {
  return ensureUser(userId);
}

export function buildMemoryContext(userId) {
  const user = ensureUser(userId);

  const topics = user.topics.length ? user.topics.join(", ") : "none";
  const recent = user.recentMessages.length
    ? user.recentMessages.map(m => `- ${m.text}`).join("\n")
    : "- none";
  const notes = user.notes.length
    ? user.notes.map(n => `- ${n.note}`).join("\n")
    : "- none";

  return `
Memory about this user:
- display name: ${user.displayName || "unknown"}
- username: ${user.username || "unknown"}
- preferred language: ${user.preferredLanguage || "unknown"}
- recurring topics: ${topics}

Recent messages:
${recent}

Notes:
${notes}
`.trim();
}
