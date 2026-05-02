function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asText(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function normalizePct(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).replace(/[%,$]/g, "").replace(/,/g, "").trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeUsd(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).replace(/[$,]/g, "").trim().toLowerCase().replace(/[.。]+$/g, "");
  const match = raw.match(/^(-?\d+(?:\.\d+)?)(k|m|b)?$/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const mult = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "b" ? 1_000_000_000 : 1;
  return base * mult;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    return value;
  }
  return null;
}

function boolFromText(value) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (["true", "yes", "y", "1", "detected", "has", "found"].includes(text)) return true;
  if (["false", "no", "n", "0", "none", "not_found", "not found"].includes(text)) return false;
  return null;
}

function normalizeName(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^and\s+/i, "")
    .replace(/^[.。:;\s]+/g, "")
    .replace(/[.。]+$/g, "")
    .trim();
}

function splitNameList(text = "") {
  return String(text || "")
    .replace(/\s+and\s+/gi, ",")
    .split(",")
    .map(normalizeName)
    .filter(Boolean)
    .filter((name) => !/^top holders?$/i.test(name))
    .slice(0, 12);
}

function appendQuery(url, ca) {
  const text = String(url || "").trim();
  if (!text) return "";
  if (text.includes("{ca}")) return text.replaceAll("{ca}", encodeURIComponent(ca));
  const sep = text.includes("?") ? "&" : "?";
  return `${text}${sep}ca=${encodeURIComponent(ca)}`;
}

function deepMerge(base = {}, extra = {}) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length) out[key] = value;
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      out[key] = deepMerge(out[key] && typeof out[key] === "object" ? out[key] : {}, value);
      continue;
    }
    if (value !== "") out[key] = value;
  }
  return out;
}

export default class DevsNightmareService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.enabled = String(options.enabled ?? process.env.DEVSNIGHTMARE_ENABLED ?? "auto").toLowerCase();
    this.apiUrl = asText(options.apiUrl || process.env.DEVSNIGHTMARE_API_URL || "");
    this.apiKey = asText(options.apiKey || process.env.DEVSNIGHTMARE_API_KEY || "");
    this.authHeader = asText(options.authHeader || process.env.DEVSNIGHTMARE_AUTH_HEADER || "x-api-key");
    this.bearerToken = asText(options.bearerToken || process.env.DEVSNIGHTMARE_BEARER_TOKEN || "");
    this.timeoutMs = Number(options.timeoutMs || process.env.DEVSNIGHTMARE_TIMEOUT_MS || 6500);
    this.cacheTtlMs = Number(options.cacheTtlMs || process.env.DEVSNIGHTMARE_CACHE_TTL_MS || 5 * 60 * 1000);
    this.cache = new Map();
  }

  initialize() {
    return true;
  }

  isEnabled() {
    if (this.enabled === "false" || this.enabled === "0" || this.enabled === "off") return false;
    if (this.enabled === "true" || this.enabled === "1" || this.enabled === "on") return true;
    return Boolean(this.apiUrl);
  }

  cacheKey(ca = "") {
    return String(ca || "").trim();
  }

  getCached(ca = "") {
    const key = this.cacheKey(ca);
    const row = this.cache.get(key);
    if (!row) return null;
    if (Date.now() - safeNum(row.savedAt, 0) > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return row.value;
  }

  setCached(ca = "", value = null) {
    const key = this.cacheKey(ca);
    if (!key || !value) return;
    this.cache.set(key, { savedAt: Date.now(), value });
  }

  buildHeaders() {
    const headers = { accept: "application/json, text/plain;q=0.9" };
    if (this.apiKey) headers[this.authHeader] = this.apiKey;
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    return headers;
  }

  async fetchJsonOrText(url) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(),
        signal: controller.signal
      });

      const contentType = String(res.headers?.get?.("content-type") || "").toLowerCase();
      const bodyText = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          statusText: res.statusText,
          text: bodyText.slice(0, 500)
        };
      }

      if (contentType.includes("application/json")) {
        try {
          return { ok: true, json: JSON.parse(bodyText), text: bodyText };
        } catch (_) {
          return { ok: true, text: bodyText };
        }
      }

      try {
        return { ok: true, json: JSON.parse(bodyText), text: bodyText };
      } catch (_) {
        return { ok: true, text: bodyText };
      }
    } finally {
      clearTimeout(id);
    }
  }

  async fetchTokenIntel(ca, context = {}) {
    const mint = asText(ca || context?.token?.ca || context?.candidate?.token?.ca);
    if (!mint || !this.isEnabled()) return null;

    const cached = this.getCached(mint);
    if (cached) return cached;

    const url = appendQuery(this.apiUrl, mint);
    if (!url) return null;

    try {
      const response = await this.fetchJsonOrText(url);
      if (!response?.ok) {
        this.logger.log?.("devsnightmare fetch failed:", response?.status, response?.statusText || response?.text || "");
        return {
          source: "devsnightmare",
          status: "unavailable",
          unavailableReason: `HTTP ${response?.status || "error"}`
        };
      }

      const normalized = this.normalizeResponse(response.json ?? response.text, {
        ca: mint,
        rawText: response.text
      });
      this.setCached(mint, normalized);
      return normalized;
    } catch (error) {
      this.logger.log?.("devsnightmare fetch error:", error?.message || String(error));
      return {
        source: "devsnightmare",
        status: "unavailable",
        unavailableReason: String(error?.message || error).slice(0, 180)
      };
    }
  }

  normalizeResponse(payload, meta = {}) {
    const root = this.unwrapPayload(payload);
    const rawText = asText(
      meta.rawText ||
      (typeof payload === "string" ? payload : "") ||
      root?.text ||
      root?.message ||
      root?.report ||
      root?.summary ||
      root?.description ||
      ""
    );

    const parsedText = rawText ? this.parseTextReport(rawText) : {};
    const structured = this.normalizeStructuredPayload(root || {});

    return deepMerge(structured, {
      ...parsedText,
      source: "devsnightmare",
      provider: "Devs Nightmare",
      status: structured?.status || parsedText?.status || "ok",
      ca: meta.ca || parsedText?.ca || structured?.ca || "",
      rawSummary: rawText ? rawText.slice(0, 900) : structured?.rawSummary || "",
      fetchedAt: Date.now()
    });
  }

  unwrapPayload(payload) {
    if (typeof payload === "string") return { text: payload };
    if (!payload || typeof payload !== "object") return {};
    return (
      payload.data?.token ||
      payload.data?.result ||
      payload.data?.intel ||
      payload.data ||
      payload.result?.token ||
      payload.result?.intel ||
      payload.result ||
      payload.intel ||
      payload.report ||
      payload
    );
  }

  normalizeStructuredPayload(root = {}) {
    const snipers = root.snipers || root.sniper || root.sniperInfo || {};
    const insiders = root.insiders || root.insider || root.insiderInfo || {};
    const team = root.team || root.teamInfo || root.teamHolders || {};
    const dev = root.dev || root.developer || root.creator || {};
    const holders = root.holders || root.holderStats || root.topHoldersStats || {};
    const bubble = root.bubblemap || root.bubbleMap || root.bubbles || {};

    const hasSnipers = pickFirst(
      boolFromText(snipers.hasSnipers),
      boolFromText(snipers.detected),
      boolFromText(root.hasSnipers),
      boolFromText(root.snipersDetected)
    );
    const hasInsiders = pickFirst(
      boolFromText(insiders.hasInsiders),
      boolFromText(insiders.detected),
      boolFromText(root.hasInsiders),
      boolFromText(root.insidersDetected)
    );

    const cexFundingMap = this.normalizeFundingMap(
      root.cexFundingMap ||
      root.cexMap ||
      root.fundingMap ||
      root.funding ||
      root.cexFunding ||
      bubble.cexFundingMap ||
      bubble.cexMap ||
      {}
    );

    const topHolders = this.normalizeTopHolders(
      root.topHolders ||
      holders.topHolders ||
      holders.top ||
      root.holderNames ||
      []
    );

    return {
      ca: asText(root.ca || root.mint || root.address || ""),
      snipers: {
        hasSnipers,
        count: safeNum(pickFirst(snipers.count, snipers.wallets, root.sniperCount), 0),
        pct: safeNum(pickFirst(snipers.pct, snipers.percent, snipers.supplyPct, root.sniperPct), 0)
      },
      insiders: {
        hasInsiders,
        count: safeNum(pickFirst(insiders.count, insiders.wallets, root.insiderCount), 0),
        pct: safeNum(pickFirst(insiders.pct, insiders.percent, insiders.supplyPct, root.insiderPct, root.insidersPct), 0)
      },
      teamHoldPct: safeNum(pickFirst(root.teamHoldPct, root.teamPct, team.pct, team.percent, team.holdPct, team.supplyPct), 0),
      devName: asText(pickFirst(root.devName, root.developerName, dev.name, dev.label, dev.username), ""),
      bubblemap: {
        majorClusters: pickFirst(
          boolFromText(bubble.majorClusters),
          boolFromText(bubble.hasMajorClusters),
          boolFromText(root.majorClusters),
          null
        ),
        cexClusterPct: safeNum(pickFirst(bubble.cexClusterPct, root.cexClusterPct, root.cexMapClusterPct), 0),
        note: asText(bubble.note || root.bubblemapNote || "")
      },
      cexFundingMap,
      top10Pct: safeNum(pickFirst(root.top10Pct, holders.top10Pct, holders.top10), 0),
      top70Pct: pickFirst(root.top70Pct, holders.top70Pct, holders.top70) === null ? null : safeNum(pickFirst(root.top70Pct, holders.top70Pct, holders.top70), 0),
      holderCount: safeNum(pickFirst(root.holderCount, root.holdersCount, holders.count, holders.holderCount), 0),
      avgBagUsd: safeNum(pickFirst(root.avgBagUsd, root.averageBagUsd, holders.avgBagUsd, holders.averageBagUsd), 0),
      topHolders,
      rawSummary: asText(root.rawSummary || root.summary || root.text || "")
    };
  }

  normalizeFundingMap(value) {
    if (!value) return {};
    if (Array.isArray(value)) {
      const out = {};
      for (const row of value) {
        const label = asText(row?.label || row?.source || row?.name || "");
        const pct = normalizePct(row?.pct ?? row?.percent ?? row?.supplyPct ?? row?.value);
        if (label && pct !== null) out[label] = pct;
      }
      return out;
    }
    if (typeof value === "object") {
      const out = {};
      for (const [source, raw] of Object.entries(value)) {
        const pct = typeof raw === "object" ? normalizePct(raw?.pct ?? raw?.percent ?? raw?.supplyPct ?? raw?.value) : normalizePct(raw);
        if (source && pct !== null) out[source] = pct;
      }
      return out;
    }
    return {};
  }

  normalizeTopHolders(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map((row) => typeof row === "string"
          ? { name: normalizeName(row) }
          : {
              name: normalizeName(row?.name || row?.label || row?.ownerLabel || row?.wallet || row?.address || ""),
              pct: normalizePct(row?.pct ?? row?.percent ?? row?.supplyPct)
            })
        .filter((row) => row.name)
        .slice(0, 12);
    }
    if (typeof value === "string") {
      return splitNameList(value).map((name) => ({ name }));
    }
    return [];
  }

  parseTextReport(input = "") {
    const text = String(input || "").replace(/\s+/g, " ").trim();
    if (!text) return {};

    const lower = text.toLowerCase();
    const out = {
      source: "devsnightmare",
      provider: "Devs Nightmare",
      status: "ok",
      rawSummary: text.slice(0, 900)
    };

    const caMatch = text.match(/\bCA\s+([1-9A-HJ-NP-Za-km-z]{32,44})\b/i) || text.match(/\(([1-9A-HJ-NP-Za-km-z]{32,44})\)/);
    if (caMatch) out.ca = caMatch[1];

    const noSnipers = /doesn['’]?t\s+have\s+snipers|no\s+snipers/i.test(text);
    const noSnipersAndInsiders = /doesn['’]?t\s+have\s+snipers\s+and\s+insiders/i.test(text);
    const noInsiders = noSnipersAndInsiders || /doesn['’]?t\s+have\s+insiders|no\s+insiders/i.test(text);

    const sniperPct = noSnipers ? 0 : pickFirst(
      normalizePct(text.match(/snipers?\s+(?:have|has|hold|holds)\s+([\d.,]+)%/i)?.[1]),
      normalizePct(text.match(/snipers?[^.]{0,35}?([\d.,]+)%/i)?.[1])
    );
    const insiderPct = noInsiders ? 0 : pickFirst(
      normalizePct(text.match(/insiders?\s+(?:have|has|hold|holds)\s+([\d.,]+)%/i)?.[1]),
      normalizePct(text.match(/insiders?[^.]{0,35}?([\d.,]+)%/i)?.[1])
    );
    const teamPct = pickFirst(
      normalizePct(text.match(/team\s+(?:has|have|hold|holds)\s+([\d.,]+)%/i)?.[1]),
      normalizePct(text.match(/team[^.]{0,35}?([\d.,]+)%/i)?.[1])
    );

    out.snipers = {
      hasSnipers: noSnipers ? false : sniperPct !== null ? sniperPct > 0 : null,
      pct: sniperPct || 0,
      count: 0
    };
    out.insiders = {
      hasInsiders: noInsiders ? false : insiderPct !== null ? insiderPct > 0 : null,
      pct: insiderPct || 0,
      count: 0
    };
    if (teamPct !== null) out.teamHoldPct = teamPct;

    const devMatch = text.match(/([A-Za-z0-9_.-]{2,40})\s+is\s+the\s+dev\b/i) || text.match(/dev\s*(?:is|:|-)?\s*([A-Za-z0-9_.-]{2,40})/i);
    if (devMatch) out.devName = normalizeName(devMatch[1]);

    const topHoldersMatch = text.match(/([A-Za-z0-9_.$\-\s,]+?)\s+are\s+top\s+holders?/i);
    if (topHoldersMatch) {
      out.topHolders = splitNameList(topHoldersMatch[1]).map((name) => ({ name }));
    }

    const noMajorClusters = /no\s+major\s+clusters?\s+on\s+the\s+bubble\s*map|no\s+major\s+clusters?\s+on\s+bubblemap/i.test(text);
    const cexClusterPct = normalizePct(text.match(/CEX\s+map\s+cluster\s+(?:has|have|holds?)\s+([\d.,]+)%/i)?.[1]);
    out.bubblemap = {
      majorClusters: noMajorClusters ? false : null,
      cexClusterPct: cexClusterPct || 0,
      note: noMajorClusters ? "No major clusters on Bubblemap" : ""
    };

    const fundingMap = {};
    const fundingRegex = /(Binance|Coinbase|MEXC|Mexc|Change\s*Now|ChangeNOW|KuCoin|Kucoin|OKX|Bybit|Gate|Bitget|Kraken|HTX|Huobi|Crypto\.com)\s*(?:funded\s+wallets\s*)?(?:have|has|holds?)?\s*([\d.,]+)%/gi;
    let match;
    while ((match = fundingRegex.exec(text))) {
      const label = match[1].replace(/\s+/g, " ").trim();
      const pct = normalizePct(match[2]);
      if (pct !== null) fundingMap[label] = pct;
    }
    out.cexFundingMap = fundingMap;

    const top70Pct = normalizePct(text.match(/top\s*70\s+holders?\s+(?:have|has|hold|holds)\s+([\d.,]+)%/i)?.[1]);
    const top10Pct = normalizePct(text.match(/top\s*10\s+(?:holders?\s+)?(?:have|has|hold|holds)\s+([\d.,]+)%/i)?.[1]);
    const holderCount = safeNum(text.match(/([\d,]+)\s+holders?\s+with\s+an?\s+average\s+bag/i)?.[1]?.replace(/,/g, ""), 0);
    const avgBagUsd = normalizeUsd(text.match(/average\s+bag\s+(?:at|of)?\s*\$?([\d.,]+[kmb]?)/i)?.[1]);

    if (top70Pct !== null) out.top70Pct = top70Pct;
    if (top10Pct !== null) out.top10Pct = top10Pct;
    if (holderCount > 0) out.holderCount = holderCount;
    if (avgBagUsd !== null) out.avgBagUsd = avgBagUsd;

    if (/\bNFA\b/i.test(text)) out.nfa = true;
    return out;
  }
}
