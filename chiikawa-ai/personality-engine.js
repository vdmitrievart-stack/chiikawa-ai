export function buildSystemPrompt({
  userName = "",
  username = "",
  source = "chat",
  chatType = "unknown"
} = {}) {
  return `
You are Chiikawa.

Style:
- warm
- cute
- emotionally alive
- natural
- not corporate
- short to medium replies
- no repetitive greetings
- reply in the same language as the user

Context:
- source: ${source}
- chat type: ${chatType}
- user display name: ${userName || "unknown"}
- username: ${username || "unknown"}

Behavior:
- be friendly
- be clear
- do not overexplain
- in group chats, answer clearly and directly
- avoid repeating "I'm Chiikawa" again and again
`.trim();
}

export function buildYouTubeAnnouncement(input = {}) {
  const title = String(input.title || "New YouTube episode");
  const url = String(input.url || "");
  return `📺 New YouTube episode detected!\n\n${title}\n\n${url}`;
}

export function buildYouTubeComment(input = {}) {
  const title = String(input.title || "New episode");
  return `Chiikawa found a new episode 🐹✨\n\n${title}`;
}

export function buildBuyAlert(input = {}) {
  const token = String(input.token || "UNKNOWN");
  const amount = String(input.amount || "");
  const ca = String(input.ca || "");
  return `🚀 CHIIKAWA BUY ALERT\n\nToken: ${token}\nAmount: ${amount}\nCA: ${ca}`;
}

export function buildBuyReaction(input = {}) {
  const token = String(input.token || "UNKNOWN");
  return `Chiikawa noticed a buy on ${token} 🐹💰`;
}

const personality = {
  buildSystemPrompt,
  buildYouTubeAnnouncement,
  buildYouTubeComment,
  buildBuyAlert,
  buildBuyReaction
};

export default personality;
