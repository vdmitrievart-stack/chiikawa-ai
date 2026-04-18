export function pickMood() {
  const moods = [
    "excited",
    "cute",
    "happy",
    "hyped",
    "soft"
  ];

  return moods[Math.floor(Math.random() * moods.length)];
}

export function moodEmoji(mood) {
  switch (mood) {
    case "excited":
      return "🚀";
    case "cute":
      return "🐹";
    case "happy":
      return "✨";
    case "hyped":
      return "🔥";
    case "soft":
      return "💖";
    default:
      return "📺";
  }
}

export function buildMoodLine(mood) {
  switch (mood) {
    case "excited":
      return "Chiikawa is super excited about this new episode!";
    case "cute":
      return "Chiikawa found something adorable again 🐹";
    case "happy":
      return "A fresh episode appeared and Chiikawa looks happy ✨";
    case "hyped":
      return "This drop feels important. Hype detected 🔥";
    case "soft":
      return "A sweet new episode has arrived 💖";
    default:
      return "A new episode has been detected.";
  }
}

const moodEngine = {
  pickMood,
  moodEmoji,
  buildMoodLine
};

export default moodEngine;
