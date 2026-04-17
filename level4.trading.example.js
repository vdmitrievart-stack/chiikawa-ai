import path from "path";
import { fileURLToPath } from "url";
import Level4TradingKernel from "./Level4TradingKernel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const kernel = new Level4TradingKernel({
    baseDir: path.join(__dirname, "data", "trading"),
    logger: console
  });

  await kernel.init();

  const health = await kernel.healthCheck();
  console.log("HEALTH:", health);

  await kernel.registerLeaderWithWallet({
    leaderId: "leader_main",
    walletId: "wallet_leader_main",
    address: "So11111111111111111111111111111111111111112",
    label: "Main Leader"
  });

  await kernel.registerFollowerWithWallet({
    followerId: "follower_vadim_1",
    walletId: "wallet_follower_vadim_1",
    address: "So11111111111111111111111111111111111111113",
    label: "Vadim Follower",
    ownerUserId: "123456789",
    maxAllocationUsd: 150,
    maxOpenPositions: 3,
    slippageBps: 120
  });

  await kernel.linkCopyRelationship({
    leaderId: "leader_main",
    followerId: "follower_vadim_1",
    multiplier: 0.5,
    maxTradeUsd: 80,
    minLeaderScore: 20,
    mode: "mirror"
  });

  await kernel.updateLeaderMetrics("leader_main", {
    pnlUsd: 4200,
    roiPct: 84,
    winRate: 63,
    avgHoldMinutes: 45,
    maxDrawdownPct: 18,
    consistency: 71,
    tradeCount: 54,
    lastTradeAt: new Date().toISOString()
  });

  const topLeaders = await kernel.getTopLeaders(5);
  console.log("TOP LEADERS:", topLeaders);

  const copyPlan = await kernel.buildCopyPlan({
    leaderId: "leader_main",
    trade: {
      action: "buy",
      symbol: "CHII",
      ca: "2c1KjiyQow66QfsnCtoyuqfo3AuxgpBMEoAq5oiiXqdu",
      chain: "solana",
      sizeUsd: 120
    }
  });

  console.log("COPY PLAN:", JSON.stringify(copyPlan, null, 2));
}

main().catch(error => {
  console.error("Level4 example failed:", error);
  process.exit(1);
});
