
function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function isLikelyCA(text) {
  const value = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(value);
}

function matchesAccumulationScan(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return false;
  const normalized = raw.replace(/\s+/g, " ");
  const compact = normalized.replace(/\s+/g, "");

  return (
    compact === "/accumscan" ||
    compact === "/accumulationscan" ||
    compact === "/cascanaccum" ||
    normalized.includes("accumulation scan") ||
    normalized.includes("scan accumulation") ||
    normalized.includes("накопление") ||
    normalized.includes("скан накоп") ||
    normalized.includes("accum scan")
  );
}

function normalizeCategory(plans = [], analyzed = {}) {
  const keys = Array.isArray(plans) ? plans.map((p) => p?.strategyKey).filter(Boolean) : [];
  if (keys.includes("reversal")) return "REVERSAL";
  if (keys.includes("runner")) return "RUNNER";
  if (keys.includes("migration_survivor")) return "MIGRATION_SURVIVOR";
  if (keys.includes("scalp")) return "SCALP";
  if (keys.includes("copytrade")) return "COPYTRADE";

  if (analyzed?.reversal?.allow) return "REVERSAL";
  if (analyzed?.migration?.passes) return "MIGRATION_SURVIVOR";
  if (analyzed?.scalp?.allow) return "SCALP";
  return "WATCH";
}

function buildAccumulationReport(result, monitorEnabled = false) {
  const analyzed = result?.analyzed || {};
  const token = analyzed?.token || {};
  const holder = analyzed?.holderAccumulation || {};
  const reversal = analyzed?.reversal || {};
  const migration = analyzed?.migration || {};
  const plans = result?.plans || [];
  const category = normalizeCategory(plans, analyzed);

  const lines = [
    `🧺 <b>ACCUMULATION SCAN — ${escapeHtml(category)}</b>`,
    ``,
    `<b>Token:</b> <b>${escapeHtml(token.name || token.symbol || "UNKNOWN")}</b>`,
    `<b>CA:</b> <code>${escapeHtml(token.ca || "")}</code>`,
    `<b>Chain:</b> ${escapeHtml(token.chainId || "-")}`,
    `<b>Price:</b> ${safeNum(token.price, 0)}`,
    `<b>Liquidity:</b> ${safeNum(token.liquidity, 0)}`,
    `<b>Volume 1h:</b> ${safeNum(token.volumeH1 ?? token.volume, 0)}`,
    `<b>Volume 24h:</b> ${safeNum(token.volumeH24 ?? token.volume, 0)}`,
    `<b>Txns 1h:</b> ${safeNum(token.txnsH1 ?? token.txns, 0)}`,
    `<b>Txns 24h:</b> ${safeNum(token.txnsH24 ?? token.txns, 0)}`,
    `<b>FDV:</b> ${safeNum(token.fdv, 0)}`,
    ``,
    `<b>Holder accumulation</b>`,
    `tracked wallets: ${safeNum(holder.trackedWallets, 0)}`,
    `fresh wallet cohort: ${safeNum(holder.freshWalletBuyCount, 0)}`,
    `retention 30m / 2h / 6h: ${fmtPct(holder.retention30mPct)} / ${fmtPct(holder.retention2hPct)} / ${fmtPct(holder.retention6hPct)}`,
    `net accumulation pct: ${fmtPct(holder.netAccumulationPct)}`,
    `net control pct: ${fmtPct(holder.netControlPct)}`,
    `reload count: ${safeNum(holder.reloadCount, 0)}`,
    `dip-buy ratio: ${round(holder.dipBuyRatio, 2)}`,
    `bottom touches: ${safeNum(holder.bottomTouches, 0)}`,
    `warehouse storage pass: ${holder.warehouseStoragePass ? "yes" : "no"}`,
    `active reaccum pass: ${holder.activeReaccumulationPass ? "yes" : "no"}`,
    `quiet accumulation pass: ${holder.quietAccumulationPass ? "yes" : "no"}`,
    `bottom-pack reversal pass: ${holder.bottomPackReversalPass ? "yes" : "no"}`,
    `phase age h: ${round(holder.accumulationPhaseAgeHours, 1)}`,
    ``,
    `<b>Reversal structure</b>`,
    `allow: ${reversal.allow ? "yes" : "no"}`,
    `score: ${safeNum(reversal.score, 0)}`,
    `mode: ${escapeHtml(reversal.primaryMode || "-")}`,
    `passed: ${escapeHtml(Array.isArray(reversal.passedModes) ? reversal.passedModes.join(", ") : "-")}`,
    `flush/base/exhaust/reclaim: ${reversal.flushDetected ? "yes" : "no"} / ${reversal.baseForming ? "yes" : "no"} / ${reversal.sellerExhaustion ? "yes" : "no"} / ${reversal.reclaimPressure ? "yes" : "no"}`,
    ``,
    `<b>Migration</b>`,
    `pair age min: ${round(migration.pairAgeMin, 1)}`,
    `survivor score: ${safeNum(migration.survivorScore, 0)}`,
    `liq/mcap %: ${round(migration.liqToMcapPct, 1)}`,
    `vol/liq %: ${round(migration.volToLiqPct, 1)}`,
    `passes: ${migration.passes ? "yes" : "no"}`,
    ``,
    `<b>Plans:</b> ${escapeHtml(plans.map((p) => p?.strategyKey).filter(Boolean).join(", ") || "none")}`,
    `<b>URL:</b> ${escapeHtml(token.url || "-")}`
  ];

  if (monitorEnabled) {
    lines.push("", `<b>Monitor:</b> active for ~8h. I will notify only on meaningful changes. Small control dips during packaging are ignored.`);
  }

  RETURN_JOIN_MARKER
}

function extractMetrics(result) {
  const analyzed = result?.analyzed || {};
  const holder = analyzed?.holderAccumulation || {};
  const reversal = analyzed?.reversal || {};
  return {
    tokenName: analyzed?.token?.name || analyzed?.token?.symbol || '-',
    ca: analyzed?.token?.ca || '',
    netControlPct: safeNum(holder?.netControlPct, 0),
    netAccumulationPct: safeNum(holder?.netAccumulationPct, 0),
    retention30mPct: safeNum(holder?.retention30mPct, 0),
    retention2hPct: safeNum(holder?.retention2hPct, 0),
    retention6hPct: safeNum(holder?.retention6hPct, 0),
    freshWalletBuyCount: safeNum(holder?.freshWalletBuyCount, 0),
    reloadCount: safeNum(holder?.reloadCount, 0),
    bottomTouches: safeNum(holder?.bottomTouches, 0),
    quietAccumulationPass: Boolean(holder?.quietAccumulationPass),
    warehouseStoragePass: Boolean(holder?.warehouseStoragePass),
    activeReaccumulationPass: Boolean(holder?.activeReaccumulationPass),
    bottomPackReversalPass: Boolean(holder?.bottomPackReversalPass),
    reversalAllow: Boolean(reversal?.allow),
    reversalScore: safeNum(reversal?.score, 0),
    reversalMode: reversal?.primaryMode || '-',
    plansText: Array.isArray(result?.plans) ? result.plans.map((p) => p?.strategyKey).filter(Boolean).join(', ') : '',
    url: analyzed?.token?.url || '-'
  };
}

function isWatchworthy(result) {
  const m = extractMetrics(result);
  return Boolean(
    m.warehouseStoragePass ||
    m.activeReaccumulationPass ||
    m.quietAccumulationPass ||
    m.bottomPackReversalPass ||
    (m.freshWalletBuyCount >= 10 && (m.retention30mPct >= 35 || m.retention2hPct >= 20 || m.netControlPct >= 55))
  );
}

function buildDeltaMessage(prev, next) {
  const lines = [];
  const deltaControl = round(next.netControlPct - prev.netControlPct, 2);
  const deltaAccum = round(next.netAccumulationPct - prev.netAccumulationPct, 2);
  const deltaRet2h = round(next.retention2hPct - prev.retention2hPct, 2);
  const deltaFresh = next.freshWalletBuyCount - prev.freshWalletBuyCount;

  const bullish = [];
  const bearish = [];

  if (!prev.quietAccumulationPass && next.quietAccumulationPass) bullish.push('quiet accumulation confirmed');
  if (!prev.warehouseStoragePass && next.warehouseStoragePass) bullish.push('warehouse storage confirmed');
  if (!prev.bottomPackReversalPass && next.bottomPackReversalPass) bullish.push('bottom-pack reversal confirmed');
  if (!prev.reversalAllow && next.reversalAllow) bullish.push(`reversal now allowed (${escapeHtml(next.reversalMode)})`);
  if (deltaControl >= 2.0) bullish.push(`net control +${deltaControl}%`);
  if (deltaAccum >= 4.0) bullish.push(`net accumulation +${deltaAccum}%`);
  if (deltaRet2h >= 10.0) bullish.push(`retention 2h +${deltaRet2h}%`);
  if (deltaFresh >= 3) bullish.push(`fresh cohort +${deltaFresh}`);

  // do not overreact to small drops during packaging
  if (deltaControl <= -6.0) bearish.push(`net control ${deltaControl}%`);
  if (deltaAccum <= -10.0) bearish.push(`net accumulation ${deltaAccum}%`);
  if (deltaRet2h <= -15.0) bearish.push(`retention 2h ${deltaRet2h}%`);
  if (prev.quietAccumulationPass && !next.quietAccumulationPass && next.netControlPct < 60) bearish.push('quiet accumulation weakened');

  if (!bullish.length && !bearish.length) return '';

  lines.push(`🔔 <b>ACCUMULATION WATCH UPDATE</b>`);
  lines.push(`<b>Token:</b> <b>${escapeHtml(next.tokenName)}</b>`);
  lines.push(`<b>CA:</b> <code>${escapeHtml(next.ca)}</code>`);
  lines.push(`<b>Net control:</b> ${fmtPct(next.netControlPct)} (${deltaControl >= 0 ? '+' : ''}${deltaControl}%)`);
  lines.push(`<b>Net accumulation:</b> ${fmtPct(next.netAccumulationPct)} (${deltaAccum >= 0 ? '+' : ''}${deltaAccum}%)`);
  lines.push(`<b>Retention 30m / 2h / 6h:</b> ${fmtPct(next.retention30mPct)} / ${fmtPct(next.retention2hPct)} / ${fmtPct(next.retention6hPct)}`);
  lines.push(`<b>Fresh cohort:</b> ${next.freshWalletBuyCount}`);
  lines.push(`<b>Warehouse / active:</b> ${next.warehouseStoragePass ? 'yes' : 'no'} / ${next.activeReaccumulationPass ? 'yes' : 'no'}`);
  if (bullish.length) {
    lines.push('', `<b>Bullish changes</b>`);
    for (const item of bullish) lines.push(`• ${escapeHtml(item)}`);
  }
  if (bearish.length) {
    lines.push('', `<b>Caution</b>`);
    for (const item of bearish) lines.push(`• ${escapeHtml(item)}`);
    lines.push('• minor control dips during packaging are ignored; this is only a warning, not a forced sell signal');
  }
  lines.push('', `<b>Plans now:</b> ${escapeHtml(next.plansText || 'none')}`);
  lines.push(`<b>URL:</b> ${escapeHtml(next.url || '-')}`);
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
          let result = null;
          if (kernel?.candidateService?.scanCA && typeof kernel.fetchTokenByCA === 'function') {
            result = await kernel.candidateService.scanCA({
              runtime: typeof kernel.getRuntime === 'function' ? kernel.getRuntime() : {},
              fetchTokenByCA: (value) => kernel.fetchTokenByCA(value),
              ca: item.ca
            });
          }
          if (!result) continue;
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

  const originalKeyboard = typeof router.keyboard === "function"
    ? router.keyboard.bind(router)
    : () => null;

  router.keyboard = function patchedKeyboard() {
    const kb = originalKeyboard();
    if (!kb || !Array.isArray(kb.keyboard)) return kb;

    const rows = kb.keyboard.map((row) => Array.isArray(row) ? [...row] : row);
    const targetLabel = "🧺 Accumulation Scan";
    const exists = rows.some((row) => Array.isArray(row) && row.includes(targetLabel));
    if (!exists) {
      rows.splice(6, 0, [targetLabel, "🔎 Scan CA"]);
    }
    return { ...kb, keyboard: rows };
  };

  const originalHandleMessage = router.handleMessage.bind(router);

  router.handleMessage = async function patchedHandleMessage(msg) {
    const chatId = msg?.chat?.id;
    const text = String(msg?.text || "").trim();

    if (!chatId || !text) {
      return originalHandleMessage(msg);
    }

    const mode = typeof router.getChatMode === "function"
      ? router.getChatMode(chatId)
      : { mode: "idle" };

    if (mode?.mode === "awaiting_accum_ca") {
      if (!isLikelyCA(text)) {
        await router.sendMessage(
          chatId,
          "🧺 <b>Accumulation Scan</b>
Пришли Solana CA, чтобы проверить накопление, удержание и признаки складского набора.",
          { reply_markup: router.keyboard() }
        );
        return;
      }

      if (typeof router.clearChatMode === "function") {
        router.clearChatMode(chatId);
      }

      await router.sendMessage(
        chatId,
        `🧺 <b>Accumulation Scan started</b>
<code>${escapeHtml(text)}</code>`,
        { reply_markup: router.keyboard() }
      );

      try {
        let result = null;

        if (kernel?.candidateService?.scanCA && typeof kernel.fetchTokenByCA === "function") {
          result = await kernel.candidateService.scanCA({
            runtime: typeof kernel.getRuntime === "function" ? kernel.getRuntime() : {},
            fetchTokenByCA: (value) => kernel.fetchTokenByCA(value),
            ca: text
          });
        } else if (typeof kernel.scanCA === "function") {
          const send = router.createSendBridge(chatId);
          await kernel.scanCA(text, send);
          return;
        }

        if (!result) {
          await router.sendMessage(
            chatId,
            "❌ Не удалось получить данные по этому контракту.",
            { reply_markup: router.keyboard() }
          );
          return;
        }

        const enableMonitor = isWatchworthy(result);
        const caption = buildAccumulationReport(result, enableMonitor);
        await router.sendPhotoOrText(chatId, result?.heroImage || null, caption, {
          reply_markup: router.keyboard()
        });

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
            `🔔 <b>Accumulation monitor enabled</b>
<code>${escapeHtml(text)}</code>
Буду следить примерно 8 часов и сообщать только о значимых изменениях накопления. Небольшие снижения контроля во время упаковки я игнорирую.`,
            { reply_markup: router.keyboard() }
          );
        }
        return;
      } catch (error) {
        await router.sendMessage(
          chatId,
          `❌ <b>Accumulation Scan error</b>
<code>${escapeHtml(error?.message || String(error))}</code>`,
          { reply_markup: router.keyboard() }
        );
        return;
      }
    }

    if (matchesAccumulationScan(text)) {
      if (typeof router.setChatMode === "function") {
        router.setChatMode(chatId, "awaiting_accum_ca");
      }
      await router.sendMessage(
        chatId,
        "🧺 <b>Accumulation Scan</b>
Пришли Solana CA, и я проверю накопление, удержание, cohort и признаки складского набора. Если увижу начальную фазу накопления, включу временный авто-монитор важных изменений.",
        { reply_markup: router.keyboard() }
      );
      return;
    }

    return originalHandleMessage(msg);
  };
}
