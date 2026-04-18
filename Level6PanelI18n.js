// Level6PanelI18n.js

export function fmtPct(v) {
  if (typeof v !== "number") return v;
  return (v * 100).toFixed(1) + "%";
}

export function level6t(lang, key, ...args) {
  const dict = {
    en: {
      level6_panel_title: (rt) => `🧠 Level 6 Engine

Enabled: ${rt.enabled}
Dry Run: ${rt.dryRun}
Auto Entries: ${rt.autoEntries}
Auto Exits: ${rt.autoExits}
Open Trades: ${rt.openTrades}
Journal Trades: ${rt.journalTrades}`,

      level6_status_title: (summary) => `📊 Level 6 Status

Win Rate: ${fmtPct(summary.winRate)}
Total Trades: ${summary.totalTrades}
PnL: ${summary.pnl} SOL
Avg Entry Score: ${summary.avgEntryScore}`,

      no_open_trades: "No open trades",

      btn_back: "⬅️ Back",
      btn_menu: "🏠 Menu",
      btn_level6_status: "📊 Status",
      btn_level6_open_trades: "📂 Open Trades"
    },

    ru: {
      level6_panel_title: (rt) => `🧠 Level 6 Engine

Включен: ${rt.enabled}
Dry Run: ${rt.dryRun}
Авто-вход: ${rt.autoEntries}
Авто-выход: ${rt.autoExits}
Открытых сделок: ${rt.openTrades}
Журнал: ${rt.journalTrades}`,

      level6_status_title: (summary) => `📊 Статус Level 6

WinRate: ${fmtPct(summary.winRate)}
Всего сделок: ${summary.totalTrades}
PnL: ${summary.pnl} SOL
Средний скор входа: ${summary.avgEntryScore}`,

      no_open_trades: "Нет открытых сделок",

      btn_back: "⬅️ Назад",
      btn_menu: "🏠 Меню",
      btn_level6_status: "📊 Статус",
      btn_level6_open_trades: "📂 Сделки"
    }
  };

  const langDict = dict[lang] || dict.en;
  const val = langDict[key];

  if (typeof val === "function") return val(...args);
  return val || key;
}

export function buildLevel6PanelKeyboard(lang, rt) {
  return {
    inline_keyboard: [
      [
        { text: level6t(lang, "btn_level6_status"), callback_data: "level6:status" },
        { text: level6t(lang, "btn_level6_open_trades"), callback_data: "level6:open_trades" }
      ],
      [
        { text: level6t(lang, "btn_menu"), callback_data: "menu:open" }
      ]
    ]
  };
}

export function formatLevel6OpenTrades(lang, trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return level6t(lang, "no_open_trades");
  }

  return `📂 Open Trades:

${trades
  .map(
    (t, i) => `${i + 1}. ${t.token}
Entry: ${t.entry}
PnL: ${t.pnl} SOL
Score: ${t.score}`
  )
  .join("\n\n")}`;
}
