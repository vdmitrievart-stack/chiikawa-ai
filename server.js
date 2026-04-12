const data = await response.json();

let reply = data?.choices?.[0]?.message?.content || "";

if (!reply || reply.trim() === "" || /^[-_\s.]+$/.test(reply)) {
  reply = "Hey... I'm here 🥺 Tell me again and I'll answer properly ✨";
}

res.json({ reply });
