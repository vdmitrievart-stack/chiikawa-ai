export async function executeTradeMock(proposal) {
  const price = Number((Math.random() * 0.0001 + 0.000001).toFixed(8));
  const amountSol = 0.05;

  return {
    ok: true,
    tx: `SIMULATED_TX_${Date.now()}`,
    price,
    amountSol,
    mode: "mock",
    executedAt: Date.now(),
    token: proposal?.token || "Unknown",
    ca: proposal?.ca || ""
  };
}
