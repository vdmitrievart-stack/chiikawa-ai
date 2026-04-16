import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { buildPersonalityPrompt } from "./personality-engine.js";
import {
  rememberInteraction,
  buildMemoryContext,
  addUserNote
} from "./memory-engine.js";
import { getMoodState, buildMoodContext } from "./mood-engine.js";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const CONFIG_FILE = path.resolve("./runtime-config.json");

// session memory for OpenAI response chaining
const sessions = new Map();

const DEFAULT_CONFIG = {
  quietMode: false,
  xWatcherEnabled: true,
  youtubeWatcherEnabled: true,
  buybotEnabled: true,
  buybotAlertMinUsd: 20,
  autoSelfTuning: true,
  updatedAt: Date.now()
};

function loadRuntimeConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveRuntimeConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save runtime config:", error.message);
  }
}

let runtimeConfig = loadRuntimeConfig();

function authOk(secret) {
  return ADMIN_SECRET && secret && secret === ADMIN_SECRET;
}

app.get("/", (req, res) => {
  res.send("Chiikawa AI server is running 🧠");
});

app.get("/runtime/config", (req, res) => {
  const secret = String(req.query.secret || "");
  if (!authOk(secret)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  return res.json({
    ok: true,
    config: runtimeConfig
  });
});

app.post("/runtime/config", (req, res) => {
  const secret = String(req.body.secret || "");
  if (!authOk(secret)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  const patch = req.body.patch || {};
  runtimeConfig = {
    ...runtimeConfig,
    ...patch,
    updatedAt: Date.now()
  };
  saveRuntimeConfig(runtimeConfig);

  return res.json({
    ok: true,
    config: runtimeConfig
  });
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

    const userId = String(req.body.userId || "anonymous");
    const userName = String(req.body.userName || "").trim();
    const username = String(req.body.username || "").trim();
    const chatId = String(req.body.chatId || "").trim();
    const chatType = String(req.body.chatType || "unknown").trim();
    const source = String(req.body.source || "chat").trim();

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        reply: "OpenAI error: OPENAI_API_KEY is missing"
      });
    }

    if (!userMessage) {
      return res.json({ reply: "Say something 🥺" });
    }

    rememberInteraction({
      userId,
      displayName: userName,
      username,
      chatId,
      chatType,
      text: userMessage
    });

    const session = sessions.get(sessionId) || {
      previous_response_id: null
    };

    const mode = pickMode(reqMode, session);
    const memoryContext = buildMemoryContext(userId);
    const moodState = getMoodState({
      source,
      signal: "normal",
      text: userMessage,
      now: new Date()
    });
    const moodContext = buildMoodContext(moodState);

    const instructions = buildPersonalityPrompt(
      mode,
      `
${memoryContext}

${moodContext}

Current source:
- source: ${source}
- chat type: ${chatType}
- user display name: ${userName || "unknown"}
- username: ${username || "unknown"}

Extra behavior:
- In group chats, be clearer and more context-aware.
- Do not constantly greet the same person again and again.
- Use memory naturally, without sounding creepy.
`
    );

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

    addUserNote(userId, `Bot recently replied about: ${userMessage.slice(0, 100)}`);

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
