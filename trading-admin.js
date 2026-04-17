import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const RUNTIME_FILE = path.join(DATA_DIR, "trading-runtime.json");

function ensureDirSync(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    console.error("ensureDirSync error:", error.message);
  }
}

ensureDirSync(DATA_DIR);

const DEFAULT_RUNTIME = {
  enabled: false,
  mode: "paper",
  killSwitch: false,
  buybotAlertMinUsd: 20,
  trackedWallets: [],
  walletScores: {},
  events: [],
  updatedAt: new Date().toISOString()
};

function loadRuntime() {
  try {
    if (!fs.existsSync(RUNTIME_FILE)) {
      return { ...DEFAULT_RUNTIME };
    }

    const raw = fs.readFileSync(RUNTIME_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...DEFAULT_RUNTIME,
      ...(parsed || {}),
      trackedWallets: Array.isArray(parsed?.trackedWallets) ? parsed.trackedWallets : [],
      walletScores:
        parsed?.walletScores && typeof parsed.walletScores === "object"
          ? parsed.walletScores
          : {},
      events: Array.isArray(parsed?.events) ? parsed.events : []
    };
  } catch (error) {
    console.error("loadRuntime error:", error.message);
    return { ...DEFAULT_RUNTIME };
  }
}

let tradingRuntime = loadRuntime();

function persistRuntime() {
  try {
    tradingRuntime.updatedAt = new Date().toISOString();
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify(tradingRuntime, null, 2), "utf8");
  } catch (error) {
    console.error("persistRuntime error:", error.message);
  }
}

function pushEvent(type, payload = {}) {
  tradingRuntime.events.unshift({
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    payload,
    at: new Date().toISOString()
  });

  tradingRuntime.events = tradingRuntime.events.slice(0, 200);
  persistRuntime();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function cleanLower(value) {
  return normalizeText(value).toLowerCase();
}

function isProbablySolanaAddress(value) {
  const text = normalizeText(value);
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
}

function parseNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function cycleMode(current) {
  const modes = ["paper", "semi", "live"];
  const idx = modes.indexOf(current);
  return idx === -1 ? modes[0] : modes[(idx + 1) % modes.length];
}

function patchRuntime(patch = {}, eventType = "runtime_updated") {
  tradingRuntime = {
    ...tradingRuntime,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  pushEvent(eventType, patch);
  persistRuntime();

  return {
    ok: true,
    message: formatTradingStatus()
  };
}

function addTrackedWallet(address, label = "tracked") {
  const normalized = normalizeText(address);
  if (!normalized) {
    return { ok: false, error: "Wallet address is required." };
  }

  if (!isProbablySolanaAddress(normalized)) {
    return { ok: false, error: "Invalid Solana wallet address." };
  }

  const exists = tradingRuntime.trackedWallets.find(
    x => cleanLower(x.address) === cleanLower(normalized)
  );

  if (exists) {
    return { ok: false, error: "Wallet already tracked." };
  }

  tradingRuntime.trackedWallets.push({
    address: normalized,
    label: normalizeText(label) || "tracked",
    addedAt: new Date().toISOString()
  });

  pushEvent("wallet_tracked", { address: normalized, label });
  persistRuntime();

  return {
    ok: true,
    message: `✅ Wallet added

label: ${label}
address: ${normalized}`
  };
}

function removeTrackedWallet(address) {
  const normalized = normalizeText(address);
  const before = tradingRuntime.trackedWallets.length;

  tradingRuntime.trackedWallets = tradingRuntime.trackedWallets.filter(
    x => cleanLower(x.address) !== cleanLower(normalized)
  );

  if (tradingRuntime.trackedWallets.length === before) {
    return { ok: false, error: "Wallet not found." };
  }

  pushEvent("wallet_untracked", { address: normalized });
  persistRuntime();

  return {
    ok: true,
    message: `🗑 Wallet removed

address: ${normalized}`
  };
}

function listTrackedWallets() {
  if (!tradingRuntime.trackedWallets.length) {
    return {
      ok: true,
      message: "👛 No tracked wallets yet."
    };
  }

  const text = tradingRuntime.trackedWallets
    .map((w, i) => {
      const score = tradingRuntime.walletScores[w.address] ?? "n/a";
      return `${i + 1}. ${w.label || "wallet"}
address: ${w.address}
score: ${score}
addedAt: ${w.addedAt}`;
    })
    .join("\n\n");

  return {
    ok: true,
    message: `👛 Tracked wallets

${text}`
  };
}

function setWalletScore(address, score) {
  const normalized = normalizeText(address);
  if (!normalized) {
    return { ok: false, error: "Wallet address is required." };
  }

  const value = parseNumber(score, NaN);
  if (!Number.isFinite(value)) {
    return { ok: false, error: "Score must be a number." };
  }

  tradingRuntime.walletScores[normalized] = value;
  pushEvent("wallet_score_updated", { address: normalized, score: value });
  persistRuntime();

  return {
    ok: true,
    message: `🏅 Wallet score updated

address: ${normalized}
score: ${value}`
  };
}

function parseCommand(text) {
  const raw = normalizeText(text);
  const parts = raw.split(/\s+/);
  const command = cleanLower(parts[0] || "");
  const args = parts.slice(1);
  return { command, args };
}

export function getTradingRuntime() {
  return {
    ...tradingRuntime,
    trackedWallets: [...tradingRuntime.trackedWallets],
    walletScores: { ...tradingRuntime.walletScores },
    events: [...tradingRuntime.events]
  };
}

export function formatTradingStatus() {
  const runtime = getTradingRuntime();

  const walletsText = runtime.trackedWallets.length
    ? runtime.trackedWallets
        .map((w, i) => {
          const score = runtime.walletScores[w.address] ?? "n/a";
          return `${i + 1}. ${w.label || "wallet"} | ${w.address} | score: ${score}`;
        })
        .join("\n")
    : "none";

  return `📊 Trading Status

enabled: ${runtime.enabled}
mode: ${runtime.mode}
killSwitch: ${runtime.killSwitch}
buybotAlertMinUsd: ${runtime.buybotAlertMinUsd}
trackedWallets: ${runtime.trackedWallets.length}

Tracked wallets:
${walletsText}`;
}

export function handleTradingAdminCallback(data) {
  try {
    switch (data) {
      case "trade:toggle_enabled":
        return patchRuntime(
          { enabled: !tradingRuntime.enabled },
          "trade_enabled_toggled"
        );

      case "trade:toggle_kill":
        return patchRuntime(
          { killSwitch: !tradingRuntime.killSwitch },
          "trade_killswitch_toggled"
        );

      case "trade:cycle_mode":
        return patchRuntime(
          { mode: cycleMode(tradingRuntime.mode) },
          "trade_mode_cycled"
        );

      case "trade:buymin_up":
        return patchRuntime(
          { buybotAlertMinUsd: Number(tradingRuntime.buybotAlertMinUsd || 0) + 5 },
          "trade_buymin_changed"
        );

      case "trade:show_status":
        return {
          ok: true,
          message: formatTradingStatus()
        };

      case "trade:show_wallets":
        return listTrackedWallets();

      default:
        return {
          ok: false,
          error: `Unknown trading callback: ${data}`
        };
    }
  } catch (error) {
    return {
      ok: false,
      error: `Trading callback failed: ${error.message}`
    };
  }
}

async function handleLevel4Command(command, args, userName, level4Kernel) {
  if (!level4Kernel) {
    if (
      command === "/add_leader" ||
      command === "/add_follower" ||
      command === "/link_copy" ||
      command === "/top_leaders" ||
      command === "/copy_plan"
    ) {
      return {
        ok: false,
        error: "Level4 kernel is required for this command."
      };
    }
    return null;
  }

  if (command === "/add_leader") {
    if (args.length < 3) {
      return {
        ok: false,
        error: "Usage: /add_leader <leaderId> <walletId> <address> [label]"
      };
    }

    const [leaderId, walletId, address, ...labelParts] = args;
    const label = labelParts.join(" ") || leaderId;

    if (!isProbablySolanaAddress(address)) {
      return { ok: false, error: "Invalid Solana wallet address." };
    }

    const result = await level4Kernel.registerLeaderWithWallet({
      leaderId,
      walletId,
      address,
      label,
      ownerUserId: userName || null,
      chain: "solana"
    });

    return {
      ok: true,
      message: `✅ Leader registered

leaderId: ${result.leader.leaderId}
walletId: ${result.wallet.walletId}
address: ${result.wallet.address}
label: ${result.wallet.label || "n/a"}`
    };
  }

  if (command === "/add_follower") {
    if (args.length < 4) {
      return {
        ok: false,
        error: "Usage: /add_follower <followerId> <walletId> <address> <ownerUserId> [label]"
      };
    }

    const [followerId, walletId, address, ownerUserId, ...labelParts] = args;
    const label = labelParts.join(" ") || followerId;

    if (!isProbablySolanaAddress(address)) {
      return { ok: false, error: "Invalid Solana wallet address." };
    }

    const result = await level4Kernel.registerFollowerWithWallet({
      followerId,
      walletId,
      address,
      label,
      ownerUserId,
      chain: "solana",
      maxAllocationUsd: 0,
      maxOpenPositions: 3,
      slippageBps: 150
    });

    return {
      ok: true,
      message: `✅ Follower registered

followerId: ${result.follower.followerId}
walletId: ${result.wallet.walletId}
address: ${result.wallet.address}
ownerUserId: ${result.follower.ownerUserId || "n/a"}
label: ${result.wallet.label || "n/a"}`
    };
  }

  if (command === "/link_copy") {
    if (args.length < 2) {
      return {
        ok: false,
        error: "Usage: /link_copy <leaderId> <followerId> [multiplier] [maxTradeUsd] [minLeaderScore] [mode]"
      };
    }

    const [leaderId, followerId, multiplierArg, maxTradeUsdArg, minLeaderScoreArg, modeArg] = args;

    const result = await level4Kernel.linkCopyRelationship({
      leaderId,
      followerId,
      multiplier: parseNumber(multiplierArg, 1),
      maxTradeUsd: parseNumber(maxTradeUsdArg, 0),
      minLeaderScore: parseNumber(minLeaderScoreArg, 0),
      mode: modeArg || "mirror"
    });

    return {
      ok: true,
      message: `🔗 Copy link created

linkId: ${result.linkId}
leaderId: ${result.leaderId}
followerId: ${result.followerId}
multiplier: ${result.multiplier}
maxTradeUsd: ${result.maxTradeUsd}
minLeaderScore: ${result.minLeaderScore}
mode: ${result.mode}
active: ${result.isActive}`
    };
  }

  if (command === "/top_leaders") {
    const limit = Math.max(1, Math.min(20, parseNumber(args[0], 10)));
    const leaders = await level4Kernel.getTopLeaders(limit);

    if (!leaders.length) {
      return {
        ok: true,
        message: "🏆 No leaders scored yet."
      };
    }

    const text = leaders
      .map((x, i) => {
        return `${i + 1}. ${x.leaderId}
score: ${x.score}
pnlUsd: ${x.pnlUsd}
roiPct: ${x.roiPct}
winRate: ${x.winRate}
tradeCount: ${x.tradeCount}`;
      })
      .join("\n\n");

    return {
      ok: true,
      message: `🏆 Top leaders

${text}`
    };
  }

  if (command === "/copy_plan") {
    if (args.length < 5) {
      return {
        ok: false,
        error: "Usage: /copy_plan <leaderId> <buy|sell> <symbol> <ca> <sizeUsd>"
      };
    }

    const [leaderId, action, symbol, ca, sizeUsdArg] = args;

    const plan = await level4Kernel.buildCopyPlan({
      leaderId,
      trade: {
        action,
        symbol,
        ca,
        chain: "solana",
        sizeUsd: parseNumber(sizeUsdArg, 0)
      }
    });

    if (!plan.ok) {
      return {
        ok: false,
        error: `Copy plan failed: ${plan.reason || "unknown_error"}`
      };
    }

    if (!plan.plans.length) {
      return {
        ok: true,
        message: `📭 No follower plans generated

leaderId: ${leaderId}
action: ${action}
symbol: ${symbol}
sizeUsd: ${sizeUsdArg}`
      };
    }

    const text = plan.plans
      .map((p, i) => {
        return `${i + 1}. followerId: ${p.followerId}
followerWalletId: ${p.followerWalletId}
action: ${p.action}
symbol: ${p.symbol}
ca: ${p.ca}
sizeUsd: ${p.sizeUsd}
mode: ${p.mode}
slippageBps: ${p.slippageBps}`;
      })
      .join("\n\n");

    return {
      ok: true,
      message: `📋 Copy plan

leaderId: ${leaderId}

${text}`
    };
  }

  return null;
}

export async function handleTradingCommand(text, userName = "admin", level4Kernel = null) {
  try {
    const { command, args } = parseCommand(text);

    const maybeLevel4 = await handleLevel4Command(command, args, userName, level4Kernel);
    if (maybeLevel4) return maybeLevel4;

    if (command === "/trade_status") {
      return {
        ok: true,
        message: formatTradingStatus()
      };
    }

    if (command === "/trade_mode") {
      if (!args.length) {
        return {
          ok: true,
          message: `Current trade mode: ${tradingRuntime.mode}`
        };
      }

      const nextMode = cleanLower(args[0]);
      const allowed = ["paper", "semi", "live"];

      if (!allowed.includes(nextMode)) {
        return {
          ok: false,
          error: `Invalid mode. Allowed: ${allowed.join(", ")}`
        };
      }

      return patchRuntime({ mode: nextMode }, "trade_mode_set");
    }

    if (command === "/kill_switch") {
      if (!args.length) {
        return {
          ok: true,
          message: `Kill switch: ${tradingRuntime.killSwitch}`
        };
      }

      const next = cleanLower(args[0]);
      if (next === "on") {
        return patchRuntime({ killSwitch: true }, "trade_killswitch_set");
      }
      if (next === "off") {
        return patchRuntime({ killSwitch: false }, "trade_killswitch_set");
      }

      return {
        ok: false,
        error: "Usage: /kill_switch <on|off>"
      };
    }

    if (command === "/trading_on") {
      return patchRuntime({ enabled: true }, "trade_enabled_set");
    }

    if (command === "/trading_off") {
      return patchRuntime({ enabled: false }, "trade_enabled_set");
    }

    if (command === "/setbuy") {
      if (!args.length) {
        return {
          ok: false,
          error: "Usage: /setbuy <minUsd>"
        };
      }

      const minUsd = parseNumber(args[0], NaN);
      if (!Number.isFinite(minUsd) || minUsd < 0) {
        return {
          ok: false,
          error: "Buy minimum must be a non-negative number."
        };
      }

      return patchRuntime({ buybotAlertMinUsd: minUsd }, "trade_buymin_set");
    }

    if (command === "/watch_wallet") {
      if (!args.length) {
        return {
          ok: false,
          error: "Usage: /watch_wallet <walletAddress> [label]"
        };
      }

      const [address, ...labelParts] = args;
      const label = labelParts.join(" ") || "tracked";
      return addTrackedWallet(address, label);
    }

    if (command === "/unwatch_wallet") {
      if (!args.length) {
        return {
          ok: false,
          error: "Usage: /unwatch_wallet <walletAddress>"
        };
      }

      return removeTrackedWallet(args[0]);
    }

    if (command === "/wallets") {
      return listTrackedWallets();
    }

    if (command === "/wallet_score") {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: /wallet_score <walletAddress> <score>"
        };
      }

      return setWalletScore(args[0], args[1]);
    }

    return {
      ok: false,
      error: `Unknown trading command: ${command}`
    };
  } catch (error) {
    return {
      ok: false,
      error: `Trading command failed: ${error.message}`
    };
  }
}

export default {
  getTradingRuntime,
  handleTradingAdminCallback,
  handleTradingCommand,
  formatTradingStatus
};
