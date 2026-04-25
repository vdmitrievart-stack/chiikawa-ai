import fs from "node:fs";
import path from "node:path";

function fail(msg) {
  console.error("❌ Patch failed:", msg);
  process.exit(1);
}

function read(file) {
  if (!fs.existsSync(file)) fail(`File not found: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function write(file, src) {
  fs.writeFileSync(file, src);
  console.log("✅ patched:", file);
}

function findMethodRange(src, methodSignature) {
  const idx = src.indexOf(methodSignature);
  if (idx === -1) return null;

  const braceStart = src.indexOf("{", idx);
  if (braceStart === -1) return null;

  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { start: idx, end: i + 1 };
      }
    }
  }

  return null;
}

function insertBeforeMethod(src, methodSignature, block, marker) {
  if (src.includes(marker)) return src;
  const idx = src.indexOf(methodSignature);
  if (idx === -1) fail(`Method not found: ${methodSignature}`);
  return src.slice(0, idx) + block + "\n\n  " + src.slice(idx);
}

function replaceMethod(src, methodSignature, newMethod, marker) {
  if (src.includes(marker)) return src;
  const range = findMethodRange(src, methodSignature);
  if (!range) fail(`Cannot locate method range: ${methodSignature}`);
  return src.slice(0, range.start) + newMethod + src.slice(range.end);
}

function patchCandidateService() {
  const file = path.resolve("telegram-bot/core/candidate-service.js");
  let src = read(file);

  // Helper sleep after safeDiv
  if (!src.includes("function sleepMs(ms)")) {
    const anchor = `function safeDiv(a, b, fallback = 0) {
  const den = safeNum(b, 0);
  if (den === 0) return fallback;
  return safeNum(a, 0) / den;
}`;
    if (!src.includes(anchor)) fail("safeDiv anchor not found in candidate-service.js");

    src = src.replace(anchor, `${anchor}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}`);
  }

  // Constructor properties
  if (!src.includes("this.dexSearchLastFetchAt")) {
    const anchor = `this.maxHolderEnrichPerPass = Number(options.maxHolderEnrichPerPass || 8);
    this.maxSmartWalletCandidates = Number(options.maxSmartWalletCandidates || process.env.GMGN_SMART_WALLET_MAX_CANDIDATES || 30);
    this.lastRadarTelemetry = this.createEmptyRadarTelemetry();`;
    if (!src.includes(anchor)) fail("constructor anchor not found in candidate-service.js");

    src = src.replace(anchor, `this.maxHolderEnrichPerPass = Number(options.maxHolderEnrichPerPass || 8);
    this.maxSmartWalletCandidates = Number(options.maxSmartWalletCandidates || process.env.GMGN_SMART_WALLET_MAX_CANDIDATES || 30);

    // PATCH: external API protection. Prevents 429 storms and keeps scans alive.
    this.dexSearchLastFetchAt = 0;
    this.dexTokenLastFetchAt = 0;
    this.dexSearchMinDelayMs = Number(process.env.DEX_SEARCH_MIN_DELAY_MS || 1500);
    this.dexTokenMinDelayMs = Number(process.env.DEX_TOKEN_MIN_DELAY_MS || 1800);
    this.dex429CooldownUntil = 0;
    this.dexSearchCache = new Map();
    this.dexTokenCache = new Map();
    this.dexCacheTtlMs = Number(process.env.DEX_CACHE_TTL_MS || 90_000);
    this.maxDexSearchQueriesPerScan = Number(process.env.MAX_DEX_SEARCH_QUERIES_PER_SCAN || 8);

    this.smartWalletDisabledUntil = 0;
    this.smartWalletFailureCooldownMs = Number(process.env.SMART_WALLET_FAILURE_COOLDOWN_MS || 10 * 60 * 1000);
    this.smartWalletHardDisabled = process.env.GMGN_SMART_WALLET_ENABLED === "false";

    this.lastRadarTelemetry = this.createEmptyRadarTelemetry();`);
  }

  // Insert helper methods before fetchDexSearch
  const helpers = `  // PATCH_API_RATE_LIMIT_START
  async waitForDexSlot(kind = "search") {
    const isToken = kind === "token";
    const minDelay = isToken ? this.dexTokenMinDelayMs : this.dexSearchMinDelayMs;
    const key = isToken ? "dexTokenLastFetchAt" : "dexSearchLastFetchAt";
    const now = Date.now();

    if (this.dex429CooldownUntil && now < this.dex429CooldownUntil) {
      await sleepMs(this.dex429CooldownUntil - now);
    }

    const elapsed = Date.now() - safeNum(this[key], 0);
    if (elapsed < minDelay) {
      await sleepMs(minDelay - elapsed);
    }

    this[key] = Date.now();
  }

  getCache(map, key) {
    const row = map.get(key);
    if (!row) return null;
    if (Date.now() - safeNum(row.ts, 0) > this.dexCacheTtlMs) {
      map.delete(key);
      return null;
    }
    return row.value;
  }

  setCache(map, key, value) {
    map.set(key, { ts: Date.now(), value });
    return value;
  }

  async fetchJsonWithProtection(url, { kind = "search", cacheKey = "" } = {}) {
    const cacheMap = kind === "token" ? this.dexTokenCache : this.dexSearchCache;
    if (cacheKey) {
      const cached = this.getCache(cacheMap, cacheKey);
      if (cached) return cached;
    }

    await this.waitForDexSlot(kind);

    let res;
    try {
      res = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "ChiikawaTradingBot/1.0"
        }
      });
    } catch (error) {
      this.logger.log("dex fetch network failed:", error.message);
      return null;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers?.get?.("retry-after") || 0);
      const cooldownMs = retryAfter > 0 ? retryAfter * 1000 : Number(process.env.DEX_429_COOLDOWN_MS || 60_000);
      this.dex429CooldownUntil = Date.now() + cooldownMs;
      this.logger.log(\`dex rate limited 429. cooling down \${cooldownMs}ms\`);
      return null;
    }

    if (!res.ok) {
      this.logger.log(\`dex fetch failed HTTP \${res.status}: \${url}\`);
      return null;
    }

    const json = await res.json().catch((error) => {
      this.logger.log("dex json parse failed:", error.message);
      return null;
    });

    if (cacheKey && json) this.setCache(cacheMap, cacheKey, json);
    return json;
  }
  // PATCH_API_RATE_LIMIT_END`;

  src = insertBeforeMethod(src, "async fetchDexSearch(query)", helpers, "PATCH_API_RATE_LIMIT_START");

  // Replace fetchDexSearch
  const newFetchDexSearch = `async fetchDexSearch(query) {
    const q = asText(query);
    if (!q) return [];

    try {
      const url = \`https://api.dexscreener.com/latest/dex/search/?q=\${encodeURIComponent(q)}\`;
      const json = await this.fetchJsonWithProtection(url, {
        kind: "search",
        cacheKey: \`search:\${q}\`
      });

      if (!json) return [];

      const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
      return pairs.filter((p) => isSolanaChain(p?.chainId));
    } catch (error) {
      this.logger.log("candidate-service search failed:", error.message);
      return [];
    }
  }`;
  src = replaceMethod(src, "async fetchDexSearch(query)", newFetchDexSearch, "cacheKey: `search:${q}`");

  // Replace fetchDexTokenByCA
  const newFetchToken = `async fetchDexTokenByCA(ca) {
  const tokenAddress = asText(ca);
  if (!tokenAddress) return null;

  try {
    const url = \`https://api.dexscreener.com/latest/dex/tokens/\${encodeURIComponent(tokenAddress)}\`;
    const json = await this.fetchJsonWithProtection(url, {
      kind: "token",
      cacheKey: \`token:\${tokenAddress}\`
    });

    if (!json) return null;

    const pairs = (Array.isArray(json?.pairs) ? json.pairs : []).filter((p) => isSolanaChain(p?.chainId));
    if (!pairs.length) return null;

    return pairs.sort((a, b) =>
      safeNum(b?.liquidity?.usd, 0) - safeNum(a?.liquidity?.usd, 0) ||
      safeNum(b?.volume?.h24, 0) - safeNum(a?.volume?.h24, 0)
    )[0] || null;
  } catch (error) {
    this.logger.log('candidate-service token fetch failed:', error.message);
    return null;
  }
}`;
  src = replaceMethod(src, "async fetchDexTokenByCA(ca)", newFetchToken, "cacheKey: `token:${tokenAddress}`");

  // Patch smart-wallet feed to stop 403 hammering
  if (!src.includes("PATCH_SMART_WALLET_COOLDOWN_START")) {
    const old = `async fetchCandidatesFromSmartWalletFeed() {
  if (!this.smartWalletFeed || typeof this.smartWalletFeed.fetchTokenHints !== 'function') {
    return {
      candidates: [],
      telemetry: {
        smartWalletFeedRaw: 0,
        smartWalletTokens: 0,
        smartWalletAccepted: 0,
        smartWalletPublishWorthy: 0,
        feedEnabled: false,
        feedMode: 'disabled'
      }
    };
  }`;

    if (!src.includes(old)) fail("fetchCandidatesFromSmartWalletFeed opening block not found");

    const repl = `async fetchCandidatesFromSmartWalletFeed() {
  // PATCH_SMART_WALLET_COOLDOWN_START
  if (
    this.smartWalletHardDisabled ||
    !this.smartWalletFeed ||
    typeof this.smartWalletFeed.fetchTokenHints !== 'function' ||
    Date.now() < safeNum(this.smartWalletDisabledUntil, 0)
  ) {
    return {
      candidates: [],
      telemetry: {
        smartWalletFeedRaw: 0,
        smartWalletTokens: 0,
        smartWalletAccepted: 0,
        smartWalletPublishWorthy: 0,
        feedEnabled: !this.smartWalletHardDisabled,
        feedMode: this.smartWalletHardDisabled ? 'disabled_by_env' : 'cooldown_or_disabled'
      }
    };
  }
  // PATCH_SMART_WALLET_COOLDOWN_END`;

    src = src.replace(old, repl);
  }

  if (!src.includes("this.smartWalletDisabledUntil = Date.now() + this.smartWalletFailureCooldownMs")) {
    const oldCatch = `  } catch (error) {
    this.logger.log('smart-wallet feed failed:', error.message);
    return {
      candidates: [],
      telemetry: {
        smartWalletFeedRaw: 0,
        smartWalletTokens: 0,
        smartWalletAccepted: 0,
        smartWalletPublishWorthy: 0,
        feedEnabled: true,
        feedMode: 'error'
      }
    };
  }`;
    if (!src.includes(oldCatch)) fail("smart wallet catch block not found");
    const replCatch = `  } catch (error) {
    const msg = String(error?.message || error || "");
    this.logger.log('smart-wallet feed failed:', msg);
    if (msg.includes("403") || msg.includes("429") || msg.includes("Too Many Requests")) {
      this.smartWalletDisabledUntil = Date.now() + this.smartWalletFailureCooldownMs;
      this.logger.log(\`smart-wallet feed cooldown for \${this.smartWalletFailureCooldownMs}ms\`);
    }
    return {
      candidates: [],
      telemetry: {
        smartWalletFeedRaw: 0,
        smartWalletTokens: 0,
        smartWalletAccepted: 0,
        smartWalletPublishWorthy: 0,
        feedEnabled: true,
        feedMode: 'error_cooldown'
      }
    };
  }`;
    src = src.replace(oldCatch, replCatch);
  }

  // Replace fetchMarketCandidates concurrency with sequential limited queries
  const newFetchMarket = `async fetchMarketCandidates() {
  this.resetRadarTelemetry();

  const bucketEntries = Object.entries(this.radarQueryBuckets || {});
  const plannedQueries = bucketEntries.flatMap(([bucket, queries]) =>
    (queries || []).map((query) => ({ bucket, query }))
  );

  const selectedQueries = plannedQueries.slice(0, Math.max(1, this.maxDexSearchQueriesPerScan));
  const results = [];

  for (const row of selectedQueries) {
    const pairs = await this.fetchDexSearch(row.query);
    results.push({ ...row, pairs });
    this.lastRadarTelemetry.scannedRaw += Array.isArray(pairs) ? pairs.length : 0;
  }

  const searchPairs = dedupeByCA(results.flatMap((x) => x.pairs || [])).filter((p) => isSolanaChain(p?.chainId));
  const smartWalletResult = await this.fetchCandidatesFromSmartWalletFeed();

  this.lastRadarTelemetry.smartWalletFeedRaw = safeNum(smartWalletResult?.telemetry?.smartWalletFeedRaw, 0);
  this.lastRadarTelemetry.smartWalletTokens = safeNum(smartWalletResult?.telemetry?.smartWalletTokens, 0);
  this.lastRadarTelemetry.smartWalletAccepted = safeNum(smartWalletResult?.telemetry?.smartWalletAccepted, 0);
  this.lastRadarTelemetry.scannedRaw += safeNum(smartWalletResult?.telemetry?.smartWalletFeedRaw, 0);

  const byCa = new Map();

  for (const pair of searchPairs) {
    const candidate = this.analyzePair(pair);
    const bucket = this.classifyRadarBucket(candidate?.token || {});
    candidate.discoveryBucket = bucket;
    candidate.discoverySource = 'dex_search';
    this.bumpBucket(bucket, 1);
    const ca = asText(candidate?.token?.ca);
    if (!ca) continue;
    byCa.set(ca, candidate);
  }

  for (const candidate of smartWalletResult?.candidates || []) {
    const ca = asText(candidate?.token?.ca);
    if (!ca) continue;
    this.bumpBucket('smart_wallets', 1);
    if (!byCa.has(ca)) {
      byCa.set(ca, candidate);
      continue;
    }
    const existing = byCa.get(ca);
    existing.discoveryBucket = 'smart_wallets';
    existing.discoverySource = existing.discoverySource === 'dex_search'
      ? 'dex_search+gmgn_smart_wallets'
      : existing.discoverySource;
    existing.smartWalletFeed = candidate.smartWalletFeed;
    existing.score = clamp(Math.max(safeNum(existing.score, 0), safeNum(candidate.score, 0)), 0, 99);
    existing.reasons = [...new Set([...(existing.reasons || []), ...(candidate.reasons || [])])];
    byCa.set(ca, existing);
  }

  this.lastRadarTelemetry.uniquePairs = byCa.size;

  const analyzed = [];
  for (const candidate of byCa.values()) {
    if (!isSolanaChain(candidate?.token?.chainId)) continue;
    if (this.isNoiseCandidate(candidate)) {
      this.lastRadarTelemetry.filteredNoise += 1;
      continue;
    }
    analyzed.push(candidate);
  }

  this.lastRadarTelemetry.candidatesAfterAnalysis = analyzed.length;

  return analyzed.sort((a, b) => {
    const bScore = Math.max(
      safeNum(b?.score, 0),
      safeNum(b?.migration?.survivorScore, 0),
      safeNum(b?.scalp?.score, 0),
      safeNum(b?.reversal?.score, 0),
      safeNum(b?.packaging?.score, 0)
    );
    const aScore = Math.max(
      safeNum(a?.score, 0),
      safeNum(a?.migration?.survivorScore, 0),
      safeNum(a?.scalp?.score, 0),
      safeNum(a?.reversal?.score, 0),
      safeNum(a?.packaging?.score, 0)
    );
    return (
      bScore - aScore ||
      safeNum(b?.smartWalletFeed?.walletHits, 0) - safeNum(a?.smartWalletFeed?.walletHits, 0) ||
      safeNum(b?.token?.volumeH1, 0) - safeNum(a?.token?.volumeH1, 0) ||
      safeNum(b?.token?.liquidity, 0) - safeNum(a?.token?.liquidity, 0)
    );
  });
}`;
  src = replaceMethod(src, "async fetchMarketCandidates()", newFetchMarket, "const selectedQueries = plannedQueries.slice");

  write(file, src);
}

function patchTradingKernel() {
  const file = path.resolve("telegram-bot/core/trading-kernel.js");
  let src = read(file);

  if (!src.includes("this.signalNoticeState = new Map();")) {
    const anchor = "this.noticeCooldowns = new Map();";
    if (!src.includes(anchor)) fail("noticeCooldowns anchor not found in trading-kernel.js");
    src = src.replace(anchor, `${anchor}
    this.signalNoticeState = new Map();`);
  }

  const methods = `  // PATCH_SIGNAL_ANTISPAM_START
  buildSignalFingerprint(candidate = {}, plans = []) {
    const token = candidate?.token || {};
    const planSet = (plans || []).map((p) => p?.strategyKey || "").filter(Boolean).sort().join(",");
    return {
      ca: String(token?.ca || ""),
      planSet,
      score: safeNum(candidate?.score, 0),
      price: safeNum(token?.price, 0),
      liquidity: safeNum(token?.liquidity, 0),
      volumeH1: safeNum(token?.volumeH1, 0),
      volumeH24: safeNum(token?.volumeH24, token?.volume || 0),
      txnsH1: safeNum(token?.txnsH1, 0),
      reversalScore: safeNum(candidate?.reversal?.score, 0),
      scalpScore: safeNum(candidate?.scalp?.score, 0),
      migrationScore: safeNum(candidate?.migration?.survivorScore, 0),
      antiRugVerdict: String(candidate?.antiRug?.verdict || "")
    };
  }

  pctMove(from, to) {
    const a = safeNum(from, 0);
    const b = safeNum(to, 0);
    if (!a || !b) return 0;
    return ((b - a) / a) * 100;
  }

  getSignalShift(prev = {}, next = {}) {
    if (!prev?.ca) return { changed: true, reason: "first_seen" };
    if (prev.planSet !== next.planSet) return { changed: true, reason: "plans_changed" };
    if (Math.abs(next.score - prev.score) >= 10) return { changed: true, reason: "score_shift" };
    if (Math.abs(next.reversalScore - prev.reversalScore) >= 10) return { changed: true, reason: "reversal_shift" };
    if (Math.abs(next.scalpScore - prev.scalpScore) >= 10) return { changed: true, reason: "scalp_shift" };
    if (Math.abs(next.migrationScore - prev.migrationScore) >= 12) return { changed: true, reason: "migration_shift" };
    if (next.antiRugVerdict !== prev.antiRugVerdict) return { changed: true, reason: "anti_rug_changed" };
    if (Math.abs(this.pctMove(prev.price, next.price)) >= 9) return { changed: true, reason: "price_move" };
    if (Math.abs(this.pctMove(prev.liquidity, next.liquidity)) >= 14) return { changed: true, reason: "liquidity_move" };
    return { changed: false, reason: "minor_noise" };
  }

  shouldEmitCandidateSignal(candidate = {}, plans = []) {
    const fp = this.buildSignalFingerprint(candidate, plans);
    if (!fp.ca) return { emit: true, mode: "full", reason: "no_ca", fingerprint: fp };

    const now = Date.now();
    const prev = this.signalNoticeState.get(fp.ca);
    const fullCooldownMs = Number(process.env.SIGNAL_FULL_COOLDOWN_MS || 30 * 60 * 1000);
    const updateCooldownMs = Number(process.env.SIGNAL_UPDATE_COOLDOWN_MS || 10 * 60 * 1000);

    if (!prev) return { emit: true, mode: "full", reason: "first_seen", fingerprint: fp };

    const shift = this.getSignalShift(prev.fingerprint, fp);
    if (!shift.changed) return { emit: false, mode: "silent", reason: shift.reason, fingerprint: fp };

    if (now - safeNum(prev.lastUpdateAt, 0) >= updateCooldownMs) {
      return { emit: true, mode: "update", reason: shift.reason, fingerprint: fp };
    }

    if (now - safeNum(prev.lastFullAt, 0) >= fullCooldownMs) {
      return { emit: true, mode: "full", reason: shift.reason, fingerprint: fp };
    }

    return { emit: false, mode: "silent", reason: shift.reason, fingerprint: fp };
  }

  markCandidateSignal(candidate = {}, plans = [], decision = {}) {
    const fp = decision?.fingerprint || this.buildSignalFingerprint(candidate, plans);
    if (!fp.ca) return;

    const prev = this.signalNoticeState.get(fp.ca);
    const now = Date.now();
    this.signalNoticeState.set(fp.ca, {
      fingerprint: fp,
      firstSeenAt: prev?.firstSeenAt || now,
      lastFullAt: decision?.mode === "full" ? now : safeNum(prev?.lastFullAt, 0),
      lastUpdateAt: now
    });
  }

  buildSignalUpdateText(candidate = {}, plans = [], reason = "update") {
    const token = candidate?.token || {};
    const planLine = (plans || []).map((p) => p.strategyKey).join(", ") || "none";
    return \`🔁 <b>SIGNAL UPDATE</b>

<b>Token:</b> \${escapeHtml(token.name || token.symbol || "UNKNOWN")}
<b>CA:</b> <code>\${escapeHtml(token.ca || "-")}</code>
<b>Reason:</b> \${escapeHtml(reason)}

Score: \${safeNum(candidate?.score, 0)}
Plans: \${escapeHtml(planLine)}
Price: \${safeNum(token.price, 0)}
Liquidity: \${safeNum(token.liquidity, 0)}
Volume 1h: \${safeNum(token.volumeH1, 0)}
Volume 24h: \${safeNum(token.volumeH24, token.volume || 0)}
Anti-rug: \${escapeHtml(candidate?.antiRug?.verdict || "-")} / \${safeNum(candidate?.antiRug?.riskScore, 0)}\`;
  }
  // PATCH_SIGNAL_ANTISPAM_END`;

  src = insertBeforeMethod(src, "async tick(sendBridge)", methods, "PATCH_SIGNAL_ANTISPAM_START");

  const oldBlock = `await notificationService.sendPhotoOrText(
      heroImage,
      this.candidateService.buildHeroCaption(candidate)
    );

    await notificationService.sendText(
      this.candidateService.buildAnalysisText(candidate, plans)
    );`;

  const newBlock = `const signalDecision = this.shouldEmitCandidateSignal(candidate, plans);

    if (signalDecision.emit) {
      if (signalDecision.mode === "full") {
        await notificationService.sendPhotoOrText(
          heroImage,
          this.candidateService.buildHeroCaption(candidate)
        );

        await notificationService.sendText(
          this.candidateService.buildAnalysisText(candidate, plans)
        );
      } else {
        await notificationService.sendText(
          this.buildSignalUpdateText(candidate, plans, signalDecision.reason)
        );
      }

      this.markCandidateSignal(candidate, plans, signalDecision);
    } else {
      this.logger.log(
        "candidate signal suppressed:",
        candidate?.token?.ca,
        signalDecision.reason
      );
    }`;

  if (!src.includes("const signalDecision = this.shouldEmitCandidateSignal(candidate, plans);")) {
    if (!src.includes(oldBlock)) fail("notification block not found in trading-kernel.js");
    src = src.replace(oldBlock, newBlock);
  }

  write(file, src);
}

patchCandidateService();
patchTradingKernel();

console.log("✅ Done. API 429 protection + smart-wallet 403 cooldown + duplicate signal suppression applied.");
