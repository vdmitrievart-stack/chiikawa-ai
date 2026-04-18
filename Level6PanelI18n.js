const LEVEL6_I18N = {
  en: {
    level6_panel_title: status => `🧠 Level 6 Panel

enabled: ${status.enabled}
dryRun: ${status.dryRun}
autoEntries: ${status.autoEntries}
autoExits: ${status.autoExits}
openTrades: ${status.openTrades}
journalTrades: ${status.journalTrades}`,

    level6_status_title: summary => `🧠 Level 6 Status

closedTrades: ${summary.closedTrades}
winRate: ${this.#fmtPct ? this.#fmtPct(summary.winRate) : summary.winRate}
averagePnlPct: ${summary.averagePnlPct}
medianPnlPct: ${summary.medianPnlPct}
totalPnlUsd: ${summary.totalPnlUsd}`,

    btn_level6_panel: "🧠 Level 6",
    btn_level6_status: "📊 Level 6 Status",
    btn_level6_open_trades: "📂 Open Trades",
    btn_level6_dryrun_on: "🟢 L6 Dry Run ON",
    btn_level6_dryrun_off: "🔴 L6 Dry Run OFF",
    btn_level6_auto_entries_on: "⚡ Auto Entries ON",
    btn_level6_auto_entries_off: "⚡ Auto Entries OFF",
    btn_level6_auto_exits_on: "🚪 Auto Exits ON",
    btn_level6_auto_exits_off: "🚪 Auto Exits OFF",
    btn_level6_refresh: "🔄 Refresh L6",
    btn_back: "⬅️ Back",
    btn_menu: "📋 Menu",

    level6_open_trades_empty: "No open Level 6 trades.",
    level6_open_trades_header: "📂 Open Level 6 Trades",
    level6_dryrun_enabled: "Level 6 dry run enabled.",
    level6_dryrun_disabled: "Level 6 dry run disabled.",
    level6_auto_entries_enabled: "Level 6 auto entries enabled.",
    level6_auto_entries_disabled: "Level 6 auto entries disabled.",
    level6_auto_exits_enabled: "Level 6 auto exits enabled.",
    level6_auto_exits_disabled: "Level 6 auto exits disabled.",
    level6_not_ready: "Level 6 is not initialized yet."
  },

  ru: {
    level6_panel_title: status => `🧠 Панель Level 6

enabled: ${status.enabled}
dryRun: ${status.dryRun}
autoEntries: ${status.autoEntries}
autoExits: ${status.autoExits}
openTrades: ${status.openTrades}
journalTrades: ${status.journalTrades}`,

    level6_status_title: summary => `🧠 Статус Level 6

closedTrades: ${summary.closedTrades}
winRate: ${summary.winRate}
averagePnlPct: ${summary.averagePnlPct}
medianPnlPct: ${summary.medianPnlPct}
totalPnlUsd: ${summary.totalPnlUsd}`,

    btn_level6_panel: "🧠 Level 6",
    btn_level6_status: "📊 Статус Level 6",
    btn_level6_open_trades: "📂 Открытые сделки",
    btn_level6_dryrun_on: "🟢 L6 Dry Run ON",
    btn_level6_dryrun_off: "🔴 L6 Dry Run OFF",
    btn_level6_auto_entries_on: "⚡ Автовходы ON",
    btn_level6_auto_entries_off: "⚡ Автовходы OFF",
    btn_level6_auto_exits_on: "🚪 Автовыходы ON",
    btn_level6_auto_exits_off: "🚪 Автовыходы OFF",
    btn_level6_refresh: "🔄 Обновить L6",
    btn_back: "⬅️ Назад",
    btn_menu: "📋 Меню",

    level6_open_trades_empty: "Нет открытых сделок Level 6.",
    level6_open_trades_header: "📂 Открытые сделки Level 6",
    level6_dryrun_enabled: "Level 6 dry run включен.",
    level6_dryrun_disabled: "Level 6 dry run выключен.",
    level6_auto_entries_enabled: "Автовходы Level 6 включены.",
    level6_auto_entries_disabled: "Автовходы Level 6 выключены.",
    level6_auto_exits_enabled: "Автовыходы Level 6 включены.",
    level6_auto_exits_disabled: "Автовыходы Level 6 выключены.",
    level6_not_ready: "Level 6 ещё не инициализирован."
  }
};

export function level6t(langCode, key, ...args) {
  const lang = LEVEL6_I18N[langCode] || LEVEL6_I18N.en;
  const fallback = LEVEL6_I18N.en[key];
  const value = lang[key] ?? fallback;

  if (typeof value === "function") {
    return value(...args);
  }

  return value;
}

export function buildLevel6PanelKeyboard(langCode, level6Status = {}) {
  const dryRun = Boolean(level6Status.dryRun);
  const autoEntries = Boolean(level6Status.autoEntries);
  const autoExits = Boolean(level6Status.autoExits);

  return {
    inline_keyboard: [
      [
        { text: level6t(langCode, "btn_level6_status"), callback_data: "level6:status" },
        { text: level6t(langCode, "btn_level6_open_trades"), callback_data: "level6:open_trades" }
      ],
      [
        {
          text: dryRun
            ? level6t(langCode, "btn_level6_dryrun_off")
            : level6t(langCode, "btn_level6_dryrun_on"),
          callback_data: dryRun ? "level6:dryrun_off" : "level6:dryrun_on"
        }
      ],
      [
        {
          text: autoEntries
            ? level6t(langCode, "btn_level6_auto_entries_off")
            : level6t(langCode, "btn_level6_auto_entries_on"),
          callback_data: autoEntries
            ? "level6:auto_entries_off"
            : "level6:auto_entries_on"
        },
        {
          text: autoExits
            ? level6t(langCode, "btn_level6_auto_exits_off")
            : level6t(langCode, "btn_level6_auto_exits_on"),
          callback_data: autoExits
            ? "level6:auto_exits_off"
            : "level6:auto_exits_on"
        }
      ],
      [
        { text: level6t(langCode, "btn_level6_refresh"), callback_data: "level6:refresh" }
      ],
      [
        { text: level6t(langCode, "btn_back"), callback_data: "tradepanel:open" },
        { text: level6t(langCode, "btn_menu"), callback_data: "menu:open" }
      ]
    ]
  };
}

export function formatLevel6OpenTrades(langCode, trades = []) {
  if (!Array.isArray(trades) || !trades.length) {
    return level6t(langCode, "level6_open_trades_empty");
  }

  const lines = [level6t(langCode, "level6_open_trades_header"), ""];

  for (const trade of trades.slice(0, 12)) {
    lines.push(
      `${trade.token?.symbol || "UNKNOWN"} | ${trade.tradeId}`,
      `wallet: ${trade.walletId || "n/a"}`,
      `entryMode: ${trade.entryMode || "n/a"}`,
      `entryPriceUsd: ${trade.entryPriceUsd || 0}`,
      `entrySizeUsd: ${trade.entrySizeUsd || 0}`,
      ""
    );
  }

  return lines.join("\n").trim();
}
