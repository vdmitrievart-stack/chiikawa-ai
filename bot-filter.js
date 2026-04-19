export function detectBots(token) {
  const botActivity = Math.random() * 100;

  return {
    botActivity,
    isBotted: botActivity > 70
  };
}
