export function analyzeWallets(token) {
  // mock smart money logic (позже подключим GMGN API)

  const concentration = Math.random() * 100;
  const smartMoney = Math.random() * 100;

  let score = 0;

  if (smartMoney > 60) score += 20;
  if (concentration < 40) score += 20;

  return {
    smartMoney,
    concentration,
    score
  };
}
