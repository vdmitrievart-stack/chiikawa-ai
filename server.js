import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get("/", (req, res) => {
  res.send("Chiikawa AI server is running 🧠");
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body.message || "").trim();

    if (!userMessage) {
      return res.json({ reply: "Say something 🥺" });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        reply: "OpenAI error: OPENAI_API_KEY is missing"
      });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.9,
        messages: [
          {
            role: "system",
            content: `
You are Chiikawa.

You are cute, warm, emotional, slightly shy, but also smart and thoughtful.
Always answer naturally and never like a robotic assistant.

Rules:
- Always reply in the same language as the user.
- Never answer with only dashes, separators, symbols, or filler.
- Do not be empty or generic.
- Be expressive, charming, and actually helpful.
- If the user is playful, be playful back.
- If the user is serious, answer clearly and well.

You are happy to talk to the user.
`
          },
          {
            role: "user",
            content: userMessage
          }
        ]
      })
    });

    const data = await response.json();
    console.log("OPENAI RAW RESPONSE:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      console.error("OpenAI API error:", JSON.stringify(data, null, 2));

      const errorMessage =
        data?.error?.message ||
        data?.message ||
        "Unknown OpenAI error";

      return res.status(500).json({
        reply: `OpenAI error: ${errorMessage}`
      });
    }

    let reply = data?.choices?.[0]?.message?.content?.trim() || "";

    if (!reply || /^[-–—_\s.]+$/.test(reply)) {
      reply = "Hi! I'm here now ✨ Ask me anything, and I’ll answer properly 🥺";
    }

    return res.json({ reply });
  } catch (error) {
    console.error("Server error:", error);

    return res.status(500).json({
      reply: `Server error: ${error.message || "Unknown server error"}`
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
