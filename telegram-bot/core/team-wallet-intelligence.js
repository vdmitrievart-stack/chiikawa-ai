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
      reasons.push('many tracked wallets also sit in the same external project');
    } else if (maxClusterWallets >= 3) {
      riskScore += 16;
      reasons.push('several tracked wallets overlap in another project');
    }
    if (projects.length >= 3) {
      riskScore += 12;
      reasons.push('multiple repeated cross-project overlaps');
    }
    if (checkedWallets > 0 && walletsWithOtherTokens / checkedWallets >= 0.75) {
      riskScore += 10;
      reasons.push('most checked team/sniper wallets hold other projects');
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

  buildRisk(groups = {}, devHistory = {}, walletCluster = {}, crossProjects = {}, whaleBuys = {}) {
    let riskScore = 0;
    const reasons = [];

    if (safeNum(groups?.team?.pct, 0) >= 18) {
      riskScore += 24;
      reasons.push("team/insider cluster holds large supply");
    }
    if (safeNum(groups?.snipers15m?.pct, 0) >= 15) {
      riskScore += 16;
      reasons.push("early snipers still hold meaningful supply");
    }
    if (safeNum(groups?.meta?.sameBuyWindowCount, 0) >= 5) {
      riskScore += 12;
      reasons.push("many wallets bought in same 15m window");
    }
    if (safeNum(groups?.meta?.sameWalletAgeCount, 0) >= 5) {
      riskScore += 14;
      reasons.push("many wallets were created/first active same day");
    }
    if (safeNum(groups?.meta?.sameFundingCount, 0) >= 4) {
      riskScore += 18;
      reasons.push("shared funding source cluster");
    }
    if (safeNum(devHistory?.launchesTotal, 0) >= 4) {
      const scamRatio = safeNum(devHistory?.scamLikeCount, 0) / Math.max(1, safeNum(devHistory?.launchesTotal, 0));
      if (scamRatio >= 0.65) {
        riskScore += 22;
        reasons.push("dev history mostly dead/rug-like launches");
      } else if (scamRatio >= 0.35) {
        riskScore += 10;
        reasons.push("dev history has several weak launches");
      }
    }
    if (safeNum(walletCluster?.clusterRiskScore, 0) >= 70) {
      riskScore += 12;
      reasons.push("holder cluster risk already high");
    }
    if (safeNum(crossProjects?.maxClusterWallets, 0) >= 4) {
      riskScore += 14;
      reasons.push("tracked wallets overlap in other projects");
    } else if (safeNum(crossProjects?.maxClusterWallets, 0) >= 3) {
      riskScore += 8;
      reasons.push("small cross-project wallet overlap detected");
    }
    if (safeNum(whaleBuys?.dumpingWhaleCount, 0) >= 2) {
      riskScore += 12;
      reasons.push("whale buyers already reduced holdings");
    }
    if (safeNum(whaleBuys?.holdingWhaleCount, 0) >= 2 && safeNum(whaleBuys?.totalCurrentPct, 0) >= 2) {
      riskScore -= 6;
      reasons.push("whale buyers are still holding");
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

  async analyze({ token = {}, candidate = {} } = {}) {
    await this.initialize();
    const mint = asText(token?.ca || candidate?.token?.ca);
    if (!mint) throw new Error("TeamWalletIntelligence requires token CA");

    const totalSupply = await this.getTokenSupply(mint);
    const dev = await this.detectDevWallet(mint);
    const launchAt = safeNum(token?.pairCreatedAt, 0) || safeNum(dev?.createdAt, 0) || Date.now();
    const devHistory = dev?.devWallet ? await this.fetchPumpFunDevHistory(dev.devWallet) : null;
    const records = await this.ensureHolderRecords(token, candidate);
    const rows = this.normalizeRowsWithSupply(records, totalSupply).slice(0, this.maxTrackedWallets);
    const groups = this.deriveGroups(rows, totalSupply, launchAt, dev.devWallet);
    const crossProjects = await this.detectCrossProjectWalletClusters(rows, mint, groups);
    const whaleBuys = this.detectWhaleBuys(rows, totalSupply, { ...(candidate?.token || {}), ...token });
    const deltas = this.buildDeltas(mint, groups);
    const walletCluster = candidate?.holderAccumulation?.walletCluster || this.holderAccumulationEngine?.getDashboardSummary?.()?.walletCluster || null;
    const risk = this.buildRisk(groups, devHistory || {}, walletCluster || {}, crossProjects || {}, whaleBuys || {});

    const snapshot = {
      mint,
      tokenName: token?.name || token?.symbol || candidate?.token?.name || "UNKNOWN",
      totalSupply,
      dev,
      groups,
      risk,
      walletCluster,
      crossProjects,
      whaleBuys,
      updatedAt: Date.now()
    };
    if (this.store?.addSnapshot) await this.store.addSnapshot(mint, snapshot);

    return {
      mint,
      token,
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
    return `${label} — ${safeNum(group?.count, 0)} wallets | ${fmtNum(group?.amount, 2)} tokens | ${fmtPct(group?.pct, 2)}`;
  }

  formatDeltaLine(label, key, deltas = {}) {
    const d = deltas?.[key];
    if (!d) return `${label}: нет snapshot истории`;
    return `${label}: team ${fmtSigned(d.team?.pctDelta, 2, "%")} | snipers15m ${fmtSigned(d.snipers15m?.pctDelta, 2, "%")} | dev ${fmtSigned(d.dev?.pctDelta, 2, "%")}`;
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
      `🕵️ <b>TEAM / INSIDER / SNIPER INTEL — V13</b>`,
      ``,
      `<b>${escapeHtml(token?.name || token?.symbol || "UNKNOWN")}</b>`,
      `<code>${escapeHtml(analysis?.mint || token?.ca || "")}</code>`,
      `Risk — ${safeNum(risk?.score, 0) >= 70 ? "🚩" : safeNum(risk?.score, 0) >= 45 ? "🟡" : "✅"} <b>${escapeHtml(risk?.level || "LOW")}</b> / ${safeNum(risk?.score, 0)}`,
      ``,
      `<b>👨‍💻 Dev wallet</b>`,
      `Dev — ${dev?.devWallet ? `<code>${escapeHtml(dev.devWallet)}</code>` : "не определён"}`,
      `Source — ${escapeHtml(devSource)}`,
      `Запусков dev — ${safeNum(hist?.launchesTotal, 0)} | dead/rug-like — ${safeNum(hist?.scamLikeCount, 0)} | живых/успешных — ${safeNum(hist?.successfulLikeCount, 0)} | unclear — ${safeNum(hist?.unclearCount, 0)}`,
      `Dev history source — ${escapeHtml(devHistorySource)}`,
      ``,
      `<b>🎯 Snipers</b>`,
      this.formatGroupLine("Первые 1м", groups?.snipers1m),
      this.formatGroupLine("Первые 5м", groups?.snipers5m),
      this.formatGroupLine("Первые 15м", groups?.snipers15m),
      ``,
      `<b>🧬 Insider / team cluster</b>`,
      this.formatGroupLine("Team/insider wallets", groups?.team),
      this.formatGroupLine("Dev wallet сейчас", groups?.dev),
      `Same 15m buy-window — ${safeNum(meta?.sameBuyWindowCount, 0)} wallets / ${fmtPct(meta?.sameBuyWindowSupplyPct, 2)} | CV ${fmtNum(meta?.sameBuyWindowCv, 3)}`,
      `Same-day wallet age — ${safeNum(meta?.sameWalletAgeCount, 0)} wallets / ${fmtPct(meta?.sameWalletAgeSupplyPct, 2)} | CV ${fmtNum(meta?.sameWalletAgeCv, 3)}`,
      `Same funding — ${safeNum(meta?.sameFundingCount, 0)} wallets / ${fmtPct(meta?.sameFundingSupplyPct, 2)}${meta?.sameFundingSource ? ` | ${escapeHtml(String(meta.sameFundingSource).slice(0, 24))}` : ""}`,
      ``,
      `<b>🧩 Cross-project wallet overlap</b>`,
      `Проверено кошельков — ${safeNum(crossProjects?.checkedWallets, 0)} | с другими токенами — ${safeNum(crossProjects?.walletsWithOtherTokens, 0)}`,
      `Скоплений в других проектах — ${safeNum(crossProjects?.clusteredProjectCount, 0)} | отфильтровано common/stable — ${safeNum(crossProjects?.skippedCommonProjectCount, 0)} | risk ${escapeHtml(crossProjects?.riskLevel || "LOW")}/${safeNum(crossProjects?.riskScore, 0)}`,
      ...(Array.isArray(crossProjects?.projects) && crossProjects.projects.length
        ? crossProjects.projects.slice(0, 5).flatMap((project) => [
            `• ${escapeHtml(project?.name || project?.symbol || "UNKNOWN")} ${project?.symbol ? `($${escapeHtml(project.symbol)})` : ""} — ${safeNum(project?.walletCount, 0)} wallets`,
            `  CA: <code>${escapeHtml(project?.ca || "")}</code> | liq ${fmtUsd(project?.liquidityUsd, 0)} | FDV ${fmtUsd(project?.fdv || project?.marketCap, 0)}`
          ])
        : [`• явного скопления одних и тех же кошельков в других проектах пока нет`]),
      ``,
      `<b>🐋 Whale buys</b>`,
      `Whale signal — ${escapeHtml(whaleBuys?.signal || "LOW")} | holders ${safeNum(whaleBuys?.holderWhaleCount ?? whaleBuys?.whaleCount, 0)} | buyers ${safeNum(whaleBuys?.buyWhaleCount, 0)} | holding ${safeNum(whaleBuys?.holdingWhaleCount, 0)} | reducing ${safeNum(whaleBuys?.dumpingWhaleCount, 0)}`,
      `Сейчас держат — ${fmtNum(whaleBuys?.totalCurrentAmount, 2)} tokens / ${fmtPct(whaleBuys?.totalCurrentPct, 2)} | ${fmtUsd(whaleBuys?.currentUsd, 0)}`,
      `Суммарно куплено — ${fmtNum(whaleBuys?.totalBoughtAmount, 2)} tokens / ${fmtPct(whaleBuys?.totalBoughtPct, 2)} | ${fmtUsd(whaleBuys?.totalBoughtUsd, 0)}`,
      ...(Array.isArray(whaleBuys?.rows) && whaleBuys.rows.length
        ? whaleBuys.rows.slice(0, 5).map((row) => {
            const buyPart = row?.isBuyWhale
              ? `latest buy ${fmtPct(row.latestBuyPct, 2)} | hold ${row.holdingPct === null ? "n/a" : fmtPct(row.holdingPct, 0)}`
              : `holder/transfer | bought ${fmtPct(row.totalBoughtPct, 2)}`;
            return `• ${shortWallet(row.owner)} — now ${fmtPct(row.supplyPct, 2)} | ${buyPart}`;
          })
        : [`• крупных whale-buy признаков среди top holders пока нет`]),
      ``,
      `<b>⏱ Changes by snapshots</b>`,
      this.formatDeltaLine("1м", "1m", analysis?.deltas),
      this.formatDeltaLine("5м", "5m", analysis?.deltas),
      this.formatDeltaLine("15м", "15m", analysis?.deltas),
      this.formatDeltaLine("30м", "30m", analysis?.deltas),
      ``,
      `<b>🔎 Top team wallets</b>`
    ];

    if (topTeamWallets.length) {
      for (const row of topTeamWallets) {
        lines.push(`• ${shortWallet(row.owner)} — ${fmtPct(row.supplyPct, 2)} | age ${row.walletFirstActivityComplete ? fmtNum((Date.now() - safeNum(row.walletFirstActivityAt, 0)) / 86400000, 1) + "d" : "unknown"}`);
      }
    } else {
      lines.push(`• пока нет выраженного team cluster в top holders`);
    }

    if (Array.isArray(risk?.reasons) && risk.reasons.length) {
      lines.push(``);
      lines.push(`🧠 Signals — ${escapeHtml(risk.reasons.slice(0, 5).join(" | "))}`);
    }

    lines.push(``);
    lines.push(`⚠️ Dev wallet/dev-history — эвристика. Cross-project overlap показывает текущие ненулевые SPL-балансы кошельков; USDC/USDT/wSOL/common assets отфильтрованы. Для полной истории прошлых участий нужен расширенный индексер.`);

    return lines.join("\n");
  }
}
