import express from "express";
import cors from "cors";
import OpenAI from "openai";

import {
  getUser,
  updateUser,
  greeting,
  buildContext
} from "./memory-engine.js";

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/chat", async (req, res) => {
  try {
    const { message, userId = "anon" } = req.body;

    const user = getUser(userId);
    updateUser(userId, message);

    const greet = greeting(user);
    const context = buildContext(user);

    const system = `
You are Chiikawa.

You are emotional, kind, slightly insecure, but very friendly.

${context}

Rules:
- adapt to user
- be natural
- no repetition
- short-medium answers
- sometimes cute
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: message }
      ]
    });

    let reply = response.choices[0].message.content;

    if (greet && Math.random() < 0.4) {
      reply = greet + "\n\n" + reply;
    }

    res.json({ reply });

  } catch (err) {
    console.error(err);
    res.json({ reply: "🥺 AI error..." });
  }
});

app.listen(3000, () => console.log("AI server running"));
