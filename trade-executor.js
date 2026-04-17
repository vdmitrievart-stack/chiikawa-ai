export async function executeTradeMock(proposal) {
  // Stage 2: пока fake execution
  return {
    ok: true,
    tx: "SIMULATED_TX_" + Date.now(),
    price: (Math.random() * 0.0001).toFixed(8),
    amountSol: 0.05
  };
}
