import fs from "fs";
import path from "path";
import Level4TradingKernel from "./Level4TradingKernel.js";
import Level6TradingOrchestrator from "./Level6TradingOrchestrator.js";

const RUNTIME_FILE = path.join(process.cwd(), "data", "trading-runtime.json");

const DEFAULT_RUNTIME = {
  enabled: true,
  mode: "paper",
  killSwitch: false,
  buybotAlertMinUsd: 20,
  trackedWallets: [],
  autoCopyEnabled: false,
  level5DryRun: true,
  level6: {
    enabled: true,
    dryRun: true,
    autoEntries: false,
    autoExits: false
  }
};

function ensureRuntimeDir() {
  fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
}

function loadRuntime() {
  try {
    ensureRuntimeDir();
    if (!fs.existsSync(RUNTIME_FILE)) {
      return structuredClone(DEFAULT_RUNTIME);
    }

    const raw = fs.readFileSync(RUNTIME_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...structuredClone(DEFAULT_RUNTIME),
      ...parsed,
      level6: {
        ...structuredClone(DEFAULT_RUNTIME.level6),
        ...(parsed.level6 || {})
      }
    };
  } catch {
    return structuredClone(DEFAULT_RUNTIME);
  }
}

function saveRuntime() {
  ensureRuntimeDir();
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), "utf8");
}

const runtime = loadRuntime();

const level4Kernel = new Level4TradingKernel({
  baseDir: path.join(process.cwd(), "data", "trading"),
  logger: console
});

let level4Ready = false;

const level6 = new Level6TradingOrchestrator({
  logger: console,
  baseDir: path.join(process.cwd(), "data", "trading", "level6"),
  enabled: runtime.level6.enabled,
  dryRun: runtime.level6.dryRun,
  autoExecuteEntries: runtime.level6.autoEntries,
  autoExecuteExits: runtime.level6.autoExits,
  defaultWalletId: "wallet_1"
});

let level6Ready = false;

export async function initTradingAdmin() {
  if (!level4Ready) {
    await level4Kernel.init();
    level4Ready = true;
  }

  if (!level6Ready) {
    await level6.init();
    level6Ready = true;
  }

  return {
    ok: true,
    runtime: getTradingRuntime(),
    level6: getLevel6Runtime()
  };
}

export function getTradingRuntime() {
  return {
    enabled: runtime.enabled,
    mode: runtime.mode,
    killSwitch: runtime.killSwitch,
    buybotAlertMinUsd: runtime.buybotAlertMinUsd,
    trackedWallets: [...runtime.trackedWallets],
    autoCopyEnabled: runtime.autoCopyEnabled,
    level5DryRun: runtime.level5DryRun
  };
}

export function getLevel6Runtime() {
  return {
    enabled: runtime.level6.enabled,
    dryRun: runtime.level6.dryRun,
    autoEntries: runtime.level6.autoEntries,
    autoExits: runtime.level6.autoExits,
    ready: level6Ready,
    ...level6.getStatus()
  };
}

export function formatTradingStatus() {
  const t = getTradingRuntime();
  const l6 = getLevel6Runtime();

  return `📊 Trading Status

enabled: ${t.enabled}
mode: ${t.mode}
killSwitch: ${t.killSwitch}
buybotAlertMinUsd: ${t.buybotAlertMinUsd}
trackedWallets: ${t.trackedWallets.length}
autoCopyEnabled: ${t.autoCopyEnabled}
level5DryRun: ${t.level5DryRun}

🧠 Level 6
enabled: ${l6.enabled}
dryRun: ${l6.dryRun}
autoEntries: ${l6.autoEntries}
autoExits: ${l6.autoExits}
ready: ${l6.ready}
openTrades: ${l6.openTrades}
journalTrades: ${l6.journalTrades}`;
}

export async function getLevel6Summary() {
  if (!level6Ready) {
    await level6.init();
    level6Ready = true;
  }
  return level6.summarizeJournal();
}

export async function getLevel6OpenTrades() {
  if (!level6Ready) {
    await level6.init();
    level6Ready = true;
  }
  return level6.getOpenTrades();
}

function persistLevel6Flags() {
  runtime.level6.enabled = level6.getStatus().enabled;
  runtime.level6.dryRun = level6.getStatus().dryRun;
  runtime.level6.autoEntries = level6.getStatus().autoEntries;
  runtime.level6.autoExits = level6.getStatus().autoExits;
  saveRuntime();
}

function toggleTradingEnabled() {
  runtime.enabled = !runtime.enabled;
  saveRuntime();
  return { ok: true, message: `Trading enabled: ${runtime.enabled}` };
}

function toggleKillSwitch() {
  runtime.killSwitch = !runtime.killSwitch;
  saveRuntime();
  return { ok: true, message: `Kill switch: ${runtime.killSwitch}` };
}

function cycleMode() {
  const modes = ["paper", "semi", "live"];
  const index = modes.indexOf(runtime.mode);
  runtime.mode = modes[(index + 1) % modes.length];
  saveRuntime();
  return { ok: true, message: `Mode: ${runtime.mode}` };
}

function incrementBuyMin() {
  runtime.buybotAlertMinUsd += 5;
  saveRuntime();
  return { ok: true, message: `Buy Min: $${runtime.buybotAlertMinUsd}` };
}

function toggleAutoCopy() {
  runtime.autoCopyEnabled = !runtime.autoCopyEnabled;
  saveRuntime();
  return {
    ok: true,
    message: `AutoCopy: ${runtime.autoCopyEnabled ? "ON" : "OFF"}`
  };
}

function toggleLevel5DryRun() {
  runtime.level5DryRun = !runtime.level5DryRun;
  saveRuntime();
  return {
    ok: true,
    message: `Level5 Dry Run: ${runtime.level5DryRun ? "ON" : "OFF"}`
  };
}

function listWallets() {
  if (!runtime.trackedWallets.length) {
    return { ok: true, message: "No tracked wallets." };
  }

  const text = runtime.trackedWallets
    .map((w, i) => `${i + 1}. ${w.id} | ${w.address} | ${w.label || "-"}`)
    .join("\n");

  return { ok: true, message: `Tracked wallets:\n\n${text}` };
}

function addTrackedWallet(address, label = "") {
  const id = `wallet_${runtime.trackedWallets.length + 1}`;
  runtime.trackedWallets.push({ id, address, label });
  saveRuntime();
  return { ok: true, message: `Wallet added: ${id}` };
}

function removeTrackedWallet(address) {
  const before = runtime.trackedWallets.length;
  runtime.trackedWallets = runtime.trackedWallets.filter(
    w => w.address !== address && w.id !== address
  );
  saveRuntime();
  return {
    ok: true,
    message:
      runtime.trackedWallets.length < before
        ? "Wallet removed."
        : "Wallet not found."
  };
}

async function handleLevel6AdminAction(action) {
  if (!level6Ready) {
    await level6.init();
    level6Ready = true;
  }

  if (action === "status") {
    const summary = await level6.summarizeJournal();
    return { ok: true, message: formatLevel6Summary(summary) };
  }

  if (action === "open_trades") {
    const trades = await level6.getOpenTrades();
    if (!trades.length) {
      return { ok: true, message: "No open Level 6 trades." };
    }

    const text = trades
      .slice(0, 12)
      .map(
        t =>
          `${t.token?.symbol || "UNKNOWN"} | ${t.tradeId}\nwallet: ${t.walletId}\nentryMode: ${t.entryMode}\nentrySizeUsd: ${t.entrySizeUsd}`
      )
      .join("\n\n");

    return { ok: true, message: `Open Level 6 trades:\n\n${text}` };
  }

  if (action === "dryrun_on") {
    level6.setDryRun(true);
    runtime.level6.dryRun = true;
    persistLevel6Flags();
    return { ok: true, message: "Level 6 dry run enabled." };
  }

  if (action === "dryrun_off") {
    level6.setDryRun(false);
    runtime.level6.dryRun = false;
    persistLevel6Flags();
    return { ok: true, message: "Level 6 dry run disabled." };
  }

  if (action === "auto_entries_on") {
    level6.setAutoEntries(true);
    runtime.level6.autoEntries = true;
    persistLevel6Flags();
    return { ok: true, message: "Level 6 auto entries enabled." };
  }

  if (action === "auto_entries_off") {
    level6.setAutoEntries(false);
    runtime.level6.autoEntries = false;
    persistLevel6Flags();
    return { ok: true, message: "Level 6 auto entries disabled." };
  }

  if (action === "auto_exits_on") {
    level6.setAutoExits(true);
    runtime.level6.autoExits = true;
    persistLevel6Flags();
    return { ok: true, message: "Level 6 auto exits enabled." };
  }

  if (action === "auto_exits_off") {
    level6.setAutoExits(false);
    runtime.level6.autoExits = false;
    persistLevel6Flags();
    return { ok: true, message: "Level 6 auto exits disabled." };
  }

  if (action === "refresh") {
    return {
      ok: true,
      message: formatLevel6PanelStatus(level6.getStatus())
    };
  }

  return { ok: false, error: "Unknown Level 6 action" };
}

function formatLevel6PanelStatus(status) {
  return `🧠 Level 6 Panel

enabled: ${status.enabled}
dryRun: ${status.dryRun}
autoEntries: ${status.autoEntries}
autoExits: ${status.autoExits}
openTrades: ${status.openTrades}
journalTrades: ${status.journalTrades}`;
}

function formatLevel6Summary(summary) {
  return `🧠 Level 6 Status

closedTrades: ${summary.closedTrades}
winRate: ${Number(summary.winRate || 0).toFixed(4)}
averagePnlPct: ${Number(summary.averagePnlPct || 0).toFixed(2)}
medianPnlPct: ${Number(summary.medianPnlPct || 0).toFixed(2)}
totalPnlUsd: ${Number(summary.totalPnlUsd || 0).toFixed(2)}`;
}

export async function handleTradingAdminCallback(data) {
  try {
    if (data === "trade:show_status") {
      return { ok: true, message: formatTradingStatus() };
    }

    if (data === "trade:show_wallets") {
      return listWallets();
    }

    if (data === "trade:toggle_enabled") {
      return toggleTradingEnabled();
    }

    if (data === "trade:toggle_kill") {
      return toggleKillSwitch();
    }

    if (data === "trade:cycle_mode") {
      return cycleMode();
    }

    if (data === "trade:buymin_up") {
      return incrementBuyMin();
    }

    if (data === "level5:autocopy_toggle") {
      return toggleAutoCopy();
    }

    if (data === "level5:dryrun_toggle") {
      return toggleLevel5DryRun();
    }

    if (data.startsWith("level6:")) {
      return handleLevel6AdminAction(data.split(":")[1]);
    }

    return { ok: false, error: "Unknown callback" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function handleTradingCommand(text, userName = "admin") {
  try {
    const cmd = String(text || "").trim();

    if (cmd === "/trade_status") {
      return { ok: true, message: formatTradingStatus() };
    }

    if (cmd === "/wallets") {
      return listWallets();
    }

    if (cmd.startsWith("/watch_wallet ")) {
      const [, address, ...labelParts] = cmd.split(/\s+/);
      if (!address) {
        return { ok: false, error: "Usage: /watch_wallet <address> [label]" };
      }
      return addTrackedWallet(address, labelParts.join(" "));
    }

    if (cmd.startsWith("/unwatch_wallet ")) {
      const [, address] = cmd.split(/\s+/);
      if (!address) {
        return { ok: false, error: "Usage: /unwatch_wallet <address_or_id>" };
      }
      return removeTrackedWallet(address);
    }

    if (cmd === "/trading_on") {
      runtime.enabled = true;
      saveRuntime();
      return { ok: true, message: "Trading enabled: true" };
    }

    if (cmd === "/trading_off") {
      runtime.enabled = false;
      saveRuntime();
      return { ok: true, message: "Trading enabled: false" };
    }

    if (cmd === "/kill_switch") {
      return toggleKillSwitch();
    }

    if (cmd === "/trade_mode") {
      return cycleMode();
    }

    if (cmd.startsWith("/setbuy ")) {
      const value = Number(cmd.split(/\s+/)[1]);
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, error: "Usage: /setbuy <usd>" };
      }
      runtime.buybotAlertMinUsd = value;
      saveRuntime();
      return { ok: true, message: `Buy Min: $${runtime.buybotAlertMinUsd}` };
    }

    if (cmd === "/autocopy_on") {
      runtime.autoCopyEnabled = true;
      saveRuntime();
      return { ok: true, message: "AutoCopy enabled." };
    }

    if (cmd === "/autocopy_off") {
      runtime.autoCopyEnabled = false;
      saveRuntime();
      return { ok: true, message: "AutoCopy disabled." };
    }

    if (cmd === "/autocopy_status") {
      return {
        ok: true,
        message: `AutoCopy: ${runtime.autoCopyEnabled}\nLevel5 Dry Run: ${runtime.level5DryRun}`
      };
    }

    if (cmd === "/level5_dryrun_on") {
      runtime.level5DryRun = true;
      saveRuntime();
      return { ok: true, message: "Level5 Dry Run enabled." };
    }

    if (cmd === "/level5_dryrun_off") {
      runtime.level5DryRun = false;
      saveRuntime();
      return { ok: true, message: "Level5 Dry Run disabled." };
    }

    if (cmd === "/level5_health") {
      return {
        ok: true,
        message: `Level5 Health

autoCopyEnabled: ${runtime.autoCopyEnabled}
level5DryRun: ${runtime.level5DryRun}
trackedWallets: ${runtime.trackedWallets.length}`
      };
    }

    if (cmd === "/level6_status") {
      const summary = await getLevel6Summary();
      return { ok: true, message: formatLevel6Summary(summary) };
    }

    if (cmd === "/level6_open_trades") {
      const trades = await getLevel6OpenTrades();
      if (!trades.length) {
        return { ok: true, message: "No open Level 6 trades." };
      }

      return {
        ok: true,
        message: trades
          .slice(0, 12)
          .map(
            t =>
              `${t.token?.symbol || "UNKNOWN"} | ${t.tradeId}\nwallet: ${t.walletId}\nentryMode: ${t.entryMode}\nentrySizeUsd: ${t.entrySizeUsd}`
          )
          .join("\n\n")
      };
    }

    if (cmd === "/level6_dryrun_on") {
      return handleLevel6AdminAction("dryrun_on");
    }

    if (cmd === "/level6_dryrun_off") {
      return handleLevel6AdminAction("dryrun_off");
    }

    return { ok: false, error: "Unknown command" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
