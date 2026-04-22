
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

function buildAccumulationReport(result) {
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
    `retention 30m / 2h: ${fmtPct(holder.retention30mPct)} / ${fmtPct(holder.retention2hPct)}`,
    `net accumulation pct: ${fmtPct(holder.netAccumulationPct)}`,
    `net control pct: ${fmtPct(holder.netControlPct)}`,
    `reload count: ${safeNum(holder.reloadCount, 0)}`,
    `dip-buy ratio: ${round(holder.dipBuyRatio, 2)}`,
    `bottom touches: ${safeNum(holder.bottomTouches, 0)}`,
    `quiet accumulation pass: ${holder.quietAccumulationPass ? "yes" : "no"}`,
    `bottom-pack reversal pass: ${holder.bottomPackReversalPass ? "yes" : "no"}`,
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

  return lines.join("\n");
}

export function applyAccumulationScanHotfix(router, kernel) {
  if (!router || !kernel || router.__accumulationScanHotfixApplied) return;
  router.__accumulationScanHotfixApplied = true;

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
          "🧺 <b>Accumulation Scan</b>\nПришли Solana CA, чтобы проверить накопление, удержание и признаки складского набора.",
          { reply_markup: router.keyboard() }
        );
        return;
      }

      if (typeof router.clearChatMode === "function") {
        router.clearChatMode(chatId);
      }

      await router.sendMessage(
        chatId,
        `🧺 <b>Accumulation Scan started</b>\n<code>${escapeHtml(text)}</code>`,
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

        const caption = buildAccumulationReport(result);
        await router.sendPhotoOrText(chatId, result?.heroImage || null, caption, {
          reply_markup: router.keyboard()
        });
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
      if (typeof router.setChatMode === "function") {
        router.setChatMode(chatId, "awaiting_accum_ca");
      }
      await router.sendMessage(
        chatId,
        "🧺 <b>Accumulation Scan</b>\nПришли Solana CA, и я проверю накопление, удержание, cohort и признаки складского набора.",
        { reply_markup: router.keyboard() }
      );
      return;
    }

    return originalHandleMessage(msg);
  };
}
