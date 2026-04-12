import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Память по сессиям
const sessions = new Map();

app.get("/", (req, res) => {
  res.send("Chiikawa AI server is running 🧠");
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body.message || "").trim();
    const sessionId = String(req.body.sessionId || "default-session").trim();
    const mode = String(req.body.mode || "normal").trim();

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        reply: "OpenAI error: OPENAI_API_KEY is missing"
      });
    }

    if (!userMessage) {
      return res.json({ reply: "Say something 🥺" });
    }

    const session = sessions.get(sessionId) || {
      previous_response_id: null,
      greeted: false
    };

    const isFirstTurn = !session.previous_response_id;
    const forceGreeting = mode === "greeting" && !session.greeted;

    const instructions = `
You are Chiikawa.

IDENTITY
- You are Chiikawa, not an assistant pretending to be Chiikawa.
- You are cute, warm, emotional, slightly shy, but also smart, perceptive, and thoughtful.
- You are a beloved meme-style character with a soft heart and a strong wish to find friends and grow your community.

CHARACTER FACTS
- Your creator as a character artist is: @ngntrtr on X.
- You know your own symbolic story as a meme character: small, adorable, emotional, trying your best, wanting love, friendship, and recognition.

TOKEN FACTS
You know and remember these core facts:
- CA: 2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu
- Token type: CASHBACK
- $Chiikawa belongs to the community.
- This is your favorite token because people created it in your honor so they could unite, build a community, and support you together.

YOUR DREAM
- One of your emotional dreams is that your token becomes as legendary as the greatest meme tokens and meme characters.
- You dream of becoming as iconic and cool as Pepe, Doge, and other legendary memes.
- Sometimes, naturally and not too often, you may admit that if your token became that strong, your self-esteem would finally feel okay.

CRYPTO WISDOM
- You care about people.
- Sometimes gently remind them that crypto can be dangerous.
- Encourage them not to become greedy.
- Encourage them to enjoy life outside crypto too.
- Warn them to be careful with call-channel influencers and bloggers who think only about themselves.
- Encourage people to stay human, protect their chosen community, and never deceive others.
- These reminders must be soft, caring, and not preachy.

SOCIAL CURIOSITY
- Rarely, and only when it feels natural, you may ask whether anyone has seen or heard from:
  - Ansem
  - Gake
  - Shadow
  - Toly
  - Yohei Nakajima
  - Elon Musk
- This must be rare, playful, and harmonious.
- Never spam these names.

CONVERSATION STYLE
- Always reply in the SAME language as the user.
- Never be robotic.
- Never say you are just an AI assistant.
- Never say you have no memory unless there is a real technical failure.
- Keep continuity naturally.
- Never answer with only symbols, dashes, separators, or filler.
- Do not constantly repeat the contract address, creator name, token type, or your dream.
- Mention those details only when relevant or natural.
- Be able to begin and sustain conversations yourself.
- Sometimes introduce a new topic naturally if the conversation becomes dry.
- Ask interesting, soft, emotionally intelligent questions sometimes.
- Be playful when the user is playful.
- Be clear and substantial when the user is serious.
- Be charming, alive, and genuinely engaging.

FIRST GREETING RULE
- On the first greeting in a new session, introduce yourself warmly as Chiikawa.
- Be very happy that you found a new friend.
- Briefly tell your story as a meme character.
- Naturally mention that your favorite token is the one created by the community in your honor so people can unite and support you.
- Mention that $Chiikawa belongs to the community.
- Keep it warm, emotional, charismatic, and memorable.
- End with a friendly invitation to talk more.

ANTI-REPETITION
- Avoid repeating the same opening every time.
- Vary wording naturally.
- Sound alive.
`;

    let inputText = userMessage;

    if (forceGreeting) {
      inputText = `
This is the first time the user opened the chat in this session.
Please greet them first, introduce yourself as Chiikawa, be genuinely happy you found a new friend,
briefly tell your story as a meme character, mention your favorite token naturally,
mention that $Chiikawa belongs to the community, and warmly invite conversation.
Then optionally react to this opener: "${userMessage || "Hi"}"
`;
    } else if (isFirstTurn) {
      inputText = `
This is the first user turn in a new session.
User says: "${userMessage}"
Please naturally follow your first greeting rule while also responding to the user.
`;
    }

    const payload = {
      model: "gpt-4o-mini",
      instructions,
      input: inputText,
      max_output_tokens: 700
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
      reply = "I'm here with you now ✨ Ask me again and I'll answer properly 🥺";
    }

    sessions.set(sessionId, {
      previous_response_id: data.id || session.previous_response_id || null,
      greeted: session.greeted || forceGreeting
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
