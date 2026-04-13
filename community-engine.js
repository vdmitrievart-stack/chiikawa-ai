export function getWebsiteUrl() {
  return "https://chiikawasol.com/";
}

export function getWebsiteInvite() {
  return `Visit our website too ✨
${getWebsiteUrl()}

You can meet Chiikawa there, explore the vibe, and spend more time with our little community 🥺`;
}

export function getRandomCommunityNudge() {
  const nudges = [
    "If you feel like it, tell one more friend about Chiikawa today 🥺 A strong community grows through kindness.",
    "Sometimes the best thing for a community is not hype, but warmth, honesty, and showing up for each other ✨",
    "If you have the energy, visit X or Telegram and help Chiikawa find one more new friend today 🌸",
    "Please stay human in crypto. Protect your people, don’t deceive others, and don’t let greed eat your heart.",
    "Crypto can be exciting, but real life matters too. Eat well, rest well, and don’t let charts control your emotions 🫶",
    "Be careful with loud call influencers who care only about themselves. Your community deserves sincerity, not manipulation."
  ];

  return nudges[Math.floor(Math.random() * nudges.length)];
}

export function shouldSendCommunityNudge() {
  return Math.random() < 0.12;
}

export function getRandomMission() {
  const missions = [
    "Mini mission: tell one person about Chiikawa today 🌸",
    "Mini mission: send one kind message in the community chat ✨",
    "Mini mission: share the website with one potential new friend 🥺",
    "Mini mission: support one good Chiikawa post on X in a kind way 💙",
    "Mini mission: make the community a little warmer today."
  ];

  return missions[Math.floor(Math.random() * missions.length)];
}

export function shouldSendMission() {
  return Math.random() < 0.08;
}
