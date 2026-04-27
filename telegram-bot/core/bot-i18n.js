const UI = {
  ru: {
    ready: "🤖 <b>Бот готов</b>\nИспользуйте меню ниже.",
    run_started: "✅ Запуск выполнен",
    soft_stop: "🛑 Мягкая остановка включена. Новые входы запрещены, открытые позиции будут сопровождаться до выхода.",
    hard_kill: "☠️ Hard kill выполнен.",
    send_ca: "🧾 Отправьте CA токена.",
    send_team_ca: "🕵️ V10 ACTIVE. Отправьте CA токена для Team / Insider / Sniper Intel.",
    choose_lang: "🌐 Выберите язык: lang ru / lang en",
    lang_set: "Язык установлен",
    add_leader_prompt: "Отправьте адрес лидера.",
    add_secret_prompt: "Отправьте: <code>wallet_id env:SECRET_NAME</code>",
    leader_added: "Лидер добавлен",
    leaders_synced: "Лидеры синхронизированы",
    invalid_ca: "❌ Неверный CA.",
    secret_format: "❌ Формат: <code>wallet_id env:SECRET_NAME</code>",
    wallet_not_found: "❌ Кошелек не найден",
    secret_saved: "✅ Секрет сохранен",
    pending_applied: "✅ Pending config применен",
    pending_not_ready: "⏳ Pending config пока нельзя применить",
    pending_budget_saved: "✅ Pending budget сохранен",
    budget_invalid: "❌ Неверный бюджет",
    scan_hint: "Используйте Scan CA или Scan Market.",
    unknown: "Используйте меню ниже."
  },
  en: {
    ready: "🤖 <b>Bot ready</b>\nUse the menu below.",
    run_started: "✅ Run started",
    soft_stop: "🛑 Soft stop enabled. No new entries; open positions will be managed until exit.",
    hard_kill: "☠️ Hard kill executed.",
    send_ca: "🧾 Send token CA.",
    send_team_ca: "🕵️ V10 ACTIVE. Send token CA for Team / Insider / Sniper Intel.",
    choose_lang: "🌐 Choose language: lang ru / lang en",
    lang_set: "Language set",
    add_leader_prompt: "Send leader address.",
    add_secret_prompt: "Send: <code>wallet_id env:SECRET_NAME</code>",
    leader_added: "Leader added",
    leaders_synced: "Leaders synced",
    invalid_ca: "❌ Invalid CA.",
    secret_format: "❌ Format: <code>wallet_id env:SECRET_NAME</code>",
    wallet_not_found: "❌ Wallet not found",
    secret_saved: "✅ Secret saved",
    pending_applied: "✅ Pending config applied",
    pending_not_ready: "⏳ Pending config not ready",
    pending_budget_saved: "✅ Pending budget saved",
    budget_invalid: "❌ Invalid budget",
    scan_hint: "Use Scan CA or Scan Market.",
    unknown: "Use the menu below."
  }
};

export function makeTranslator(getLang) {
  return (key) => {
    const lang = typeof getLang === 'function' ? getLang() : 'ru';
    return UI[lang]?.[key] || UI.ru[key] || key;
  };
}

export function buildKeyboard(t) {
  const b = (text) => ({ text });
  return {
    keyboard: [
      [b('🚀 Run Multi'), b('⚡ Run Scalp')],
      [b('↩️ Run Reversal'), b('🏃 Run Runner')],
      [b('📋 Run Copytrade'), b('🌊 Run Migration')],
      [b('🛑 Stop'), b('☠️ Kill')],
      [b('📊 Status'), b('📑 Pending Intents')],
      [b('🔎 Scan CA'), b('🔍 Scan Market')],
      [b('💰 Balance'), b('👛 Wallets')],
      [b('🕵️ Team Scan V9'), b('🎯 Snipers')],
      [b('📋 Copytrade'), b('🧮 Budget')],
      [b('🛰️ GMGN Status'), b('⚙️ GMGN Execution')],
      [b('📦 GMGN Orders'), b('❤️ Leader Health')],
      [b('🔄 Sync Leaders'), b('🌐 Language')],
      [b('📈 Export CSV'), b('📦 Export JSON')],
      [b('➕ Add Balance'), b('➖ Withdraw Balance')]
    ],
    resize_keyboard: true,
    persistent: true
  };
}
