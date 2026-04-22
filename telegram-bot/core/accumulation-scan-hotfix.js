
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtPct(v, digits = 2) {
  const n = safeNum(v, 0);
  return `${n.toFixed(digits)}%`;
}

function isLikelyCA(text) {
  const value = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(value);
}

function asTokenName(token = {}) {
  return token?.name || token?.symbol || "UNKNOWN";
}

function buildBasicAnalyzed(token = {}) {
  const liquidity = safeNum(token?.liquidity, 0);
  const fdv = safeNum(token?.fdv, 0);
  const volume24h = safeNum(token?.volumeH24, token?.volume, 0);
  const pairAgeMin = safeNum(token?.pairCreatedAt, 0) > 0
    ? Math.max(0, (Date.now() - safeNum(token?.pairCreatedAt, 0)) / 60000)
    : 0;

  const liqToMcapPct = fdv > 0 ? (liquidity / Math.max(fdv, 1)) * 100 : 0;
  const volToLiqPct = liquidity > 0 ? (volume24h / Math.max(liquidity, 1)) * 100 : 0;

  return {
    token,
    score: 0,
    socials: { socialCount: 0, links: { twitter: "", telegram: "", website: "" } },
    rug: { risk: 0 },
    corpse: { score: 0, isCorpse: false },
    developer: { verdict: "Neutral" },
    accumulation: { score: 0 },
    absorption: { score: 0 },
    holderAccumulation: null,
    reversal: {
      allow: false,
      score: 0,
      primaryMode: "base_reclaim_reversal",
      quietAccumulation: false,
      bottomPack: false,
      metrics: {}
    },
    migration: {
      pairAgeMin,
      survivorScore: 0,
      liqToMcapPct,
      volToLiqPct,
      passes: false
    },
    narrative: {
      verdict: "weak",
      summary: token?.description || "No narrative available."
    }
  };
}

async function performScanCA(kernel, ca) {
  const runtime = typeof kernel?.getRuntime === "function" ? kernel.getRuntime() : {};
  const cs = kernel?.candidateService || null;

  if (cs && typeof cs.scanCA === "function" && typeof kernel?.fetchTokenByCA === "function") {
    try {
      const result = await cs.scanCA.call(cs, {
        runtime,
        fetchTokenByCA: (value) => kernel.fetchTokenByCA(value),
        ca
      });
      if (result) return result;
    } catch (error) {
      kernel?.logger?.log?.("accum scan primary scanCA failed:", error?.message || String(error));
    }
  }

  if (typeof kernel?.fetchTokenByCA !== "function") {
    throw new Error("kernel.fetchTokenByCA unavailable");
  }

  const token = await kernel.fetchTokenByCA(ca);
  if (!token) return null;
  if (String(token?.chainId || "").toLowerCase() !== "solana") return null;

  let analyzed = null;

  if (cs && typeof cs.analyzeToken === "function") {
    try {
      analyzed = await cs.analyzeToken.call(cs, token);
    } catch (error) {
      kernel?.logger?.log?.("accum scan analyzeToken failed:", error?.message || String(error));
    }
  }

  if (!analyzed) {
    analyzed = buildBasicAnalyzed(token);
  }

  if (cs && typeof cs.enrichCandidateWithHolderLive === "function") {
    try {
      const enriched = await cs.enrichCandidateWithHolderLive.call(cs, analyzed);
      if (enriched) analyzed = enriched;
    } catch (error) {
      kernel?.logger?.log?.("accum scan holder enrich failed:", error?.message || String(error));
    }
  } else if (kernel?.holderAccumulationEngine?.trackCandidate) {
    try {
      analyzed.holderAccumulation = await kernel.holderAccumulationEngine.trackCandidate(analyzed);
    } catch (error) {
      kernel?.logger?.log?.("accum scan holder engine fallback failed:", error?.message || String(error));
    }
  }

  if ((!analyzed.reversal || typeof analyzed.reversal !== "object") && cs && typeof cs.buildReversalSignals === "function") {
    try {
      analyzed.reversal = cs.buildReversalSignals.call(cs, analyzed);
    } catch (error) {
      kernel?.logger?.log?.("accum scan reversal signals failed:", error?.message || String(error));
    }
  }

  if (!analyzed.migration || typeof analyzed.migration !== "object") {
    analyzed.migration = buildBasicAnalyzed(token).migration;
  }

  let plans = [];
  if (cs && typeof cs.buildPlans === "function") {
    try {
      plans = cs.buildPlans.call(cs, analyzed, runtime?.strategyScope || "all") || [];
    } catch (error) {
      kernel?.logger?.log?.("accum scan buildPlans failed:", error?.message || String(error));
    }
  }

  return {
    analyzed,
    plans,
    heroImage: token?.imageUrl || null
  };
}

function buildAccumulationReport(result = {}, monitorEligible = false) {
  const analyzed = result?.analyzed || {};
  const token = analyzed?.token || {};
  const holder = analyzed?.holderAccumulation || {};
  const reversal = analyzed?.reversal || {};
  const migration = analyzed?.migration || {};
  const plans = Array.isArray(result?.plans) ? result.plans : [];

  const archetype = holder?.archetype || (holder?.warehouseStoragePass ? "warehouse_storage" : holder?.activeReaccumulationPass ? "active_reaccumulation" : "mixed_watch");
  const planText = plans.length ? plans.map((p) => p?.strategyKey || "-").join(", ") : "нет";

  return [
    "🧺 <b>СКАН НАКОПЛЕНИЯ — СМОТРИТЕ</b>",
    "",
    `<b>Токен:</b> ${escapeHtml(asTokenName(token))}`,
    `<b>CA:</b> <code>${escapeHtml(token?.ca || "")}</code>`,
    `<b>Чейн:</b> ${escapeHtml(String(token?.chainId || "-"))}`,
    `<b>Цена:</b> ${safeNum(token?.price, 0)}`,
    `<b>Ликвидность:</b> ${safeNum(token?.liquidity, 0)}`,
    `<b>Объём за 1 час:</b> ${safeNum(token?.volumeH1, 0)}`,
    `<b>Объём за 24 часа:</b> ${safeNum(token?.volumeH24, token?.volume, 0)}`,
    `<b>Транзакции за 1 час:</b> ${safeNum(token?.txnsH1, 0)}`,
    `<b>Транзакции за 24 часа:</b> ${safeNum(token?.txnsH24, token?.txns, 0)}`,
    `<b>FDV:</b> ${safeNum(token?.fdv, 0)}`,
    "",
    "<b>Накопление держателей</b>",
    `Отслеженные кошельки: ${safeNum(holder?.trackedWalletCount, holder?.trackedWallets, 0)}`,
    `Новая когорта кошельков: ${safeNum(holder?.freshWalletBuyCount, 0)}`,
    `Удержание за 30 минут/2 часа: ${fmtPct(holder?.retention30mPct)} / ${fmtPct(holder?.retention2hPct)}`,
    `Историческое удержание за 6 часов/24 часа: ${fmtPct(holder?.retention6hPct)} / ${fmtPct(holder?.retention24hPct)}`,
    `Процент чистого накопления: ${fmtPct(holder?.netAccumulationPct)}`,
    `Процент чистого контроля: ${fmtPct(holder?.netControlPct)}`,
    `Количество перезагрузок: ${safeNum(holder?.reloadCount, 0)}`,
    `Соотношение покупки на спаде: ${safeNum(holder?.dipBuyRatio, 0).toFixed(2)}`,
    `Количество минимумов: ${safeNum(holder?.bottomTouches, 0)}`,
    `Тихое накопление: ${holder?.quietAccumulationPass ? "да" : "нет"}`,
    `Нижняя упаковка: ${holder?.bottomPackReversalPass ? "да" : "нет"}`,
    `Склад / активный добор: ${holder?.warehouseStoragePass ? "да" : "нет"} / ${holder?.activeReaccumulationPass ? "да" : "нет"}`,
    `Архетип когорты: ${escapeHtml(archetype)}`,
    "",
    "<b>Структура разворота</b>",
    `Разрешено: ${reversal?.allow ? "да" : "нет"}`,
    `Оценка: ${safeNum(reversal?.score, 0)}`,
    `Режим: ${escapeHtml(reversal?.primaryMode || "-")}`,
    "",
    "<b>Миграция</b>",
    `Минимальный возраст пары: ${safeNum(migration?.pairAgeMin, 0).toFixed(1)}`,
    `Оценка выживания: ${safeNum(migration?.survivorScore, 0)}`,
    `Процент ликвидности/рыночной капитализации: ${safeNum(migration?.liqToMcapPct, 0).toFixed(1)}`,
    `Процент объёма/ликвидности: ${safeNum(migration?.volToLiqPct, 0).toFixed(1)}`,
    `Прохождение: ${migration?.passes ? "да" : "нет"}`,
    "",
    `<b>Планы:</b> ${escapeHtml(planText)}`,
    `<b>URL:</b> ${escapeHtml(token?.url || "-")}`,
    monitorEligible ? "\n🔔 Монитор важных изменений накопления включится автоматически." : ""
  ].join("\n");
}

function extractMetrics(result = {}) {
  const analyzed = result?.analyzed || {};
  const token = analyzed?.token || {};
  const holder = analyzed?.holderAccumulation || {};
  const reversal = analyzed?.reversal || {};
  const plans = Array.isArray(result?.plans) ? result.plans : [];
  return {
    tokenName: asTokenName(token),
    ca: token?.ca || "",
    url: token?.url || "",
    retention30mPct: safeNum(holder?.retention30mPct, 0),
    retention2hPct: safeNum(holder?.retention2hPct, 0),
    retention6hPct: safeNum(holder?.retention6hPct, 0),
    netAccumulationPct: safeNum(holder?.netAccumulationPct, 0),
    netControlPct: safeNum(holder?.netControlPct, 0),
    freshWalletBuyCount: safeNum(holder?.freshWalletBuyCount, 0),
    warehouseStoragePass: Boolean(holder?.warehouseStoragePass),
    activeReaccumulationPass: Boolean(holder?.activeReaccumulationPass),
    quietAccumulationPass: Boolean(holder?.quietAccumulationPass),
    bottomPackReversalPass: Boolean(holder?.bottomPackReversalPass),
    archetype: holder?.archetype || (holder?.warehouseStoragePass ? "warehouse_storage" : holder?.activeReaccumulationPass ? "active_reaccumulation" : "mixed_watch"),
    reversalAllow: Boolean(reversal?.allow),
    reversalScore: safeNum(reversal?.score, 0),
    plansText: plans.length ? plans.map((p) => p?.strategyKey || "-").join(", ") : "нет"
  };
}

function isWatchworthy(result = {}) {
  const next = extractMetrics(result);
  return (
    next.quietAccumulationPass ||
    next.warehouseStoragePass ||
    next.netControlPct >= 45 ||
    next.retention30mPct >= 40 ||
    next.retention2hPct >= 25
  );
}

function buildDeltaMessage(prev = {}, next = {}) {
  const deltaControl = +(safeNum(next.netControlPct, 0) - safeNum(prev.netControlPct, 0)).toFixed(2);
  const deltaAccum = +(safeNum(next.netAccumulationPct, 0) - safeNum(prev.netAccumulationPct, 0)).toFixed(2);

  const bullish = [];
  const bearish = [];

  if (deltaControl >= 3) bullish.push(`контроль вырос на ${deltaControl}%`);
  if (deltaAccum >= 5) bullish.push(`накопление выросло на ${deltaAccum}%`);
  if (!prev.warehouseStoragePass && next.warehouseStoragePass) bullish.push("складская упаковка подтверждена");
  if (!prev.quietAccumulationPass && next.quietAccumulationPass) bullish.push("включилось тихое накопление");
  if (!prev.reversalAllow && next.reversalAllow) bullish.push("разворотная структура дозрела");
  if (!prev.bottomPackReversalPass && next.bottomPackReversalPass) bullish.push("включился bottom-pack reversal");

  if (deltaControl <= -8) bearish.push(`контроль заметно снизился на ${Math.abs(deltaControl)}%`);
  if (deltaAccum <= -10) bearish.push(`накопление заметно снизилось на ${Math.abs(deltaAccum)}%`);
  if (prev.warehouseStoragePass && !next.warehouseStoragePass) bearish.push("складская упаковка ослабла");
  if (prev.quietAccumulationPass && !next.quietAccumulationPass) bearish.push("тихое накопление выключилось");

  if (!bullish.length && !bearish.length) return "";

  const lines = [
    "🔔 <b>ACCUMULATION WATCH UPDATE</b>",
    `<b>Token:</b> <b>${escapeHtml(next.tokenName)}</b>`,
    `<b>CA:</b> <code>${escapeHtml(next.ca)}</code>`,
    `<b>Net control:</b> ${fmtPct(next.netControlPct)} (${deltaControl >= 0 ? "+" : ""}${deltaControl}%)`,
    `<b>Net accumulation:</b> ${fmtPct(next.netAccumulationPct)} (${deltaAccum >= 0 ? "+" : ""}${deltaAccum}%)`,
    `<b>Retention 30m / 2h / 6h:</b> ${fmtPct(next.retention30mPct)} / ${fmtPct(next.retention2hPct)} / ${fmtPct(next.retention6hPct)}`,
    `<b>Fresh cohort:</b> ${next.freshWalletBuyCount}`,
    `<b>Warehouse / active:</b> ${next.warehouseStoragePass ? "yes" : "no"} / ${next.activeReaccumulationPass ? "yes" : "no"}`,
    `<b>Archetype:</b> ${escapeHtml(next.archetype)}`
  ];

  if (bullish.length) {
    lines.push("", "<b>Bullish changes</b>");
    for (const item of bullish) lines.push(`• ${escapeHtml(item)}`);
  }
  if (bearish.length) {
    lines.push("", "<b>Caution</b>");
    for (const item of bearish) lines.push(`• ${escapeHtml(item)}`);
    lines.push("• minor control dips during packaging are ignored; this is only a warning, not a forced sell signal");
  }

  lines.push("", `<b>Plans now:</b> ${escapeHtml(next.plansText || "none")}`, `<b>URL:</b> ${escapeHtml(next.url || "-")}`);
  return lines.join("\n");
}

export function applyAccumulationScanHotfix(router, kernel) {
  if (!router || !kernel || router.__accumulationScanHotfixApplied) return;
  router.__accumulationScanHotfixApplied = true;

  const WATCH_INTERVAL_MS = Number(process.env.ACCUM_WATCH_INTERVAL_MS || 10 * 60 * 1000);
  const WATCH_TTL_MS = Number(process.env.ACCUM_WATCH_TTL_MS || 8 * 60 * 60 * 1000);
  const watched = new Map();
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
          const nextMetrics = extractMetrics(result);
          const text = buildDeltaMessage(item.lastMetrics, nextMetrics);
          if (text) {
            await router.sendMessage(item.chatId, text, { reply_markup: router.keyboard() });
            item.lastNotifiedAt = now;
          }
          item.lastMetrics = nextMetrics;
        } catch (error) {
          router.logger?.log?.("accum watch loop error:", error?.message || String(error));
        }
      }
      if (watched.size === 0 && watchLoopId) {
        clearInterval(watchLoopId);
        watchLoopId = null;
      }
    }, WATCH_INTERVAL_MS);
  };

  const originalKeyboard = typeof router.keyboard === "function"
    ? router.keyboard.bind(router)
    : () => null;

  router.keyboard = function patchedKeyboard() {
    const kb = originalKeyboard();
    if (!kb || !Array.isArray(kb.keyboard)) return kb;
    const rows = kb.keyboard.map((row) => Array.isArray(row) ? [...row] : row);
    const label = "🧺 Accumulation Scan";
    const exists = rows.some((row) => Array.isArray(row) && row.includes(label));
    if (!exists) rows.splice(6, 0, [label, "🔎 Scan CA"]);
    return { ...kb, keyboard: rows };
  };

  const originalHandleMessage = router.handleMessage.bind(router);

  router.handleMessage = async function patchedHandleMessage(msg) {
    const chatId = msg?.chat?.id;
    const text = String(msg?.text || "").trim();
    if (!chatId || !text) return originalHandleMessage(msg);

    const mode = typeof router.getChatMode === "function" ? router.getChatMode(chatId) : { mode: "idle" };

    if (mode?.mode === "awaiting_accum_ca") {
      if (!isLikelyCA(text)) {
        await router.sendMessage(
          chatId,
          `🧺 <b>Accumulation Scan</b>\nПришли Solana CA, чтобы проверить накопление, удержание и признаки складского набора.`,
          { reply_markup: router.keyboard() }
        );
        return;
      }

      if (typeof router.clearChatMode === "function") router.clearChatMode(chatId);

      await router.sendMessage(
        chatId,
        `🧺 <b>Accumulation Scan started</b>\n<code>${escapeHtml(text)}</code>`,
        { reply_markup: router.keyboard() }
      );

      try {
        let result = await performScanCA(kernel, text);
        if (!result && typeof kernel.scanCA === "function") {
          const send = router.createSendBridge(chatId);
          await kernel.scanCA(text, send);
          return;
        }
        if (!result) {
          await router.sendMessage(chatId, "❌ Не удалось получить данные по этому контракту.", { reply_markup: router.keyboard() });
          return;
        }

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
            lastMetrics: metrics
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

    if (text === "🧺 Accumulation Scan") {
      if (typeof router.setChatMode === "function") router.setChatMode(chatId, "awaiting_accum_ca");
      await router.sendMessage(
        chatId,
        `🧺 <b>Accumulation Scan</b>\nПришли Solana CA, и я проверю накопление, удержание, когорту и признаки складского набора. Если увижу начальную фазу накопления, включу временный авто-монитор важных изменений.`,
        { reply_markup: router.keyboard() }
      );
      return;
    }

    return originalHandleMessage(msg);
  };
}
