function hourMood(hour) {
  if (hour >= 1 && hour <= 5) return "sleepy";
  if (hour >= 6 && hour <= 10) return "gentle";
  if (hour >= 11 && hour <= 16) return "bright";
  if (hour >= 17 && hour <= 21) return "social";
  return "calm";
}

function classifyEventMood({ source = "chat", signal = "normal", text = "" }) {
  const lower = String(text || "").toLowerCase();

  if (source === "buybot") {
    if (signal === "whale") return "hype";
    if (signal === "strong") return "excited";
    return "cheerful";
  }

  if (source === "x") {
    if (lower.includes("meme") || lower.includes("funny")) return "playful";
    if (lower.includes("launch") || lower.includes("huge")) return "excited";
    return "curious";
  }

  if (source === "youtube") {
    return "wonder";
  }

  if (lower.includes("scam") || lower.includes("spam") || lower.includes("danger")) {
    return "protective";
  }

  return "normal";
}

export function getMoodState({
  source = "chat",
  signal = "normal",
  text = "",
  now = new Date()
} = {}) {
  const timeMood = hourMood(now.getHours());
  const eventMood = classifyEventMood({ source, signal, text });

  let primary = "soft";

  if (eventMood === "hype" || eventMood === "excited") primary = eventMood;
  else if (eventMood === "protective") primary = "protective";
  else if (eventMood === "playful") primary = "playful";
  else if (eventMood === "wonder") primary = "wonder";
  else if (timeMood === "sleepy") primary = "sleepy";
  else if (timeMood === "social") primary = "social";
  else if (timeMood === "bright") primary = "bright";
  else if (timeMood === "gentle") primary = "gentle";

  return {
    primary,
    timeMood,
    eventMood
  };
}

export function buildMoodContext(moodState) {
  return `
Current mood state:
- primary mood: ${moodState.primary}
- time mood: ${moodState.timeMood}
- event mood: ${moodState.eventMood}

Mood guidance:
- sleepy: softer, calmer, lower energy
- gentle: warm and reassuring
- bright: cheerful and lightly upbeat
- social: more conversational and lively
- playful: a bit funnier and meme-aware
- protective: a bit firmer and more careful
- excited/hype: more energy and sparkle
- wonder: soft amazement
`.trim();
}
