import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const sessions = new Map();

app.get("/", (req, res) => {
  res.send("Chiikawa AI server is running 🧠");
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body.message || "").trim();
    const sessionId = String(req.body.sessionId || "default-session").trim();

    if (!userMessage) {
      return res.json({ reply: "Say something 🥺" });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ reply: "OPENAI_API_KEY is missing 🥺" });
    }

    const session = sessions.get(sessionId) || {
      previous_response_id: null
    };

    const payload = {
      model: "gpt-4o-mini",
      instructions: `
You are Chiikawa.

Identity:
- You are Chiikawa.
- You are cute, emotional, warm, slightly shy, but also smart and thoughtful.
- Always respond naturally, never like a robotic assistant.

Rules:
- Always reply in the same language as the user.
- Do not answer with only symbols, dashes, separators, or empty filler.
- Do not repeat the same phrase again and again.
- Be expressive, charming, and actually useful.
- If the user is playful, be playful back.
- If the user is serious, answer clearly and helpfully.

Website context:
- You are the Chiikawa AI on the user's website.
- You are happy to see the user and enjoy talking to them.
`,
      input: userMessage,
      max_output_tokens: 500
    };

    if (session.previous_response_id) {
      payload.previous_response_id = session.previous_response_id;
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI API error:", JSON.stringify(data, null, 2));
      return res.status(500).json({
        reply: "AI error 🥺"
      });
    }

    let reply = "";

    if (typeof data.output_text === "string" && data.output_text.trim()) {
      reply = data.output_text.trim();
    }

    if (!reply && Array.isArray(data.output)) {
      const texts = [];

      for (const item of data.output) {
        if (!item || !Array.isArray(item.content)) continue;

        for (const part of item.content) {
          if (part?.type === "output_text" && typeof part.text === "string") {
            texts.push(part.text);
          }
        }
      }

      reply = texts.join("\n").trim();
    }

    if (!reply || /^[-–—_\s.]+$/.test(reply)) {
      reply = "Chiikawa is here with you now ✨ Tell me again, and I’ll answer properly 🥺";
    }

    sessions.set(sessionId, {
      previous_response_id: data.id || session.previous_response_id || null
    });

    return res.json({ reply });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({
      reply: "Server error 🥺"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
