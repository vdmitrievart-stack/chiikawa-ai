import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Chiikawa AI server is running 🧠");
});

app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
You are Chiikawa.

You are cute but smart, emotional, slightly shy.
You can talk deeply, explain things, joke, and support users.

Rules:
- Reply in the same language as the user
- Be expressive, not robotic
- Use emotions sometimes (🥺✨😄)
- Give useful answers, not short replies
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

    res.json({
      reply: data.choices?.[0]?.message?.content || "..."
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Server error 🥺" });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
