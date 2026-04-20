export const I18N = {
  ru: {
    menu_run_multi: "🚀 Run Multi",
    menu_run_scalp: "⚡ Run Scalp",
    menu_run_reversal: "↩️ Run Reversal",
    menu_run_runner: "🏃 Run Runner",
    menu_run_copy: "📋 Run Copytrade",
    menu_stop: "🛑 Stop",
    menu_kill: "☠️ Kill",
    menu_status: "📊 Status",
    menu_scan_market: "🔎 Scan Market",
    menu_scan_ca: "🧾 Scan CA",
    menu_balance: "💰 Balance",
    menu_wallets: "👛 Wallets",
    menu_copytrade: "📋 Copytrade",
    menu_budget: "🧮 Budget",
    menu_gmgn_status: "🛰 GMGN Status",
    menu_leader_health: "🫀 Leader Health",
    menu_sync_leaders: "🔄 Sync Leaders",
    menu_language: "🌐 Language",
    menu_export_csv: "📈 Export CSV",
    menu_export_json: "📦 Export JSON",
    menu_export_xlsx: "📊 Export XLSX",

    ready: "🤖 <b>Бот готов</b>",
    send_ca: "🧾 <b>Send CA</b>\n\nОтправь контракт следующим сообщением.",
    invalid_ca: "❌ Это не похоже на валидный CA.",
    scan_hint: "Сначала нажми <b>🧾 Scan CA</b>, потом отправь адрес.",
    soft_stop: "🛑 Мягкая остановка включена. Новые входы запрещены, открытые позиции будут сопровождаться до выхода.",
    hard_kill: "☠️ Жесткая остановка выполнена.",
    choose_lang: "🌐 Выбери язык:\n<code>lang ru</code> или <code>lang en</code>",
    lang_set: "🌐 Язык переключен",
    add_leader_prompt: "✍️ Отправь address лидера следующим сообщением.",
    add_secret_prompt: "🔐 Отправь в следующем сообщении строку вида:\n<code>wallet_id env:SECRET_NAME</code>",
    pending_budget_saved: "✅ Pending budget сохранен",
    leader_added: "✅ Лидер добавлен",
    secret_saved: "✅ Secret ref сохранен",
    leaders_synced: "✅ Лидеры синхронизированы",
    run_started: "✅ Запуск выполнен",
    pending_applied: "✅ Pending config применен",
    unknown: "Используйте меню ниже.",
    budget_invalid: "❌ Budget invalid. Sum must be 100.",
    wallet_not_found: "❌ Wallet not found",
    secret_format: "❌ Format: <code>wallet_id env:SECRET_NAME</code>",
    pending_not_ready: "Pending config not applied yet. Stop the bot and close positions first."
  },
  en: {
    menu_run_multi: "🚀 Run Multi",
    menu_run_scalp: "⚡ Run Scalp",
    menu_run_reversal: "↩️ Run Reversal",
    menu_run_runner: "🏃 Run Runner",
    menu_run_copy: "📋 Run Copytrade",
    menu_stop: "🛑 Stop",
    menu_kill: "☠️ Kill",
    menu_status: "📊 Status",
    menu_scan_market: "🔎 Scan Market",
    menu_scan_ca: "🧾 Scan CA",
    menu_balance: "💰 Balance",
    menu_wallets: "👛 Wallets",
    menu_copytrade: "📋 Copytrade",
    menu_budget: "🧮 Budget",
    menu_gmgn_status: "🛰 GMGN Status",
    menu_leader_health: "🫀 Leader Health",
    menu_sync_leaders: "🔄 Sync Leaders",
    menu_language: "🌐 Language",
    menu_export_csv: "📈 Export CSV",
    menu_export_json: "📦 Export JSON",
    menu_export_xlsx: "📊 Export XLSX",

    ready: "🤖 <b>Bot ready</b>",
    send_ca: "🧾 <b>Send CA</b>\n\nSend the token contract in the next message.",
    invalid_ca: "❌ This does not look like a valid CA.",
    scan_hint: "First press <b>🧾 Scan CA</b>, then send the address.",
    soft_stop: "🛑 Soft stop enabled. No new entries, existing positions will be managed until exit.",
    hard_kill: "☠️ Hard stop executed.",
    choose_lang: "🌐 Choose language:\n<code>lang ru</code> or <code>lang en</code>",
    lang_set: "🌐 Language switched",
    add_leader_prompt: "✍️ Send leader address in the next message.",
    add_secret_prompt: "🔐 Send a line in the next message like:\n<code>wallet_id env:SECRET_NAME</code>",
    pending_budget_saved: "✅ Pending budget saved",
    leader_added: "✅ Leader added",
    secret_saved: "✅ Secret ref saved",
    leaders_synced: "✅ Leaders synced",
    run_started: "✅ Run started",
    pending_applied: "✅ Pending config applied",
    unknown: "Use the menu below.",
    budget_invalid: "❌ Budget invalid. Sum must be 100.",
    wallet_not_found: "❌ Wallet not found",
    secret_format: "❌ Format: <code>wallet_id env:SECRET_NAME</code>",
    pending_not_ready: "Pending config not applied yet. Stop the bot and close positions first."
  }
};

export function makeTranslator(getLang) {
  return function t(key) {
    const lang = (typeof getLang === "function" ? getLang() : "ru") || "ru";
    return I18N[lang]?.[key] || I18N.ru[key] || key;
  };
}

export function buildKeyboard(t) {
  return {
    keyboard: [
      [t("menu_run_multi"), t("menu_run_scalp")],
      [t("menu_run_reversal"), t("menu_run_runner")],
      [t("menu_run_copy"), t("menu_stop")],
      [t("menu_kill"), t("menu_status")],
      [t("menu_scan_market"), t("menu_scan_ca")],
      [t("menu_balance"), t("menu_budget")],
      [t("menu_wallets"), t("menu_copytrade")],
      [t("menu_gmgn_status"), t("menu_leader_health")],
      [t("menu_sync_leaders"), t("menu_language")],
      [t("menu_export_csv"), t("menu_export_json")],
      [t("menu_export_xlsx")]
    ],
    resize_keyboard: true,
    persistent: true
  };
}
