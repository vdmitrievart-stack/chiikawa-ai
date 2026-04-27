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

function fmtApproxPct(v, d = 2) {
  return `≈${round(v, d)}%`;
}

function fmtSignedPct(v, d = 2) {
  const n = round(v, d);
  return `${n > 0 ? '+' : ''}${n}%`;
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
    (holder?.quietAccumulationPass ||
      holder?.warehouseStoragePass ||
      holder?.bottomPackReversalPass ||
      safeNum(holder?.netControlPct) >= 65) &&
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

function derivePackagingProbeReady(analyzed = {}) {
  const holder = analyzed?.holderAccumulation || {};
  if (analyzed?.reversal?.allow) return false;
  return Boolean(
    (holder?.warehouseStoragePass || holder?.quietAccumulationPass) &&
      safeNum(holder?.freshWalletBuyCount, 0) >= 10 &&
      safeNum(holder?.retention30mPct, 0) >= 70 &&
      safeNum(holder?.retention2hPct, 0) >= 65 &&
      safeNum(holder?.netAccumulationPct, 0) >= 80 &&
      safeNum(holder?.netControlPct, 0) >= 65 &&
      safeNum(holder?.bottomTouches, 0) >= 3
  );
}

function deriveStructureScore(analyzed = {}) {
  const reversal = analyzed?.reversal || {};
  const holder = analyzed?.holderAccumulation || {};
  const migration = analyzed?.migration || {};
  let score = safeNum(reversal?.score, 0);

  if (score <= 0) {
    if (holder?.quietAccumulationPass) score += 16;
    if (holder?.warehouseStoragePass) score += 18;
    if (holder?.bottomPackReversalPass) score += 16;
    if (safeNum(holder?.netControlPct) >= 80) score += 14;
    else if (safeNum(holder?.netControlPct) >= 70) score += 10;
    if (safeNum(holder?.retention30mPct) >= 75) score += 8;
    if (safeNum(holder?.retention2hPct) >= 65) score += 8;
    if (safeNum(holder?.historicalRetention6hPct ?? holder?.retention6hPct, 0) >= 10) score += 6;
    if (safeNum(holder?.bottomTouches) >= 4) score += 10;
    else if (safeNum(holder?.bottomTouches) >= 3) score += 7;
    if (safeNum(holder?.reloadCount, 0) >= 3) score += 6;
    if (safeNum(migration?.survivorScore, 0) >= 80) score += 4;
  }

  if (derivePackagingProbeReady(analyzed) && score < 58) {
    score = 58;
  }

  return Math.min(100, Math.max(0, round(score, 0)));
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
      note: "спокойная складская упаковка, без лишней суеты"
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
      note: "похоже на усредняющегося спекулянта, а не на упаковщика"
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


function normalizeNarrativeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\$#@]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTokenName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function extractLinksMapSimple(links = []) {
  const map = { twitter: '', telegram: '', website: '' };
  const rows = Array.isArray(links) ? links : [];
  for (const row of rows) {
    const type = String(row?.type || '').toLowerCase();
    const url = String(row?.url || '').trim();
    if (!url) continue;
    if (!map.twitter && (type === 'x' || type.includes('twitter'))) map.twitter = url;
    else if (!map.telegram && type.includes('telegram')) map.telegram = url;
    else if (!map.website && type.includes('website')) map.website = url;
    else if (!map.website) map.website = url;
  }
  return map;
}

function socialCountFromLinks(links = []) {
  const map = extractLinksMapSimple(links);
  return Object.values(map).filter(Boolean).length;
}

function buildNarrativeTags(token = {}) {
  const name = String(token?.name || '').trim();
  const symbol = String(token?.symbol || '').trim();
  const tags = [];
  if (symbol) tags.push(`$${symbol}`);
  if (symbol) tags.push(symbol);
  if (name) tags.push(name);
  return [...new Set(tags.filter(Boolean))].slice(0, 4);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { accept: 'application/json', ...(options.headers || {}) } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(id);
  }
}

function dedupeDexPairs(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const ca = String(row?.baseToken?.address || row?.token?.ca || '').trim();
    if (!ca || seen.has(ca)) continue;
    seen.add(ca);
    out.push(row);
  }
  return out;
}

function sameNameFamily(token = {}, other = {}) {
  const nameA = normalizeTokenName(token?.name);
  const symA = normalizeTokenName(token?.symbol);
  const nameB = normalizeTokenName(other?.baseToken?.name || other?.name);
  const symB = normalizeTokenName(other?.baseToken?.symbol || other?.symbol);
  if (!nameA && !symA) return false;
  return Boolean(
    (nameA && nameB && nameA === nameB) ||
    (symA && symB && symA === symB) ||
    (nameA && symB && nameA === symB) ||
    (symA && nameB && symA === nameB)
  );
}

function scoreOgCandidate(token = {}, pair = {}) {
  const liquidity = safeNum(pair?.liquidity?.usd || pair?.liquidity, 0);
  const volume = safeNum(pair?.volume?.h24 || pair?.volume, 0);
  const txns = safeNum(pair?.txns?.h24?.buys, 0) + safeNum(pair?.txns?.h24?.sells, 0) + safeNum(pair?.txns, 0);
  const pairCreatedAt = safeNum(pair?.pairCreatedAt, 0);
  const ageScore = pairCreatedAt > 0 ? Math.max(0, (Date.now() - pairCreatedAt) / 3600000) : 0;
  const socials = socialCountFromLinks([
    ...(Array.isArray(pair?.info?.socials) ? pair.info.socials.map((x) => ({ type: x?.type || '', url: x?.url || '' })) : []),
    ...(Array.isArray(pair?.info?.websites) ? pair.info.websites.map((x) => ({ type: 'website', url: x?.url || '' })) : []),
  ]);
  let score = 0;
  if (sameNameFamily(token, pair)) score += 25;
  if (normalizeTokenName(token?.name) === normalizeTokenName(pair?.baseToken?.name)) score += 18;
  if (normalizeTokenName(token?.symbol) === normalizeTokenName(pair?.baseToken?.symbol)) score += 14;
  score += Math.min(30, ageScore / 8);
  score += Math.min(20, liquidity / 25000);
  score += Math.min(18, volume / 50000);
  score += Math.min(14, txns / 300);
  score += socials * 4;
  return score;
}

async function detectNameCollisionIntel(token = {}) {
  const name = String(token?.name || '').trim();
  const symbol = String(token?.symbol || '').trim();
  const ca = String(token?.ca || '').trim();
  if (!name && !symbol) {
    return { collisionDetected: false, sameNameCount: 0, likelyOg: true, verdict: 'no_name', note: 'Нет данных имени/тикера' };
  }

  const queries = [...new Set([name, symbol, `${name} ${symbol}`].filter(Boolean))].slice(0, 3);
  const allPairs = [];
  for (const q of queries) {
    const json = await fetchJsonWithTimeout(`https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(q)}`);
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    allPairs.push(...pairs.filter((p) => String(p?.chainId || '').toLowerCase() === 'solana'));
  }
  const family = dedupeDexPairs(allPairs).filter((p) => sameNameFamily(token, p));
  const familyCount = family.length;
  if (!familyCount) {
    return { collisionDetected: false, sameNameCount: 0, likelyOg: true, verdict: 'unique', note: 'Одноимённых конкурентов не найдено' };
  }

  const ranked = family.map((p) => ({
    ca: String(p?.baseToken?.address || '').trim(),
    name: String(p?.baseToken?.name || '').trim(),
    symbol: String(p?.baseToken?.symbol || '').trim(),
    pairCreatedAt: safeNum(p?.pairCreatedAt, 0),
    liquidity: safeNum(p?.liquidity?.usd, 0),
    volume24h: safeNum(p?.volume?.h24, 0),
    txns24h: safeNum(p?.txns?.h24?.buys, 0) + safeNum(p?.txns?.h24?.sells, 0),
    score: scoreOgCandidate(token, p),
  })).sort((a, b) => b.score - a.score || a.pairCreatedAt - b.pairCreatedAt);

  const top = ranked[0] || null;
  const likelyOg = !top || top.ca === ca;
  const primaryOrganicSupport = likelyOg ? 'this_token' : 'other_same_name_token';
  return {
    collisionDetected: familyCount > 1,
    sameNameCount: familyCount,
    likelyOg,
    top,
    alternatives: ranked.filter((x) => x.ca !== ca).slice(0, 3),
    primaryOrganicSupport,
    verdict: likelyOg ? (familyCount > 1 ? 'likely_og' : 'unique') : 'likely_clone',
    note: likelyOg
      ? (familyCount > 1 ? 'Есть одноимённые токены, но этот выглядит как OG/основной' : 'Одноимённых конкурентов не найдено')
      : 'Есть одноимённый более сильный/старый кандидат, это может быть клон или испорченный дубль',
  };
}

function extractPostsFromJson(node, out = [], depth = 0) {
  if (!node || depth > 6 || out.length >= 120) return out;
  if (Array.isArray(node)) {
    for (const item of node) extractPostsFromJson(item, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  const text = String(node?.text || node?.content || node?.body || node?.message || '').trim();
  const author = String(
    node?.author || node?.username || node?.handle || node?.screen_name || node?.user?.username || node?.user?.handle || node?.account?.username || ''
  ).trim();
  if (text) out.push({ text, author });
  for (const value of Object.values(node)) {
    if (typeof value === 'object') extractPostsFromJson(value, out, depth + 1);
  }
  return out;
}

async function detectNarrativeMentions(token = {}) {
  const templates = String(process.env.NARRATIVE_QUERY_URLS || '').split(/[\n,;]/).map((x) => x.trim()).filter(Boolean);
  const tags = buildNarrativeTags(token);
  if (!templates.length || !tags.length) {
    return {
      feedConfigured: false,
      tags,
      mentionCount: 0,
      uniqueAuthors: 0,
      diversityScore: 0,
      botLikeRatio: 0,
      authenticityScore: 0,
      sentiment: 'unknown',
      verdict: 'no_feed',
      note: 'Источник публичных упоминаний не настроен'
    };
  }

  const headers = {};
  if (process.env.NARRATIVE_QUERY_API_KEY) headers.authorization = `Bearer ${process.env.NARRATIVE_QUERY_API_KEY}`;
  const posts = [];
  for (const template of templates.slice(0, 3)) {
    for (const tag of tags.slice(0, 3)) {
      const url = template.replace(/\{q\}/g, encodeURIComponent(tag));
      const json = await fetchJsonWithTimeout(url, { headers }, 4000);
      if (json) posts.push(...extractPostsFromJson(json));
    }
  }

  const dedup = [];
  const seen = new Set();
  for (const row of posts) {
    const key = `${normalizeNarrativeText(row.text)}::${String(row.author || '').toLowerCase()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(row);
  }

  const mentionCount = dedup.length;
  const uniqueAuthors = new Set(dedup.map((x) => String(x.author || '').toLowerCase()).filter(Boolean)).size;
  const uniqueTexts = new Set(dedup.map((x) => normalizeNarrativeText(x.text)).filter(Boolean)).size;
  const repetitiveRatio = mentionCount > 0 ? Math.max(0, 1 - uniqueTexts / mentionCount) : 0;
  const diversityScore = mentionCount > 0 ? Math.min(100, round((uniqueAuthors / mentionCount) * 100, 2)) : 0;
  const botLikeRatio = Math.min(100, round((repetitiveRatio * 65) + ((mentionCount > 0 ? 1 - uniqueAuthors / Math.max(mentionCount, 1) : 0) * 35), 2));

  const joined = dedup.map((x) => normalizeNarrativeText(x.text)).join(' ');
  const positiveLex = ['bullish', 'send', 'runner', 'based', 'og', 'cto', 'gem', 'packaging', 'accumulation', 'reversal'];
  const negativeLex = ['scam', 'rug', 'farm', 'dead', 'avoid', 'dump', 'fake', 'clone'];
  const pos = positiveLex.reduce((s, k) => s + (joined.includes(k) ? 1 : 0), 0);
  const neg = negativeLex.reduce((s, k) => s + (joined.includes(k) ? 1 : 0), 0);
  const sentiment = pos > neg ? 'positive' : neg > pos ? 'negative' : 'mixed';

  let authenticityScore = 0;
  authenticityScore += Math.min(35, mentionCount * 2.5);
  authenticityScore += Math.min(30, diversityScore * 0.3);
  authenticityScore += Math.max(0, 30 - botLikeRatio * 0.3);
  if (sentiment === 'positive') authenticityScore += 8;
  if (sentiment === 'negative') authenticityScore -= 10;
  authenticityScore = Math.max(0, Math.min(100, round(authenticityScore, 2)));

  const verdict = authenticityScore >= 65 ? 'organic' : authenticityScore >= 40 ? 'mixed' : mentionCount > 0 ? 'manufactured' : 'quiet';
  return {
    feedConfigured: true,
    tags,
    mentionCount,
    uniqueAuthors,
    uniqueTexts,
    diversityScore,
    botLikeRatio,
    authenticityScore,
    sentiment,
    verdict,
    note: verdict === 'organic'
      ? 'Упоминания выглядят живыми и разнообразными'
      : verdict === 'manufactured'
        ? 'Упоминания выглядят однотипно или ботоподобно'
        : verdict === 'quiet'
          ? 'Публичный нарратив пока тихий'
          : 'Нарратив есть, но смешанный по качеству'
  };
}

async function buildNarrativeOgIntel(result = {}) {
  const token = result?.analyzed?.token || result?.token || {};
  const [collision, mentions] = await Promise.all([
    detectNameCollisionIntel(token),
    detectNarrativeMentions(token),
  ]);
  return { collision, mentions, tags: buildNarrativeTags(token) };
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
    packagingProbeReady: derivePackagingProbeReady(analyzed),
    meaningfulWalletCount: safeNum(holder?.meaningfulWalletCount, 0),
    meaningfulHolderGrowthPct: safeNum(holder?.meaningfulHolderGrowthPct, 0),
    meaningfulHolderDelta: safeNum(holder?.meaningfulHolderDelta, 0),
    priceSinceLastSummaryPct: safeNum(holder?.priceSinceLastSummaryPct, 0),
    bullishHolderGrowthOnWeakness: Boolean(holder?.bullishHolderGrowthOnWeakness),
    holderGrowthWindowMin: safeNum(holder?.holderGrowthWindowMin, 0),
    walletCluster: holder?.walletCluster || null,
    clusterRisk: holder?.walletCluster?.clusterRisk || '-',
    clusterRiskScore: safeNum(holder?.walletCluster?.clusterRiskScore, 0),
    avgWalletAgeDays: safeNum(holder?.walletCluster?.avgWalletAgeDays ?? holder?.walletCluster?.avgAgeDays, 0),
    walletAgeKnownCount: safeNum(holder?.walletCluster?.walletAgeKnownCount, 0),
    walletAgeUnknownCount: safeNum(holder?.walletCluster?.walletAgeUnknownCount, 0),
    youngWalletCount7d: safeNum(holder?.walletCluster?.youngWalletCount7d, 0),
    veryYoungWalletCount3d: safeNum(holder?.walletCluster?.veryYoungWalletCount3d, 0),
    oldWalletCount30d: safeNum(holder?.walletCluster?.oldWalletCount30d, 0),
    sameDayClusterCount: safeNum(holder?.walletCluster?.sameDayClusterCount, 0),
    sameDayYoungClusterCount: safeNum(holder?.walletCluster?.sameDayYoungClusterCount, 0),
    sameBuyWindowClusterCount: safeNum(holder?.walletCluster?.sameBuyWindowClusterCount, 0),
    sameFundingClusterCount: safeNum(holder?.walletCluster?.sameFundingClusterCount, 0),
    sameDayBuySizeCv: safeNum(holder?.walletCluster?.sameDayBuySizeCv, 999),
    sameBuyWindowBuySizeCv: safeNum(holder?.walletCluster?.sameBuyWindowBuySizeCv, 999),
    globalBuySizeCv: safeNum(holder?.walletCluster?.globalBuySizeCv, 999),
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
    `<b>Avg peak FDV multiple:</b> ${matured.length ? `${fmtNum(avgPeak, 2)}x` : `-`}`,
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
  const packagingProbeReady = derivePackagingProbeReady(analyzed);
  const shortPlanList = plans.length ? plans.map((p) => p?.strategyKey).filter(Boolean) : [];
  if (packagingProbeReady && !shortPlanList.includes('packaging_probe')) {
    shortPlanList.unshift('packaging_probe');
  }

  const flush = Boolean(reversal?.flushDetected);
  const base = Boolean(reversal?.baseForming);
  const exhaust = Boolean(reversal?.sellerExhaustion);
  const reclaim = Boolean(reversal?.reclaimPressure);

  const lines = [
    deriveDisplayHeader(result),
    `🧺 <b>ACCUMULATION SCAN — ${escapeHtml(category)}</b>`,
    category === 'PACKAGING'
      ? `🟡 Ранняя стадия упаковки. Это watchlist/ранний вход, а не поздний подтвержденный reversal.`
      : ``,
    packagingProbeReady
      ? green('Packaging probe: можно брать небольшую пробную позицию')
      : yellow('Packaging probe: пока только наблюдение'),
    ``,
    `<b>${escapeHtml(token.name || token.symbol || 'UNKNOWN')}</b>`,
    `<code>${escapeHtml(token.ca || '')}</code>`,
    `Цена ${safeNum(token.price, 0)} | FDV ${safeNum(token.fdv, 0)} | Ликвидность ${safeNum(token.liquidity, 0)}`,
    `Объём 1ч/24ч ${safeNum(token.volumeH1 ?? token.volume, 0)} / ${safeNum(token.volumeH24 ?? token.volume, 0)} | Txns 1ч/24ч ${safeNum(token.txnsH1 ?? token.txns, 0)} / ${safeNum(token.txnsH24 ?? token.txns, 0)}`,
    ``,
    `<b>📦 Holder accumulation</b>`,
    `${safeNum(holder.trackedWallets, 0) > 0 ? green('Кошельков отслежено') : red('Кошельков отслежено')} — ${safeNum(holder.trackedWallets, 0)}`,
    `${safeNum(holder.meaningfulWalletCount ?? 0, 0) >= 10 ? green('Значимые self-buy холдеры') : yellow('Значимые self-buy холдеры')} — ${safeNum(holder.meaningfulWalletCount ?? 0, 0)}`,
    `${safeNum(holder.freshWalletBuyCount, 0) >= 10 ? green('Новая когорта') : yellow('Новая когорта')} — ${safeNum(holder.freshWalletBuyCount, 0)}`,
    `${yellow('Self-buy / transfer-only / dust')} — ${safeNum(holder.selfBuyWalletCount ?? 0, 0)} / ${safeNum(holder.transferOnlyWalletCount ?? 0, 0)} / ${safeNum(holder.dustFilteredWalletCount ?? 0, 0)}`,
    `${yellow('Порог значимого холдера')} — >= ${fmtPct(holder.minimumMeaningfulSharePct ?? 0.3, 2)} от отслеживаемой базы + сам купил` ,
    `${safeNum(holder.meaningfulHolderGrowthPct ?? 0, 0) > 0 ? green('Рост реальных холдеров') : safeNum(holder.meaningfulHolderGrowthPct ?? 0, 0) < 0 ? red('Рост реальных холдеров') : yellow('Рост реальных холдеров')} — ${fmtSignedPct(holder.meaningfulHolderGrowthPct ?? 0, 2)}${safeNum(holder.holderGrowthWindowMin ?? 0, 0) > 0 ? ` за ${fmtNum(holder.holderGrowthWindowMin ?? 0, 0)}м` : ''}`,
    `${safeNum(holder.priceSinceLastSummaryPct ?? 0, 0) !== 0 ? (safeNum(holder.priceSinceLastSummaryPct ?? 0, 0) <= 0 ? yellow('Цена за окно наблюдения') : yellow('Цена за окно наблюдения')) : yellow('Цена за окно наблюдения')} — ${fmtSignedPct(holder.priceSinceLastSummaryPct ?? 0, 2)}`,
    `${holder?.bullishHolderGrowthOnWeakness ? green('Бычья дивергенция накопления: цена слабеет, а реальные холдеры растут') : yellow('Бычья дивергенция накопления: пока не подтверждена')}`,
    `${safeNum(holder.retention30mPct, 0) >= 50 ? green('Удержание 30м / 2ч') : yellow('Удержание 30м / 2ч')} — ${fmtPct(holder.retention30mPct)} / ${fmtPct(holder.retention2hPct)}`,
    `${safeNum(holder.historicalRetention6hPct ?? holder.retention6hPct, 0) > 0 ? green('Историческое удержание 6ч / 24ч') : yellow('Историческое удержание 6ч / 24ч')} — ${fmtPct(holder.historicalRetention6hPct ?? holder.retention6hPct)} / ${fmtPct(holder.historicalRetention24hPct)}`,
    `${safeNum(holder.netAccumulationPct, 0) > 0 ? green('Чистое накопление') : yellow('Чистое накопление')} — ${fmtPct(holder.netAccumulationPct)}`,
    `${safeNum(holder.netControlPct, 0) >= 65 ? green('Оценочная доля когорты (среди значимых отслеж.)') : yellow('Оценочная доля когорты (среди значимых отслеж.)')} — ${fmtApproxPct(Math.min(safeNum(holder.netControlPct, 0), 95), 2)}`,
    `${yellow('Покрытие значимых холдеров')} — ${fmtPct(holder.meaningfulCoveragePct ?? 0, 2)}`,
    `${safeNum(holder.reloadCount, 0) >= 2 ? green('Reload count') : yellow('Reload count')} — ${safeNum(holder.reloadCount, 0)} | Dip-buy ${fmtNum(holder.dipBuyRatio, 2)} | Bottom touches ${safeNum(holder.bottomTouches, 0)}`,
    ``,
    `<b>🧬 Возраст кошельков / wallet cluster</b>`,
    (holder?.walletCluster
      ? `${safeNum(holder.walletCluster.clusterRiskScore, 0) >= 70 ? red('Cluster risk') : safeNum(holder.walletCluster.clusterRiskScore, 0) >= 45 ? yellow('Cluster risk') : green('Cluster risk')} — ${escapeHtml(holder.walletCluster.clusterRisk || "-")} / ${safeNum(holder.walletCluster.clusterRiskScore, 0)}`
      : yellow('Cluster risk — данных пока нет. Обнови holder-accumulation-engine.js + wallet-cluster-intelligence.js')),
    (holder?.walletCluster
      ? `${yellow('Возраст проверен')} — ${safeNum(holder.walletCluster.walletAgeKnownCount, 0)} / ${safeNum(holder.walletCluster.trackedWallets, 0)} кошельков${safeNum(holder.walletCluster.walletAgeUnknownCount, 0) > 0 ? ` | unknown ${safeNum(holder.walletCluster.walletAgeUnknownCount, 0)}` : ''}`
      : ``),
    (holder?.walletCluster
      ? `${safeNum(holder.walletCluster.avgWalletAgeDays ?? holder.walletCluster.avgAgeDays, 0) <= 7 ? red('Средний возраст кошельков') : safeNum(holder.walletCluster.avgWalletAgeDays ?? holder.walletCluster.avgAgeDays, 0) <= 30 ? yellow('Средний возраст кошельков') : green('Средний возраст кошельков')} — ${fmtNum(holder.walletCluster.avgWalletAgeDays ?? holder.walletCluster.avgAgeDays, 1)}д`
      : ``),
    (holder?.walletCluster
      ? `${safeNum(holder.walletCluster.youngWalletCount7d, 0) >= 5 ? red('Молодые кошельки ≤7д / ≤3д') : safeNum(holder.walletCluster.youngWalletCount7d, 0) >= 3 ? yellow('Молодые кошельки ≤7д / ≤3д') : green('Молодые кошельки ≤7д / ≤3д')} — ${safeNum(holder.walletCluster.youngWalletCount7d, 0)} / ${safeNum(holder.walletCluster.veryYoungWalletCount3d, 0)} | supply ${fmtPct(holder.walletCluster.youngSupplyPct)}`
      : ``),
    (holder?.walletCluster
      ? `${safeNum(holder.walletCluster.oldWalletCount30d, 0) >= 6 ? green('Старые кошельки >30д') : yellow('Старые кошельки >30д')} — ${safeNum(holder.walletCluster.oldWalletCount30d, 0)} | supply ${fmtPct(holder.walletCluster.oldSupplyPct)}`
      : ``),
    (holder?.walletCluster
      ? `${safeNum(holder.walletCluster.sameDayClusterCount, 0) >= 5 ? red('Созданы/активированы в один день') : safeNum(holder.walletCluster.sameDayClusterCount, 0) >= 3 ? yellow('Созданы/активированы в один день') : green('Созданы/активированы в один день')} — ${safeNum(holder.walletCluster.sameDayClusterCount, 0)} кош. / ${fmtPct(holder.walletCluster.sameDayClusterSupplyPct)} supply`
      : ``),
    (holder?.walletCluster
      ? `${safeNum(holder.walletCluster.sameDayYoungClusterCount, 0) >= 4 ? red('Молодой same-day cluster') : safeNum(holder.walletCluster.sameDayYoungClusterCount, 0) >= 2 ? yellow('Молодой same-day cluster') : green('Молодой same-day cluster')} — ${safeNum(holder.walletCluster.sameDayYoungClusterCount, 0)} кош.`
      : ``),
    (holder?.walletCluster
      ? `${safeNum(holder.walletCluster.sameBuyWindowClusterCount, 0) >= 4 ? red('Покупки в одном 15м окне') : safeNum(holder.walletCluster.sameBuyWindowClusterCount, 0) >= 2 ? yellow('Покупки в одном 15м окне') : green('Покупки в одном 15м окне')} — ${safeNum(holder.walletCluster.sameBuyWindowClusterCount, 0)} кош. / ${fmtPct(holder.walletCluster.sameBuyWindowSupplyPct)} supply`
      : ``),
    (holder?.walletCluster
      ? `${safeNum(holder.walletCluster.sameDayBuySizeCv, 999) <= 0.22 ? red('Похожие размеры покупок CV') : safeNum(holder.walletCluster.sameDayBuySizeCv, 999) <= 0.35 ? yellow('Похожие размеры покупок CV') : green('Похожие размеры покупок CV')} — same-day ${fmtNum(holder.walletCluster.sameDayBuySizeCv, 3)} | 15m ${fmtNum(holder.walletCluster.sameBuyWindowBuySizeCv, 3)} | global ${fmtNum(holder.walletCluster.globalBuySizeCv, 3)}`
      : ``),
    (holder?.walletCluster
      ? `${safeNum(holder.walletCluster.sameFundingClusterCount, 0) >= 4 ? red('Same funding source') : safeNum(holder.walletCluster.sameFundingClusterCount, 0) >= 2 ? yellow('Same funding source') : green('Same funding source')} — ${safeNum(holder.walletCluster.sameFundingClusterCount, 0)} кош. / ${fmtPct(holder.walletCluster.sameFundingSupplyPct)} supply`
      : ``),
    (holder?.walletCluster?.reasons?.length
      ? `🧠 Cluster signals — ${escapeHtml(holder.walletCluster.reasons.slice(0, 4).join(' | '))}`
      : ``),
    `${holder?.quietAccumulationPass ? green('Тихое накопление') : red('Тихое накопление')} | ${holder?.warehouseStoragePass ? green('Складская упаковка') : yellow('Складская упаковка')} | ${holder?.activeReaccumulationPass ? green('Активный добор') : yellow('Активный добор')}`,
    `${holder?.bottomPackReversalPass ? green('Нижняя упаковка') : red('Нижняя упаковка')} | ${archetype.key === 'warehouse_storage' ? green('Архетип') : yellow('Архетип')} — ${escapeHtml(archetype.label)}`,
    `🟡 ${escapeHtml(archetype.note)}`,
    ``,
    `<b>🔁 Структура разворота</b>`,
    `${reversal?.allow ? green('Reversal confirmed') : red('Reversal confirmed')} | score ${safeNum(structureScore, 0)} | mode ${escapeHtml(reversal?.primaryMode || '-')}`,
    `${flush ? green('flush') : red('flush')} / ${base ? green('base') : red('base')} / ${exhaust ? green('exhaustion') : red('exhaustion')} / ${reclaim ? green('reclaim') : red('reclaim')}`,
    ``,
    `<b>🌊 Миграция</b>`,
    `Возраст пары ${fmtNum(migration?.pairAgeMin, 1)}м | Survivor ${safeNum(migration?.survivorScore, 0)} | liq/mcap ${fmtPct(migration?.liqToMcapPct)} | vol/liq ${fmtPct(migration?.volToLiqPct)}`,
    `${migration?.passes ? green('Migration pass') : yellow('Migration pass')} — ${migration?.passes ? 'да' : 'нет'}`,
    ``,
    `<b>🧠 Narrative / OG</b>`,
    `${Array.isArray(result?.narrativeOg?.tags) && result.narrativeOg.tags.length ? yellow('Теги наблюдения') + ' — ' + escapeHtml(result.narrativeOg.tags.join(' / ')) : yellow('Теги наблюдения') + ' — -'}`,
    `${result?.narrativeOg?.collision?.collisionDetected ? red('Коллизия имени') : green('Коллизия имени')} — ${result?.narrativeOg?.collision?.collisionDetected ? 'да' : 'нет'}${result?.narrativeOg?.collision?.sameNameCount ? ' (' + safeNum(result?.narrativeOg?.collision?.sameNameCount, 0) + ')' : ''}`,
    `${result?.narrativeOg?.collision?.likelyOg ? green('OG статус') : red('OG статус')} — ${result?.narrativeOg?.collision?.likelyOg ? 'похоже на OG' : 'похоже на клон/испорченный дубль'}`,
    `${result?.narrativeOg?.collision?.top && !result?.narrativeOg?.collision?.likelyOg ? yellow('Более сильный одноимённый кандидат') + ' — ' + escapeHtml(result.narrativeOg.collision.top.name || '-') + ' / <code>' + escapeHtml(result.narrativeOg.collision.top.ca || '-') + '</code>' : yellow('Комментарий OG') + ' — ' + escapeHtml(result?.narrativeOg?.collision?.note || '-')}`,
    `${result?.narrativeOg?.mentions?.feedConfigured ? green('Фид упоминаний') : yellow('Фид упоминаний')} — ${result?.narrativeOg?.mentions?.feedConfigured ? 'подключен' : 'не настроен'}`,
    `${result?.narrativeOg?.mentions?.feedConfigured ? ((safeNum(result?.narrativeOg?.mentions?.authenticityScore, 0) >= 65) ? green('Аутентичность нарратива') : (safeNum(result?.narrativeOg?.mentions?.authenticityScore, 0) >= 40 ? yellow('Аутентичность нарратива') : red('Аутентичность нарратива'))) + ' — ' + fmtNum(result?.narrativeOg?.mentions?.authenticityScore, 0) + '/100 | authors ' + safeNum(result?.narrativeOg?.mentions?.uniqueAuthors, 0) + ' | mentions ' + safeNum(result?.narrativeOg?.mentions?.mentionCount, 0) : yellow('Аутентичность нарратива') + ' — нет внешнего фида'}`,
    `${result?.narrativeOg?.mentions?.feedConfigured ? ((safeNum(result?.narrativeOg?.mentions?.botLikeRatio, 0) <= 35) ? green('Bot-like ratio') : red('Bot-like ratio')) + ' — ' + fmtPct(result?.narrativeOg?.mentions?.botLikeRatio, 1) + ' | diversity ' + fmtPct(result?.narrativeOg?.mentions?.diversityScore, 1) + ' | sentiment ' + escapeHtml(result?.narrativeOg?.mentions?.sentiment || '-') : yellow('Комментарий по нарративу') + ' — ' + escapeHtml(result?.narrativeOg?.mentions?.note || 'Источник упоминаний не настроен')}`,
    `${yellow('Комментарий')} — ${escapeHtml(result?.narrativeOg?.mentions?.note || result?.narrativeOg?.collision?.note || '-')}`,
    ``,
    `<b>Планы:</b> ${shortPlanList.length ? escapeHtml(shortPlanList.join(', ')) : 'нет'}`,
    `<b>URL:</b> ${escapeHtml(token.url || '-')}`,
  ].filter(Boolean);

  if (monitorEnabled) {
    lines.push('');
    lines.push(yellow('Для этого токена будет временно включен монитор важных изменений накопления.'));
  }

  return lines.join('\n');
}

function buildWalletClusterShortReport(result = {}) {
  const analyzed = result?.analyzed || {};
  const token = analyzed?.token || result?.token || {};
  const holder = analyzed?.holderAccumulation || {};
  const cluster = holder?.walletCluster || null;

  const base = [
    `🧬 <b>WALLET CLUSTER / ВОЗРАСТ КОШЕЛЬКОВ</b>`,
    `<b>${escapeHtml(token.name || token.symbol || 'UNKNOWN')}</b>`,
    `<code>${escapeHtml(token.ca || '')}</code>`,
  ];

  if (!cluster) {
    base.push(yellow('Wallet cluster — данных пока нет'));
    base.push(`Проверь замену файлов: holder-accumulation-engine.js + wallet-cluster-intelligence.js`);
    return base.join('\n');
  }

  const riskScore = safeNum(cluster.clusterRiskScore, 0);
  base.push(`${riskScore >= 70 ? red('Cluster risk') : riskScore >= 45 ? yellow('Cluster risk') : green('Cluster risk')} — ${escapeHtml(cluster.clusterRisk || '-')} / ${riskScore}`);
  base.push(`${yellow('Возраст проверен')} — ${safeNum(cluster.walletAgeKnownCount ?? cluster.trackedWallets, 0)} / ${safeNum(cluster.trackedWallets, 0)} кошельков`);
  base.push(`${safeNum(cluster.avgWalletAgeDays ?? cluster.avgAgeDays, 0) <= 7 ? red('Средний возраст') : safeNum(cluster.avgWalletAgeDays ?? cluster.avgAgeDays, 0) <= 30 ? yellow('Средний возраст') : green('Средний возраст')} — ${fmtNum(cluster.avgWalletAgeDays ?? cluster.avgAgeDays, 1)}д`);
  base.push(`${safeNum(cluster.youngWalletCount7d, 0) >= 5 ? red('Молодые ≤7д / ≤3д') : safeNum(cluster.youngWalletCount7d, 0) >= 3 ? yellow('Молодые ≤7д / ≤3д') : green('Молодые ≤7д / ≤3д')} — ${safeNum(cluster.youngWalletCount7d, 0)} / ${safeNum(cluster.veryYoungWalletCount3d, 0)} | supply ${fmtPct(cluster.youngSupplyPct)}`);
  base.push(`${safeNum(cluster.oldWalletCount30d, 0) >= 6 ? green('Старые >30д') : yellow('Старые >30д')} — ${safeNum(cluster.oldWalletCount30d, 0)} | supply ${fmtPct(cluster.oldSupplyPct)}`);
  base.push(`${safeNum(cluster.sameDayClusterCount, 0) >= 5 ? red('Same-day cluster') : safeNum(cluster.sameDayClusterCount, 0) >= 3 ? yellow('Same-day cluster') : green('Same-day cluster')} — ${safeNum(cluster.sameDayClusterCount, 0)} кош. / ${fmtPct(cluster.sameDayClusterSupplyPct)} supply`);
  base.push(`${safeNum(cluster.sameDayYoungClusterCount, 0) >= 4 ? red('Young same-day cluster') : safeNum(cluster.sameDayYoungClusterCount, 0) >= 2 ? yellow('Young same-day cluster') : green('Young same-day cluster')} — ${safeNum(cluster.sameDayYoungClusterCount, 0)} кош.`);
  base.push(`${safeNum(cluster.sameBuyWindowClusterCount, 0) >= 4 ? red('Same 15m buy-window') : safeNum(cluster.sameBuyWindowClusterCount, 0) >= 2 ? yellow('Same 15m buy-window') : green('Same 15m buy-window')} — ${safeNum(cluster.sameBuyWindowClusterCount, 0)} кош. / ${fmtPct(cluster.sameBuyWindowSupplyPct)} supply`);
  base.push(`${safeNum(cluster.sameFundingClusterCount, 0) >= 4 ? red('Same funding') : safeNum(cluster.sameFundingClusterCount, 0) >= 2 ? yellow('Same funding') : green('Same funding')} — ${safeNum(cluster.sameFundingClusterCount, 0)} кош. / ${fmtPct(cluster.sameFundingSupplyPct)} supply`);
  base.push(`${safeNum(cluster.sameDayBuySizeCv, 999) <= 0.22 ? red('Buy size CV') : safeNum(cluster.sameDayBuySizeCv, 999) <= 0.35 ? yellow('Buy size CV') : green('Buy size CV')} — day ${fmtNum(cluster.sameDayBuySizeCv, 3)} | 15m ${fmtNum(cluster.sameBuyWindowBuySizeCv, 3)} | all ${fmtNum(cluster.globalBuySizeCv, 3)}`);
  if (Array.isArray(cluster.reasons) && cluster.reasons.length) {
    base.push(`🧠 ${escapeHtml(cluster.reasons.slice(0, 3).join(' | '))}`);
  }
  return base.filter(Boolean).join('\n');
}

async function sendLongText(router, chatId, text, options = {}) {
  const maxLen = 3600;
  const rows = String(text || '').split('\n');
  let part = '';

  for (const row of rows) {
    const next = part ? `${part}\n${row}` : row;
    if (next.length > maxLen) {
      if (part) await router.sendMessage(chatId, part, options);
      part = row;
    } else {
      part = next;
    }
  }

  if (part) await router.sendMessage(chatId, part, options);
}

function buildDeltaMessage(prev, next) {
  const deltaControl = round(next.netControlPct - prev.netControlPct, 2);
  const deltaAccum = round(next.netAccumulationPct - prev.netAccumulationPct, 2);
  const deltaRet2h = round(next.retention2hPct - prev.retention2hPct, 2);
  const deltaFresh = next.freshWalletBuyCount - prev.freshWalletBuyCount;
  const deltaMeaningful = safeNum(next.meaningfulWalletCount, 0) - safeNum(prev.meaningfulWalletCount, 0);
  const bullish = [];
  const bearish = [];

  if (!prev.packagingProbeReady && next.packagingProbeReady) bullish.push(green('packaging probe ready'));
  if (!prev.quietAccumulationPass && next.quietAccumulationPass) bullish.push(green('quiet accumulation confirmed'));
  if (!prev.warehouseStoragePass && next.warehouseStoragePass) bullish.push(green('warehouse storage confirmed'));
  if (!prev.bottomPackReversalPass && next.bottomPackReversalPass) bullish.push(green('bottom-pack started'));
  if (!prev.reversalAllow && next.reversalAllow) bullish.push(green(`reversal now allowed (${escapeHtml(next.reversalMode)})`));
  if (deltaControl >= 2.0) bullish.push(green(`cohort control +${deltaControl}%`));
  if (deltaAccum >= 4.0) bullish.push(green(`net accumulation +${deltaAccum}%`));
  if (deltaRet2h >= 10.0) bullish.push(green(`retention 2h +${deltaRet2h}%`));
  if (deltaFresh >= 3) bullish.push(green(`fresh cohort +${deltaFresh}`));
  if (deltaMeaningful >= 2) bullish.push(green(`meaningful holders +${deltaMeaningful}`));
  if (next.bullishHolderGrowthOnWeakness) bullish.push(green('реальные холдеры растут на просадке цены'));

  if (deltaControl <= -6.0) bearish.push(red(`cohort control ${deltaControl}%`));
  if (deltaAccum <= -10.0) bearish.push(red(`net accumulation ${deltaAccum}%`));
  if (deltaRet2h <= -15.0) bearish.push(red(`retention 2h ${deltaRet2h}%`));
  if (deltaMeaningful <= -2) bearish.push(red(`meaningful holders ${deltaMeaningful}`));
  if (prev.quietAccumulationPass && !next.quietAccumulationPass && next.netControlPct < 60) bearish.push(red('quiet accumulation weakened'));

  if (!bullish.length && !bearish.length) return '';

  const positiveOnly = bullish.length > 0 && bearish.length === 0;
  const negativeOnly = bearish.length > 0 && bullish.length === 0;
  const mixed = bullish.length > 0 && bearish.length > 0;
  const header = positiveOnly
    ? `🔼🔼🔼🔼🔼🔼🔼🔔 <b>ACCUMULATION WATCH UPDATE</b>`
    : negativeOnly
      ? `🔻🔻🔻🔻🔻🔻🔻🚨 <b>ACCUMULATION RISK UPDATE</b>`
      : `🔄🔼🔻🔔 <b>ACCUMULATION WATCH UPDATE</b>`;

  const lines = [
    header,
    `<b>Token:</b> <b>${escapeHtml(next.tokenName)}</b>`,
    `<b>CA:</b> <code>${escapeHtml(next.ca)}</code>`,
    `<b>Category:</b> <b>${escapeHtml(next.category)}</b>`,
    `<b>Рост реальных холдеров:</b> ${fmtSignedPct(next.meaningfulHolderGrowthPct ?? 0, 2)}${safeNum(next.holderGrowthWindowMin ?? 0, 0) > 0 ? ` за ${fmtNum(next.holderGrowthWindowMin ?? 0, 0)}м` : ''}`,
    `<b>Цена за окно наблюдения:</b> ${fmtSignedPct(next.priceSinceLastSummaryPct ?? 0, 2)}`,
    `<b>Оценочный контроль когорты:</b> ${fmtApproxPct(Math.min(next.netControlPct, 95), 2)} (${deltaControl >= 0 ? '+' : ''}${deltaControl}%)`,
    `<b>Чистое накопление:</b> ${fmtPct(next.netAccumulationPct)} (${deltaAccum >= 0 ? '+' : ''}${deltaAccum}%)`,
    `<b>Удержание 30м / 2ч / 6ч:</b> ${fmtPct(next.retention30mPct)} / ${fmtPct(next.retention2hPct)} / ${fmtPct(next.retention6hPct)}`,
    `<b>Новая когорта:</b> ${next.freshWalletBuyCount}`,
    `<b>Склад / активно:</b> ${next.warehouseStoragePass ? 'да' : 'нет'} / ${next.activeReaccumulationPass ? 'да' : 'нет'}`,
    `<b>Архетип:</b> ${escapeHtml(next.archetype || '-')}`,
  ];

  if (next.walletCluster) {
    lines.push(
      '',
      '<b>🧬 Возраст кошельков / wallet cluster</b>',
      `<b>Cluster risk:</b> ${escapeHtml(next.clusterRisk || '-')} / ${safeNum(next.clusterRiskScore, 0)}`,
      `<b>Возраст проверен:</b> ${safeNum(next.walletAgeKnownCount, 0)} known / ${safeNum(next.walletAgeUnknownCount, 0)} unknown`,
      `<b>Средний возраст:</b> ${fmtNum(next.avgWalletAgeDays, 1)}д`,
      `<b>Молодые ≤7д / ≤3д:</b> ${safeNum(next.youngWalletCount7d, 0)} / ${safeNum(next.veryYoungWalletCount3d, 0)}`,
      `<b>Старые >30д:</b> ${safeNum(next.oldWalletCount30d, 0)}`,
      `<b>Same-day / same 15m:</b> ${safeNum(next.sameDayClusterCount, 0)} / ${safeNum(next.sameBuyWindowClusterCount, 0)}`,
      `<b>Same funding:</b> ${safeNum(next.sameFundingClusterCount, 0)}`,
      `<b>Buy size CV:</b> day ${fmtNum(next.sameDayBuySizeCv, 3)} | 15m ${fmtNum(next.sameBuyWindowBuySizeCv, 3)} | global ${fmtNum(next.globalBuySizeCv, 3)}`
    );
  }


  if (bullish.length) {
    lines.push('', '<b>🟢 Позитивные изменения</b>', ...bullish.map((x) => `• ${x}`));
  }
  if (bearish.length) {
    lines.push('', '<b>🔴 Риски / ухудшение</b>', ...bearish.map((x) => `• ${x}`));
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
      if (result) { result.narrativeOg = await buildNarrativeOgIntel(result); return result; }
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

  const result = { analyzed, plans, heroImage: token?.imageUrl || null };
  result.narrativeOg = await buildNarrativeOgIntel(result);
  return result;
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
        // Emergency v4: send wallet-cluster/age as a separate short message BEFORE the full report.
        // Even if an old path still uses photo captions, this block cannot be hidden by caption truncation.
        await router.sendMessage(chatId, buildWalletClusterShortReport(result), { reply_markup: router.keyboard() });
        // Send the full report as normal messages, not as a photo caption.
        await sendLongText(router, chatId, caption, { reply_markup: router.keyboard() });

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
