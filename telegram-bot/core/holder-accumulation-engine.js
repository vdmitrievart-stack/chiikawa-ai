
import { Connection, PublicKey } from "@solana/web3.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function chunk(rows = [], size = 4) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function sum(rows, key) {
  return rows.reduce((acc, row) => acc + safeNum(row?.[key], 0), 0);
}

export default class HolderAccumulationEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.store = options.store;
    this.rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || "";
    this.summaryTtlMs = Number(options.summaryTtlMs || 5 * 60 * 1000);
    this.walletTtlMs = Number(options.walletTtlMs || 30 * 60 * 1000);
    this.maxTrackedWallets = Number(options.maxTrackedWallets || 20);
    this.maxHistorySignatures = Number(options.maxHistorySignatures || 18);
    this.minMeaningfulTrackedSharePct = Number(options.minMeaningfulTrackedSharePct || 0.4);
    this.minMeaningfulHoldingPct = Number(options.minMeaningfulHoldingPct || 20);
    this.connection = null;
  }

  async initialize() {
    if (this.store?.initialize) await this.store.initialize();
    if (this.rpcUrl && !this.connection) {
      this.connection = new Connection(this.rpcUrl, "confirmed");
    }
  }

  getDashboardSummary() {
    return this.store?.getLatestSummary?.() || null;
  }

  async trackCandidate(candidate = {}) {
    await this.initialize();

    const mint = asText(candidate?.token?.ca);
    if (!mint) return null;

    const cached = this.store?.getSummary?.(mint);
    if (cached && Date.now() - safeNum(cached?.updatedAt, 0) < this.summaryTtlMs) {
      return cached;
    }

    if (!this.connection) {
      return cached || this.buildEmptySummary(candidate);
    }

    try {
      const holders = await this.fetchTopTokenAccounts(mint);
      const historical = await this.enrichHistoricalWallets(mint, holders, candidate);
      const summary = this.buildSummary(candidate, historical);
      await this.store?.setSummary?.(mint, summary);
      return summary;
    } catch (error) {
      this.logger.log("holder engine trackCandidate error:", error.message);
      return cached || this.buildEmptySummary(candidate);
    }
  }

  buildEmptySummary(candidate = {}) {
    const mint = asText(candidate?.token?.ca);
    return {
      tokenName: candidate?.token?.name || candidate?.token?.symbol || "-",
      mint,
      trackedWallets: 0,
      freshWalletBuyCount: 0,
      warehouseWalletCount: 0,
      retention30mPct: 0,
      retention2hPct: 0,
      retention6hPct: 0,
      retention24hPct: 0,
      historicalRetentionBasis: "live_only",
      netAccumulationPct: 0,
      netControlPct: 0,
      reloadCount: 0,
      dipBuyRatio: 0,
      bottomTouches: this.estimateBottomTouches(candidate),
      quietAccumulationPass: false,
      bottomPackReversalPass: false,
      accumulationPhaseAgeHours: 0,
      warehouseSimilarityScore: 0,
      warehouseChurnScore: 100,
      warehouseStoragePass: false,
      activeReaccumulationPass: false,
      warehouseMode: 'none',
      meaningfulWalletCount: 0,
      selfBuyWalletCount: 0,
      transferOnlyWalletCount: 0,
      dustFilteredWalletCount: 0,
      meaningfulCoveragePct: 0,
      updatedAt: Date.now()
    };
  }

  async fetchTopTokenAccounts(mint) {
    const mintKey = new PublicKey(mint);
    const largest = await this.connection.getTokenLargestAccounts(mintKey);
    const rows = (largest?.value || []).slice(0, this.maxTrackedWallets);

    const out = [];
    for (const row of rows) {
      const tokenAccount = asText(row?.address?.toBase58?.() || row?.address || "");
      if (!tokenAccount) continue;
      try {
        const parsed = await this.connection.getParsedAccountInfo(new PublicKey(tokenAccount));
        const info = parsed?.value?.data?.parsed?.info || {};
        const owner = asText(info?.owner, "");
        const amount = safeNum(row?.uiAmount, 0);
        if (!owner || amount <= 0) continue;
        out.push({ tokenAccount, owner, currentTokenAmount: amount });
      } catch (error) {
        this.logger.log("holder engine parsed token account error:", error.message);
      }
    }
    return out;
  }

  ownerSigned(tx, owner) {
    const keys = Array.isArray(tx?.transaction?.message?.accountKeys) ? tx.transaction.message.accountKeys : [];
    return keys.some((row) => {
      const key = asText(row?.pubkey?.toBase58?.() || row?.pubkey || row || "");
      const signer = row?.signer === true || row?.signer === 1 || row?.signer === "true";
      return key === owner && signer;
    });
  }

  async enrichHistoricalWallets(mint, holders = [], candidate = {}) {
    const now = Date.now();
    const out = [];
    for (const holder of holders) {
      const cached = this.store?.getWalletRecord?.(mint, holder.tokenAccount);
      if (cached && now - safeNum(cached?.updatedAt, 0) < this.walletTtlMs) {
        out.push({ ...cached, currentTokenAmount: holder.currentTokenAmount, owner: holder.owner, tokenAccount: holder.tokenAccount });
        continue;
      }

      const fresh = await this.backfillTokenAccountHistory(mint, holder, candidate);
      out.push(fresh);
      await this.store?.setWalletRecord?.(mint, holder.tokenAccount, fresh);
    }
    return out;
  }

  async backfillTokenAccountHistory(mint, holder = {}, candidate = {}) {
    const tokenAccount = asText(holder.tokenAccount);
    const owner = asText(holder.owner);
    const currentTokenAmount = safeNum(holder.currentTokenAmount, 0);
    const now = Date.now();

    let signatures = [];
    try {
      signatures = await this.connection.getSignaturesForAddress(new PublicKey(tokenAccount), { limit: this.maxHistorySignatures });
    } catch (error) {
      this.logger.log("holder engine signatures error:", error.message);
    }

    let earliestBuyAt = 0;
    let latestBuyAt = 0;
    let latestSellAt = 0;
    let earliestTransferInAt = 0;
    let totalBought = 0;
    let totalSold = 0;
    let totalTransferredIn = 0;
    let buyCount = 0;
    let selfBuyCount = 0;
    let transferInCount = 0;
    let sellCount = 0;

    for (const group of chunk(signatures, 4)) {
      const txs = await Promise.all(group.map(async (sigRow) => {
        try {
          return await this.connection.getParsedTransaction(sigRow.signature, { maxSupportedTransactionVersion: 0 });
        } catch {
          return null;
        }
      }));

      for (let i = 0; i < txs.length; i += 1) {
        const tx = txs[i];
        const sigRow = group[i];
        if (!tx?.meta) continue;
        const delta = this.computeTokenAccountDelta(tx, mint, tokenAccount, owner);
        if (delta > 0) {
          const at = safeNum(sigRow?.blockTime, 0) * 1000;
          const selfDirectedBuy = this.ownerSigned(tx, owner);
          if (selfDirectedBuy) {
            totalBought += delta;
            buyCount += 1;
            selfBuyCount += 1;
            if (at > 0 && (!earliestBuyAt || at < earliestBuyAt)) earliestBuyAt = at;
            if (at > latestBuyAt) latestBuyAt = at;
          } else {
            totalTransferredIn += delta;
            transferInCount += 1;
            if (at > 0 && (!earliestTransferInAt || at < earliestTransferInAt)) earliestTransferInAt = at;
          }
        } else if (delta < 0) {
          totalSold += Math.abs(delta);
          sellCount += 1;
          const at = safeNum(sigRow?.blockTime, 0) * 1000;
          if (at > latestSellAt) latestSellAt = at;
        }
      }
    }

    const firstSeenAt = earliestBuyAt || earliestTransferInAt || (signatures.length ? safeNum(signatures[signatures.length - 1]?.blockTime, 0) * 1000 : 0) || 0;
    const firstEconomicAt = earliestBuyAt || 0;
    const holdDurationMinutes = firstEconomicAt > 0 ? (now - firstEconomicAt) / 60000 : 0;
    const currentHoldingPct = totalBought > 0 ? clamp((currentTokenAmount / Math.max(totalBought, 0.0000001)) * 100, 0, 100) : 0;
    const reloadCount = Math.max(0, selfBuyCount - 1);
    const churnScore = clamp(totalBought > 0 ? (totalSold / totalBought) * 100 : 100, 0, 100);
    const selfBuyer = selfBuyCount > 0;
    const transferOnly = !selfBuyer && totalTransferredIn > 0;
    const storageLike = selfBuyer && currentHoldingPct >= 60 && churnScore <= 40 && (sellCount <= 1 || latestSellAt === 0);

    const priceWeakness = safeNum(candidate?.delta?.priceH6Pct, 0) < 0 || safeNum(candidate?.delta?.priceH24Pct, 0) < 0;
    const dipBuyRatio = selfBuyCount > 0 ? clamp((reloadCount / selfBuyCount) * (priceWeakness ? 1 : 0.5), 0, 1) : 0;

    return {
      tokenAccount,
      owner,
      currentTokenAmount,
      totalBought,
      totalSold,
      totalTransferredIn,
      buyCount: selfBuyCount,
      selfBuyCount,
      transferInCount,
      sellCount,
      firstBuyAt: earliestBuyAt || 0,
      latestBuyAt,
      latestSellAt,
      firstSeenAt,
      holdDurationMinutes,
      currentHoldingPct,
      reloadCount,
      churnScore,
      dipBuyRatio,
      selfBuyer,
      transferOnly,
      storageLike,
      updatedAt: now
    };
  }

  computeTokenAccountDelta(tx, mint, tokenAccount, owner) {
    const pre = Array.isArray(tx?.meta?.preTokenBalances) ? tx.meta.preTokenBalances : [];
    const post = Array.isArray(tx?.meta?.postTokenBalances) ? tx.meta.postTokenBalances : [];

    const sumFor = (rows) => rows
      .filter((row) => asText(row?.mint) === mint && asText(row?.owner) === owner)
      .reduce((acc, row) => {
        const amt = safeNum(row?.uiTokenAmount?.uiAmount, 0);
        return acc + amt;
      }, 0);

    const preAmt = sumFor(pre);
    const postAmt = sumFor(post);
    return postAmt - preAmt;
  }

  buildSummary(candidate = {}, walletRows = []) {
    const mint = asText(candidate?.token?.ca);
    const tokenName = candidate?.token?.name || candidate?.token?.symbol || mint;
    const now = Date.now();
    const pairAgeMin = safeNum(candidate?.migration?.pairAgeMin, 0);
    const cohortWindowMin = Math.max(60, Math.min(10 * 24 * 60, pairAgeMin > 0 ? pairAgeMin : 10 * 24 * 60));

    const trackedWallets = walletRows.length;
    const totalCurrentTracked = sum(walletRows, 'currentTokenAmount');

    const normalizedRows = walletRows.map((row) => {
      const trackedSharePct = totalCurrentTracked > 0 ? (safeNum(row?.currentTokenAmount, 0) / totalCurrentTracked) * 100 : 0;
      const meaningful = Boolean(row?.selfBuyer) && trackedSharePct >= this.minMeaningfulTrackedSharePct && safeNum(row?.currentHoldingPct, 0) >= this.minMeaningfulHoldingPct;
      return { ...row, trackedSharePct, meaningful };
    });

    const meaningfulRows = normalizedRows.filter((row) => row?.meaningful);
    const meaningfulTrackedCurrent = sum(meaningfulRows, 'currentTokenAmount');
    const meaningfulWalletCount = meaningfulRows.length;
    const selfBuyWalletCount = normalizedRows.filter((row) => row?.selfBuyer).length;
    const transferOnlyWalletCount = normalizedRows.filter((row) => row?.transferOnly).length;
    const dustFilteredWalletCount = normalizedRows.filter((row) => !row?.meaningful && !row?.transferOnly).length;
    const meaningfulCoveragePct = totalCurrentTracked > 0 ? (meaningfulTrackedCurrent / totalCurrentTracked) * 100 : 0;

    const freshCohort = meaningfulRows.filter((row) => safeNum(row?.holdDurationMinutes, 0) > 0 && safeNum(row?.holdDurationMinutes, 0) <= cohortWindowMin);
    const freshWalletBuyCount = freshCohort.length;
    const warehouseWallets = freshCohort.filter((row) => row?.storageLike);

    const retained30m = freshCohort.filter((row) => safeNum(row?.holdDurationMinutes, 0) >= 30 && safeNum(row?.currentHoldingPct, 0) >= 60).length;
    const retained2h = freshCohort.filter((row) => safeNum(row?.holdDurationMinutes, 0) >= 120 && safeNum(row?.currentHoldingPct, 0) >= 60).length;
    const retained6h = freshCohort.filter((row) => safeNum(row?.holdDurationMinutes, 0) >= 360 && safeNum(row?.currentHoldingPct, 0) >= 60).length;
    const retained24h = freshCohort.filter((row) => safeNum(row?.holdDurationMinutes, 0) >= 1440 && safeNum(row?.currentHoldingPct, 0) >= 60).length;

    const freshCurrent = sum(freshCohort, 'currentTokenAmount');
    const freshBought = sum(freshCohort, 'totalBought');
    const reloadCount = sum(freshCohort, 'reloadCount');
    const avgDipBuy = freshCohort.length ? freshCohort.reduce((acc, row) => acc + safeNum(row?.dipBuyRatio, 0), 0) / freshCohort.length : 0;
    const avgChurn = freshCohort.length ? freshCohort.reduce((acc, row) => acc + safeNum(row?.churnScore, 0), 0) / freshCohort.length : 100;
    const earliestBuyAt = freshCohort.reduce((min, row) => {
      const v = safeNum(row?.firstBuyAt, 0);
      if (!v) return min;
      return min && min < v ? min : v;
    }, 0);

    const retention30mPct = freshWalletBuyCount > 0 ? (retained30m / freshWalletBuyCount) * 100 : 0;
    const retention2hPct = freshWalletBuyCount > 0 ? (retained2h / freshWalletBuyCount) * 100 : 0;
    const retention6hPct = freshWalletBuyCount > 0 ? (retained6h / freshWalletBuyCount) * 100 : 0;
    const retention24hPct = freshWalletBuyCount > 0 ? (retained24h / freshWalletBuyCount) * 100 : 0;
    const netAccumulationPct = freshBought > 0 ? clamp((freshCurrent / freshBought) * 100, 0, 100) : 0;
    const netControlPct = meaningfulTrackedCurrent > 0 ? clamp((freshCurrent / meaningfulTrackedCurrent) * 100, 0, 100) : 0;
    const bottomTouches = this.estimateBottomTouches(candidate, reloadCount, retention2hPct);
    const accumulationPhaseAgeHours = earliestBuyAt > 0 ? (now - earliestBuyAt) / 3600000 : 0;
    const warehouseSimilarityScore = this.estimateSimilarityScore(freshCohort, candidate);

    const warehouseStoragePass =
      freshWalletBuyCount >= 10 &&
      netAccumulationPct >= 70 &&
      netControlPct >= 45 &&
      meaningfulCoveragePct >= 15 &&
      avgChurn <= 45 &&
      (retention30mPct >= 45 || retention2hPct >= 28 || retention6hPct >= 16) &&
      (warehouseWallets.length >= 6 || warehouseSimilarityScore >= 32 || bottomTouches >= 2);

    const activeReaccumulationPass =
      freshWalletBuyCount >= 8 &&
      (retention30mPct >= 25 || retention2hPct >= 12) &&
      (reloadCount >= 2 || avgDipBuy >= 0.18) &&
      bottomTouches >= 2;

    const quietAccumulationPass =
      warehouseStoragePass ||
      activeReaccumulationPass ||
      (
        freshWalletBuyCount >= 10 &&
        netControlPct >= 20 &&
        meaningfulCoveragePct >= 15 &&
        (retention30mPct >= 30 || retention2hPct >= 18 || retention6hPct >= 10) &&
        (bottomTouches >= 2)
      );

    const bottomPackReversalPass =
      (
        warehouseStoragePass &&
        (freshWalletBuyCount >= 14 || warehouseWallets.length >= 8) &&
        bottomTouches >= 2 &&
        (retention2hPct >= 12 || accumulationPhaseAgeHours >= 2)
      ) || (
        activeReaccumulationPass &&
        avgDipBuy >= 0.16 &&
        bottomTouches >= 2 &&
        avgChurn <= 50
      );

    const warehouseMode = warehouseStoragePass
      ? 'warehouse_storage_accumulation'
      : activeReaccumulationPass
        ? 'active_reaccumulation'
        : 'none';

    return {
      tokenName,
      mint,
      trackedWallets,
      freshWalletBuyCount,
      warehouseWalletCount: warehouseWallets.length,
      retention30mPct: roundPct(retention30mPct),
      retention2hPct: roundPct(retention2hPct),
      retention6hPct: roundPct(retention6hPct),
      retention24hPct: roundPct(retention24hPct),
      historicalRetentionBasis: "first_buy_backfill",
      netAccumulationPct: roundPct(netAccumulationPct),
      netControlPct: roundPct(netControlPct),
      reloadCount,
      dipBuyRatio: roundNum(avgDipBuy, 2),
      bottomTouches,
      quietAccumulationPass,
      bottomPackReversalPass,
      accumulationPhaseAgeHours: roundNum(accumulationPhaseAgeHours, 2),
      warehouseSimilarityScore: roundNum(warehouseSimilarityScore, 2),
      warehouseChurnScore: roundNum(100 - avgChurn, 2),
      warehouseStoragePass,
      activeReaccumulationPass,
      warehouseMode,
      meaningfulWalletCount,
      selfBuyWalletCount,
      transferOnlyWalletCount,
      dustFilteredWalletCount,
      meaningfulCoveragePct: roundPct(meaningfulCoveragePct),
      minimumMeaningfulSharePct: this.minMeaningfulTrackedSharePct,
      updatedAt: now
    };
  }

  estimateBottomTouches(candidate = {}, reloadCount = 0, retention2hPct = 0) {
    const priceM5 = safeNum(candidate?.delta?.priceM5Pct, 0);
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, 0);
    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, 0);
    let touches = 0;
    if (Math.abs(priceM5) <= 4) touches += 1;
    if (priceH1 <= 0 && priceH1 > -15) touches += 1;
    if (priceH6 < 0) touches += 1;
    if (reloadCount >= 2) touches += 1;
    if (retention2hPct >= 12) touches += 1;
    return clamp(touches, 0, 5);
  }

  estimateSimilarityScore(rows = [], candidate = {}) {
    if (!rows.length) return 0;
    const holds = rows.map((x) => safeNum(x?.holdDurationMinutes, 0)).filter(Boolean);
    const holdings = rows.map((x) => safeNum(x?.currentHoldingPct, 0));
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(arr.length, 1);
    const variance = (arr) => {
      const m = mean(arr);
      return arr.reduce((acc, x) => acc + (x - m) ** 2, 0) / Math.max(arr.length, 1);
    };
    const holdVar = variance(holds || [0]);
    const holdPctVar = variance(holdings || [0]);
    const priceM5 = Math.abs(safeNum(candidate?.delta?.priceM5Pct, 0));
    const score = 100 - Math.min(100, Math.sqrt(holdVar) * 0.5 + Math.sqrt(holdPctVar) * 0.7 + priceM5 * 1.5);
    return clamp(score, 0, 100);
  }
}

function roundPct(v) {
  return Math.round((safeNum(v, 0) + Number.EPSILON) * 100) / 100;
}

function roundNum(v, d = 2) {
  const p = 10 ** d;
  return Math.round((safeNum(v, 0) + Number.EPSILON) * p) / p;
}
