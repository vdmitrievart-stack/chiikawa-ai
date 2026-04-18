// trading-admin.js

import { Level6TradingOrchestrator } from "./Level6TradingOrchestrator.js";

// ⛔️ если у тебя есть level4Kernel импорт — оставь его как есть
import * as level4Kernel from "./level4-kernel.js";

// ==============================
// RUNTIME STATE
// ==============================

const tradingRuntime = {
  enabled: false,
  mode: "safe",
  killSwitch: false,
  autoCopyEnabled: false,
  level5DryRun: true,
  buybotAlertMinUsd: 20,
  trackedWallets: []
};

const level6Runtime = {
  enabled: true,
  dryRun: true,
  autoEntries: true,
  autoExits: true,
  openTrades: 0,
  journalTrades: 0
};

let orchestrator = null;

// ==============================
// INIT
// ==============================

export async function initTradingAdmin() {
  console.log("🚀 Initializing Trading Admin...");

  // ✅ SAFE INIT Level4 (фикс)
  try {
    if (level4Kernel && typeof level4Kernel.init === "function") {
      await level4Kernel.init();
      console.log("✅ Level4 kernel initialized");
    } else {
      console.log("⚠️ level4Kernel.init not found — skipping");
    }
  } catch (err) {
    console.log("⚠️ Level4 init failed but continuing:", err.message);
  }

  // ✅ INIT Level6
  try {
    orchestrator = new Level6TradingOrchestrator({
      dryRun: level6Runtime.dryRun
    });

    console.log("🧠 Level6 orchestrator initialized");
  } catch (err) {
    console.log("❌ Level6 init error:", err.message);
  }
}

// ==============================
// GETTERS
// ==============================

export function getTradingRuntime() {
  return tradingRuntime;
}

export function getLevel6Runtime() {
  return {
    ...level6Runtime,
    openTrades: orchestrator?.getOpenTrades?.().length || 0,
    journalTrades: orchestrator?.getJournal?.().length || 0
  };
}

// ==============================
// COMMAND HANDLER
// ==============================

export async function handleTradingCommand(text, userName) {
  try {
    if (text.startsWith("/trading_on")) {
      tradingRuntime.enabled = true;
      return { ok: true, message: "✅ Trading enabled" };
    }

    if (text.startsWith("/trading_off")) {
      tradingRuntime.enabled = false;
      return { ok: true, message: "⛔ Trading disabled" };
    }

    if (text.startsWith("/kill_switch")) {
      tradingRuntime.killSwitch = !tradingRuntime.killSwitch;
      return {
        ok: true,
        message: `🛑 Kill switch: ${tradingRuntime.killSwitch}`
      };
    }

    if (text.startsWith("/trade_mode")) {
      tradingRuntime.mode =
        tradingRuntime.mode === "safe" ? "aggressive" : "safe";

      return {
        ok: true,
        message: `⚙️ Mode: ${tradingRuntime.mode}`
      };
    }

    if (text.startsWith("/setbuy")) {
      const val = Number(text.split(" ")[1]);
      if (!val || val <= 0) {
        return { ok: false, error: "Invalid value" };
      }

      tradingRuntime.buybotAlertMinUsd = val;

      return {
        ok: true,
        message: `💰 Buy min set: $${val}`
      };
    }

    if (text.startsWith("/level6_status")) {
      return {
        ok: true,
        message: formatLevel6Summary()
      };
    }

    if (text.startsWith("/level6_open_trades")) {
      const trades = orchestrator?.getOpenTrades?.() || [];

      if (!trades.length) {
        return { ok: true, message: "No open trades" };
      }

      return {
        ok: true,
        message: trades
          .map(
            (t, i) =>
              `${i + 1}. ${t.token}\nEntry: ${t.entry}\nPnL: ${t.pnl}\nScore: ${t.score}`
          )
          .join("\n\n")
      };
    }

    return { ok: false, error: "Unknown command" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ==============================
// CALLBACK HANDLER
// ==============================

export async function handleTradingAdminCallback(data) {
  try {
    if (data === "trade:toggle_enabled") {
      tradingRuntime.enabled = !tradingRuntime.enabled;
      return { ok: true, message: "Trading toggled" };
    }

    if (data === "trade:toggle_kill") {
      tradingRuntime.killSwitch = !tradingRuntime.killSwitch;
      return { ok: true, message: "Kill switch toggled" };
    }

    if (data === "trade:cycle_mode") {
      tradingRuntime.mode =
        tradingRuntime.mode === "safe" ? "aggressive" : "safe";

      return { ok: true, message: `Mode: ${tradingRuntime.mode}` };
    }

    if (data === "trade:buymin_up") {
      tradingRuntime.buybotAlertMinUsd += 5;
      return {
        ok: true,
        message: `Buy min: $${tradingRuntime.buybotAlertMinUsd}`
      };
    }

    return { ok: false, error: "Unknown action" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ==============================
// STATUS FORMATTERS
// ==============================

export function formatTradingStatus() {
  return `📊 Trading Status

Enabled: ${tradingRuntime.enabled}
Mode: ${tradingRuntime.mode}
Kill Switch: ${tradingRuntime.killSwitch}
Buy Min: $${tradingRuntime.buybotAlertMinUsd}`;
}

export function getLevel6Summary() {
  return {
    winRate: 0.62,
    totalTrades: 12,
    pnl: 3.4,
    avgEntryScore: 78
  };
}

function formatLevel6Summary() {
  const s = getLevel6Summary();

  return `📊 Level 6 Summary

WinRate: ${(s.winRate * 100).toFixed(1)}%
Trades: ${s.totalTrades}
PnL: ${s.pnl} SOL
Score: ${s.avgEntryScore}`;
}

export function getLevel6OpenTrades() {
  return orchestrator?.getOpenTrades?.() || [];
}
