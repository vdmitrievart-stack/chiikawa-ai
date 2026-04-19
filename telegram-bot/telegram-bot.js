import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { getBestTrade, getLatestTokenPrice } from "./scan-engine.js";
import {
  enterTrade,
  exitTrade,
  getPortfolio,
  markToMarket,
  shouldExitPosition,
  updatePositionMarket,
  estimateRoundTripCostPct,
  resetPortfolio
} from "./portfolio.js";

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chiikawa_secret";
const PATH = `/telegram/${WEBHOOK_SECRET}`;

const AUTO_INTERVAL_MS = Number(process.env.AUTO_INTERVAL_MS || 60000);
const AUTO_HOURS_DEFAULT = Number(process.env.AUTO_HOURS_DEFAULT || 4);
const TRADE_COOLDOWN_MS = Number(process.env.TRADE_COOLDOWN_MS || 90 * 60 * 1000);

if (!TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

let intervalId = null;
let autoStopId = null;
let activeChatId = null;
const recentlyTraded = new Map();

let runState = {
  startedAt: null,
  stoppedAt: null,
  runId: null,
  notes: []
};

const userSettings = new Map();

const I18N = {
  en: {
    ready: "🤖 Bot ready.",
    commands: "Commands",
    run4h: "▶️ Run 4h",
    stop: "🛑 Stop",
    status: "📊 Status",
    scan: "🔎 Scan",
    exportCsv: "📈 Export CSV",
    exportJson: "📦 Export JSON",
    language: "🌍 Language",
    started: "🚀 Starting 4h simulation from 1 SOL",
    stopped: "🛑 Bot stopped",
    alreadyStopped: "ℹ️ Bot already stopped",
    autoStopped: "🛑 AUTO STOPPED (4h finished)",
    noCandidates: "❌ No candidates found",
    skipScore: "❌ Skip (score below threshold)",
    couldNotOpen: "⏳ Could not open position",
    openActive: "⏳ Open position still active",
    autoMode: "Auto mode",
    balance: "Balance",
    position: "Position",
    tradesClosed: "Trades closed",
    cooldownList: "Recently traded cooldown list",
    none: "none",
    analysis: "ANALYSIS",
    strategy: "Strategy",
    reasons: "Reasons",
    accumulation: "Accumulation",
    distribution: "Distribution",
    absorption: "Absorption",
    exceptional: "Exceptional Override",
    expectedEdge: "Expected edge",
    costs: "Round-trip costs",
    holdTarget: "Hold target",
    setup: "Setup",
    positionUpdate: "POSITION UPDATE",
    entry: "ENTRY",
    exit: "EXIT",
    signalScore: "Signal score",
    entryRef: "Entry ref",
    entryEffective: "Entry effective",
    exitRef: "Exit ref",
    size: "Size",
    entryCosts: "Entry costs",
    exitCosts: "Exit costs",
    netPnl: "Net PnL",
    grossPnl: "Gross PnL",
    age: "Age",
    statusWord: "Status",
    reasonWord: "Reason",
    highWater: "High watermark",
    lowWater: "Low watermark",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "s",
    falseBounce: "❌ Skip (false bounce)",
    edgeSkip: "❌ Skip (expected edge does not beat costs + margin)",
    statusTitle: "STATUS",
    chooseLanguage: "Choose language",
    languageSet: "Language set",
    exportDone: "Stats exported",
    copyHint: "Tap the code block to copy",
    token: "Token",
    ca: "CA",
    score: "Score",
    price: "Price",
    liquidity: "Liquidity",
    volume24h: "Volume 24h",
    txns24h: "Txns 24h",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "Concentration",
    botActivity: "Bot Activity",
    sentiment: "Sentiment",
    delta: "Delta",
    priceDelta: "Price Δ",
    volumeDelta: "Volume Δ",
    txnsDelta: "Txns Δ",
    liquidityDelta: "Liquidity Δ",
    buyPressureDelta: "Buy Pressure Δ",
    current: "Current",
    grossPnlWord: "Gross PnL",
    netPnlWord: "Net PnL",
    runId: "Run ID",
    localeLabel: "Language"
  },
  ru: {
    ready: "🤖 Бот готов.",
    commands: "Команды",
    run4h: "▶️ Запуск 4ч",
    stop: "🛑 Стоп",
    status: "📊 Статус",
    scan: "🔎 Скан",
    exportCsv: "📈 Экспорт CSV",
    exportJson: "📦 Экспорт JSON",
    language: "🌍 Язык",
    started: "🚀 Запускаю 4-часовую симуляцию с 1 SOL",
    stopped: "🛑 Бот остановлен",
    alreadyStopped: "ℹ️ Бот уже остановлен",
    autoStopped: "🛑 АВТО ОСТАНОВЛЕН (4ч завершены)",
    noCandidates: "❌ Кандидаты не найдены",
    skipScore: "❌ Пропуск (оценка ниже порога)",
    couldNotOpen: "⏳ Не удалось открыть позицию",
    openActive: "⏳ Позиция все еще активна",
    autoMode: "Авто режим",
    balance: "Баланс",
    position: "Позиция",
    tradesClosed: "Закрытых сделок",
    cooldownList: "Список кулдауна",
    none: "нет",
    analysis: "АНАЛИЗ",
    strategy: "Стратегия",
    reasons: "Причины",
    accumulation: "Накопление",
    distribution: "Распределение",
    absorption: "Поглощение",
    exceptional: "Особый override",
    expectedEdge: "Ожидаемое преимущество",
    costs: "Полные издержки",
    holdTarget: "Цель удержания",
    setup: "Сетап",
    positionUpdate: "ОБНОВЛЕНИЕ ПОЗИЦИИ",
    entry: "ВХОД",
    exit: "ВЫХОД",
    signalScore: "Оценка сигнала",
    entryRef: "Базовый вход",
    entryEffective: "Фактический вход",
    exitRef: "Базовый выход",
    size: "Размер",
    entryCosts: "Издержки входа",
    exitCosts: "Издержки выхода",
    netPnl: "Чистый PnL",
    grossPnl: "Грубый PnL",
    age: "Возраст",
    statusWord: "Статус",
    reasonWord: "Причина",
    highWater: "Верхняя отметка",
    lowWater: "Нижняя отметка",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "с",
    falseBounce: "❌ Пропуск (ложный отскок)",
    edgeSkip: "❌ Пропуск (преимущество не бьёт издержки + запас)",
    statusTitle: "СТАТУС",
    chooseLanguage: "Выбери язык",
    languageSet: "Язык установлен",
    exportDone: "Статистика выгружена",
    copyHint: "Нажми на блок кода, чтобы скопировать",
    token: "Токен",
    ca: "CA",
    score: "Оценка",
    price: "Цена",
    liquidity: "Ликвидность",
    volume24h: "Объем 24ч",
    txns24h: "Транзакции 24ч",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "Концентрация",
    botActivity: "Активность ботов",
    sentiment: "Сентимент",
    delta: "Дельта",
    priceDelta: "Цена Δ",
    volumeDelta: "Объем Δ",
    txnsDelta: "Транзакции Δ",
    liquidityDelta: "Ликвидность Δ",
    buyPressureDelta: "Давление покупок Δ",
    current: "Текущая",
    grossPnlWord: "Грубый PnL",
    netPnlWord: "Чистый PnL",
    runId: "ID запуска",
    localeLabel: "Язык"
  },
  es: {
    ready: "🤖 Bot listo.",
    commands: "Comandos",
    run4h: "▶️ Ejecutar 4h",
    stop: "🛑 Detener",
    status: "📊 Estado",
    scan: "🔎 Escanear",
    exportCsv: "📈 Exportar CSV",
    exportJson: "📦 Exportar JSON",
    language: "🌍 Idioma",
    started: "🚀 Iniciando simulación de 4h con 1 SOL",
    stopped: "🛑 Bot detenido",
    alreadyStopped: "ℹ️ El bot ya está detenido",
    autoStopped: "🛑 AUTO DETENIDO (4h completadas)",
    noCandidates: "❌ No se encontraron candidatos",
    skipScore: "❌ Omitido (score por debajo del umbral)",
    couldNotOpen: "⏳ No se pudo abrir la posición",
    openActive: "⏳ La posición sigue activa",
    autoMode: "Modo auto",
    balance: "Balance",
    position: "Posición",
    tradesClosed: "Operaciones cerradas",
    cooldownList: "Lista de cooldown",
    none: "ninguna",
    analysis: "ANÁLISIS",
    strategy: "Estrategia",
    reasons: "Razones",
    accumulation: "Acumulación",
    distribution: "Distribución",
    absorption: "Absorción",
    exceptional: "Override excepcional",
    expectedEdge: "Ventaja esperada",
    costs: "Costes totales",
    holdTarget: "Objetivo de permanencia",
    setup: "Setup",
    positionUpdate: "ACTUALIZACIÓN DE POSICIÓN",
    entry: "ENTRADA",
    exit: "SALIDA",
    signalScore: "Puntuación de señal",
    entryRef: "Entrada ref",
    entryEffective: "Entrada efectiva",
    exitRef: "Salida ref",
    size: "Tamaño",
    entryCosts: "Costes de entrada",
    exitCosts: "Costes de salida",
    netPnl: "PnL neto",
    grossPnl: "PnL bruto",
    age: "Edad",
    statusWord: "Estado",
    reasonWord: "Razón",
    highWater: "Máximo",
    lowWater: "Mínimo",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "s",
    falseBounce: "❌ Omitido (rebote falso)",
    edgeSkip: "❌ Omitido (la ventaja no supera costes + margen)",
    statusTitle: "ESTADO",
    chooseLanguage: "Elige idioma",
    languageSet: "Idioma configurado",
    exportDone: "Estadísticas exportadas",
    copyHint: "Toca el bloque de código para copiar",
    token: "Token",
    ca: "CA",
    score: "Score",
    price: "Precio",
    liquidity: "Liquidez",
    volume24h: "Volumen 24h",
    txns24h: "Txns 24h",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "Concentración",
    botActivity: "Actividad bot",
    sentiment: "Sentimiento",
    delta: "Delta",
    priceDelta: "Precio Δ",
    volumeDelta: "Volumen Δ",
    txnsDelta: "Txns Δ",
    liquidityDelta: "Liquidez Δ",
    buyPressureDelta: "Presión compradora Δ",
    current: "Actual",
    grossPnlWord: "PnL bruto",
    netPnlWord: "PnL neto",
    runId: "ID de ejecución",
    localeLabel: "Idioma"
  },
  de: {
    ready: "🤖 Bot bereit.",
    commands: "Befehle",
    run4h: "▶️ 4h starten",
    stop: "🛑 Stoppen",
    status: "📊 Status",
    scan: "🔎 Scan",
    exportCsv: "📈 CSV exportieren",
    exportJson: "📦 JSON exportieren",
    language: "🌍 Sprache",
    started: "🚀 Starte 4h-Simulation mit 1 SOL",
    stopped: "🛑 Bot gestoppt",
    alreadyStopped: "ℹ️ Bot ist bereits gestoppt",
    autoStopped: "🛑 AUTO GESTOPPT (4h beendet)",
    noCandidates: "❌ Keine Kandidaten gefunden",
    skipScore: "❌ Übersprungen (Score unter Schwelle)",
    couldNotOpen: "⏳ Position konnte nicht geöffnet werden",
    openActive: "⏳ Position ist noch aktiv",
    autoMode: "Auto-Modus",
    balance: "Kontostand",
    position: "Position",
    tradesClosed: "Geschlossene Trades",
    cooldownList: "Cooldown-Liste",
    none: "keine",
    analysis: "ANALYSE",
    strategy: "Strategie",
    reasons: "Gründe",
    accumulation: "Akkumulation",
    distribution: "Distribution",
    absorption: "Absorption",
    exceptional: "Sonder-Override",
    expectedEdge: "Erwarteter Vorteil",
    costs: "Gesamtkosten",
    holdTarget: "Halteziel",
    setup: "Setup",
    positionUpdate: "POSITIONS-UPDATE",
    entry: "EINSTIEG",
    exit: "AUSSTIEG",
    signalScore: "Signalscore",
    entryRef: "Referenz-Einstieg",
    entryEffective: "Effektiver Einstieg",
    exitRef: "Referenz-Ausstieg",
    size: "Größe",
    entryCosts: "Einstiegskosten",
    exitCosts: "Ausstiegskosten",
    netPnl: "Netto-PnL",
    grossPnl: "Brutto-PnL",
    age: "Alter",
    statusWord: "Status",
    reasonWord: "Grund",
    highWater: "Hochmarke",
    lowWater: "Tiefmarke",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "s",
    falseBounce: "❌ Übersprungen (falscher Bounce)",
    edgeSkip: "❌ Übersprungen (Vorteil schlägt Kosten + Puffer nicht)",
    statusTitle: "STATUS",
    chooseLanguage: "Sprache wählen",
    languageSet: "Sprache gesetzt",
    exportDone: "Statistik exportiert",
    copyHint: "Codeblock antippen zum Kopieren",
    token: "Token",
    ca: "CA",
    score: "Score",
    price: "Preis",
    liquidity: "Liquidität",
    volume24h: "Volumen 24h",
    txns24h: "Txns 24h",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "Konzentration",
    botActivity: "Bot-Aktivität",
    sentiment: "Sentiment",
    delta: "Delta",
    priceDelta: "Preis Δ",
    volumeDelta: "Volumen Δ",
    txnsDelta: "Txns Δ",
    liquidityDelta: "Liquidität Δ",
    buyPressureDelta: "Kaufdruck Δ",
    current: "Aktuell",
    grossPnlWord: "Brutto-PnL",
    netPnlWord: "Netto-PnL",
    runId: "Run-ID",
    localeLabel: "Sprache"
  },
  fr: {
    ready: "🤖 Bot prêt.",
    commands: "Commandes",
    run4h: "▶️ Lancer 4h",
    stop: "🛑 Arrêter",
    status: "📊 Statut",
    scan: "🔎 Scan",
    exportCsv: "📈 Export CSV",
    exportJson: "📦 Export JSON",
    language: "🌍 Langue",
    started: "🚀 Lancement de la simulation 4h avec 1 SOL",
    stopped: "🛑 Bot arrêté",
    alreadyStopped: "ℹ️ Le bot est déjà arrêté",
    autoStopped: "🛑 AUTO ARRÊTÉ (4h terminées)",
    noCandidates: "❌ Aucun candidat trouvé",
    skipScore: "❌ Ignoré (score sous le seuil)",
    couldNotOpen: "⏳ Impossible d’ouvrir la position",
    openActive: "⏳ Position toujours active",
    autoMode: "Mode auto",
    balance: "Solde",
    position: "Position",
    tradesClosed: "Trades fermés",
    cooldownList: "Liste de cooldown",
    none: "aucune",
    analysis: "ANALYSE",
    strategy: "Stratégie",
    reasons: "Raisons",
    accumulation: "Accumulation",
    distribution: "Distribution",
    absorption: "Absorption",
    exceptional: "Override exceptionnel",
    expectedEdge: "Avantage attendu",
    costs: "Coûts totaux",
    holdTarget: "Objectif de maintien",
    setup: "Setup",
    positionUpdate: "MISE À JOUR POSITION",
    entry: "ENTRÉE",
    exit: "SORTIE",
    signalScore: "Score du signal",
    entryRef: "Entrée ref",
    entryEffective: "Entrée effective",
    exitRef: "Sortie ref",
    size: "Taille",
    entryCosts: "Coûts d’entrée",
    exitCosts: "Coûts de sortie",
    netPnl: "PnL net",
    grossPnl: "PnL brut",
    age: "Âge",
    statusWord: "Statut",
    reasonWord: "Raison",
    highWater: "Plus haut",
    lowWater: "Plus bas",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "s",
    falseBounce: "❌ Ignoré (faux rebond)",
    edgeSkip: "❌ Ignoré (l’avantage ne couvre pas coûts + marge)",
    statusTitle: "STATUT",
    chooseLanguage: "Choisir la langue",
    languageSet: "Langue définie",
    exportDone: "Statistiques exportées",
    copyHint: "Touchez le bloc code pour copier",
    token: "Token",
    ca: "CA",
    score: "Score",
    price: "Prix",
    liquidity: "Liquidité",
    volume24h: "Volume 24h",
    txns24h: "Txns 24h",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "Concentration",
    botActivity: "Activité bot",
    sentiment: "Sentiment",
    delta: "Delta",
    priceDelta: "Prix Δ",
    volumeDelta: "Volume Δ",
    txnsDelta: "Txns Δ",
    liquidityDelta: "Liquidité Δ",
    buyPressureDelta: "Pression acheteuse Δ",
    current: "Actuel",
    grossPnlWord: "PnL brut",
    netPnlWord: "PnL net",
    runId: "ID de run",
    localeLabel: "Langue"
  },
  pt: {
    ready: "🤖 Bot pronto.",
    commands: "Comandos",
    run4h: "▶️ Rodar 4h",
    stop: "🛑 Parar",
    status: "📊 Status",
    scan: "🔎 Scan",
    exportCsv: "📈 Exportar CSV",
    exportJson: "📦 Exportar JSON",
    language: "🌍 Idioma",
    started: "🚀 Iniciando simulação de 4h com 1 SOL",
    stopped: "🛑 Bot parado",
    alreadyStopped: "ℹ️ O bot já está parado",
    autoStopped: "🛑 AUTO PARADO (4h concluídas)",
    noCandidates: "❌ Nenhum candidato encontrado",
    skipScore: "❌ Ignorado (pontuação abaixo do limite)",
    couldNotOpen: "⏳ Não foi possível abrir a posição",
    openActive: "⏳ Posição ainda ativa",
    autoMode: "Modo auto",
    balance: "Saldo",
    position: "Posição",
    tradesClosed: "Trades fechados",
    cooldownList: "Lista de cooldown",
    none: "nenhuma",
    analysis: "ANÁLISE",
    strategy: "Estratégia",
    reasons: "Razões",
    accumulation: "Acumulação",
    distribution: "Distribuição",
    absorption: "Absorção",
    exceptional: "Override excepcional",
    expectedEdge: "Vantagem esperada",
    costs: "Custos totais",
    holdTarget: "Meta de tempo",
    setup: "Setup",
    positionUpdate: "ATUALIZAÇÃO DA POSIÇÃO",
    entry: "ENTRADA",
    exit: "SAÍDA",
    signalScore: "Pontuação do sinal",
    entryRef: "Entrada ref",
    entryEffective: "Entrada efetiva",
    exitRef: "Saída ref",
    size: "Tamanho",
    entryCosts: "Custos de entrada",
    exitCosts: "Custos de saída",
    netPnl: "PnL líquido",
    grossPnl: "PnL bruto",
    age: "Idade",
    statusWord: "Status",
    reasonWord: "Motivo",
    highWater: "Máxima",
    lowWater: "Mínima",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "s",
    falseBounce: "❌ Ignorado (falso repique)",
    edgeSkip: "❌ Ignorado (vantagem não cobre custos + margem)",
    statusTitle: "STATUS",
    chooseLanguage: "Escolha o idioma",
    languageSet: "Idioma definido",
    exportDone: "Estatísticas exportadas",
    copyHint: "Toque no bloco de código para copiar",
    token: "Token",
    ca: "CA",
    score: "Pontuação",
    price: "Preço",
    liquidity: "Liquidez",
    volume24h: "Volume 24h",
    txns24h: "Txns 24h",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "Concentração",
    botActivity: "Atividade bot",
    sentiment: "Sentimento",
    delta: "Delta",
    priceDelta: "Preço Δ",
    volumeDelta: "Volume Δ",
    txnsDelta: "Txns Δ",
    liquidityDelta: "Liquidez Δ",
    buyPressureDelta: "Pressão compradora Δ",
    current: "Atual",
    grossPnlWord: "PnL bruto",
    netPnlWord: "PnL líquido",
    runId: "ID da execução",
    localeLabel: "Idioma"
  },
  tr: {
    ready: "🤖 Bot hazır.",
    commands: "Komutlar",
    run4h: "▶️ 4s Çalıştır",
    stop: "🛑 Durdur",
    status: "📊 Durum",
    scan: "🔎 Tara",
    exportCsv: "📈 CSV Dışa Aktar",
    exportJson: "📦 JSON Dışa Aktar",
    language: "🌍 Dil",
    started: "🚀 1 SOL ile 4 saatlik simülasyon başlatılıyor",
    stopped: "🛑 Bot durduruldu",
    alreadyStopped: "ℹ️ Bot zaten durdu",
    autoStopped: "🛑 OTOMATİK DURDU (4s tamamlandı)",
    noCandidates: "❌ Aday bulunamadı",
    skipScore: "❌ Geçildi (puan eşik altında)",
    couldNotOpen: "⏳ Pozisyon açılamadı",
    openActive: "⏳ Pozisyon hâlâ aktif",
    autoMode: "Oto mod",
    balance: "Bakiye",
    position: "Pozisyon",
    tradesClosed: "Kapanan işlemler",
    cooldownList: "Cooldown listesi",
    none: "yok",
    analysis: "ANALİZ",
    strategy: "Strateji",
    reasons: "Nedenler",
    accumulation: "Birikim",
    distribution: "Dağıtım",
    absorption: "Emilim",
    exceptional: "Özel override",
    expectedEdge: "Beklenen avantaj",
    costs: "Toplam maliyet",
    holdTarget: "Bekletme hedefi",
    setup: "Kurulum",
    positionUpdate: "POZİSYON GÜNCELLEMESİ",
    entry: "GİRİŞ",
    exit: "ÇIKIŞ",
    signalScore: "Sinyal puanı",
    entryRef: "Giriş ref",
    entryEffective: "Efektif giriş",
    exitRef: "Çıkış ref",
    size: "Boyut",
    entryCosts: "Giriş maliyetleri",
    exitCosts: "Çıkış maliyetleri",
    netPnl: "Net PnL",
    grossPnl: "Brüt PnL",
    age: "Süre",
    statusWord: "Durum",
    reasonWord: "Neden",
    highWater: "En yüksek",
    lowWater: "En düşük",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "sn",
    falseBounce: "❌ Geçildi (sahte sıçrama)",
    edgeSkip: "❌ Geçildi (avantaj maliyet + marjı aşmıyor)",
    statusTitle: "DURUM",
    chooseLanguage: "Dil seç",
    languageSet: "Dil ayarlandı",
    exportDone: "İstatistik dışa aktarıldı",
    copyHint: "Kopyalamak için kod bloğuna dokun",
    token: "Token",
    ca: "CA",
    score: "Puan",
    price: "Fiyat",
    liquidity: "Likidite",
    volume24h: "Hacim 24s",
    txns24h: "İşlem 24s",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "Yoğunlaşma",
    botActivity: "Bot aktivitesi",
    sentiment: "Duygu",
    delta: "Delta",
    priceDelta: "Fiyat Δ",
    volumeDelta: "Hacim Δ",
    txnsDelta: "İşlem Δ",
    liquidityDelta: "Likidite Δ",
    buyPressureDelta: "Alış baskısı Δ",
    current: "Güncel",
    grossPnlWord: "Brüt PnL",
    netPnlWord: "Net PnL",
    runId: "Çalıştırma ID",
    localeLabel: "Dil"
  },
  ar: {
    ready: "🤖 البوت جاهز.",
    commands: "الأوامر",
    run4h: "▶️ تشغيل 4س",
    stop: "🛑 إيقاف",
    status: "📊 الحالة",
    scan: "🔎 فحص",
    exportCsv: "📈 تصدير CSV",
    exportJson: "📦 تصدير JSON",
    language: "🌍 اللغة",
    started: "🚀 بدء محاكاة 4 ساعات برصيد 1 SOL",
    stopped: "🛑 تم إيقاف البوت",
    alreadyStopped: "ℹ️ البوت متوقف بالفعل",
    autoStopped: "🛑 تم الإيقاف التلقائي (اكتملت 4 ساعات)",
    noCandidates: "❌ لم يتم العثور على مرشحين",
    skipScore: "❌ تم التجاوز (النتيجة أقل من الحد)",
    couldNotOpen: "⏳ تعذر فتح الصفقة",
    openActive: "⏳ الصفقة ما زالت نشطة",
    autoMode: "الوضع التلقائي",
    balance: "الرصيد",
    position: "الصفقة",
    tradesClosed: "الصفقات المغلقة",
    cooldownList: "قائمة الانتظار",
    none: "لا يوجد",
    analysis: "التحليل",
    strategy: "الاستراتيجية",
    reasons: "الأسباب",
    accumulation: "تجميع",
    distribution: "تصريف",
    absorption: "امتصاص",
    exceptional: "تجاوز استثنائي",
    expectedEdge: "الميزة المتوقعة",
    costs: "إجمالي التكاليف",
    holdTarget: "مدة الاحتفاظ",
    setup: "الإعداد",
    positionUpdate: "تحديث الصفقة",
    entry: "دخول",
    exit: "خروج",
    signalScore: "درجة الإشارة",
    entryRef: "دخول مرجعي",
    entryEffective: "دخول فعلي",
    exitRef: "خروج مرجعي",
    size: "الحجم",
    entryCosts: "تكاليف الدخول",
    exitCosts: "تكاليف الخروج",
    netPnl: "صافي الربح/الخسارة",
    grossPnl: "الربح/الخسارة الإجمالي",
    age: "العمر",
    statusWord: "الحالة",
    reasonWord: "السبب",
    highWater: "أعلى مستوى",
    lowWater: "أدنى مستوى",
    stopLoss: "SL",
    takeProfit: "TP",
    hold: "ث",
    falseBounce: "❌ تم التجاوز (ارتداد زائف)",
    edgeSkip: "❌ تم التجاوز (الميزة لا تتجاوز التكاليف + الهامش)",
    statusTitle: "الحالة",
    chooseLanguage: "اختر اللغة",
    languageSet: "تم تعيين اللغة",
    exportDone: "تم تصدير الإحصائيات",
    copyHint: "اضغط على مربع الكود للنسخ",
    token: "الرمز",
    ca: "CA",
    score: "النتيجة",
    price: "السعر",
    liquidity: "السيولة",
    volume24h: "حجم 24س",
    txns24h: "معاملات 24س",
    fdv: "FDV",
    rug: "Rug",
    smartMoney: "Smart Money",
    concentration: "التركيز",
    botActivity: "نشاط البوت",
    sentiment: "المعنويات",
    delta: "دلتا",
    priceDelta: "السعر Δ",
    volumeDelta: "الحجم Δ",
    txnsDelta: "المعاملات Δ",
    liquidityDelta: "السيولة Δ",
    buyPressureDelta: "ضغط الشراء Δ",
    current: "الحالي",
    grossPnlWord: "الربح/الخسارة الإجمالي",
    netPnlWord: "صافي الربح/الخسارة",
    runId: "معرّف التشغيل",
    localeLabel: "اللغة"
  }
};

function getLang(userId) {
  return userSettings.get(userId)?.lang || "ru";
}

function setLang(userId, lang) {
  const cur = userSettings.get(userId) || {};
  userSettings.set(userId, { ...cur, lang });
}

function t(userId, key) {
  const lang = getLang(userId);
  return I18N[lang]?.[key] || I18N.ru[key] || key;
}

function languageMenu() {
  return {
    inline_keyboard: [
      [
        { text: "English", callback_data: "lang:en" },
        { text: "Русский", callback_data: "lang:ru" }
      ],
      [
        { text: "Español", callback_data: "lang:es" },
        { text: "Deutsch", callback_data: "lang:de" }
      ],
      [
        { text: "Français", callback_data: "lang:fr" },
        { text: "Português", callback_data: "lang:pt" }
      ],
      [
        { text: "Türkçe", callback_data: "lang:tr" },
        { text: "العربية", callback_data: "lang:ar" }
      ]
    ]
  };
}

function menu(userId) {
  return {
    inline_keyboard: [
      [
        { text: t(userId, "run4h"), callback_data: "run4h" },
        { text: t(userId, "stop"), callback_data: "stop" }
      ],
      [
        { text: t(userId, "status"), callback_data: "status" },
        { text: t(userId, "scan"), callback_data: "scan" }
      ],
      [
        { text: t(userId, "exportCsv"), callback_data: "exportcsv" },
        { text: t(userId, "exportJson"), callback_data: "exportstats" }
      ],
      [
        { text: t(userId, "language"), callback_data: "langmenu" }
      ]
    ]
  };
}

function pruneRecentlyTraded() {
  const now = Date.now();
  for (const [ca, ts] of recentlyTraded.entries()) {
    if (now - ts > TRADE_COOLDOWN_MS) {
      recentlyTraded.delete(ca);
    }
  }
}

function stopAutoInternal() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (autoStopId) {
    clearTimeout(autoStopId);
    autoStopId = null;
  }
  runState.stoppedAt = Date.now();
}

function buildRunStats() {
  const pf = getPortfolio();
  const history = pf.tradeHistory || [];
  const wins = history.filter(t => t.netPnlPct > 0);
  const losses = history.filter(t => t.netPnlPct <= 0);
  const avgPnl = history.length
    ? history.reduce((a, t) => a + t.netPnlPct, 0) / history.length
    : 0;

  return {
    runId: runState.runId,
    startedAt: runState.startedAt,
    stoppedAt: runState.stoppedAt,
    balance: pf.balance,
    openPosition: pf.position,
    totalTrades: history.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: history.length ? (wins.length / history.length) * 100 : 0,
    avgNetPnlPct: avgPnl,
    tradeHistory: history,
    notes: runState.notes
  };
}

function statsToCsv(stats) {
  const header = [
    "runId",
    "openedAt",
    "closedAt",
    "token",
    "ca",
    "entryReferencePrice",
    "entryEffectivePrice",
    "exitReferencePrice",
    "amountSol",
    "entryCostsSol",
    "exitCostsSol",
    "netPnlPct",
    "netPnlSol",
    "reason",
    "signalScore",
    "expectedEdgePct",
    "setup",
    "balanceAfter"
  ];

  const rows = stats.tradeHistory.map(t => [
    stats.runId,
    t.openedAt,
    t.closedAt,
    escapeCsv(t.token),
    t.ca,
    t.entryReferencePrice,
    t.entryEffectivePrice,
    t.exitReferencePrice,
    t.amountSol,
    t.entryCosts?.totalSol ?? "",
    t.exitCosts?.totalSol ?? "",
    t.netPnlPct,
    t.netPnlSol,
    escapeCsv(t.reason),
    t.signalScore,
    t.expectedEdgePct,
    escapeCsv(t.signalContext?.setup || t.signalContext?.reason || ""),
    t.balance
  ]);

  return [header.join(","), ...rows.map(r => r.join(","))].join("\n");
}

function escapeCsv(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function exportJson(chatId) {
  const stats = buildRunStats();
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${stats.runId || Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(stats, null, 2), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "application/json"
  });
}

async function exportCsv(chatId) {
  const stats = buildRunStats();
  const filePath = path.join(os.tmpdir(), `chiikawa-stats-${stats.runId || Date.now()}.csv`);
  await fs.writeFile(filePath, statsToCsv(stats), "utf8");
  await bot.sendDocument(chatId, filePath, {}, {
    filename: path.basename(filePath),
    contentType: "text/csv"
  });
}

async function sendSignalMessage(chatId, text, imageUrl = null, replyMarkup = null) {
  if (imageUrl) {
    try {
      await bot.sendPhoto(chatId, imageUrl, {
        caption: text.slice(0, 1024),
        parse_mode: "HTML",
        reply_markup: replyMarkup || undefined
      });
      return;
    } catch (error) {
      console.log("sendPhoto fallback:", error.message);
    }
  }

  await send(chatId, text, replyMarkup ? { reply_markup: replyMarkup } : {});
}

function formatAnalysis(best, userId) {
  return `🔎 <b>${t(userId, "analysis")}</b>

<b>${t(userId, "token")}:</b> ${best.token.name}
<b>${t(userId, "ca")}:</b> <code>${best.token.ca}</code>
<b>${t(userId, "copyHint")}:</b> <code>${best.token.ca}</code>
<b>${t(userId, "score")}:</b> ${best.score}

<b>${t(userId, "price")}:</b> ${best.token.price}
<b>${t(userId, "liquidity")}:</b> ${best.token.liquidity}
<b>${t(userId, "volume24h")}:</b> ${best.token.volume}
<b>${t(userId, "txns24h")}:</b> ${best.token.txns}
<b>${t(userId, "fdv")}:</b> ${best.token.fdv}

⚠️ <b>${t(userId, "rug")}:</b> ${best.rug.risk}
🧠 <b>${t(userId, "smartMoney")}:</b> ${best.wallet.smartMoney}
👥 <b>${t(userId, "concentration")}:</b> ${best.wallet.concentration.toFixed(2)}
🤖 <b>${t(userId, "botActivity")}:</b> ${best.bots.botActivity}
🐦 <b>${t(userId, "sentiment")}:</b> ${best.sentiment.sentiment}

📈 <b>${t(userId, "delta")}</b>
<b>${t(userId, "priceDelta")}:</b> ${best.delta.priceDeltaPct.toFixed(2)}%
<b>${t(userId, "volumeDelta")}:</b> ${best.delta.volumeDeltaPct.toFixed(2)}%
<b>${t(userId, "txnsDelta")}:</b> ${best.delta.txnsDeltaPct.toFixed(2)}%
<b>${t(userId, "liquidityDelta")}:</b> ${best.delta.liquidityDeltaPct.toFixed(2)}%
<b>${t(userId, "buyPressureDelta")}:</b> ${best.delta.buyPressureDelta.toFixed(3)}

🧲 <b>${t(userId, "accumulation")}:</b> ${best.accumulation.score}
📤 <b>${t(userId, "distribution")}:</b> ${best.distribution.score}
🧱 <b>${t(userId, "absorption")}:</b> ${best.absorption.score}
🚨 <b>${t(userId, "exceptional")}:</b> ${best.exceptionalOverride.active ? "ON" : "OFF"}

🎯 <b>${t(userId, "strategy")}</b>
<b>${t(userId, "expectedEdge")}:</b> ${best.strategy.expectedEdgePct}%
<b>${t(userId, "costs")}:</b> ${estimateRoundTripCostPct()}%
<b>${t(userId, "holdTarget")}:</b> ${(best.strategy.intendedHoldMs / 1000).toFixed(0)}${t(userId, "hold")}
<b>${t(userId, "takeProfit")}:</b> ${best.strategy.takeProfitPct}%
<b>${t(userId, "stopLoss")}:</b> ${best.strategy.stopLossPct}%
<b>${t(userId, "setup")}:</b> ${best.strategy.reason}

<b>${t(userId, "reasons")}:</b>
${best.reasons.map(r => `• ${r}`).join("\n")}`;
}

async function runCycle(chatId, userId) {
  try {
    pruneRecentlyTraded();

    const pf = getPortfolio();

    if (pf.position) {
      const latest = await getLatestTokenPrice(pf.position.ca);
      if (!latest?.price) {
        await send(chatId, `⏳ ${t(userId, "openActive")}: ${pf.position.token}`);
        return;
      }

      updatePositionMarket(latest.price);
      const mtm = markToMarket(latest.price);
      const exitCheck = shouldExitPosition(latest.price);

      await send(
        chatId,
        `📈 <b>${t(userId, "positionUpdate")}</b>

<b>${t(userId, "token")}:</b> ${pf.position.token}
<b>${t(userId, "ca")}:</b> <code>${pf.position.ca}</code>
<b>${t(userId, "copyHint")}:</b> <code>${pf.position.ca}</code>
<b>${t(userId, "entryRef")}:</b> ${pf.position.entryReferencePrice}
<b>${t(userId, "current")}:</b> ${latest.price}
<b>${t(userId, "grossPnlWord")}:</b> ${mtm.grossPnlPct.toFixed(2)}%
<b>${t(userId, "netPnlWord")}:</b> ${mtm.netPnlPct.toFixed(2)}%
<b>${t(userId, "age")}:</b> ${(mtm.ageMs / 1000).toFixed(0)}${t(userId, "hold")}
<b>${t(userId, "highWater")}:</b> ${pf.position.highWaterMarkPrice}
<b>${t(userId, "lowWater")}:</b> ${pf.position.lowWaterMarkPrice}
<b>${t(userId, "statusWord")}:</b> ${exitCheck.reason}`
      );

      if (exitCheck.shouldExit) {
        const closed = exitTrade(latest.price, exitCheck.reason);
        if (closed) {
          recentlyTraded.set(closed.ca, Date.now());

          const exitText = `🏁 <b>${t(userId, "exit")}</b>

<b>${t(userId, "token")}:</b> ${closed.token}
<b>${t(userId, "ca")}:</b> <code>${closed.ca}</code>
<b>${t(userId, "copyHint")}:</b> <code>${closed.ca}</code>
<b>${t(userId, "entryRef")}:</b> ${closed.entryReferencePrice}
<b>${t(userId, "entryEffective")}:</b> ${closed.entryEffectivePrice}
<b>${t(userId, "exitRef")}:</b> ${closed.exitReferencePrice}

<b>${t(userId, "entryCosts")}:</b> ${closed.entryCosts.totalSol.toFixed(6)} SOL
<b>${t(userId, "exitCosts")}:</b> ${closed.exitCosts.totalSol.toFixed(6)} SOL

<b>${t(userId, "netPnl")}:</b> ${closed.netPnlPct.toFixed(2)}%
<b>${t(userId, "balance")}:</b> ${closed.balance.toFixed(4)} SOL
<b>${t(userId, "reasonWord")}:</b> ${closed.reason}`;

          await sendSignalMessage(chatId, exitText, pf.position.signalContext?.imageUrl || null);
        }
      }

      return;
    }

    const excludeCas = [...recentlyTraded.keys()];
    const best = await getBestTrade({ excludeCas });

    if (!best) {
      await send(chatId, t(userId, "noCandidates"));
      return;
    }

    await sendSignalMessage(chatId, formatAnalysis(best, userId), best.token.imageUrl || null);

    if (best.score < 85) {
      await send(chatId, t(userId, "skipScore"));
      return;
    }

    if (best.falseBounce.rejected) {
      await send(chatId, `${t(userId, "falseBounce")}: ${best.falseBounce.reasons.join(", ")}`);
      return;
    }

    const minRequiredEdge = estimateRoundTripCostPct() + 1.2;
    if (best.strategy.expectedEdgePct < minRequiredEdge) {
      await send(
        chatId,
        `${t(userId, "edgeSkip")} (${best.strategy.expectedEdgePct}% < ${minRequiredEdge}%)`
      );
      return;
    }

    const entry = enterTrade({
      token: best.token,
      intendedHoldMs: best.strategy.intendedHoldMs,
      expectedEdgePct: best.strategy.expectedEdgePct,
      stopLossPct: best.strategy.stopLossPct,
      takeProfitPct: best.strategy.takeProfitPct,
      reason: best.strategy.reason,
      signalScore: best.score,
      signalContext: {
        delta: best.delta,
        accumulation: best.accumulation,
        distribution: best.distribution,
        absorption: best.absorption,
        exceptionalOverride: best.exceptionalOverride,
        reasons: best.reasons,
        setup: best.strategy.reason,
        imageUrl: best.token.imageUrl || null
      }
    });

    if (!entry) {
      await send(chatId, t(userId, "couldNotOpen"));
      return;
    }

    const afterEntry = getPortfolio();

    const entryText = `🚀 <b>${t(userId, "entry")}</b>

<b>${t(userId, "token")}:</b> ${entry.token}
<b>${t(userId, "ca")}:</b> <code>${entry.ca}</code>
<b>${t(userId, "copyHint")}:</b> <code>${entry.ca}</code>
<b>${t(userId, "signalScore")}:</b> ${entry.signalScore}
<b>${t(userId, "setup")}:</b> ${entry.reason}

<b>${t(userId, "entryRef")}:</b> ${entry.entryReferencePrice}
<b>${t(userId, "entryEffective")}:</b> ${entry.entryEffectivePrice}
<b>${t(userId, "size")}:</b> ${entry.amountSol.toFixed(4)} SOL
<b>${t(userId, "expectedEdge")}:</b> ${entry.expectedEdgePct}%

<b>${t(userId, "entryCosts")}:</b> ${entry.entryCosts.totalSol.toFixed(6)} SOL
<b>${t(userId, "balance")}:</b> ${afterEntry.balance.toFixed(4)} SOL`;

    await sendSignalMessage(chatId, entryText, best.token.imageUrl || null);
  } catch (error) {
    console.log("cycle error:", error.message);
    await send(chatId, `⚠️ Cycle error: ${error.message}`);
  }
}

function startAuto(chatId, hours = AUTO_HOURS_DEFAULT) {
  stopAutoInternal();
  activeChatId = chatId;
  recentlyTraded.clear();
  resetPortfolio(1.0);

  runState = {
    startedAt: Date.now(),
    stoppedAt: null,
    runId: `run-${Date.now()}`,
    notes: [`Started ${hours}h simulation with 1 SOL`]
  };

  intervalId = setInterval(() => {
    runCycle(chatId, activeChatIdUserId ?? 0);
  }, AUTO_INTERVAL_MS);

  autoStopId = setTimeout(async () => {
    stopAutoInternal();
    if (activeChatId) {
      await send(activeChatId, t(activeChatIdUserId ?? 0, "autoStopped"));
    }
  }, hours * 60 * 60 * 1000);
}

let activeChatIdUserId = null;

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  const text = String(msg.text || "").trim();

  activeChatIdUserId = userId;

  if (text === "/start") {
    await send(
      chatId,
      `${t(userId, "ready")} ${t(userId, "commands")}: /run4h /stop /status /scan /exportcsv /exportstats /language`,
      { reply_markup: menu(userId) }
    );
    return;
  }

  if (text === "/run4h") {
    await send(chatId, t(userId, "started"), { reply_markup: menu(userId) });
    startAuto(chatId, 4);
    return;
  }

  if (text === "/stop") {
    if (intervalId) {
      stopAutoInternal();
      await send(chatId, t(userId, "stopped"), { reply_markup: menu(userId) });
    } else {
      await send(chatId, t(userId, "alreadyStopped"), { reply_markup: menu(userId) });
    }
    return;
  }

  if (text === "/status") {
    const pf = getPortfolio();
    await send(
      chatId,
      `📊 <b>${t(userId, "statusTitle")}</b>

<b>${t(userId, "balance")}:</b> ${pf.balance.toFixed(4)} SOL
<b>${t(userId, "position")}:</b> ${pf.position ? pf.position.token : t(userId, "none")}
<b>${t(userId, "autoMode")}:</b> ${intervalId ? "ON" : "OFF"}
<b>${t(userId, "tradesClosed")}:</b> ${pf.tradeHistory.length}
<b>${t(userId, "cooldownList")}:</b> ${recentlyTraded.size}
<b>${t(userId, "runId")}:</b> ${runState.runId || "-"}`,
      { reply_markup: menu(userId) }
    );
    return;
  }

  if (text === "/scan") {
    await runCycle(chatId, userId);
    return;
  }

  if (text === "/exportstats") {
    await exportJson(chatId);
    return;
  }

  if (text === "/exportcsv") {
    await exportCsv(chatId);
    return;
  }

  if (text === "/language") {
    await send(chatId, t(userId, "chooseLanguage"), {
      reply_markup: languageMenu()
    });
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from?.id || chatId;
  const data = query.data;

  activeChatIdUserId = userId;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch {}

  if (data === "run4h") {
    await send(chatId, t(userId, "started"), { reply_markup: menu(userId) });
    startAuto(chatId, 4);
    return;
  }

  if (data === "stop") {
    if (intervalId) {
      stopAutoInternal();
      await send(chatId, t(userId, "stopped"), { reply_markup: menu(userId) });
    } else {
      await send(chatId, t(userId, "alreadyStopped"), { reply_markup: menu(userId) });
    }
    return;
  }

  if (data === "status") {
    const pf = getPortfolio();
    await send(
      chatId,
      `📊 <b>${t(userId, "statusTitle")}</b>

<b>${t(userId, "balance")}:</b> ${pf.balance.toFixed(4)} SOL
<b>${t(userId, "position")}:</b> ${pf.position ? pf.position.token : t(userId, "none")}
<b>${t(userId, "autoMode")}:</b> ${intervalId ? "ON" : "OFF"}
<b>${t(userId, "tradesClosed")}:</b> ${pf.tradeHistory.length}
<b>${t(userId, "cooldownList")}:</b> ${recentlyTraded.size}
<b>${t(userId, "runId")}:</b> ${runState.runId || "-"}`,
      { reply_markup: menu(userId) }
    );
    return;
  }

  if (data === "scan") {
    await runCycle(chatId, userId);
    return;
  }

  if (data === "exportstats") {
    await exportJson(chatId);
    return;
  }

  if (data === "exportcsv") {
    await exportCsv(chatId);
    return;
  }

  if (data === "langmenu") {
    await send(chatId, t(userId, "chooseLanguage"), {
      reply_markup: languageMenu()
    });
    return;
  }

  if (data.startsWith("lang:")) {
    const lang = data.split(":")[1];
    setLang(userId, lang);
    await send(chatId, `${t(userId, "languageSet")}: ${lang.toUpperCase()}`, {
      reply_markup: menu(userId)
    });
  }
}

async function processUpdate(update) {
  try {
    if (update?.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }

    if (update?.message?.text) {
      await handleMessage(update.message);
    }
  } catch (error) {
    console.log("update error:", error.message);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === PATH) {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", async () => {
      res.writeHead(200);
      res.end("OK");

      try {
        const update = JSON.parse(body);
        await processUpdate(update);
      } catch (error) {
        console.log("webhook error:", error.message);
      }
    });

    return;
  }

  if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, async () => {
  console.log("🚀 Server started");
  await bot.setWebHook(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}${PATH}`);
  console.log("✅ Webhook set");
});
