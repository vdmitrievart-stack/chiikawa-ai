import fs from "fs";
import path from "path";

const FILE = path.resolve("./memory.json");

let db = { users: {} };

if (fs.existsSync(FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    console.log("memory reset");
  }
}

function save() {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

function now() {
  return Date.now();
}

// 🎯 стиль
function detectStyle(text) {
  const t = text.toLowerCase();

  if (t.includes("gm") || t.includes("bro") || t.includes("pump")) return "crypto";
  if (t.length < 8) return "short";
  if (t.includes("?")) return "curious";

  return "normal";
}

// 🎯 тема
function detectTopic(text) {
  const t = text.toLowerCase();

  if (t.includes("ca")) return "contract";
  if (t.includes("price") || t.includes("pump")) return "price";
  if (t.includes("website")) return "website";
  if (t.includes("chiikawa")) return "chiikawa";

  return "general";
}

// 🧠 получить
export function getUser(userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      firstSeen: now(),
      lastSeen: now(),
      messages: 0,
      style: "normal",
      topics: {},
      mood: 0,
      favorite: false,
      toxic: 0
    };
  }

  return db.users[userId];
}

// 🧠 обновление
export function updateUser(userId, text) {
  const user = getUser(userId);

  user.lastSeen = now();
  user.messages++;

  user.style = detectStyle(text);

  const topic = detectTopic(text);
  user.topics[topic] = (user.topics[topic] || 0) + 1;

  // ❤️ любимые
  if (user.messages > 30) user.favorite = true;

  // 🧠 настроение
  if (text.toLowerCase().includes("love") || text.includes("❤️")) {
    user.mood += 2;
  } else {
    user.mood -= 0.2;
  }

  // ☠️ токсичность
  if (text.includes("scam") || text.includes("shit")) {
    user.toxic++;
  }

  save();
}

// 🎯 настроение к пользователю
export function buildEmotion(user) {
  if (user.toxic > 5) return "defensive";
  if (user.mood > 10) return "attached";
  if (user.favorite) return "friendly";

  return "neutral";
}

// 🎯 приветствие
export function greeting(user) {
  if (user.messages < 3) {
    return "🥺✨ Hi... I'm Chiikawa... I'm really happy to meet you...";
  }

  if (user.favorite) {
    return "🥹✨ You're back... I missed you...";
  }

  return "";
}

// 🎯 контекст
export function buildContext(user) {
  let ctx = "";

  if (user.style === "crypto") {
    ctx += "User speaks crypto style.\n";
  }

  if (user.topics.contract > 2) {
    ctx += "User often asks CA.\n";
  }

  if (user.topics.price > 3) {
    ctx += "User likes pump topics.\n";
  }

  const emotion = buildEmotion(user);
  ctx += `Emotion toward user: ${emotion}\n`;

  return ctx;
}
