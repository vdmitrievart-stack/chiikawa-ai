import fs from "fs";
import path from "path";

const MEMORY_FILE = path.resolve("./memory.json");

let memory = {
  users: {}
};

// загрузка
if (fs.existsSync(MEMORY_FILE)) {
  try {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  } catch {
    console.log("Memory reset");
  }
}

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// 🎯 определить стиль
function detectStyle(text) {
  const t = text.toLowerCase();

  if (t.includes("bro") || t.includes("gm") || t.includes("lol")) return "crypto";
  if (t.length < 10) return "short";
  if (t.includes("?")) return "curious";

  return "normal";
}

// 🎯 извлечь тему
function extractTopic(text) {
  const t = text.toLowerCase();

  if (t.includes("price") || t.includes("pump")) return "price";
  if (t.includes("ca")) return "contract";
  if (t.includes("website")) return "website";
  if (t.includes("chiikawa")) return "chiikawa";

  return "general";
}

// 🧠 получить пользователя
export function getUserMemory(userId) {
  if (!memory.users[userId]) {
    memory.users[userId] = {
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      messages: 0,
      style: "normal",
      topics: {},
      isNew: true
    };
  }

  return memory.users[userId];
}

// 🧠 обновить память
export function updateMemory(userId, text) {
  const user = getUserMemory(userId);

  user.lastSeen = Date.now();
  user.messages += 1;
  user.isNew = user.messages < 3;

  const style = detectStyle(text);
  user.style = style;

  const topic = extractTopic(text);
  user.topics[topic] = (user.topics[topic] || 0) + 1;

  saveMemory();
}

// 🎯 приветствие
export function buildGreeting(user) {
  if (user.isNew) {
    return "🥺✨ Hi new friend... I'm Chiikawa... I'm really happy you found me...";
  }

  if (user.messages > 20) {
    return "🥹✨ Oh... it's you again... I'm really happy to see you...";
  }

  return "✨ Hi again...";
}

// 🎯 персонализация ответа
export function buildMemoryContext(user) {
  let ctx = "";

  if (user.style === "crypto") {
    ctx += "User speaks like crypto community. Be slightly playful.\n";
  }

  if (user.topics.price > 3) {
    ctx += "User is interested in price/pumps.\n";
  }

  if (user.topics.contract > 2) {
    ctx += "User often asks for CA.\n";
  }

  return ctx;
}
