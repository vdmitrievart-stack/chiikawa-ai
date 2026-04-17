// trading-admin.js

let tradingRuntime = {
  enabled: false,
  mode: "sim",
  killSwitch: false,
  buybotAlertMinUsd: 20,
  trackedWallets: []
};

export function getTradingRuntime() {
  return tradingRuntime;
}

export function formatTradingStatus() {
  return `Trading:

enabled: ${tradingRuntime.enabled}
mode: ${tradingRuntime.mode}
killSwitch: ${tradingRuntime.killSwitch}
buybotAlertMinUsd: ${tradingRuntime.buybotAlertMinUsd}
trackedWallets: ${tradingRuntime.trackedWallets.length}`;
}

export function handleTradingAdminCallback(action) {
  if (action === "trade:toggle_enabled") {
    tradingRuntime.enabled = !tradingRuntime.enabled;
    return { ok: true, message: "Trading toggled" };
  }

  if (action === "trade:toggle_kill") {
    tradingRuntime.killSwitch = !tradingRuntime.killSwitch;
    return { ok: true, message: "Kill switch toggled" };
  }

  if (action === "trade:cycle_mode") {
    const modes = ["sim", "paper", "live"];
    const i = modes.indexOf(tradingRuntime.mode);
    tradingRuntime.mode = modes[(i + 1) % modes.length];
    return { ok: true, message: "Mode changed" };
  }

  if (action === "trade:buymin_up") {
    tradingRuntime.buybotAlertMinUsd += 10;
    return { ok: true, message: "Buy min updated" };
  }

  return { ok: false, error: "Unknown action" };
}

// ==============================
// LEVEL 4 COMMAND HANDLER
// ==============================

export async function handleTradingCommand(text, userName, kernel) {
  try {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0];

    // ==========================
    // ADD LEADER
    // ==========================
    if (cmd === "/add_leader") {
      const [_, leaderId, walletId, address, label] = parts;

      if (!leaderId || !walletId || !address) {
        return { ok: false, error: "Usage: /add_leader <leaderId> <walletId> <address> [label]" };
      }

      await kernel.wallets.addWallet({
        walletId,
        address,
        role: "leader",
        label: label || leaderId,
        ownerUserId: userName,
        isActive: true
      });

      return {
        ok: true,
        message: `✅ Leader added

leaderId: ${leaderId}
walletId: ${walletId}
address: ${address}`
      };
    }

    // ==========================
    // ADD FOLLOWER
    // ==========================
    if (cmd === "/add_follower") {
      const [_, followerId, walletId, address, ownerUserId, label] = parts;

      if (!followerId || !walletId || !address || !ownerUserId) {
        return {
          ok: false,
          error: "Usage: /add_follower <followerId> <walletId> <address> <ownerUserId> [label]"
        };
      }

      await kernel.wallets.addWallet({
        walletId,
        address,
        role: "follower",
        label: label || followerId,
        ownerUserId,
        isActive: true
      });

      return {
        ok: true,
        message: `✅ Follower added

followerId: ${followerId}
walletId: ${walletId}
address: ${address}
owner: ${ownerUserId}`
      };
    }

    // ==========================
    // LINK COPY
    // ==========================
    if (cmd === "/link_copy") {
      const [
        _,
        leaderId,
        followerId,
        multiplier = "1",
        maxTradeUsd = "100",
        minLeaderScore = "0",
        mode = "mirror"
      ] = parts;

      if (!leaderId || !followerId) {
        return {
          ok: false,
          error: "Usage: /link_copy <leaderId> <followerId> [multiplier] [maxTradeUsd] [minLeaderScore] [mode]"
        };
      }

      await kernel.copytrading.link({
        leaderId,
        followerId,
        multiplier: Number(multiplier),
        maxTradeUsd: Number(maxTradeUsd),
        minLeaderScore: Number(minLeaderScore),
        mode
      });

      return {
        ok: true,
        message: `🔗 Copy link created

leader: ${leaderId}
follower: ${followerId}
multiplier: ${multiplier}
maxTradeUsd: ${maxTradeUsd}
minScore: ${minLeaderScore}
mode: ${mode}`
      };
    }

    // ==========================
    // TOP LEADERS
    // ==========================
    if (cmd === "/top_leaders") {
      const limit = Number(parts[1] || 10);

      const leaders = await kernel.scoring.getTopLeaders(limit);

      if (!leaders.length) {
        return { ok: true, message: "No leaders yet" };
      }

      const text = leaders
        .map((l, i) => {
          return `${i + 1}. ${l.leaderId}
score: ${l.score}
winRate: ${l.winRate}
pnl: ${l.pnl}`;
        })
        .join("\n\n");

      return { ok: true, message: `🏆 Top Leaders\n\n${text}` };
    }

    // ==========================
    // COPY PLAN (SIMULATED EXEC)
    // ==========================
    if (cmd === "/copy_plan") {
      const [_, leaderId, side, symbol, ca, sizeUsd] = parts;

      if (!leaderId || !side || !symbol || !ca || !sizeUsd) {
        return {
          ok: false,
          error: "Usage: /copy_plan <leaderId> <buy|sell> <symbol> <ca> <sizeUsd>"
        };
      }

      const plan = await kernel.copytrading.buildCopyPlan({
        leaderId,
        side,
        symbol,
        ca,
        sizeUsd: Number(sizeUsd)
      });

      return {
        ok: true,
        message: `📋 Copy Plan

leader: ${leaderId}
side: ${side}
symbol: ${symbol}
sizeUsd: ${sizeUsd}

followers:
${plan.fills.map(f => `- ${f.followerId}: $${f.sizeUsd}`).join("\n")}`
      };
    }

    // ==========================
    // FALLBACK
    // ==========================
    return { ok: false, error: "Unknown trading command" };

  } catch (error) {
    return {
      ok: false,
      error: `Trading error: ${error.message}`
    };
  }
}
