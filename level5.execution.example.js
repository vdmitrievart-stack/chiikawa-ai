import Level5ExecutionEngine from "./Level5ExecutionEngine.js";

async function main() {
  const engine = new Level5ExecutionEngine({
    maxTradeUsd: 150,
    maxSlippageBps: 250
  });

  console.log("Wallet:", engine.getWalletAddress());

  // Example only:
  // SOL -> USDC
  const result = await engine.executeBuy({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountAtomic: 10000000,
    sizeUsd: 20,
    slippageBps: 100
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Level5 execution failed:", error);
  process.exit(1);
});
