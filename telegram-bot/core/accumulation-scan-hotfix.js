function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 2) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function fmtPct(v, d = 2) {
  return `${round(v, d)}%`;
}

function fmtNum(v, d = 2) {
  return `${round(v, d)}`;
}

function fmtFdv(v) {
  return `${round(v, 2)}`;
}

function isLikelyCA(text) {
  const value = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(value);
}

function normalize(text) {
  return String(text || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function matchesAccumulationScan(text) {
  const normalized = normalize(text);
  const compact = normalized.replace(/\s+/g, "");
  return (
    compact === "/accumscan" ||
    compact === "/accumulationscan" ||
    compact === "/cascanaccum" ||
    normalized.includes("accumulation scan") ||
    normalized.includes("scan accumulation") ||
    normalized.includes("накопление") ||
    normalized.includes("скан накоп") ||
    normalized.includes("accum scan") ||
    normalized.includes("🧺 accumulation scan")
  );
}

function matchesSignalStats(text) {
  const normalized = normalize(text);
  const compact = normalized.replace(/\s+/g, "");
  return (
    compact === "/signalstats" ||
    compact === "/statssignals" ||
    normalized.includes("signal stats") ||
    normalized.includes("статистика сигналов") ||
    normalized.includes("📊 signal stats")
  );
}

function green(text) {
  return `✅ ${text}`;
}

function yellow(text) {
  return `🟡 ${text}`;
}

function red(text) {
  return `🚩 ${text}`;
}

function getCategory(result) {
  const analyzed = result?.analyzed || {};
  const plans = Array.isArray(result?.plans) ? result.plans : [];
  const keys = plans.map((p) => p?.strategyKey).filter(Boolean);
  const holder = analyzed?.holderAccumulation || {};

  if (
    (holder?.quietAccumulationPass || holder?.warehouseStoragePass || safeNum(holder?.netControlPct) >= 65) &&
    !analyzed?.reversal?.allow
  ) {
    return "PACKAGING";
  }

  if (keys.includes("reversal") || analyzed?.reversal?.allow) return "REVERSAL";
  if (keys.includes("runner")) return "RUNNER";
  if (keys.includes("migration_survivor") || analyzed?.migration?.passes) return "MIGRATION_SURVIVOR";
  if (keys.includes("scalp") || analyzed?.scalp?.allow) return "SCALP";
  return "WATCH";
}

function deriveStructureScore(analyzed = {}) {
  const reversal = analyzed?.reversal || {};
  const holder = analyzed?.holderAccumulation || {};
  const migration = analyzed?.migration || {};
  let score = safeNum(reversal?.score, 0);
  if (score > 0) return score;

  if (holder?.quietAccumulationPass) score += 18;
  if (holder?.warehouseStoragePass) score += 18;
  if (holder?.bottomPackReversalPass) score += 16;
  if (safeNum(holder?.netControlPct) >= 70) score += 10;
  if (safeNum(holder?.retention2hPct) >= 60) score += 8;
  if (safeNum(holder?.bottomTouches) >= 3) score += 8;
  if (safeNum(holder?.reloadCount) >= 2) score += 6;
  if (safeNum(migration?.survivorScore) >= 80) score += 6;
  if (safeNum(holder?.historicalRetention6hPct) >= 10) score += 4;

  return Math.min(100, score);
}

function deriveCohortArchetype(holder = {}) {
  const warehouse = Boolean(holder?.warehouseStoragePass);
  const active = Boolean(holder?.activeReaccumulationPass);
  const netControl = safeNum(holder?.netControlPct, 0);
  const ret2h = safeNum(holder?.retention2hPct, 0);
  const fresh = safeNum(holder?.freshWalletBuyCount, 0);
  const reload = safeNum(holder?.reloadCount, 0);
  const dip = safeNum(holder?.dipBuyRatio, 0);

  if (warehouse && !active) {
    return {
      key: "warehouse_storage",
      label: "warehouse_storage",
      note: "складская упаковка: много кошельков, высокое удержание, низкая суета"
    };
  }

  if (active && !warehouse) {
    return {
      key: "active_reaccumulation",
      label: "active_reaccumulation",
      note: "живой активный добор на проливах"
    };
  }

  if (fresh >= 8 && reload >= 2 && ret2h < 45 && netControl < 55) {
    return {
      key: "speculative_dca",
      label: "speculative_dca",
      note: "скорее усредняющийся спекулянт, а не упаковщик"
    };
  }

  if (fresh >= 10 && netControl >= 60 && ret2h >= 55 && dip < 0.12) {
    return {
      key: "warehouse_storage",
      label: "warehouse_storage",
      note: "похоже на тихую упаковку даже без сильного reload"
    };
  }

  return {
    key: "mixed_watch",
    label: "mixed_watch",
    note: "есть интересные признаки, но архетип пока смешанный"
  };
}

function extractMetrics(result) {
  const analyzed = result?.analyzed || {};
  const token = analyzed?.token || {};
  const holder = analyzed?.holderAccumulation || {};
  const reversal = analyzed?.reversal || {};
  const category = getCategory(result);
  return {
    tokenName: token?.name || token?.symbol || "UNKNOWN",
    ca: token?.ca || "",
    fdv: safeNum(token?.fdv, 0),
    price: safeNum(token?.price, 0),
    category,
    freshWalletBuyCount: safeNum(holder?.freshWalletBuyCount, 0),
    retention30mPct: safeNum(holder?.retention30mPct, 0),
    retention2hPct: safeNum(holder?.retention2hPct, 0),
    retention6hPct: safeNum(holder?.historicalRetention6hPct ?? holder?.retention6hPct, 0),
    retention24hPct: safeNum(holder?.historicalRetention24hPct, 0),
    netAccumulationPct: safeNum(holder?.netAccumulationPct, 0),
    netControlPct: safeNum(holder?.netControlPct, 0),
    reloadCount: safeNum(holder?.reloadCount, 0),
    dipBuyRatio: safeNum(holder?.dipBuyRatio, 0),
    bottomTouches: safeNum(holder?.bottomTouches, 0),
    quietAccumulationPass: Boolean(holder?.quietAccumulationPass),
    bottomPackReversalPass: Boolean(holder?.bottomPackReversalPass),
    warehouseStoragePass: Boolean(holder?.warehouseStoragePass),
    activeReaccumulationPass: Boolean(holder?.activeReaccumulationPass),
    reversalAllow: Boolean(reversal?.allow),
    reversalMode: reversal?.primaryMode || "-",
    archetype: deriveCohortArchetype(holder).label,
  };
}

function buildSignalStatsReport(signalRegistry) {
  const rows = [...signalRegistry.values()];
  if (!rows.length) {
    return `📊 <b>SIGNAL STATS</b>\n\nПока нет сохраненной статистики сигналов в текущем runtime.`;
  }

  const byCategory = rows.reduce((acc, row) => {
    const key = row.category || "WATCH";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const matured = rows.filter((row) => safeNum(row.detectedFdv, 0) > 0 && safeNum(row.highestFdv, 0) > 0);
  const best = matured.sort((a, b) => (safeNum(b.highestFdv, 0) / Math.max(safeNum(b.detectedFdv, 1), 1)) - (safeNum(a.highestFdv, 0) / Math.max(safeNum(a.detectedFdv, 1), 1)))[0] || null;
  const avgPeak = matured.length
    ? matured.reduce((sum, row) => sum + (safeNum(row.highestFdv, 0) / Math.max(safeNum(row.detectedFdv, 1), 1)), 0) / matured.length
    : 0;

  const lines = [
    `📊 <b>SIGNAL STATS</b>`,
    ``,
    `<b>Total tracked:</b> ${rows.length}`,
    `<b>Packaging:</b> ${safeNum(byCategory.PACKAGING, 0)}`,
    `<b>Reversal:</b> ${safeNum(byCategory.REVERSAL, 0)}`,
    `<b>Runner:</b> ${safeNum(byCategory.RUNNER, 0)}`,
    `<b>Migration:</b> ${safeNum(byCategory.MIGRATION_SURVIVOR, 0)}`,
    `<b>Watch:</b> ${safeNum(byCategory.WATCH, 0)}`,
    `<b>Avg peak FDV multiple:</b> ${matured.length ? fmtNum(avgPeak, 2) + 'x' : '-'}`,
  ];

  if (best) {
    const mult = safeNum(best.highestFdv, 0) / Math.max(safeNum(best.detectedFdv, 1), 1);
    lines.push(``);
    lines.push(`<b>Best case</b>`);
    lines.push(`${escapeHtml(best.tokenName)} | ${escapeHtml(best.category)}`);
    lines.push(`detected FDV: ${fmtFdv(best.detectedFdv)} → peak FDV: ${fmtFdv(best.highestFdv)} (${fmtNum(mult, 2)}x)`);
    lines.push(`<code>${escapeHtml(best.ca)}</code>`);
  }

  const latest = rows
    .sort((a, b) => safeNum(b.lastSeenAt, 0) - safeNum(a.lastSeenAt, 0))
    .slice(0, 5);
  if (latest.length) {
    lines.push(``);
    lines.push(`<b>Latest tracked</b>`);
    for (const row of latest) {
      const mult = safeNum(row.highestFdv, 0) > 0 && safeNum(row.detectedFdv, 0) > 0
        ? safeNum(row.highestFdv, 0) / Math.max(safeNum(row.detectedFdv, 1), 1)
        : 0;
      lines.push(`• ${escapeHtml(row.tokenName)} | ${escapeHtml(row.category)} | detected ${fmtFdv(row.detectedFdv)} | peak ${fmtFdv(row.highestFdv)}${mult ? ` (${fmtNum(mult, 2)}x)` : ''}`);
    }
  }

  return lines.join("\n");
}

function updateSignalRegistry(signalRegistry, result) {
  const analyzed = result?.analyzed || {};
  const token = analyzed?.token || {};
  const holder = analyzed?.holderAccumulation || {};
  const ca = token?.ca || "";
  if (!ca) return;

  const category = getCategory(result);
  const now = Date.now();
  const detectedFdv = safeNum(token?.fdv, 0);
  const detectedPrice = safeNum(token?.price, 0);
  const existing = signalRegistry.get(ca) || {
    ca,
    tokenName: token?.name || token?.symbol || "UNKNOWN",
    category,
    detectedAt: now,
    detectedFdv,
    detectedPrice,
    highestFdv: detectedFdv,
    highestPrice: detectedPrice,
    highestSeenAt: now,
    lastSeenAt: now,
    quietAccumulationPass: Boolean(holder?.quietAccumulationPass),
    warehouseStoragePass: Boolean(holder?.warehouseStoragePass),
    archetype: deriveCohortArchetype(holder).label,
  };

  existing.tokenName = token?.name || token?.symbol || existing.tokenName;
  existing.category = category || existing.category;
  existing.lastSeenAt = now;
  existing.quietAccumulationPass = Boolean(holder?.quietAccumulationPass);
  existing.warehouseStoragePass = Boolean(holder?.warehouseStoragePass);
  existing.archetype = deriveCohortArchetype(holder).label;

  if (detectedFdv > safeNum(existing.highestFdv, 0)) {
    existing.highestFdv = detectedFdv;
    existing.highestSeenAt = now;
  }
  if (detectedPrice > safeNum(existing.highestPrice, 0)) {
    existing.highestPrice = detectedPrice;
  }

  signalRegistry.set(ca, existing);
}

function deriveDisplayHeader(result) {
  const category = getCategory(result);
  if (category === "PACKAGING") {
    return `📦📦📦📦📦👀📢👀📦📦📦📦📦 <b>PACKAGING DETECTED</b>`;
  }
  if (category === "REVERSAL") return `🔁 <b>REVERSAL DETECTED</b>`;
  if (category === "RUNNER") return `🏃 <b>RUNNER DETECTED</b>`;
  if (category === "MIGRATION_SURVIVOR") return `🌊 <b>MIGRATION SURVIVOR</b>`;
  return `👀 <b>WATCHLIST CANDIDATE</b>`;
}

function buildAccumulationReport(result, monitorEnabled = false) {
  const analyzed = result?.analyzed || {};
  const token = analyzed?.token || {};
  const holder = analyzed?.holderAccumulation || {};
  const reversal = analyzed?.reversal || {};
  const migration = analyzed?.migration || {};
  const plans = result?.plans || [];
  const category = getCategory(result);
  const archetype = deriveCohortArchetype(holder);
  const structureScore = deriveStructureScore(analyzed);

  const positiveHolder = [];
  if (holder?.quietAccumulationPass) positiveHolder.push(green('Тихое накопление: да'));
  else positiveHolder.push(red('Тихое накопление: нет'));
  if (holder?.warehouseStoragePass) positiveHolder.push(green('Складская упаковка: да'));
  else positiveHolder.push(yellow('Складская упаковка: нет'));
  if (holder?.activeReaccumulationPass) positiveHolder.push(green('Активный добор: да'));
  else positiveHolder.push(yellow('Активный добор: нет'));
  if (holder?.bottomPackReversalPass) positiveHolder.push(green('Нижняя упаковка: да'));
  else positiveHolder.push(red('Нижняя упаковка: нет'));

  const flush = Boolean(reversal?.flushDetected);
  const base = Boolean(reversal?.baseForming);
  const exhaust = Boolean(reversal?.sellerExhaustion);
  const reclaim = Boolean(reversal?.reclaimPressure);

  const lines = [
    deriveDisplayHeader(result),
    `🧺 <b>ACCUMULATION SCAN — <b>${escapeHtml(category)}</b></b>`,
    "",
    `<b>Token:</b> <b>${escapeHtml(token.name || token.symbol || 'UNKNOWN')}</b>`,
    `<b>CA:</b> <code>${escapeHtml(token.ca || '')}</code>`,
    `<b>Chain:</b> ${escapeHtml(token.chainId || '-')}`,
    `<b>Price:</b> ${safeNum(token.price, 0)}`,
    `<b>Liquidity:</b> ${safeNum(token.liquidity, 0)}`,
    `<b>Volume 1h:</b> ${safeNum(token.volumeH1 ?? token.volume, 0)}`,
    `<b>Volume 24h:</b> ${safeNum(token.volumeH24 ?? token.volume, 0)}`,
    `<b>Txns 1h:</b> ${safeNum(token.txnsH1 ?? token.txns, 0)}`,
    `<b>Txns 24h:</b> ${safeNum(token.txnsH24 ?? token.txns, 0)}`,
    `<b>FDV:</b> ${safeNum(token.fdv, 0)}`,
    "",
    `<b>Holder accumulation</b>`,
    `${safeNum(holder.trackedWallets, 0) > 0 ? green('Отслеженные кошельки: ') : red('Отслеженные кошельки: ')}${safeNum(holder.trackedWallets, 0)}`,
    `${safeNum(holder.freshWalletBuyCount, 0) >= 10 ? green('Новая когорта кошельков: ') : yellow('Новая когорта кошельков: ')}${safeNum(holder.freshWalletBuyCount, 0)}`,
    `${safeNum(holder.retention30mPct, 0) >= 50 ? green('Удержание 30м / 2ч: ') : yellow('Удержание 30м / 2ч: ')}${fmtPct(holder.retention30mPct)} / ${fmtPct(holder.retention2hPct)}`,
    `${safeNum(holder.historicalRetention6hPct ?? holder.retention6hPct, 0) > 0 ? green('Историческое удержание 6ч / 24ч: ') : yellow('Историческое удержание 6ч / 24ч: ')}${fmtPct(holder.historicalRetention6hPct ?? holder.retention6hPct)} / ${fmtPct(holder.historicalRetention24hPct)}`,
    `${safeNum(holder.netAccumulationPct, 0) > 0 ? green('Процент чистого накопления: ') : yellow('Процент чистого накопления: ')}${fmtPct(holder.netAccumulationPct)}`,
    `${safeNum(holder.netControlPct, 0) >= 65 ? green('Процент чистого контроля: ') : yellow('Процент чистого контроля: ')}${fmtPct(holder.netControlPct)}`,
    `${safeNum(holder.reloadCount, 0) >= 2 ? green('Количество перезагрузок: ') : yellow('Количество перезагрузок: ')}${safeNum(holder.reloadCount, 0)}`,
    `${safeNum(holder.dipBuyRatio, 0) >= 0.12 ? green('Соотношение покупки на спаде: ') : yellow('Соотношение покупки на спаде: ')}${fmtNum(holder.dipBuyRatio, 2)}`,
    `${safeNum(holder.bottomTouches, 0) >= 3 ? green('Количество минимумов: ') : yellow('Количество минимумов: ')}${safeNum(holder.bottomTouches, 0)}`,
    ...positiveHolder,
    `${archetype.key === 'warehouse_storage' ? green('Архетип когорты: ') : yellow('Архетип когорты: ')}${escapeHtml(archetype.label)}`,
    `${yellow('Комментарий: ')}${escapeHtml(archetype.note)}`,
    "",
    `<b>Структура разворота</b>`,
    `${reversal?.allow ? green('Разрешено: да') : red('Разрешено: нет')}`,
    `${structureScore > 0 ? yellow('Оценка: ') : red('Оценка: ')}${safeNum(structureScore, 0)}`,
    `${yellow('Режим: ')}${escapeHtml(reversal?.primaryMode || '-')}`,
    `${flush ? green('Сброс') : red('Сброс')} / ${base ? green('база') : red('база')} / ${exhaust ? green('исчерпание') : red('исчерпание')} / ${reclaim ? green('reclaim') : red('reclaim')}`,
    "",
    `<b>Миграция</b>`,
    `${safeNum(migration?.pairAgeMin, 0) > 0 ? yellow('Возраст пары мин: ') : red('Возраст пары мин: ')}${fmtNum(migration?.pairAgeMin, 1)}`,
    `${safeNum(migration?.survivorScore, 0) >= 60 ? green('Оценка выживания: ') : yellow('Оценка выживания: ')}${safeNum(migration?.survivorScore, 0)}`,
    `${safeNum(migration?.liqToMcapPct, 0) > 0 ? yellow('Процент ликвидности/рыночной капитализации: ') : red('Процент ликвидности/рыночной капитализации: ')}${fmtPct(migration?.liqToMcapPct)}`,
    `${safeNum(migration?.volToLiqPct, 0) > 0 ? yellow('Процент объёма/ликвидности: ') : red('Процент объёма/ликвидности: ')}${fmtPct(migration?.volToLiqPct)}`,
    `${migration?.passes ? green('Прохождение: да') : yellow('Прохождение: нет')}`,
    "",
    `<b>Планы:</b> ${plans.length ? escapeHtml(plans.map((p) => p?.strategyKey).filter(Boolean).join(', ')) : 'нет'}`,
    `<b>URL:</b> ${escapeHtml(token.url || '-')}`,
  ];

  if (category === 'PACKAGING') {
    lines.splice(2, 0, yellow('Раннее обнаружение упаковки. Это watchlist/ранняя фаза, а не готовый reversal.'));
  }

  if (monitorEnabled) {
    lines.push('');
    lines.push(yellow('Для этого токена будет временно включен монитор важных изменений накопления.'));
  }

  return lines.join('\n');
}

function buildDeltaMessage(prev, next) {
  const deltaControl = round(next.netControlPct - prev.netControlPct, 2);
  const deltaAccum = round(next.netAccumulationPct - prev.netAccumulationPct, 2);
  const deltaRet2h = round(next.retention2hPct - prev.retention2hPct, 2);
  const deltaFresh = next.freshWalletBuyCount - prev.freshWalletBuyCount;
  const bullish = [];
  const bearish = [];

  if (!prev.quietAccumulationPass && next.quietAccumulationPass) bullish.push(green('quiet accumulation confirmed'));
  if (!prev.warehouseStoragePass && next.warehouseStoragePass) bullish.push(green('warehouse storage confirmed'));
  if (!prev.bottomPackReversalPass && next.bottomPackReversalPass) bullish.push(green('bottom-pack reversal confirmed'));
  if (!prev.reversalAllow && next.reversalAllow) bullish.push(green(`reversal now allowed (${escapeHtml(next.reversalMode)})`));
  if (deltaControl >= 2.0) bullish.push(green(`net control +${deltaControl}%`));
  if (deltaAccum >= 4.0) bullish.push(green(`net accumulation +${deltaAccum}%`));
  if (deltaRet2h >= 10.0) bullish.push(green(`retention 2h +${deltaRet2h}%`));
  if (deltaFresh >= 3) bullish.push(green(`fresh cohort +${deltaFresh}`));

  if (deltaControl <= -6.0) bearish.push(red(`net control ${deltaControl}%`));
  if (deltaAccum <= -10.0) bearish.push(red(`net accumulation ${deltaAccum}%`));
  if (deltaRet2h <= -15.0) bearish.push(red(`retention 2h ${deltaRet2h}%`));
  if (prev.quietAccumulationPass && !next.quietAccumulationPass && next.netControlPct < 60) bearish.push(red('quiet accumulation weakened'));

  if (!bullish.length && !bearish.length) return '';

  const lines = [
    `🔔 <b>ACCUMULATION WATCH UPDATE</b>`,
    `<b>Token:</b> <b>${escapeHtml(next.tokenName)}</b>`,
    `<b>CA:</b> <code>${escapeHtml(next.ca)}</code>`,
    `<b>Category:</b> <b>${escapeHtml(next.category)}</b>`,
    `<b>Net control:</b> ${fmtPct(next.netControlPct)} (${deltaControl >= 0 ? '+' : ''}${deltaControl}%)`,
    `<b>Net accumulation:</b> ${fmtPct(next.netAccumulationPct)} (${deltaAccum >= 0 ? '+' : ''}${deltaAccum}%)`,
    `<b>Retention 30m / 2h / 6h:</b> ${fmtPct(next.retention30mPct)} / ${fmtPct(next.retention2hPct)} / ${fmtPct(next.retention6hPct)}`,
    `<b>Fresh cohort:</b> ${next.freshWalletBuyCount}`,
    `<b>Warehouse / active:</b> ${next.warehouseStoragePass ? 'yes' : 'no'} / ${next.activeReaccumulationPass ? 'yes' : 'no'}`,
    `<b>Archetype:</b> ${escapeHtml(next.archetype || '-')}`,
  ];

  if (bullish.length) {
    lines.push('', '<b>🟢 Bullish changes</b>', ...bullish.map((x) => `• ${x}`));
  }
  if (bearish.length) {
    lines.push('', '<b>🔴 Bearish changes</b>', ...bearish.map((x) => `• ${x}`));
  }
  return lines.join('\n');
}

function isWatchworthy(result) {
  const holder = result?.analyzed?.holderAccumulation || {};
  return Boolean(
    holder?.quietAccumulationPass ||
    holder?.warehouseStoragePass ||
    holder?.bottomPackReversalPass ||
    safeNum(holder?.netControlPct, 0) >= 60 ||
    safeNum(holder?.retention2hPct, 0) >= 50 ||
    safeNum(holder?.freshWalletBuyCount, 0) >= 10
  );
}

async function performScanCA(kernel, ca) {
  const cs = kernel?.candidateService;
  const runtime = typeof kernel?.getRuntime === 'function' ? kernel.getRuntime() : {};

  if (cs?.scanCA && typeof kernel?.fetchTokenByCA === 'function') {
    try {
      const result = await cs.scanCA.call(cs, {
        runtime,
        fetchTokenByCA: (value) => kernel.fetchTokenByCA(value),
        ca,
      });
      if (result) return result;
    } catch (_) {}
  }

  if (typeof kernel?.fetchTokenByCA !== 'function') return null;
  const token = await kernel.fetchTokenByCA(ca);
  if (!token) return null;
  if (String(token?.chainId || '').toLowerCase() !== 'solana') return null;

  let analyzed = {
    token,
    holderAccumulation: {},
    reversal: { allow: false, score: 0, primaryMode: '-', passedModes: [] },
    migration: { passes: false, survivorScore: 0 },
    scalp: { allow: false },
    rug: { risk: 0 },
    developer: { verdict: 'Neutral' },
    corpse: { isCorpse: false },
  };

  if (cs && typeof cs.analyzeToken === 'function') {
    analyzed = await cs.analyzeToken.call(cs, token);
  }

  if (cs && typeof cs.enrichCandidateWithHolderLive === 'function') {
    try {
      const enriched = await cs.enrichCandidateWithHolderLive.call(cs, analyzed);
      if (enriched) analyzed = enriched;
    } catch (_) {}
  }

  let plans = [];
  if (cs && typeof cs.buildPlans === 'function') {
    try {
      plans = cs.buildPlans.call(cs, analyzed, runtime?.strategyScope || 'all') || [];
    } catch (_) {}
  }

  return { analyzed, plans, heroImage: token?.imageUrl || null };
}

export function applyAccumulationScanHotfix(router, kernel) {
  if (!router || !kernel || router.__accumulationScanHotfixApplied) return;
  router.__accumulationScanHotfixApplied = true;

  const WATCH_INTERVAL_MS = Number(process.env.ACCUM_WATCH_INTERVAL_MS || 10 * 60 * 1000);
  const WATCH_TTL_MS = Number(process.env.ACCUM_WATCH_TTL_MS || 8 * 60 * 60 * 1000);
  const watched = new Map();
  const signalRegistry = new Map();
  let watchLoopId = null;

  const ensureWatchLoop = () => {
    if (watchLoopId) return;
    watchLoopId = setInterval(async () => {
      const now = Date.now();
      for (const [key, item] of watched.entries()) {
        if (now > safeNum(item?.expiresAt, 0)) {
          watched.delete(key);
          continue;
        }
        if (now - safeNum(item?.lastCheckedAt, 0) < WATCH_INTERVAL_MS - 5000) continue;
        item.lastCheckedAt = now;
        try {
          const result = await performScanCA(kernel, item.ca);
          if (!result) continue;
          updateSignalRegistry(signalRegistry, result);
          const nextMetrics = extractMetrics(result);
          const text = buildDeltaMessage(item.lastMetrics, nextMetrics);
          if (text) {
            await router.sendMessage(item.chatId, text, { reply_markup: router.keyboard() });
            item.lastNotifiedAt = now;
          }
          item.lastMetrics = nextMetrics;
        } catch (error) {
          router.logger?.log?.('accum watch loop error:', error?.message || String(error));
        }
      }
      if (watched.size === 0 && watchLoopId) {
        clearInterval(watchLoopId);
        watchLoopId = null;
      }
    }, WATCH_INTERVAL_MS);
  };

  const originalKeyboard = typeof router.keyboard === 'function' ? router.keyboard.bind(router) : () => null;
  router.keyboard = function patchedKeyboard() {
    const kb = originalKeyboard();
    if (!kb || !Array.isArray(kb.keyboard)) return kb;
    const rows = kb.keyboard.map((row) => (Array.isArray(row) ? [...row] : row));

    const accumLabel = '🧺 Accumulation Scan';
    const statsLabel = '📊 Signal Stats';
    const hasAccum = rows.some((row) => Array.isArray(row) && row.includes(accumLabel));
    const hasStats = rows.some((row) => Array.isArray(row) && row.includes(statsLabel));

    if (!hasAccum || !hasStats) {
      rows.splice(6, 0, [accumLabel, statsLabel]);
    }
    return { ...kb, keyboard: rows };
  };

  const originalHandleMessage = router.handleMessage.bind(router);
  router.handleMessage = async function patchedHandleMessage(msg) {
    const chatId = msg?.chat?.id;
    const text = String(msg?.text || '').trim();
    if (!chatId || !text) return originalHandleMessage(msg);

    const mode = typeof router.getChatMode === 'function' ? router.getChatMode(chatId) : { mode: 'idle' };

    if (matchesSignalStats(text)) {
      await router.sendMessage(chatId, buildSignalStatsReport(signalRegistry), { reply_markup: router.keyboard() });
      return;
    }

    if (mode?.mode === 'awaiting_accum_ca') {
      if (!isLikelyCA(text)) {
        await router.sendMessage(
          chatId,
          `🧺 <b>Accumulation Scan</b>\nПришли Solana CA, чтобы проверить накопление, удержание и признаки складского набора.`,
          { reply_markup: router.keyboard() }
        );
        return;
      }

      if (typeof router.clearChatMode === 'function') router.clearChatMode(chatId);
      await router.sendMessage(chatId, `🧺 <b>Accumulation Scan started</b>\n<code>${escapeHtml(text)}</code>`, { reply_markup: router.keyboard() });

      try {
        const result = await performScanCA(kernel, text);
        if (!result) {
          await router.sendMessage(chatId, '❌ Не удалось получить данные по этому контракту.', { reply_markup: router.keyboard() });
          return;
        }

        updateSignalRegistry(signalRegistry, result);
        const enableMonitor = isWatchworthy(result);
        const caption = buildAccumulationReport(result, enableMonitor);
        await router.sendPhotoOrText(chatId, result?.heroImage || null, caption, { reply_markup: router.keyboard() });

        if (enableMonitor) {
          const metrics = extractMetrics(result);
          const key = `${chatId}:${text}`;
          watched.set(key, {
            chatId,
            ca: text,
            startedAt: Date.now(),
            expiresAt: Date.now() + WATCH_TTL_MS,
            lastCheckedAt: Date.now(),
            lastNotifiedAt: 0,
            lastMetrics: metrics,
          });
          ensureWatchLoop();
          await router.sendMessage(
            chatId,
            `🔔 <b>Accumulation monitor enabled</b>\n<code>${escapeHtml(text)}</code>\nБуду следить примерно 8 часов и сообщать только о значимых изменениях накопления. Небольшие снижения контроля во время упаковки я игнорирую.`,
            { reply_markup: router.keyboard() }
          );
        }
        return;
      } catch (error) {
        await router.sendMessage(
          chatId,
          `❌ <b>Accumulation Scan error</b>\n<code>${escapeHtml(error?.message || String(error))}</code>`,
          { reply_markup: router.keyboard() }
        );
        return;
      }
    }

    if (matchesAccumulationScan(text)) {
      if (typeof router.setChatMode === 'function') router.setChatMode(chatId, 'awaiting_accum_ca');
      await router.sendMessage(
        chatId,
        `🧺 <b>Accumulation Scan</b>\nПришли Solana CA, и я проверю накопление, удержание, cohort и признаки складского набора. Если увижу начальную фазу накопления, включу временный авто-монитор важных изменений.`,
        { reply_markup: router.keyboard() }
      );
      return;
    }

    return originalHandleMessage(msg);
  };
}
