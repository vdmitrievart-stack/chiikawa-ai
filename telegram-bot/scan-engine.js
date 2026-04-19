// === ДОБАВЛЕНО: Narrative + Social ===
function analyzeNarrative(token) {
  const text = (token.description || "").toLowerCase();

  let score = 0;
  const flags = [];
  const positives = [];

  if (!text) {
    return {
      score: -10,
      verdict: "No narrative",
      flags: ["No description"],
      positives: []
    };
  }

  if (text.includes("100x") || text.includes("next gem")) {
    score -= 20;
    flags.push("Hype narrative");
  }

  if (text.includes("community")) {
    score -= 8;
    flags.push("Generic wording");
  }

  if (text.length < 50) {
    score -= 12;
    flags.push("Too short");
  }

  if (text.length > 120) {
    score += 10;
    positives.push("Detailed description");
  }

  if (text.includes("ai") || text.includes("bot") || text.includes("tool")) {
    score += 10;
    positives.push("Has concept");
  }

  return {
    score,
    verdict: score > 10 ? "Strong" : score > 0 ? "OK" : "Weak",
    flags,
    positives
  };
}

function analyzeSocials(token) {
  const links = token.links || {};
  let score = 0;
  const notes = [];

  if (links.twitter) {
    score += 10;
    notes.push("Twitter");
  }

  if (links.telegram) {
    score += 10;
    notes.push("Telegram");
  }

  if (links.website) {
    score += 10;
    notes.push("Website");
  }

  if (!links.twitter && !links.telegram) {
    score -= 15;
    notes.push("No socials");
  }

  return { score, notes };
}
