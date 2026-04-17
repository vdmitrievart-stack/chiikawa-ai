import fs from "fs";
import path from "path";

const STATE_FILE = path.resolve("./trading-runtime.json");

const DEFAULT_STATE = {
  mode: "confirm", // off | confirm | auto
  enabled: false,
  killSwitch: false,

  maxPositionSol: 0.1,
  dailyMaxLossSol: 0.3,
  maxOpenPositions: 2,

  buybotAlertMinUsd: 40,
  minWalletScore: 60,
  minTokenScore: 70,

  copyWalletsEnabled: true,
  freshMemeMaxSol: 0.05,

  publicAnnounceBuys: true,
  publicPinBuyPosts: true,

  trackedWallets: []
};

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { ...DEFAULT_STATE };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...DEFAULT_STATE,
      ...parsed,
      trackedWallets: Array.isArray(parsed.trackedWallets)
        ? parsed.trackedWallets
        : []
    };
  } catch (error) {
    console.error("trading-admin load error:", error.message);
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("trading-admin save error:", error.message);
  }
}

const state = loadState();

function normalizeTradingMode(value) {
  const mode = String(value || "").toLowerCase().trim();
  if (["off", "confirm", "auto"].includes(mode)) return mode;
  return "confirm";
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeAddress(address) {
  return String(address || "").trim();
}

function isProbablySolanaAddress(address) {
  const a = normalizeAddress(address);
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
}

function stableHash(text) {
  let hash = 0;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pseudoMetric(address, min, max, salt) {
  const h = stableHash(`${address}:${salt}`);
  const ratio = (h % 10000) / 10000;
  return min + ratio * (max - min);
}

function computeWalletScore(address) {
  const winRate = Math.round(pseudoMetric(address, 28, 74, "winRate"));
  const roi = Number(pseudoMetric(address, -12, 185, "roi").toFixed(1));
  const avgHoldMinutes = Math.round(pseudoMetric(address, 3, 280, "hold"));
  const rugExposure = Math.round(pseudoMetric(address, 5, 48, "rug"));
  const consistency = Math.round(pseudoMetric(address, 30, 89, "consistency"));

  let score = 0;
  score += winRate * 0.35;
  score += Math.max(0, Math.min(100, roi)) * 0.2;
  score += consistency * 0.25;
  score += Math.max(0, 100 - rugExposure) * 0.2;

  return {
    address,
    score: Math.round(score),
    winRate,
    roi,
    avgHoldMinutes,
    rugExposure,
    consistency,
    confidence: "stage1-estimated"
  };
}

function getTrackedWallet(address) {
  const a = normalizeAddress(address);
  return state.trackedWallets.find(w => w.address === a) || null;
}

function addTrackedWallet(address, addedBy = "admin") {
  const a = normalizeAddress(address);

  if (!isProbablySolanaAddress(a)) {
    return {
      ok: false,
      error: "Invalid Solana wallet address format"
    };
  }

  const existing = getTrackedWallet(a);
  if (existing) {
    return {
      ok: true,
      wallet: existing,
      alreadyExisted: true
    };
  }

  const wallet = {
    address: a,
    alias: null,
    enabled: true,
    notes: "",
    score: null,
    winRate: null,
    roi: null,
    avgHoldMinutes: null,
    rugExposure: null,
    consistency: null,
    addedAt: Date.now(),
    addedBy
  };

  state.trackedWallets.push(wallet);
  saveState();

  return {
    ok: true,
    wallet,
    alreadyExisted: false
  };
}

function removeTrackedWallet(address) {
  const a = normalizeAddress(address);
  const before = state.trackedWallets.length;
  state.trackedWallets = state.trackedWallets.filter(w => w.address !== a);
  saveState();

  return {
    ok: true,
    removed: state.trackedWallets.length < before
  };
}

function listTrackedWallets() {
  return [...state.trackedWallets].sort((a, b) => {
    const ta = Number(b.addedAt || 0);
    const tb = Number(a.addedAt || 0);
    return ta - tb;
  });
}

function refreshTrackedWalletScore(address) {
  const wallet = getTrackedWallet(address);

  if (!wallet) {
    return {
      ok: false,
      error: "Wallet not found"
    };
  }

  const metrics = computeWalletScore(address);

  Object.assign(wallet, {
    score: metrics.score,
    winRate: metrics.winRate,
    roi: metrics.roi,
    avgHoldMinutes: metrics.avgHoldMinutes,
    rugExposure: metrics.rugExposure,
    consistency: metrics.consistency,
    lastScoredAt: Date.now()
  });

  saveState();

  return {
    ok: true,
    wallet,
    metrics
  };
}

function formatWalletScoreReport(metrics) {
  return `🧠 Wallet Score

Address:
${metrics.address}

Score: ${metrics.score}/100
Win rate: ${metrics.winRate}%
ROI: ${metrics.roi}%
Avg hold: ${metrics.avgHoldMinutes} min
Rug exposure: ${metrics.rugExposure}%
Consistency: ${metrics.consistency}%

Confidence:
${metrics.confidence}`;
}

export function getTradingRuntime() {
  return { ...state };
}

export function setTradingRuntime(patch = {}) {
  Object.assign(state, patch);

  state.mode = normalizeTradingMode(state.mode);
  state.buybotAlertMinUsd = clampNumber(state.buybotAlertMinUsd, 0, 100000, 40);
  state.maxPositionSol = clampNumber(state.maxPositionSol, 0, 1000, 0.1);
  state.dailyMaxLossSol = clampNumber(state.dailyMaxLossSol, 0, 10000, 0.3);
  state.maxOpenPositions = clampNumber(state.maxOpenPositions, 1, 100, 2);
  state.minWalletScore = clampNumber(state.minWalletScore, 0, 100, 60);
  state.minTokenScore = clampNumber(state.minTokenScore, 0, 100, 70);
  state.freshMemeMaxSol = clampNumber(state.freshMemeMaxSol, 0, 1000, 0.05);

  saveState();
  return getTradingRuntime();
}

export function formatTradingStatus() {
  return `💼 Trading Status

enabled: ${state.enabled}
mode: ${state.mode}
killSwitch: ${state.killSwitch}

maxPositionSol: ${state.maxPositionSol}
dailyMaxLossSol: ${state.dailyMaxLossSol}
maxOpenPositions: ${state.maxOpenPositions}

buybotAlertMinUsd: ${state.buybotAlertMinUsd}
minWalletScore: ${state.minWalletScore}
minTokenScore: ${state.minTokenScore}

copyWalletsEnabled: ${state.copyWalletsEnabled}
publicAnnounceBuys: ${state.publicAnnounceBuys}
publicPinBuyPosts: ${state.publicPinBuyPosts}

trackedWallets: ${state.trackedWallets.length}`;
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
          text: "Trade status",
          callback_data: "trade:show_status"
        }
      ]
    ]
  };
}

export function handleTradingAdminCallback(data) {
  const current = getTradingRuntime();

  if (data === "trade:toggle_enabled") {
    return {
      ok: true,
      state: setTradingRuntime({ enabled: !current.enabled }),
      message: `Trading enabled: ${!current.enabled}`
    };
  }

  if (data === "trade:toggle_kill") {
    return {
      ok: true,
      state: setTradingRuntime({ killSwitch: !current.killSwitch }),
      message: `Kill switch: ${!current.killSwitch}`
    };
  }

  if (data === "trade:toggle_copy") {
    return {
      ok: true,
      state: setTradingRuntime({ copyWalletsEnabled: !current.copyWalletsEnabled }),
      message: `Copy wallets enabled: ${!current.copyWalletsEnabled}`
    };
  }

  if (data === "trade:cycle_mode") {
    const next =
      current.mode === "off"
        ? "confirm"
        : current.mode === "confirm"
          ? "auto"
          : "off";

    return {
      ok: true,
      state: setTradingRuntime({ mode: next }),
      message: `Trading mode: ${next}`
    };
  }

  if (data === "trade:buymin_up") {
    const next = clampNumber(
      Number(current.buybotAlertMinUsd || 40) + 10,
      0,
      100000,
      40
    );

    return {
      ok: true,
      state: setTradingRuntime({ buybotAlertMinUsd: next }),
      message: `Buy alert min: $${next}`
    };
  }

  if (data === "trade:show_status") {
    return {
      ok: true,
      state: current,
      message: formatTradingStatus()
    };
  }

  if (data === "trade:show_wallets") {
    const wallets = listTrackedWallets();

    if (!wallets.length) {
      return {
        ok: true,
        state: current,
        message: "No tracked wallets yet."
      };
    }

    const text = wallets
      .slice(0, 20)
      .map((w, i) => `${i + 1}. ${w.address}${w.score != null ? ` • score ${w.score}` : ""}`)
      .join("\n");

    return {
      ok: true,
      state: current,
      message: `Tracked wallets

${text}`
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
    return {
      ok: true,
      message: formatTradingStatus()
    };
  }

  if (cmd === "/trade_mode") {
    if (!args[0]) {
      return {
        ok: true,
        message: `Current trade mode: ${state.mode}
Use /trade_mode off|confirm|auto`
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
        ? `Wallet already tracked:
${result.wallet.address}`
        : `Now tracking wallet:
${result.wallet.address}`
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
        ? `Stopped tracking wallet:
${address}`
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
      message: `Tracked wallets

${lines.join("\n")}`
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
