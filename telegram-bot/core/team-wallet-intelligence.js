import { Connection, PublicKey } from "@solana/web3.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function round(v, d = 2) {
  const p = 10 ** d;
  return Math.round((safeNum(v, 0) + Number.EPSILON) * p) / p;
}

function fmtPct(v, d = 2) {
  return `${round(v, d)}%`;
}

function fmtNum(v, d = 2) {
  return `${round(v, d)}`;
}

function fmtUsd(v, d = 2) {
  const n = safeNum(v, 0);
  if (n >= 1000000) return `$${fmtNum(n / 1000000, 2)}M`;
  if (n >= 1000) return `$${fmtNum(n / 1000, 2)}K`;
  return `$${fmtNum(n, d)}`;
}

function fmtSigned(v, d = 2, suffix = "") {
  const n = round(v, d);
  return `${n > 0 ? "+" : ""}${n}${suffix}`;
}

function shortWallet(wallet = "") {
  const w = asText(wallet, "-");
  if (w.length <= 12) return w;
  return `${w.slice(0, 5)}…${w.slice(-5)}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function bucketByMs(ts, bucketMs) {
  const t = safeNum(ts, 0);
  if (!t) return 0;
  return Math.floor(t / bucketMs);
}

function maxBucket(rows = [], keyFn = () => "") {
  const map = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) || "");
    if (!key || key === "0") continue;
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }
  let key = "";
  let bucketRows = [];
  for (const [k, list] of map.entries()) {
    if (list.length > bucketRows.length) {
      key = k;
      bucketRows = list;
    }
  }
  return { key, rows: bucketRows, count: bucketRows.length };
}

function coefficientOfVariation(values = []) {
  const nums = values.map((x) => safeNum(x, 0)).filter((x) => x > 0);
  if (nums.length < 2) return 999;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean <= 0) return 999;
  const variance = nums.reduce((acc, x) => acc + ((x - mean) ** 2), 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

function sum(rows = [], key = "currentTokenAmount") {
  return rows.reduce((acc, row) => acc + safeNum(row?.[key], 0), 0);
}

function uniqueByOwner(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const owner = asText(row?.owner);
    if (!owner) continue;
    const prev = map.get(owner) || {
      owner,
      tokenAccounts: [],
      currentTokenAmount: 0,
      totalBought: 0,
      totalSold: 0,
      totalTransferredIn: 0,
      firstBuyAt: 0,
      firstSeenAt: 0,
      latestBuyAt: 0,
      latestBuyAmount: 0,
      walletFirstActivityAt: 0,
      walletFirstActivityComplete: false,
      fundingSource: "",
      selfBuyer: false,
      transferOnly: false,
      storageLike: false
    };

    prev.tokenAccounts.push(asText(row?.tokenAccount));
    prev.currentTokenAmount += safeNum(row?.currentTokenAmount, 0);
    prev.totalBought += safeNum(row?.totalBought, 0);
    prev.totalSold += safeNum(row?.totalSold, 0);
    prev.totalTransferredIn += safeNum(row?.totalTransferredIn, 0);
    prev.selfBuyer = prev.selfBuyer || Boolean(row?.selfBuyer);
    prev.transferOnly = prev.transferOnly || Boolean(row?.transferOnly);
    prev.storageLike = prev.storageLike || Boolean(row?.storageLike);

    const firstBuyAt = safeNum(row?.firstBuyAt, 0);
    const firstSeenAt = safeNum(row?.firstSeenAt, 0);
    const latestBuyAt = safeNum(row?.latestBuyAt, 0);
    const walletFirstActivityAt = safeNum(row?.walletFirstActivityAt, 0);

    if (firstBuyAt && (!prev.firstBuyAt || firstBuyAt < prev.firstBuyAt)) prev.firstBuyAt = firstBuyAt;
    if (firstSeenAt && (!prev.firstSeenAt || firstSeenAt < prev.firstSeenAt)) prev.firstSeenAt = firstSeenAt;
    if (latestBuyAt && latestBuyAt > prev.latestBuyAt) {
      prev.latestBuyAt = latestBuyAt;
      prev.latestBuyAmount = safeNum(row?.latestBuyAmount, 0);
    }
    if (walletFirstActivityAt && (!prev.walletFirstActivityAt || walletFirstActivityAt < prev.walletFirstActivityAt)) {
      prev.walletFirstActivityAt = walletFirstActivityAt;
    }
    prev.walletFirstActivityComplete = prev.walletFirstActivityComplete || row?.walletFirstActivityComplete === true;
    if (!prev.fundingSource && row?.fundingSource) prev.fundingSource = String(row.fundingSource);

    map.set(owner, prev);
  }
  return [...map.values()];
}

const COMMON_CROSS_PROJECT_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoGQn1Vy9d5U8rWkzH", // USDT
  "So11111111111111111111111111111111111111112", // wSOL
  "So11111111111111111111111111111111111111111"
]);

function isCommonCrossProjectMint(mint = "") {
  return COMMON_CROSS_PROJECT_MINTS.has(asText(mint));
}

function isStableOrBaseAssetProject(meta = {}) {
  const ca = asText(meta?.ca || meta?.address || meta?.mint);
  const name = String(meta?.name || "").toLowerCase();
  const symbol = String(meta?.symbol || "").toLowerCase().replace(/^\$/, "");
  if (isCommonCrossProjectMint(ca)) return true;
  const stableSymbols = new Set(["usdc", "usdt", "usd", "usds", "pyusd", "uxd"]);
  if (stableSymbols.has(symbol)) return true;
  if (name.includes("usd coin") || name.includes("tether")) return true;
  if (symbol === "sol" || symbol === "wsol" || name === "wrapped sol" || name === "solana") return true;
  return false;
}

function hasUsefulProjectMeta(meta = {}) {
  if (!meta || isStableOrBaseAssetProject(meta)) return false;
  return Boolean(asText(meta?.ca));
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { accept: "application/json", ...(options.headers || {}) }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(id);
  }
}

export default class TeamWalletIntelligence {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || "";
    this.connection = options.connection || null;
    this.holderAccumulationEngine = options.holderAccumulationEngine || null;
    this.holderStore = options.holderStore || options.holderAccumulationStore || null;
    this.store = options.store || null;
    this.maxTrackedWallets = Number(options.maxTrackedWallets || 30);
    this.maxMintSignatures = Number(options.maxMintSignatures || 80);
    this.maxDevLaunches = Number(options.maxDevLaunches || process.env.DEV_HISTORY_LIMIT || 30);
    this.devHistoryTtlMs = Number(options.devHistoryTtlMs || 6 * 60 * 60 * 1000);
    this.maxCrossProjectWallets = Number(options.maxCrossProjectWallets || process.env.CROSS_PROJECT_WALLET_LIMIT || 12);
    this.maxCrossProjectTokensPerWallet = Number(options.maxCrossProjectTokensPerWallet || process.env.CROSS_PROJECT_TOKENS_PER_WALLET || 40);
    this.maxCrossProjectReportRows = Number(options.maxCrossProjectReportRows || process.env.CROSS_PROJECT_REPORT_ROWS || 6);
    this.whaleSupplyPct = Number(options.whaleSupplyPct || process.env.WHALE_SUPPLY_PCT || 1);
    this.whaleBuySupplyPct = Number(options.whaleBuySupplyPct || process.env.WHALE_BUY_SUPPLY_PCT || 0.5);
    this.whaleBuyUsd = Number(options.whaleBuyUsd || process.env.WHALE_BUY_USD || 500);

    // Optional external intel adapter. Works with Devs Nightmare/private APIs when configured.
    // If no API is configured, local RPC/holder analysis keeps working as before.
    this.externalIntelService = options.externalIntelService || options.devsNightmareService || null;
  }

  async initialize() {
    if (this.store?.initialize) await this.store.initialize();
    if (this.holderStore?.initialize) await this.holderStore.initialize();
    if (this.holderAccumulationEngine?.initialize) await this.holderAccumulationEngine.initialize();
    if (this.rpcUrl && !this.connection) {
      this.connection = new Connection(this.rpcUrl, "confirmed");
    }
    return true;
  }

  async getTokenSupply(mint) {
    if (!this.connection || !mint) return 0;
    try {
      const supply = await this.connection.getTokenSupply(new PublicKey(mint));
      return safeNum(supply?.value?.uiAmount, 0);
    } catch (error) {
      this.logger.log?.("team intel token supply error:", error.message);
      return 0;
    }
  }

  async detectDevWallet(mint) {
    if (!this.connection || !mint) {
      return { devWallet: "", createdAt: 0, source: "no_rpc" };
    }

    try {
      const mintKey = new PublicKey(mint);
      const signatures = await this.connection.getSignaturesForAddress(mintKey, { limit: this.maxMintSignatures });
      if (!Array.isArray(signatures) || !signatures.length) {
        return { devWallet: "", createdAt: 0, source: "no_mint_signatures" };
      }

      const oldestRows = [...signatures].reverse().slice(0, 8);
      for (const sigRow of oldestRows) {
        const tx = await this.connection.getParsedTransaction(sigRow.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
        const keys = Array.isArray(tx?.transaction?.message?.accountKeys) ? tx.transaction.message.accountKeys : [];
        const signers = keys
          .filter((row) => row?.signer === true || row?.signer === 1 || row?.signer === "true")
          .map((row) => asText(row?.pubkey?.toBase58?.() || row?.pubkey || row || ""))
          .filter(Boolean)
          .filter((key) => key !== mint);

        if (signers.length) {
          return {
            devWallet: signers[0],
            createdAt: safeNum(sigRow?.blockTime, 0) * 1000,
            source: "mint_first_signer_heuristic"
          };
        }
      }

      return {
        devWallet: "",
        createdAt: safeNum(signatures[signatures.length - 1]?.blockTime, 0) * 1000,
        source: "mint_signatures_no_signer"
      };
    } catch (error) {
      this.logger.log?.("team intel dev wallet detect error:", error.message);
      return { devWallet: "", createdAt: 0, source: "error" };
    }
  }

  async fetchPumpFunDevHistory(devWallet) {
    const dev = asText(devWallet);
    if (!dev) return null;

    const cached = this.store?.getDevHistory?.(dev);
    if (cached && Date.now() - safeNum(cached?.updatedAt, 0) < this.devHistoryTtlMs) {
      return cached;
    }

    const customTemplate = asText(process.env.DEV_HISTORY_QUERY_URL || "");
    const templates = customTemplate
      ? [customTemplate]
      : [
          "https://frontend-api.pump.fun/coins/user-created-coins/{wallet}?offset=0&limit={limit}&includeNsfw=true",
          "https://frontend-api-v2.pump.fun/coins/user-created-coins/{wallet}?offset=0&limit={limit}&includeNsfw=true",
          "https://frontend-api-v3.pump.fun/coins/user-created-coins/{wallet}?offset=0&limit={limit}&includeNsfw=true"
        ];

    let rows = [];
    let source = "";
    for (const template of templates) {
      const url = template
        .replace(/\{wallet\}/g, encodeURIComponent(dev))
        .replace(/\{limit\}/g, String(this.maxDevLaunches));
      const json = await fetchJsonWithTimeout(url, {}, 6500);
      const candidates = Array.isArray(json)
        ? json
        : Array.isArray(json?.coins)
          ? json.coins
          : Array.isArray(json?.data)
            ? json.data
            : [];
      if (candidates.length) {
        rows = candidates.slice(0, this.maxDevLaunches);
        source = url.includes("{wallet}") ? "custom" : "pumpfun_user_created_coins";
        break;
      }
    }

    const launches = rows.map((row) => {
      const createdAt = safeNum(row?.created_timestamp || row?.createdAt || row?.created_at, 0);
      const normalizedCreatedAt = createdAt > 0 && createdAt < 10_000_000_000 ? createdAt * 1000 : createdAt;
      const usdMarketCap = safeNum(row?.usd_market_cap ?? row?.market_cap ?? row?.marketCap, 0);
      const replies = safeNum(row?.reply_count ?? row?.replies, 0);
      const complete = Boolean(row?.complete || row?.raydium_pool || row?.king_of_the_hill_timestamp);
      const ageHours = normalizedCreatedAt > 0 ? Math.max(0, (Date.now() - normalizedCreatedAt) / 3600000) : 0;
      const deadLike = Boolean(
        ageHours >= 2 &&
        !complete &&
        usdMarketCap > 0 &&
        usdMarketCap < 8000
      );
      const rugLike = Boolean(
        ageHours >= 4 &&
        !complete &&
        usdMarketCap > 0 &&
        usdMarketCap < 5000 &&
        replies <= 3
      );
      const successfulLike = Boolean(complete || usdMarketCap >= 30000);
      return {
        mint: asText(row?.mint || row?.address || row?.ca),
        name: asText(row?.name || row?.symbol || "UNKNOWN"),
        symbol: asText(row?.symbol || ""),
        createdAt: normalizedCreatedAt,
        usdMarketCap,
        complete,
        replies,
        deadLike,
        rugLike,
        successfulLike
      };
    });

    const history = {
      wallet: dev,
      source: rows.length ? source : "unavailable",
      checkedAt: Date.now(),
      launchesTotal: launches.length,
      scamLikeCount: launches.filter((x) => x.deadLike || x.rugLike).length,
      rugLikeCount: launches.filter((x) => x.rugLike).length,
      deadLikeCount: launches.filter((x) => x.deadLike).length,
      successfulLikeCount: launches.filter((x) => x.successfulLike).length,
      unclearCount: launches.filter((x) => !x.successfulLike && !x.deadLike && !x.rugLike).length,
      launches: launches.slice(0, 10)
    };

    if (this.store?.setDevHistory) await this.store.setDevHistory(dev, history);
    return history;
  }

  async fetchTokenProjectMeta(mint) {
    const ca = asText(mint);
    if (!ca) return null;

    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(ca)}`;
    const json = await fetchJsonWithTimeout(url, {}, 4500);
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    const solPairs = pairs
      .filter((pair) => String(pair?.chainId || '').toLowerCase() === 'solana')
      .sort((a, b) => safeNum(b?.liquidity?.usd, 0) - safeNum(a?.liquidity?.usd, 0));

    const best = solPairs[0] || pairs[0] || null;
    if (!best) {
      return {
        ca,
        name: 'UNKNOWN',
        symbol: '',
        pairAddress: '',
        fdv: 0,
        marketCap: 0,
        liquidityUsd: 0,
        volume24h: 0,
        url: ''
      };
    }

    const baseAddress = asText(best?.baseToken?.address || '');
    const quoteAddress = asText(best?.quoteToken?.address || '');
    const matchedToken = baseAddress === ca
      ? best?.baseToken
      : quoteAddress === ca
        ? best?.quoteToken
        : best?.baseToken;

    const meta = {
      ca,
      name: asText(matchedToken?.name || matchedToken?.symbol || 'UNKNOWN'),
      symbol: asText(matchedToken?.symbol || ''),
      pairAddress: asText(best?.pairAddress || ''),
      fdv: safeNum(best?.fdv, 0),
      marketCap: safeNum(best?.marketCap, 0),
      liquidityUsd: safeNum(best?.liquidity?.usd, 0),
      volume24h: safeNum(best?.volume?.h24, 0),
      url: asText(best?.url || '')
    };

    return {
      ...meta,
      excludedAsCommonAsset: isStableOrBaseAssetProject(meta)
    };
  }

  async fetchWalletTokenMints(owner, currentMint) {
    const wallet = asText(owner);
    const excludeMint = asText(currentMint);
    if (!this.connection || !wallet) return [];

    try {
      const tokenProgramId = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const accounts = await this.connection.getParsedTokenAccountsByOwner(
        new PublicKey(wallet),
        { programId: tokenProgramId }
      );

      return (accounts?.value || [])
        .map((row) => {
          const info = row?.account?.data?.parsed?.info || {};
          const mint = asText(info?.mint || '');
          const amount = safeNum(info?.tokenAmount?.uiAmount, 0);
          return { mint, amount };
        })
        .filter((row) => row.mint && row.mint !== excludeMint && row.amount > 0 && !isCommonCrossProjectMint(row.mint))
        .sort((a, b) => safeNum(b.amount, 0) - safeNum(a.amount, 0))
        .slice(0, this.maxCrossProjectTokensPerWallet);
    } catch (error) {
      this.logger.log?.('team intel wallet portfolio error:', wallet, error.message);
      return [];
    }
  }

  async detectCrossProjectWalletClusters(rows = [], mint = '', groups = {}) {
    const teamWallets = new Set(groups?.team?.wallets || []);
    const sniperWallets = new Set(groups?.snipers15m?.wallets || []);

    const priorityRows = rows
      .map((row) => ({
        ...row,
        priorityScore:
          (teamWallets.has(row.owner) ? 100 : 0) +
          (sniperWallets.has(row.owner) ? 40 : 0) +
          safeNum(row?.supplyPct, 0)
      }))
      .sort((a, b) => safeNum(b.priorityScore, 0) - safeNum(a.priorityScore, 0))
      .slice(0, this.maxCrossProjectWallets);

    const projectMap = new Map();
    const walletRows = [];

    for (const row of priorityRows) {
      const owner = asText(row?.owner);
      if (!owner) continue;

      const tokens = await this.fetchWalletTokenMints(owner, mint);
      walletRows.push({ owner, tokenCount: tokens.length, tokens: tokens.map((x) => x.mint).slice(0, 12) });

      for (const token of tokens) {
        const entry = projectMap.get(token.mint) || {
          ca: token.mint,
          wallets: new Set(),
          totalTokenAmountObserved: 0
        };
        entry.wallets.add(owner);
        entry.totalTokenAmountObserved += safeNum(token.amount, 0);
        projectMap.set(token.mint, entry);
      }
    }

    const clustered = [...projectMap.values()]
      .map((entry) => ({
        ca: entry.ca,
        walletCount: entry.wallets.size,
        wallets: [...entry.wallets],
        totalTokenAmountObserved: entry.totalTokenAmountObserved
      }))
      .filter((entry) => entry.walletCount >= 2)
      .sort((a, b) => safeNum(b.walletCount, 0) - safeNum(a.walletCount, 0))
      .slice(0, this.maxCrossProjectReportRows);

    const projects = [];
    const skippedCommonProjects = [];
    for (const entry of clustered) {
      const meta = await this.fetchTokenProjectMeta(entry.ca);
      const project = {
        ...entry,
        ...(meta || {})
      };
      if (!hasUsefulProjectMeta(project)) {
        skippedCommonProjects.push(project);
        continue;
      }
      projects.push(project);
    }

    projects.sort((a, b) =>
      safeNum(b.walletCount, 0) - safeNum(a.walletCount, 0) ||
      safeNum(b.liquidityUsd, 0) - safeNum(a.liquidityUsd, 0)
    );

    const checkedWallets = priorityRows.length;
    const walletsWithOtherTokens = walletRows.filter((row) => safeNum(row?.tokenCount, 0) > 0).length;
    const maxClusterWallets = projects.length ? Math.max(...projects.map((proj) => safeNum(proj.walletCount, 0))) : 0;

    let riskScore = 0;
    const reasons = [];
    if (maxClusterWallets >= 5) {
      riskScore += 30;
      reasons.push('много отслеженных кошельков также сидят в одном внешнем проекте');
    } else if (maxClusterWallets >= 3) {
      riskScore += 16;
      reasons.push('несколько отслеженных кошельков пересекаются в другом проекте');
    }
    if (projects.length >= 3) {
      riskScore += 12;
      reasons.push('повторяющиеся пересечения кошельков между проектами');
    }
    if (checkedWallets > 0 && walletsWithOtherTokens / checkedWallets >= 0.75) {
      riskScore += 10;
      reasons.push('большинство проверенных team/sniper кошельков держат другие проекты');
    }

    return {
      checkedWallets,
      walletsWithOtherTokens,
      clusteredProjectCount: projects.length,
      skippedCommonProjectCount: skippedCommonProjects.length,
      maxClusterWallets,
      riskScore: clamp(Math.round(riskScore), 0, 100),
      riskLevel: riskScore >= 45 ? 'HIGH' : riskScore >= 25 ? 'MEDIUM' : riskScore >= 10 ? 'WATCH' : 'LOW',
      projects,
      reasons
    };
  }

  detectWhaleBuys(rows = [], totalSupply = 0, token = {}) {
    const price = safeNum(token?.price, 0);
    const whaleRows = rows
      .map((row) => {
        const currentAmount = safeNum(row?.currentTokenAmount, 0);
        const totalBought = safeNum(row?.totalBought, 0);
        const totalTransferredIn = safeNum(row?.totalTransferredIn, 0);
        const latestBuyAmount = safeNum(row?.latestBuyAmount, 0);
        const totalSold = safeNum(row?.totalSold, 0);
        const supplyPct = safeNum(row?.supplyPct, 0);
        const totalBoughtPct = totalSupply > 0 ? (totalBought / totalSupply) * 100 : 0;
        const latestBuyPct = totalSupply > 0 ? (latestBuyAmount / totalSupply) * 100 : 0;
        const currentUsd = currentAmount * price;
        const latestBuyUsd = latestBuyAmount * price;
        const totalBoughtUsd = totalBought * price;
        const hasSelfBuy = totalBought > 0 || Boolean(row?.selfBuyer);
        const holdingPct = hasSelfBuy
          ? clamp((currentAmount / Math.max(totalBought, 0.0000001)) * 100, 0, 100)
          : null;
        const soldPct = hasSelfBuy
          ? clamp((totalSold / Math.max(totalBought, 0.0000001)) * 100, 0, 100)
          : null;
        const isBuyWhale = Boolean(
          latestBuyPct >= this.whaleBuySupplyPct ||
          totalBoughtPct >= this.whaleSupplyPct ||
          latestBuyUsd >= this.whaleBuyUsd
        );
        const isHolderWhale = Boolean(
          supplyPct >= this.whaleSupplyPct ||
          currentUsd >= this.whaleBuyUsd
        );
        const isWhale = isBuyWhale || isHolderWhale;
        const status = isBuyWhale
          ? (holdingPct !== null && holdingPct >= 60 ? 'buy_holding' : holdingPct !== null && holdingPct <= 40 ? 'buy_reduced' : 'buy_partial')
          : (totalTransferredIn > 0 ? 'holder_transfer' : 'holder_only');
        return {
          owner: row?.owner,
          currentAmount,
          totalBought,
          totalTransferredIn,
          latestBuyAmount,
          supplyPct,
          totalBoughtPct,
          latestBuyPct,
          currentUsd,
          latestBuyUsd,
          totalBoughtUsd,
          holdingPct,
          soldPct,
          latestBuyAt: safeNum(row?.latestBuyAt, 0),
          hasSelfBuy,
          isBuyWhale,
          isHolderWhale,
          status,
          isWhale
        };
      })
      .filter((row) => row.isWhale)
      .sort((a, b) =>
        safeNum(b.supplyPct, 0) - safeNum(a.supplyPct, 0) ||
        safeNum(b.latestBuyPct, 0) - safeNum(a.latestBuyPct, 0)
      );

    const buyWhaleRows = whaleRows.filter((row) => row.isBuyWhale);
    const holderWhaleRows = whaleRows.filter((row) => row.isHolderWhale);
    const holdingRows = whaleRows.filter((row) =>
      safeNum(row?.currentAmount, 0) > 0 &&
      (row.holdingPct === null || safeNum(row?.holdingPct, 0) >= 60)
    );
    const dumpingRows = whaleRows.filter((row) =>
      row.hasSelfBuy &&
      (safeNum(row?.soldPct, 0) >= 50 || safeNum(row?.holdingPct, 0) <= 40)
    );
    const totalCurrentAmount = whaleRows.reduce((acc, row) => acc + safeNum(row.currentAmount, 0), 0);
    const totalBoughtAmount = buyWhaleRows.reduce((acc, row) => acc + safeNum(row.totalBought, 0), 0);
    const latestBuyAmountSum = buyWhaleRows.reduce((acc, row) => acc + safeNum(row.latestBuyAmount, 0), 0);

    let signal = 'LOW';
    if (whaleRows.length >= 3 && totalSupply > 0 && (totalCurrentAmount / totalSupply) * 100 >= 3) signal = 'STRONG';
    else if (whaleRows.length >= 2 || (totalSupply > 0 && (totalCurrentAmount / totalSupply) * 100 >= 1.5)) signal = 'WATCH';

    return {
      whaleCount: whaleRows.length,
      buyWhaleCount: buyWhaleRows.length,
      holderWhaleCount: holderWhaleRows.length,
      holdingWhaleCount: holdingRows.length,
      dumpingWhaleCount: dumpingRows.length,
      totalCurrentAmount,
      totalCurrentPct: totalSupply > 0 ? (totalCurrentAmount / totalSupply) * 100 : 0,
      totalBoughtAmount,
      totalBoughtPct: totalSupply > 0 ? (totalBoughtAmount / totalSupply) * 100 : 0,
      latestBuyAmountSum,
      latestBuyPctSum: totalSupply > 0 ? (latestBuyAmountSum / totalSupply) * 100 : 0,
      currentUsd: totalCurrentAmount * price,
      totalBoughtUsd: totalBoughtAmount * price,
      signal,
      rows: whaleRows.slice(0, 7)
    };
  }

  normalizeRowsWithSupply(records = [], totalSupply = 0) {
    const rows = uniqueByOwner(records).map((row) => ({ ...row }));
    const totalTracked = sum(rows, "currentTokenAmount");
    return rows.map((row) => {
      const amount = safeNum(row?.currentTokenAmount, 0);
      return {
        ...row,
        supplyPct: totalSupply > 0 ? (amount / totalSupply) * 100 : 0,
        trackedSharePct: totalTracked > 0 ? (amount / totalTracked) * 100 : 0,
        buyBucket15m: bucketByMs(row?.latestBuyAt, 15 * 60 * 1000),
        walletAgeBucketDay: row?.walletFirstActivityComplete ? bucketByMs(row?.walletFirstActivityAt, 24 * 60 * 60 * 1000) : 0,
        tokenFirstSeenAt: safeNum(row?.firstBuyAt || row?.firstSeenAt, 0)
      };
    });
  }

  buildGroup(rows = [], totalSupply = 0) {
    const amount = sum(rows, "currentTokenAmount");
    return {
      count: rows.length,
      amount,
      pct: totalSupply > 0 ? (amount / totalSupply) * 100 : 0,
      wallets: rows.map((row) => row.owner).filter(Boolean)
    };
  }

  deriveGroups(rows = [], totalSupply = 0, launchAt = 0, devWallet = "") {
    const devRows = devWallet ? rows.filter((row) => row.owner === devWallet) : [];
    const ageBase = safeNum(launchAt, 0);
    const withFirstInteraction = rows.map((row) => ({
      ...row,
      firstInteractionAt: safeNum(row?.firstBuyAt || row?.firstSeenAt || row?.latestBuyAt, 0)
    }));

    const snipers1m = ageBase > 0
      ? withFirstInteraction.filter((row) => row.firstInteractionAt >= ageBase && row.firstInteractionAt <= ageBase + 60_000)
      : [];
    const snipers5m = ageBase > 0
      ? withFirstInteraction.filter((row) => row.firstInteractionAt >= ageBase && row.firstInteractionAt <= ageBase + 5 * 60_000)
      : [];
    const snipers15m = ageBase > 0
      ? withFirstInteraction.filter((row) => row.firstInteractionAt >= ageBase && row.firstInteractionAt <= ageBase + 15 * 60_000)
      : [];

    const sameBuyWindow = maxBucket(rows, (row) => row.buyBucket15m);
    const sameWalletAge = maxBucket(rows.filter((row) => row.walletFirstActivityComplete), (row) => row.walletAgeBucketDay);
    const sameFunding = maxBucket(rows, (row) => row.fundingSource);

    const teamWallets = new Set();
    if (sameBuyWindow.count >= 3) sameBuyWindow.rows.forEach((row) => teamWallets.add(row.owner));
    if (sameWalletAge.count >= 3) sameWalletAge.rows.forEach((row) => teamWallets.add(row.owner));
    if (sameFunding.count >= 3) sameFunding.rows.forEach((row) => teamWallets.add(row.owner));
    rows.filter((row) => row.storageLike && safeNum(row?.supplyPct, 0) >= 0.3).forEach((row) => teamWallets.add(row.owner));
    if (devWallet) teamWallets.add(devWallet);

    const teamRows = rows.filter((row) => teamWallets.has(row.owner));
    const snipersAll = Array.from(new Set(snipers15m.map((row) => row.owner)))
      .map((owner) => rows.find((row) => row.owner === owner))
      .filter(Boolean);

    return {
      allTop: this.buildGroup(rows, totalSupply),
      dev: this.buildGroup(devRows, totalSupply),
      snipers1m: this.buildGroup(snipers1m, totalSupply),
      snipers5m: this.buildGroup(snipers5m, totalSupply),
      snipers15m: this.buildGroup(snipers15m, totalSupply),
      snipersAll: this.buildGroup(snipersAll, totalSupply),
      team: this.buildGroup(teamRows, totalSupply),
      meta: {
        sameBuyWindowCount: sameBuyWindow.count,
        sameBuyWindowSupplyPct: this.buildGroup(sameBuyWindow.rows, totalSupply).pct,
        sameWalletAgeCount: sameWalletAge.count,
        sameWalletAgeSupplyPct: this.buildGroup(sameWalletAge.rows, totalSupply).pct,
        sameFundingCount: sameFunding.count,
        sameFundingSupplyPct: this.buildGroup(sameFunding.rows, totalSupply).pct,
        sameFundingSource: sameFunding.key || "",
        sameBuyWindowCv: coefficientOfVariation(sameBuyWindow.rows.map((row) => row.latestBuyAmount || row.currentTokenAmount)),
        sameWalletAgeCv: coefficientOfVariation(sameWalletAge.rows.map((row) => row.latestBuyAmount || row.currentTokenAmount))
      }
    };
  }

  compareGroup(current = {}, previous = {}) {
    return {
      amountDelta: safeNum(current?.amount, 0) - safeNum(previous?.amount, 0),
      pctDelta: safeNum(current?.pct, 0) - safeNum(previous?.pct, 0),
      countDelta: safeNum(current?.count, 0) - safeNum(previous?.count, 0)
    };
  }

  buildDeltas(mint, groups = {}, now = Date.now()) {
    const windows = [
      { key: "1m", ms: 60_000 },
      { key: "5m", ms: 5 * 60_000 },
      { key: "15m", ms: 15 * 60_000 },
      { key: "30m", ms: 30 * 60_000 }
    ];

    const out = {};
    for (const win of windows) {
      const snap = this.store?.getComparisonSnapshot?.(mint, win.ms, now) || null;
      if (!snap?.groups) {
        out[win.key] = null;
        continue;
      }
      out[win.key] = {
        snapshotAgeMin: Math.max(0, (now - safeNum(snap?.updatedAt, 0)) / 60000),
        allTop: this.compareGroup(groups.allTop, snap.groups.allTop),
        team: this.compareGroup(groups.team, snap.groups.team),
        snipers1m: this.compareGroup(groups.snipers1m, snap.groups.snipers1m),
        snipers5m: this.compareGroup(groups.snipers5m, snap.groups.snipers5m),
        snipers15m: this.compareGroup(groups.snipers15m, snap.groups.snipers15m),
        dev: this.compareGroup(groups.dev, snap.groups.dev)
      };
    }
    return out;
  }

  buildRisk(groups = {}, devHistory = {}, walletCluster = {}, crossProjects = {}, whaleBuys = {}, externalIntel = {}) {
    let riskScore = 0;
    const reasons = [];

    if (safeNum(groups?.team?.pct, 0) >= 18) {
      riskScore += 24;
      reasons.push("team/insider-кластер держит большую долю supply");
    }
    if (safeNum(groups?.snipers15m?.pct, 0) >= 15) {
      riskScore += 16;
      reasons.push("ранние снайперы всё ещё держат заметную долю supply");
    }
    if (safeNum(groups?.meta?.sameBuyWindowCount, 0) >= 5) {
      riskScore += 12;
      reasons.push("много кошельков купили в одном 15-минутном окне");
    }
    if (safeNum(groups?.meta?.sameWalletAgeCount, 0) >= 5) {
      riskScore += 14;
      reasons.push("много кошельков создано или впервые активно в один день");
    }
    if (safeNum(groups?.meta?.sameFundingCount, 0) >= 4) {
      riskScore += 18;
      reasons.push("кластер с общим источником funding");
    }
    if (safeNum(devHistory?.launchesTotal, 0) >= 4) {
      const scamRatio = safeNum(devHistory?.scamLikeCount, 0) / Math.max(1, safeNum(devHistory?.launchesTotal, 0));
      if (scamRatio >= 0.65) {
        riskScore += 22;
        reasons.push("история dev в основном состоит из мёртвых/rug-like запусков");
      } else if (scamRatio >= 0.35) {
        riskScore += 10;
        reasons.push("в истории dev несколько слабых запусков");
      }
    }
    if (safeNum(walletCluster?.clusterRiskScore, 0) >= 70) {
      riskScore += 12;
      reasons.push("риск кластера холдеров уже высокий");
    }
    if (safeNum(crossProjects?.maxClusterWallets, 0) >= 4) {
      riskScore += 14;
      reasons.push("отслеженные кошельки пересекаются в других проектах");
    } else if (safeNum(crossProjects?.maxClusterWallets, 0) >= 3) {
      riskScore += 8;
      reasons.push("обнаружено небольшое пересечение кошельков с другими проектами");
    }
    if (safeNum(whaleBuys?.dumpingWhaleCount, 0) >= 2) {
      riskScore += 12;
      reasons.push("whale-покупатели уже сократили позиции");
    }
    if (safeNum(whaleBuys?.holdingWhaleCount, 0) >= 2 && safeNum(whaleBuys?.totalCurrentPct, 0) >= 2) {
      riskScore -= 6;
      reasons.push("whale-покупатели всё ещё удерживают позиции");
    }

    const extSnipers = externalIntel?.snipers || externalIntel?.sniper || {};
    const extInsiders = externalIntel?.insiders || externalIntel?.insider || {};
    const extSniperPct = safeNum(this.pickFirst(extSnipers?.pct, extSnipers?.percent, externalIntel?.sniperPct), 0);
    const extInsiderPct = safeNum(this.pickFirst(extInsiders?.pct, extInsiders?.percent, externalIntel?.insiderPct, externalIntel?.insidersPct), 0);
    const extTeamPct = safeNum(this.pickFirst(externalIntel?.teamHoldPct, externalIntel?.teamPct, externalIntel?.holders?.teamPct), 0);
    const extTop10Pct = safeNum(this.pickFirst(externalIntel?.top10Pct, externalIntel?.holders?.top10Pct), 0);
    const extTop70Pct = safeNum(this.pickFirst(externalIntel?.top70Pct, externalIntel?.holders?.top70Pct), 0);
    const extMajorClusters = this.pickFirst(externalIntel?.bubblemap?.majorClusters, externalIntel?.bubbleMap?.majorClusters, externalIntel?.majorClusters);

    if (extSniperPct >= 8 || extSnipers?.hasSnipers === true) {
      riskScore += extSniperPct >= 15 ? 16 : 8;
      reasons.push("Devs Nightmare: есть заметный sniper-риск");
    }
    if (extInsiderPct >= 8 || extInsiders?.hasInsiders === true) {
      riskScore += extInsiderPct >= 15 ? 18 : 9;
      reasons.push("Devs Nightmare: есть insider-риск");
    }
    if (extTeamPct >= 20) {
      riskScore += 16;
      reasons.push("Devs Nightmare: высокая доля команды/team hold");
    } else if (extTeamPct >= 12) {
      riskScore += 8;
      reasons.push("Devs Nightmare: умеренная доля команды/team hold");
    }
    if (extTop10Pct >= 35) {
      riskScore += 10;
      reasons.push("Devs Nightmare: высокая концентрация top 10 holders");
    }
    if (extTop70Pct >= 75) {
      riskScore += 8;
      reasons.push("Devs Nightmare: высокая концентрация top 70 holders");
    }
    if (extMajorClusters === true) {
      riskScore += 12;
      reasons.push("Devs Nightmare/Bubblemap: обнаружены крупные кластеры");
    }
    if (extSnipers?.hasSnipers === false && extInsiders?.hasInsiders === false && extTeamPct > 0 && extTeamPct < 15 && extMajorClusters === false) {
      riskScore -= 8;
      reasons.push("Devs Nightmare: снайперы/инсайдеры не обнаружены, крупных кластеров нет");
    }

    riskScore = clamp(Math.round(riskScore), 0, 100);
    return {
      score: riskScore,
      level: riskScore >= 70 ? "HIGH" : riskScore >= 45 ? "MEDIUM" : riskScore >= 25 ? "WATCH" : "LOW",
      reasons
    };
  }

  async ensureHolderRecords(token = {}, candidate = {}) {
    const mint = asText(token?.ca || candidate?.token?.ca);
    if (!mint) return [];

    try {
      if (this.holderAccumulationEngine?.trackCandidate) {
        await this.holderAccumulationEngine.trackCandidate({ ...candidate, token: { ...(candidate?.token || {}), ...token } });
      }
    } catch (error) {
      this.logger.log?.("team intel holder refresh failed:", error.message);
    }

    let records = this.holderStore?.listWalletRecords?.(mint) || [];
    if (records.length) return records;

    if (!this.holderAccumulationEngine?.fetchTopTokenAccounts || !this.holderAccumulationEngine?.enrichHistoricalWallets) {
      return [];
    }

    try {
      const holders = await this.holderAccumulationEngine.fetchTopTokenAccounts(mint);
      const limited = holders.slice(0, this.maxTrackedWallets);
      records = await this.holderAccumulationEngine.enrichHistoricalWallets(mint, limited, { ...candidate, token });
      return records;
    } catch (error) {
      this.logger.log?.("team intel direct holder records failed:", error.message);
      return [];
    }
  }

  mergeExternalIntel(localIntel = {}, fetchedIntel = {}) {
    const out = { ...(localIntel || {}) };
    for (const [key, value] of Object.entries(fetchedIntel || {})) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        if (value.length) out[key] = value;
        continue;
      }
      if (typeof value === "object") {
        out[key] = this.mergeExternalIntel(out[key] && typeof out[key] === "object" ? out[key] : {}, value);
        continue;
      }
      if (value !== "") out[key] = value;
    }
    return out;
  }

  async fetchExternalIntel(mint, token = {}, candidate = {}) {
    const localIntel = this.getExternalIntel({ token, candidate }) || {};
    if (!this.externalIntelService?.fetchTokenIntel) return localIntel;

    try {
      const fetched = await this.externalIntelService.fetchTokenIntel(mint, { token, candidate });
      if (!fetched) return localIntel;
      return this.mergeExternalIntel(localIntel, fetched);
    } catch (error) {
      this.logger.log?.("external intel fetch failed:", error?.message || String(error));
      return this.mergeExternalIntel(localIntel, {
        source: "devsnightmare",
        status: "unavailable",
        unavailableReason: String(error?.message || error).slice(0, 180)
      });
    }
  }

  async analyze({ token = {}, candidate = {} } = {}) {
    await this.initialize();
    const mint = asText(token?.ca || candidate?.token?.ca);
    if (!mint) throw new Error("TeamWalletIntelligence requires token CA");

    const externalIntel = await this.fetchExternalIntel(mint, token, candidate);
    const tokenWithIntel = { ...token, externalIntel };
    const candidateWithIntel = { ...candidate, externalIntel, token: { ...(candidate?.token || {}), ...token, externalIntel } };

    const totalSupply = await this.getTokenSupply(mint);
    const dev = await this.detectDevWallet(mint);
    const launchAt = safeNum(tokenWithIntel?.pairCreatedAt, 0) || safeNum(dev?.createdAt, 0) || Date.now();
    const devHistory = dev?.devWallet ? await this.fetchPumpFunDevHistory(dev.devWallet) : null;
    const records = await this.ensureHolderRecords(tokenWithIntel, candidateWithIntel);
    const rows = this.normalizeRowsWithSupply(records, totalSupply).slice(0, this.maxTrackedWallets);
    const groups = this.deriveGroups(rows, totalSupply, launchAt, dev.devWallet);
    const crossProjects = await this.detectCrossProjectWalletClusters(rows, mint, groups);
    const whaleBuys = this.detectWhaleBuys(rows, totalSupply, { ...(candidateWithIntel?.token || {}), ...tokenWithIntel });
    const deltas = this.buildDeltas(mint, groups);
    const walletCluster = candidateWithIntel?.holderAccumulation?.walletCluster || this.holderAccumulationEngine?.getDashboardSummary?.()?.walletCluster || null;
    const risk = this.buildRisk(groups, devHistory || {}, walletCluster || {}, crossProjects || {}, whaleBuys || {}, externalIntel || {});

    const snapshot = {
      mint,
      tokenName: tokenWithIntel?.name || tokenWithIntel?.symbol || candidateWithIntel?.token?.name || "UNKNOWN",
      totalSupply,
      dev,
      groups,
      externalIntel,
      risk,
      walletCluster,
      crossProjects,
      whaleBuys,
      updatedAt: Date.now()
    };
    if (this.store?.addSnapshot) await this.store.addSnapshot(mint, snapshot);

    return {
      mint,
      token: tokenWithIntel,
      candidate: candidateWithIntel,
      externalIntel,
      devsNightmare: externalIntel?.source === "devsnightmare" ? externalIntel : null,
      totalSupply,
      launchAt,
      dev,
      devHistory,
      rows,
      groups,
      crossProjects,
      whaleBuys,
      deltas,
      walletCluster,
      risk,
      updatedAt: Date.now()
    };
  }

  formatGroupLine(label, group = {}) {
    return `${label} — ${safeNum(group?.count, 0)} кошельков | ${fmtNum(group?.amount, 2)} токенов | ${fmtPct(group?.pct, 2)}`;
  }

  formatDeltaLine(label, key, deltas = {}) {
    const d = deltas?.[key];
    if (!d) return `${label}: нет истории snapshot`;
    return `${label}: команда ${fmtSigned(d.team?.pctDelta, 2, "%")} | снайперы 15м ${fmtSigned(d.snipers15m?.pctDelta, 2, "%")} | dev ${fmtSigned(d.dev?.pctDelta, 2, "%")}`;
  }


  pickFirst(...values) {
    for (const value of values) {
      if (value === null || value === undefined) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      return value;
    }
    return null;
  }

  getExternalIntel(analysis = {}) {
    const token = analysis?.token || {};
    const candidate = analysis?.candidate || {};
    return (
      analysis?.externalIntel ||
      candidate?.externalIntel ||
      token?.externalIntel ||
      analysis?.devsNightmare ||
      candidate?.devsNightmare ||
      token?.devsNightmare ||
      analysis?.devsnightmare ||
      candidate?.devsnightmare ||
      token?.devsnightmare ||
      {}
    );
  }

  displayWalletEntity(row = {}) {
    const label = this.pickFirst(
      row?.label,
      row?.walletLabel,
      row?.ownerLabel,
      row?.entityLabel,
      row?.entityName,
      row?.name,
      row?.username,
      row?.solDomain,
      row?.domain,
      row?.twitter,
      row?.tag
    );

    if (label) return escapeHtml(String(label));
    return `<code>${escapeHtml(shortWallet(row?.owner || row?.wallet || row?.address || "-"))}</code>`;
  }

  normalizeFundingLabel(raw = "") {
    const value = String(raw || "").trim();
    if (!value) return "unknown";
    const lower = value.toLowerCase().replace(/[_.-]+/g, " ");

    if (lower.includes("binance")) return "Binance";
    if (lower.includes("coinbase")) return "Coinbase";
    if (lower.includes("mexc")) return "MEXC";
    if (lower.includes("kucoin")) return "KuCoin";
    if (lower.includes("change now") || lower.includes("changenow")) return "ChangeNOW";
    if (lower.includes("okx")) return "OKX";
    if (lower.includes("bybit")) return "Bybit";
    if (lower.includes("gate")) return "Gate";
    if (lower.includes("bitget")) return "Bitget";
    if (lower.includes("kraken")) return "Kraken";
    if (lower.includes("htx") || lower.includes("huobi")) return "HTX/Huobi";
    if (lower.includes("crypto com") || lower.includes("cryptocom")) return "Crypto.com";

    return value.length > 28 ? `${value.slice(0, 25)}…` : value;
  }

  isCexFundingLabel(label = "") {
    return /^(Binance|Coinbase|MEXC|KuCoin|ChangeNOW|OKX|Bybit|Gate|Bitget|Kraken|HTX\/Huobi|Crypto\.com)$/i.test(String(label || ""));
  }

  buildFundingBreakdown(analysis = {}) {
    const rows = Array.isArray(analysis?.rows) ? analysis.rows : [];
    const totalSupply = safeNum(analysis?.totalSupply, 0);
    const external = this.getExternalIntel(analysis);
    const externalFunding = external?.cexFundingMap || external?.fundingMap || external?.cexMap || null;

    if (externalFunding && typeof externalFunding === "object") {
      const entries = Array.isArray(externalFunding)
        ? externalFunding.map((row) => ({
            label: this.normalizeFundingLabel(row?.label || row?.source || row?.name),
            pct: safeNum(row?.pct ?? row?.supplyPct ?? row?.percent, 0),
            wallets: safeNum(row?.wallets ?? row?.count, 0)
          }))
        : Object.entries(externalFunding).map(([source, value]) => ({
            label: this.normalizeFundingLabel(source),
            pct: typeof value === "object" ? safeNum(value?.pct ?? value?.supplyPct ?? value?.percent, 0) : safeNum(value, 0),
            wallets: typeof value === "object" ? safeNum(value?.wallets ?? value?.count, 0) : 0
          }));

      const cleaned = entries.filter((row) => row.label && row.label !== "unknown" && safeNum(row.pct, 0) > 0);
      const cexPct = cleaned.filter((row) => this.isCexFundingLabel(row.label)).reduce((acc, row) => acc + safeNum(row.pct, 0), 0);
      return {
        source: "external",
        known: cleaned.length > 0,
        cexPct,
        entries: cleaned.sort((a, b) => safeNum(b.pct, 0) - safeNum(a.pct, 0)).slice(0, 8)
      };
    }

    const map = new Map();
    for (const row of rows) {
      const label = this.normalizeFundingLabel(row?.fundingSource || row?.firstFundingSource || row?.sourceFunding || "");
      if (!label || label === "unknown") continue;
      const prev = map.get(label) || { label, wallets: 0, amount: 0, pct: 0 };
      prev.wallets += 1;
      prev.amount += safeNum(row?.currentTokenAmount, 0);
      prev.pct += safeNum(row?.supplyPct, totalSupply > 0 ? (safeNum(row?.currentTokenAmount, 0) / totalSupply) * 100 : 0);
      map.set(label, prev);
    }

    const entries = [...map.values()].sort((a, b) => safeNum(b.pct, 0) - safeNum(a.pct, 0)).slice(0, 8);
    const cexPct = entries.filter((row) => this.isCexFundingLabel(row.label)).reduce((acc, row) => acc + safeNum(row.pct, 0), 0);
    return {
      source: "wallet_records",
      known: entries.length > 0,
      cexPct,
      entries
    };
  }

  buildHolderConcentrationStats(analysis = {}) {
    const rows = Array.isArray(analysis?.rows) ? [...analysis.rows] : [];
    const token = analysis?.token || {};
    const external = this.getExternalIntel(analysis);
    const sorted = rows.sort((a, b) => safeNum(b?.currentTokenAmount, 0) - safeNum(a?.currentTokenAmount, 0));
    const totalSupply = safeNum(analysis?.totalSupply, 0);

    const pctForRows = (list) => list.reduce((acc, row) => acc + safeNum(row?.supplyPct, totalSupply > 0 ? (safeNum(row?.currentTokenAmount, 0) / totalSupply) * 100 : 0), 0);
    const top10Pct = this.pickFirst(
      external?.top10Pct,
      external?.holders?.top10Pct,
      external?.topHolders?.top10Pct,
      sorted.length ? pctForRows(sorted.slice(0, 10)) : null
    );
    const top70Pct = this.pickFirst(
      external?.top70Pct,
      external?.holders?.top70Pct,
      external?.topHolders?.top70Pct,
      sorted.length >= 70 ? pctForRows(sorted.slice(0, 70)) : null
    );
    const topTrackedPct = sorted.length ? pctForRows(sorted) : 0;
    const holderCount = safeNum(this.pickFirst(
      external?.holderCount,
      external?.holders?.count,
      token?.holderCount,
      token?.holders,
      token?.holdersCount
    ), 0);

    const marketCap = safeNum(this.pickFirst(token?.marketCap, token?.fdv, token?.mcap, external?.marketCap, external?.fdv), 0);
    const avgBagUsd = safeNum(this.pickFirst(
      external?.avgBagUsd,
      external?.averageBagUsd,
      external?.holders?.avgBagUsd,
      holderCount > 0 && marketCap > 0 ? marketCap / holderCount : null
    ), 0);

    return {
      trackedCount: sorted.length,
      top10Pct: safeNum(top10Pct, 0),
      top70Pct: top70Pct === null ? null : safeNum(top70Pct, 0),
      topTrackedPct,
      holderCount,
      avgBagUsd,
      topRows: sorted.slice(0, 7)
    };
  }

  buildHolderFundingSummaryLines(analysis = {}, options = {}) {
    const compact = options?.compact === true;
    const token = analysis?.token || {};
    const dev = analysis?.dev || {};
    const groups = analysis?.groups || {};
    const meta = groups?.meta || {};
    const risk = analysis?.risk || {};
    const walletCluster = analysis?.walletCluster || {};
    const crossProjects = analysis?.crossProjects || {};
    const external = this.getExternalIntel(analysis);
    const funding = this.buildFundingBreakdown(analysis);
    const holderStats = this.buildHolderConcentrationStats(analysis);

    const snipers1m = safeNum(groups?.snipers1m?.count, 0);
    const snipers5m = safeNum(groups?.snipers5m?.count, 0);
    const snipers15m = safeNum(groups?.snipers15m?.count, 0);
    const snipers15mPct = safeNum(groups?.snipers15m?.pct, 0);
    const extSnipers = external?.snipers || external?.sniper || {};
    const extInsiders = external?.insiders || external?.insider || {};
    const extSnipersKnown = this.pickFirst(extSnipers?.hasSnipers, extSnipers?.pct, extSnipers?.count, external?.sniperPct) !== null;
    const extInsidersKnown = this.pickFirst(extInsiders?.hasInsiders, extInsiders?.pct, extInsiders?.count, external?.insiderPct, external?.insidersPct) !== null;
    const extSniperPct = safeNum(this.pickFirst(extSnipers?.pct, extSnipers?.percent, external?.sniperPct), 0);
    const extSniperCount = safeNum(this.pickFirst(extSnipers?.count, extSnipers?.wallets, external?.sniperCount), 0);
    const extInsiderPct = safeNum(this.pickFirst(extInsiders?.pct, extInsiders?.percent, external?.insiderPct, external?.insidersPct), 0);
    const extInsiderCount = safeNum(this.pickFirst(extInsiders?.count, extInsiders?.wallets, external?.insiderCount), 0);
    const hasSniperRisk = extSnipersKnown
      ? extSnipers?.hasSnipers === true || extSniperPct >= 5 || extSniperCount >= 3
      : snipers15m >= 3 || snipers15mPct >= 5;
    const sniperText = extSnipersKnown
      ? (hasSniperRisk
          ? `⚠️ <b>Снайперы:</b> Devs Nightmare видит риск${extSniperPct > 0 ? ` | держат <b>${fmtPct(extSniperPct, 2)}</b>` : ""}${extSniperCount > 0 ? ` | кошельков ${extSniperCount}` : ""}`
          : `✅ <b>Снайперы:</b> Devs Nightmare не видит снайперов | локально 1м/5м/15м: ${snipers1m}/${snipers5m}/${snipers15m}`)
      : (hasSniperRisk
          ? `⚠️ <b>Снайперы:</b> ${snipers1m}/${snipers5m}/${snipers15m} кошельков | первые 15м держат <b>${fmtPct(snipers15mPct, 2)}</b>`
          : `✅ <b>Снайперы:</b> сильного давления снайперов не видно | 1м/5м/15м: ${snipers1m}/${snipers5m}/${snipers15m}`);

    const hasInsiderRisk = extInsidersKnown && (extInsiders?.hasInsiders === true || extInsiderPct >= 5 || extInsiderCount >= 3);
    const insiderText = extInsidersKnown
      ? (hasInsiderRisk
          ? `⚠️ <b>Инсайдеры:</b> Devs Nightmare видит риск${extInsiderPct > 0 ? ` | держат <b>${fmtPct(extInsiderPct, 2)}</b>` : ""}${extInsiderCount > 0 ? ` | кошельков ${extInsiderCount}` : ""}`
          : `✅ <b>Инсайдеры:</b> Devs Nightmare не видит insider-группу`)
      : `⚪ <b>Инсайдеры:</b> внешний Devs Nightmare источник не подключён`;

    const teamPct = safeNum(this.pickFirst(external?.teamHoldPct, external?.teamPct, external?.holders?.teamPct, groups?.team?.pct), 0);
    const teamEmoji = teamPct >= 20 ? "🔴" : teamPct >= 10 ? "🟡" : "✅";
    const devHoldPct = safeNum(groups?.dev?.pct, 0);

    const devName = this.pickFirst(external?.devName, external?.developerName, external?.dev?.name, dev?.name, dev?.label);
    const devDisplay = devName
      ? `<b>${escapeHtml(devName)}</b>${dev?.devWallet ? ` / <code>${escapeHtml(shortWallet(dev.devWallet))}</code>` : ""}`
      : (dev?.devWallet ? `<code>${escapeHtml(shortWallet(dev.devWallet))}</code>` : "не определён");

    const localClusterRiskScore = Math.max(
      safeNum(risk?.score, 0),
      safeNum(walletCluster?.clusterRiskScore, 0),
      safeNum(crossProjects?.riskScore, 0)
    );
    const externalMajorClusters = this.pickFirst(
      external?.bubblemap?.majorClusters,
      external?.bubbleMap?.majorClusters,
      external?.majorClusters
    );
    const noMajorClusters = externalMajorClusters === false || (externalMajorClusters === null && localClusterRiskScore < 35 && safeNum(crossProjects?.clusteredProjectCount, 0) === 0);
    const clusterLine = noMajorClusters
      ? `✅ <b>Bubblemap / кластеры:</b> крупных кластеров не видно${externalMajorClusters === false ? " по Devs Nightmare/Bubblemap" : " по локальной эвристике"}${externalMajorClusters === null ? " | внешний Bubblemap не подключён" : ""}`
      : `${localClusterRiskScore >= 65 || externalMajorClusters === true ? "🔴" : "🟡"} <b>Bubblemap / кластеры:</b> риск ${escapeHtml(risk?.level || walletCluster?.clusterRisk || "WATCH")} / ${localClusterRiskScore} | кластеры в других проектах ${safeNum(crossProjects?.clusteredProjectCount, 0)}`;

    const cexPrefix = funding.known
      ? `${funding.cexPct >= 50 ? "🟡" : funding.cexPct >= 20 ? "👀" : "✅"} <b>CEX funding map:</b> ${fmtPct(funding.cexPct, 2)} связано с CEX`
      : `⚪ <b>CEX funding map:</b> funding-метки не найдены`;
    const fundingLine = funding.known
      ? `${cexPrefix} — ${funding.entries.map((row) => `${escapeHtml(row.label)} ${fmtPct(row.pct, 1)}`).join(" | ")}`
      : `${cexPrefix} — нужен devsnightmare / Bubblemap / CEX-индексер или поле fundingSource`;

    const top70Text = holderStats.top70Pct === null
      ? `n/a <i>(RPC видит top ${holderStats.trackedCount}, для top 70 нужен holder-indexer)</i>`
      : fmtPct(holderStats.top70Pct, 2);
    const avgBagText = holderStats.avgBagUsd > 0 ? fmtUsd(holderStats.avgBagUsd, 0) : "n/a";
    const holderCountText = holderStats.holderCount > 0 ? `${holderStats.holderCount}` : "n/a";

    const topHoldersExternal = Array.isArray(external?.topHolders) ? external.topHolders : Array.isArray(external?.holders?.topHolders) ? external.holders.topHolders : null;
    const topHolderLines = (topHoldersExternal && topHoldersExternal.length
      ? topHoldersExternal.slice(0, compact ? 5 : 7).map((row, idx) => {
          const name = this.pickFirst(row?.name, row?.label, row?.ownerLabel, row?.wallet, row?.address, `#${idx + 1}`);
          const pct = safeNum(row?.pct ?? row?.supplyPct ?? row?.percent, 0);
          return `• #${idx + 1} ${escapeHtml(String(name))}${pct > 0 ? ` — <b>${fmtPct(pct, 2)}</b>` : ""}`;
        })
      : holderStats.topRows.slice(0, compact ? 5 : 7).map((row, idx) => {
          const bagUsd = safeNum(row?.currentUsd, 0) || safeNum(row?.currentTokenAmount, 0) * safeNum(token?.price, 0);
          return `• #${idx + 1} ${this.displayWalletEntity(row)} — <b>${fmtPct(row?.supplyPct, 2)}</b>${bagUsd > 0 ? ` | bag ${fmtUsd(bagUsd, 0)}` : ""}`;
        }));

    const sourceLine = external?.source === "devsnightmare"
      ? (external?.status === "unavailable"
          ? `⚪ <b>Devs Nightmare:</b> источник настроен, но сейчас недоступен${external?.unavailableReason ? ` — ${escapeHtml(external.unavailableReason)}` : ""}`
          : `🧪 <b>Devs Nightmare:</b> данные подключены и добавлены в отчёт`)
      : `⚪ <b>Devs Nightmare:</b> API не настроен — используется локальная эвристика`;

    const lines = [
      `<b>🧷 Холдеры / Funding — быстрый вывод</b>`,
      sourceLine,
      sniperText,
      insiderText,
      `${teamEmoji} <b>Команда/инсайдеры:</b> держат <b>${fmtPct(teamPct, 2)}</b> | кошельков ${safeNum(groups?.team?.count, 0)} | dev держит ${fmtPct(devHoldPct, 2)}`,
      `👨‍💻 <b>Dev:</b> ${devDisplay}`,
      clusterLine,
      fundingLine,
      `👑 <b>Топ-холдеры:</b> top 10 <b>${fmtPct(holderStats.top10Pct, 2)}</b> | top 70 ${top70Text} | отслеженный top ${holderStats.trackedCount}: ${fmtPct(holderStats.topTrackedPct, 2)}`,
      `👥 <b>База холдеров:</b> холдеров ${holderCountText} | средний размер позиции ${avgBagText}`,
      `🔍 <b>Признаки общего источника:</b> окно покупок 15м — ${safeNum(meta?.sameBuyWindowCount, 0)} кошельков / ${fmtPct(meta?.sameBuyWindowSupplyPct, 2)} | одинаковый funding — ${safeNum(meta?.sameFundingCount, 0)} кошельков / ${fmtPct(meta?.sameFundingSupplyPct, 2)}`,
      `<b>🔝 Топ-холдеры: имена / кошельки</b>`,
      ...(topHolderLines.length ? topHolderLines : [`• нет строк top holders для отображения`]),
      `⚠️ <b>NFA:</b> это блок риска/intel, а не команда покупать или продавать.`
    ];

    return compact ? lines.slice(0, 13) : lines;
  }

  buildCompactReport(analysis = {}) {
    return [
      `🕵️ <b>КОМАНДА / ХОЛДЕРЫ / FUNDING — V15 RU</b>`,
      `<b>${escapeHtml(analysis?.token?.name || analysis?.token?.symbol || "UNKNOWN")}</b>`,
      `<code>${escapeHtml(analysis?.mint || analysis?.token?.ca || "")}</code>`,
      `Риск — ${safeNum(analysis?.risk?.score, 0) >= 70 ? "🚩" : safeNum(analysis?.risk?.score, 0) >= 45 ? "🟡" : "✅"} <b>${escapeHtml(analysis?.risk?.level || "LOW")}</b> / ${safeNum(analysis?.risk?.score, 0)}`,
      ``,
      ...this.buildHolderFundingSummaryLines(analysis, { compact: true })
    ].join("\n");
  }

  buildReport(analysis = {}) {
    const token = analysis?.token || {};
    const dev = analysis?.dev || {};
    const hist = analysis?.devHistory || {};
    const groups = analysis?.groups || {};
    const meta = groups?.meta || {};
    const crossProjects = analysis?.crossProjects || {};
    const whaleBuys = analysis?.whaleBuys || {};
    const risk = analysis?.risk || {};
    const rows = Array.isArray(analysis?.rows) ? analysis.rows : [];
    const topTeamWallets = rows
      .filter((row) => (groups?.team?.wallets || []).includes(row.owner))
      .sort((a, b) => safeNum(b?.currentTokenAmount, 0) - safeNum(a?.currentTokenAmount, 0))
      .slice(0, 5);

    const devSource = dev?.source === "mint_first_signer_heuristic"
      ? "эвристика mint tx signer"
      : dev?.source || "-";
    const devHistorySource = hist?.source || "unavailable";

    const lines = [
      `🕵️ <b>КОМАНДА / ИНСАЙДЕРЫ / СНАЙПЕРЫ — V15 RU</b>`,
      ``,
      `<b>${escapeHtml(token?.name || token?.symbol || "UNKNOWN")}</b>`,
      `<code>${escapeHtml(analysis?.mint || token?.ca || "")}</code>`,
      `Риск — ${safeNum(risk?.score, 0) >= 70 ? "🚩" : safeNum(risk?.score, 0) >= 45 ? "🟡" : "✅"} <b>${escapeHtml(risk?.level || "LOW")}</b> / ${safeNum(risk?.score, 0)}`,
      ``,
      ...this.buildHolderFundingSummaryLines(analysis, { compact: false }),
      ``,
      `<b>👨‍💻 Dev wallet</b>`,
      `Dev — ${dev?.devWallet ? `<code>${escapeHtml(dev.devWallet)}</code>` : "не определён"}`,
      `Источник — ${escapeHtml(devSource)}`,
      `Запусков dev — ${safeNum(hist?.launchesTotal, 0)} | мёртвых/rug-like — ${safeNum(hist?.scamLikeCount, 0)} | живых/успешных — ${safeNum(hist?.successfulLikeCount, 0)} | неясных — ${safeNum(hist?.unclearCount, 0)}`,
      `Источник dev history — ${escapeHtml(devHistorySource)}`,
      ``,
      `<b>🎯 Снайперы</b>`,
      this.formatGroupLine("Первые 1м", groups?.snipers1m),
      this.formatGroupLine("Первые 5м", groups?.snipers5m),
      this.formatGroupLine("Первые 15м", groups?.snipers15m),
      ``,
      `<b>🧬 Инсайдерский / team-кластер</b>`,
      this.formatGroupLine("Команда/инсайдеры", groups?.team),
      this.formatGroupLine("Dev wallet сейчас", groups?.dev),
      `Окно покупок 15м — ${safeNum(meta?.sameBuyWindowCount, 0)} кошельков / ${fmtPct(meta?.sameBuyWindowSupplyPct, 2)} | CV ${fmtNum(meta?.sameBuyWindowCv, 3)}`,
      `Одинаковый возраст кошельков — ${safeNum(meta?.sameWalletAgeCount, 0)} кошельков / ${fmtPct(meta?.sameWalletAgeSupplyPct, 2)} | CV ${fmtNum(meta?.sameWalletAgeCv, 3)}`,
      `Одинаковый funding — ${safeNum(meta?.sameFundingCount, 0)} кошельков / ${fmtPct(meta?.sameFundingSupplyPct, 2)}${meta?.sameFundingSource ? ` | ${escapeHtml(String(meta.sameFundingSource).slice(0, 24))}` : ""}`,
      ``,
      `<b>🧩 Пересечение кошельков с другими проектами</b>`,
      `Проверено кошельков — ${safeNum(crossProjects?.checkedWallets, 0)} | с другими токенами — ${safeNum(crossProjects?.walletsWithOtherTokens, 0)}`,
      `Скоплений в других проектах — ${safeNum(crossProjects?.clusteredProjectCount, 0)} | отфильтровано common/stable — ${safeNum(crossProjects?.skippedCommonProjectCount, 0)} | риск ${escapeHtml(crossProjects?.riskLevel || "LOW")}/${safeNum(crossProjects?.riskScore, 0)}`,
      ...(Array.isArray(crossProjects?.projects) && crossProjects.projects.length
        ? crossProjects.projects.slice(0, 5).flatMap((project) => [
            `• ${escapeHtml(project?.name || project?.symbol || "UNKNOWN")} ${project?.symbol ? `($${escapeHtml(project.symbol)})` : ""} — ${safeNum(project?.walletCount, 0)} кошельков`,
            `  CA: <code>${escapeHtml(project?.ca || "")}</code> | ликвидность ${fmtUsd(project?.liquidityUsd, 0)} | FDV ${fmtUsd(project?.fdv || project?.marketCap, 0)}`
          ])
        : [`• явного скопления одних и тех же кошельков в других проектах пока нет`]),
      ``,
      `<b>🐋 Крупные покупки / whale buys</b>`,
      `Whale-сигнал — ${escapeHtml(whaleBuys?.signal || "LOW")} | холдеры ${safeNum(whaleBuys?.holderWhaleCount ?? whaleBuys?.whaleCount, 0)} | покупатели ${safeNum(whaleBuys?.buyWhaleCount, 0)} | удерживают ${safeNum(whaleBuys?.holdingWhaleCount, 0)} | сокращают ${safeNum(whaleBuys?.dumpingWhaleCount, 0)}`,
      `Сейчас держат — ${fmtNum(whaleBuys?.totalCurrentAmount, 2)} токенов / ${fmtPct(whaleBuys?.totalCurrentPct, 2)} | ${fmtUsd(whaleBuys?.currentUsd, 0)}`,
      `Суммарно куплено — ${fmtNum(whaleBuys?.totalBoughtAmount, 2)} токенов / ${fmtPct(whaleBuys?.totalBoughtPct, 2)} | ${fmtUsd(whaleBuys?.totalBoughtUsd, 0)}`,
      ...(Array.isArray(whaleBuys?.rows) && whaleBuys.rows.length
        ? whaleBuys.rows.slice(0, 5).map((row) => {
            const buyPart = row?.isBuyWhale
              ? `последняя покупка ${fmtPct(row.latestBuyPct, 2)} | удержание ${row.holdingPct === null ? "n/a" : fmtPct(row.holdingPct, 0)}`
              : `холдер/трансфер | куплено ${fmtPct(row.totalBoughtPct, 2)}`;
            return `• ${shortWallet(row.owner)} — сейчас ${fmtPct(row.supplyPct, 2)} | ${buyPart}`;
          })
        : [`• крупных whale-buy признаков среди top holders пока нет`]),
      ``,
      `<b>⏱ Изменения по snapshot</b>`,
      this.formatDeltaLine("1м", "1m", analysis?.deltas),
      this.formatDeltaLine("5м", "5m", analysis?.deltas),
      this.formatDeltaLine("15м", "15m", analysis?.deltas),
      this.formatDeltaLine("30м", "30m", analysis?.deltas),
      ``,
      `<b>🔎 Топ team wallets</b>`
    ];

    if (topTeamWallets.length) {
      for (const row of topTeamWallets) {
        lines.push(`• ${shortWallet(row.owner)} — ${fmtPct(row.supplyPct, 2)} | возраст ${row.walletFirstActivityComplete ? fmtNum((Date.now() - safeNum(row.walletFirstActivityAt, 0)) / 86400000, 1) + "д" : "неизвестно"}`);
      }
    } else {
      lines.push(`• пока нет выраженного team-кластера среди top holders`);
    }

    if (Array.isArray(risk?.reasons) && risk.reasons.length) {
      lines.push(``);
      lines.push(`🧠 Сигналы — ${escapeHtml(risk.reasons.slice(0, 5).join(" | "))}`);
    }

    lines.push(``);
    lines.push(`⚠️ Dev wallet / dev-history — эвристика. Пересечение с другими проектами показывает текущие ненулевые SPL-балансы кошельков; USDC/USDT/wSOL/common assets отфильтрованы. Для полной истории прошлых участий нужен расширенный индексер.`);

    return lines.join("\n");
  }
}
