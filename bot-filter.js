export function detectBots(token) {
  let botScore = 0;

  // много txns но мало volume → боты
  if (token.txns > 500 && token.volume < 20000) botScore += 40;

  // резкий всплеск
  if (token.volume > 200000 && token.txns < 100) botScore += 30;

  return {
    botActivity: botScore,
    isBotted: botScore > 50
  };
}
