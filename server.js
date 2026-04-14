import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { buildPersonalityPrompt } from "./personality-engine.js";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Простая память по сессиям
const sessions = new Map();

app.get("/", (req, res) => {
  res.send("Chiikawa AI server is running 🧠");
});

function pickMode(reqMode, session) {
  if (reqMode === "greeting") return "greeting";
  if (!session.previous_response_id) return "greeting";
  return "chat";
}

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body.message || "").trim();
    const sessionId = String(req.body.sessionId || "default-session").trim();
    const reqMode = String(req.body.mode || "chat").trim();

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        reply: "OpenAI error: OPENAI_API_KEY is missing"
      });
    }

    if (!userMessage) {
      return res.json({ reply: "Say something 🥺" });
    }

    const session = sessions.get(sessionId) || {
      previous_response_id: null
    };

    const mode = pickMode(reqMode, session);
    const instructions = buildPersonalityPrompt(mode);

    const payload = {
      model: "gpt-4o-mini",
      instructions,
      input: userMessage,
      max_output_tokens: 500
    };

    if (session.previous_response_id) {
      payload.previous_response_id = session.previous_response_id;
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log("OPENAI RAW RESPONSE:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      const errorMessage =
        data?.error?.message ||
        data?.message ||
        "Unknown OpenAI error";

      return res.status(500).json({
        reply: `OpenAI error: ${errorMessage}`
      });
    }

    let reply = "";

    if (typeof data.output_text === "string" && data.output_text.trim()) {
      reply = data.output_text.trim();
    }

    if (!reply && Array.isArray(data.output)) {
      const parts = [];

      for (const item of data.output) {
        if (!item || !Array.isArray(item.content)) continue;

        for (const part of item.content) {
          if (part?.type === "output_text" && typeof part.text === "string") {
            parts.push(part.text);
          }
        }
      }

      reply = parts.join("\n").trim();
    }

    if (!reply || /^[-–—_\s.]+$/.test(reply)) {
      reply = "I’m here with you now ✨ Ask me again and I’ll answer properly 🥺";
    }

    sessions.set(sessionId, {
      previous_response_id: data.id || session.previous_response_id || null
    });

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
