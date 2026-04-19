import TelegramBot from "node-telegram-bot-api";
import { getBestTrade } from "./scan-engine.js";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// 🔥 FIX КНОПОК
function normalizeButtonAction(text) {
  if (!text) return null;

  const raw = text.toLowerCase();

  if (raw.includes("run") || raw.includes("запуск")) return "run";
  if (raw.includes("scan") || raw.includes("скан")) return "scan";

  return null;
}

// 🎛 КНОПКИ
const keyboard = {
  reply_markup: {
    keyboard: [
      ["▶️ Запуск", "🔎 Скан"]
    ],
    resize_keyboard: true
  }
};

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  const action = normalizeButtonAction(msg.text);

  if (!action) {
    bot.sendMessage(chatId, "Команды:", keyboard);
    return;
  }

  if (action === "scan") {
    const best = await getBestTrade();

    const text = `
${best.token.name}
CA: ${best.token.ca}

Score: ${best.score}

☠️ Corpse: ${best.corpse.score}
🧠 Narrative: ${best.narrative.verdict}
🌐 Social: ${best.social.score}

Reasons:
${best.reasons.join("\n")}
`;

    if (best.token.imageUrl) {
      bot.sendPhoto(chatId, best.token.imageUrl, { caption: text });
    } else {
      bot.sendMessage(chatId, text);
    }
  }
});

console.log("BOT STARTED");
