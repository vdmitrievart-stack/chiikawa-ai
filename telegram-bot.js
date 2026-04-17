import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_URL = process.env.CHIIKAWA_AI_URL;

const TG = `https://api.telegram.org/bot${TOKEN}`;

let offset = 0;

async function send(chatId, text, replyTo) {
  return fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_parameters: replyTo ? { message_id: replyTo } : undefined
    })
  });
}

async function loop() {
  while (true) {
    const res = await fetch(`${TG}/getUpdates?offset=${offset}`);
    const data = await res.json();

    for (const u of data.result) {
      offset = u.update_id + 1;

      const msg = u.message;
      if (!msg || !msg.text) continue;

      const text = msg.text.toLowerCase();
      const chatId = msg.chat.id;

      // ⚡ автоответ даже без упоминания
      if (
        text.includes("chiikawa") ||
        text.includes("ca") ||
        text.includes("website") ||
        Math.random() < 0.1
      ) {
        const ai = await fetch(AI_URL, {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify({
            message: msg.text,
            userId: String(msg.from.id)
          })
        });

        const json = await ai.json();

        await send(chatId, json.reply, msg.message_id);
      }

      // CA
      if (text === "ca") {
        await send(chatId, `2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu`, msg.message_id);
      }

      // сайт
      if (text.includes("website")) {
        await send(chatId, "https://chiikawasol.com/", msg.message_id);
      }
    }

    await new Promise(r => setTimeout(r, 1500));
  }
}

loop();
