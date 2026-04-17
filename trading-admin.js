import fs from "fs";
import path from "path";
import {
  TRADING_DEFAULTS,
  normalizeTradingMode,
  clampNumber
} from "./trading-config.js";
import {
  addTrackedWallet,
  removeTrackedWallet,
  listTrackedWallets,
  getTrackedWallet
} from "./tracked-wallet-store.js";
import {
  refreshTrackedWalletScore,
  formatWalletScoreReport
} from "./wallet-score-engine.js";

const STATE_FILE = path.resolve("./trading-runtime.json");

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { ...TRADING_DEFAULTS };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...TRADING_DEFAULTS,
      ...parsed
    };
  } catch (error) {
    console.error("trading-admin load error:", error.message);
    return { ...TRADING_DEFAULTS };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("trading-admin save error:", error.message);
  }
}

const state = loadState();

export function getTradingRuntime() {
  return { ...state };
}

export function setTradingRuntime(patch = {}) {
  Object.assign(state, patch);
  saveState(state);
  return getTradingRuntime();
}

export function formatTradingStatus() {
  const s = getTradingRuntime();

  return `💼 Trading Status

enabled: ${s.enabled}
mode: ${s.mode}
killSwitch: ${s.killSwitch}

maxPositionSol: ${s.maxPositionSol}
dailyMaxLossSol: ${s.dailyMaxLossSol}
maxOpenPositions: ${s.maxOpenPositions}

buybotAlertMinUsd: ${s.buybotAlertMinUsd}
minWalletScore: ${s.minWalletScore}
minTokenScore: ${s.minTokenScore}

copyWalletsEnabled: ${s.copyWalletsEnabled}
publicAnnounceBuys: ${s.publicAnnounceBuys}
publicPinBuyPosts: ${s.publicPinBuyPosts}`;
}

export function buildTradingAdminKeyboard(current = getTradingRuntime()) {
  return {
    inline_keyboard: [
      [
        {
          text: current.enabled ? "Trading: ON" : "Trading: OFF",
          callback_data: "trade:toggle_enabled"
        },
        {
          text: current.killSwitch ? "Kill switch: ON" : "Kill switch: OFF",
          callback_data: "trade:toggle_kill"
        }
      ],
      [
        {
          text: `Mode: ${current.mode}`,
          callback_data: "trade:cycle_mode"
        },
        {
          text: current.copyWalletsEnabled ? "Copy wallets: ON" : "Copy wallets: OFF",
          callback_data: "trade:toggle_copy"
        }
      ],
      [
        {
          text: `Buy min $${current.buybotAlertMinUsd}`,
          callback_data: "trade:buymin_up"
        }
      ],
      [
        {
          text: "Wallets",
          callback_data: "trade:show_wallets"
        },
        {
          text: "Status",
          callback_data: "trade:show_status"
        }
      ]
    ]
  };
}

export function handleTradingAdminCallback(data) {
  const s = getTradingRuntime();

  if (data === "trade:toggle_enabled") {
    return {
      ok: true,
      state: setTradingRuntime({ enabled: !s.enabled }),
      message: `Trading enabled: ${!s.enabled}`
    };
  }

  if (data === "trade:toggle_kill") {
    return {
      ok: true,
      state: setTradingRuntime({ killSwitch: !s.killSwitch }),
      message: `Kill switch: ${!s.killSwitch}`
    };
  }

  if (data === "trade:toggle_copy") {
    return {
      ok: true,
      state: setTradingRuntime({ copyWalletsEnabled: !s.copyWalletsEnabled }),
      message: `Copy wallets enabled: ${!s.copyWalletsEnabled}`
    };
  }

  if (data === "trade:cycle_mode") {
    const next =
      s.mode === "off" ? "confirm" :
      s.mode === "confirm" ? "auto" :
      "off";

    return {
      ok: true,
      state: setTradingRuntime({ mode: normalizeTradingMode(next) }),
      message: `Trading mode: ${next}`
    };
  }

  if (data === "trade:buymin_up") {
    const next = clampNumber(Number(s.buybotAlertMinUsd || 40) + 10, 0, 100000, 40);
    return {
      ok: true,
      state: setTradingRuntime({ buybotAlertMinUsd: next }),
      message: `Buy alert min: $${next}`
    };
  }

  if (data === "trade:show_status") {
    return {
      ok: true,
      state: s,
      message: formatTradingStatus()
    };
  }

  if (data === "trade:show_wallets") {
    const wallets = listTrackedWallets();

    if (!wallets.length) {
      return {
        ok: true,
        state: s,
        message: "No tracked wallets yet."
      };
    }

    const text = wallets
      .slice(0, 20)
      .map((w, i) => `${i + 1}. ${w.address}${w.score != null ? ` • score ${w.score}` : ""}`)
      .join("\n");

    return {
      ok: true,
      state: s,
      message: `Tracked wallets\n\n${text}`
    };
  }

  return {
    ok: false,
    error: "Unknown trading admin action"
  };
}

export function handleTradingCommand(text, adminName = "admin") {
  const raw = String(text || "").trim();
  const [cmd, ...args] = raw.split(/\s+/);

  if (cmd === "/trade_status") {
    return { ok: true, message: formatTradingStatus() };
  }

  if (cmd === "/trade_mode") {
    const current = getTradingRuntime();
    if (!args[0]) {
      return {
        ok: true,
        message: `Current trade mode: ${current.mode}\nUse /trade_mode off|confirm|auto`
      };
    }

    const mode = normalizeTradingMode(args[0]);
    const next = setTradingRuntime({ mode });
    return {
      ok: true,
      message: `Trading mode updated to: ${next.mode}`
    };
  }

  if (cmd === "/kill_switch") {
    const next = setTradingRuntime({
      killSwitch: true,
      enabled: false
    });
    return {
      ok: true,
      message: `🛑 Kill switch activated

Trading enabled: ${next.enabled}
Kill switch: ${next.killSwitch}`
    };
  }

  if (cmd === "/trading_on") {
    const next = setTradingRuntime({
      enabled: true,
      killSwitch: false
    });
    return {
      ok: true,
      message: `Trading enabled: ${next.enabled}`
    };
  }

  if (cmd === "/trading_off") {
    const next = setTradingRuntime({
      enabled: false
    });
    return {
      ok: true,
      message: `Trading enabled: ${next.enabled}`
    };
  }

  if (cmd === "/watch_wallet") {
    const address = args[0];
    if (!address) {
      return {
        ok: false,
        error: "Usage: /watch_wallet <solana_wallet_address>"
      };
    }

    const result = addTrackedWallet(address, adminName);
    if (!result.ok) return result;

    return {
      ok: true,
      message: result.alreadyExisted
        ? `Wallet already tracked:\n${result.wallet.address}`
        : `Now tracking wallet:\n${result.wallet.address}`
    };
  }

  if (cmd === "/unwatch_wallet") {
    const address = args[0];
    if (!address) {
      return {
        ok: false,
        error: "Usage: /unwatch_wallet <solana_wallet_address>"
      };
    }

    const result = removeTrackedWallet(address);
    return {
      ok: true,
      message: result.removed
        ? `Stopped tracking wallet:\n${address}`
        : `Wallet was not in tracked list.`
    };
  }

  if (cmd === "/wallets") {
    const wallets = listTrackedWallets();

    if (!wallets.length) {
      return {
        ok: true,
        message: "No tracked wallets yet."
      };
    }

    const lines = wallets.slice(0, 30).map((w, i) => {
      return `${i + 1}. ${w.address}${w.score != null ? ` • score ${w.score}` : ""}`;
    });

    return {
      ok: true,
      message: `Tracked wallets\n\n${lines.join("\n")}`
    };
  }

  if (cmd === "/wallet_score") {
    const address = args[0];
    if (!address) {
      return {
        ok: false,
        error: "Usage: /wallet_score <solana_wallet_address>"
      };
    }

    const wallet = getTrackedWallet(address);
    if (!wallet) {
      return {
        ok: false,
        error: "Wallet is not in tracked list. Add it first with /watch_wallet"
      };
    }

    const scored = refreshTrackedWalletScore(address);
    if (!scored.ok) return scored;

    return {
      ok: true,
      message: formatWalletScoreReport(scored.metrics)
    };
  }

  if (cmd === "/setbuy") {
    const amount = Number(args[0]);
    if (!Number.isFinite(amount)) {
      return {
        ok: false,
        error: "Usage: /setbuy <usd_amount>"
      };
    }

    const next = setTradingRuntime({
      buybotAlertMinUsd: clampNumber(amount, 0, 100000, 40)
    });

    return {
      ok: true,
      message: `Buy alert min updated to: $${next.buybotAlertMinUsd}`
    };
  }

  return {
    ok: false,
    error: "Unknown trading command"
  };
}
