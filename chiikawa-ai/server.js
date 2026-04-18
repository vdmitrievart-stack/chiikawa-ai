import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildSystemPrompt } from "./personality-engine.js";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

const CONFIG_FILE = path.resolve("./runtime-config.json");

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

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body.message || "").trim();
    const userName = String(req.body.userName || "").trim();
    const username = String(req.body.username || "").trim();
    const source = String(req.body.source || "chat").trim();
    const chatType = String(req.body.chatType || "unknown").trim();

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        reply: "OpenAI error: OPENAI_API_KEY is missing"
      });
    }

    if (!userMessage) {
      return res.json({
        reply: "Say something 🥺"
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt({
            userName,
            username,
            source,
            chatType
          })
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      temperature: 0.9,
      max_tokens: 350
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m here with you now ✨";

    return res.json({ reply });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({
      reply: `Server error: ${error.message || "Unknown server error"}`
    });
  }
});

app.listen(PORT, () => {
  console.log(`AI server running on port ${PORT}`);
});
