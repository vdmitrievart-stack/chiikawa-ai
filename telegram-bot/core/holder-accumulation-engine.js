import { Connection, PublicKey } from "@solana/web3.js";
import HolderAccumulationStore from "./holder-accumulation-store.js";

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

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class HolderAccumulationEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.store = options.store || new HolderAccumulationStore({ logger: this.logger });
    this.rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    this.connection = options.connection || new Connection(this.rpcUrl, "confirmed");
    this.maxTrackedAccounts = Number(options.maxTrackedAccounts || process.env.HOLDER_TRACK_MAX_ACCOUNTS || 20);
    this.refreshMs = Number(options.refreshMs || process.env.HOLDER_TRACK_REFRESH_MS || 180000);
  }

  async initialize() {
    await this.store.load();
    return true;
  }

  getDashboardSummary() {
    const rows = this.store.summarizeTopTracked(1);
    return rows[0] || null;
  }

  async trackCandidate(candidate = {}) {
    const token = candidate?.token || {};
    const mint = asText(token?.ca, "");
    if (!mint) return null;

    const existing = this.store.getTokenState(mint);
    const now = Date.now();
    if (existing?.summary?.observedAt && now - Date.parse(existing.summary.observedAt) < this.refreshMs) {
      return clone(existing.summary);
    }

    const snapshot = await this.fetchLiveSnapshot(mint);
    if (!snapshot) {
      return existing?.summary || null;
    }

    const nextState = this.mergeSnapshot(existing, snapshot, candidate);
    this.store.setTokenState(mint, nextState);
    await this.store.save();
    return clone(nextState.summary);
  }

  async fetchLiveSnapshot(mint) {
    try {
      const mintPk = new PublicKey(mint);
      const supplyResp = await this.connection.getTokenSupply(mintPk);
      const supplyUi = safeNum(supplyResp?.value?.uiAmountString || supplyResp?.value?.uiAmount, 0);
      const largestResp = await this.connection.getTokenLargestAccounts(mintPk);
      const largest = Array.isArray(largestResp?.value) ? largestResp.value.slice(0, this.maxTrackedAccounts) : [];

      const wallets = [];
      for (const row of largest) {
        try {
          const parsed = await this.connection.getParsedAccountInfo(row.address);
          const info = parsed?.value?.data?.parsed?.info;
          const owner = asText(info?.owner, "");
          const amountUi = safeNum(info?.tokenAmount?.uiAmountString || info?.tokenAmount?.uiAmount, 0);
          if (!owner || amountUi <= 0) continue;
          wallets.push({
            owner,
            tokenAccount: row.address.toBase58(),
            amountUi,
            sharePct: supplyUi > 0 ? (amountUi / supplyUi) * 100 : 0
          });
        } catch (error) {
          this.logger.log("holder parsed account error:", error.message);
        }
      }

      return {
        mint,
        observedAt: new Date().toISOString(),
        supplyUi,
        wallets
      };
    } catch (error) {
      this.logger.log("holder live snapshot failed:", error.message);
      return null;
    }
  }

  mergeSnapshot(existing = null, snapshot = {}, candidate = {}) {
    const nowIso = snapshot?.observedAt || new Date().toISOString();
    const nowMs = Date.parse(nowIso) || Date.now();
    const previousWallets = clone(existing?.wallets || {});
    const nextWallets = {};
    const currentOwners = new Set();

    for (const wallet of snapshot.wallets || []) {
      const owner = asText(wallet?.owner, "");
      if (!owner) continue;
      currentOwners.add(owner);
      const prev = previousWallets[owner] || null;
      const currentBalance = safeNum(wallet?.amountUi, 0);
      const prevBalance = safeNum(prev?.currentBalance, 0);
      const grew = prev ? currentBalance > prevBalance * 1.02 : false;
      const shrank = prev ? currentBalance < prevBalance * 0.98 : false;

      nextWallets[owner] = {
        owner,
        tokenAccount: asText(wallet?.tokenAccount, prev?.tokenAccount || ""),
        firstSeenAt: asText(prev?.firstSeenAt, nowIso),
        lastSeenAt: nowIso,
        initialBalance: prev ? safeNum(prev?.initialBalance, currentBalance) : currentBalance,
        currentBalance,
        peakBalance: Math.max(safeNum(prev?.peakBalance, currentBalance), currentBalance),
        firstSharePct: prev ? safeNum(prev?.firstSharePct, wallet?.sharePct) : safeNum(wallet?.sharePct, 0),
        currentSharePct: safeNum(wallet?.sharePct, 0),
        increaseCount: safeNum(prev?.increaseCount, 0) + (grew ? 1 : 0),
        decreaseCount: safeNum(prev?.decreaseCount, 0) + (shrank ? 1 : 0),
        lastIncreaseAt: grew ? nowIso : asText(prev?.lastIncreaseAt, ""),
        lastDecreaseAt: shrank ? nowIso : asText(prev?.lastDecreaseAt, "")
      };
    }

    for (const [owner, prev] of Object.entries(previousWallets)) {
      if (currentOwners.has(owner)) continue;
      nextWallets[owner] = {
        ...prev,
        currentBalance: 0,
        currentSharePct: 0,
        decreaseCount: safeNum(prev?.currentBalance, 0) > 0 ? safeNum(prev?.decreaseCount, 0) + 1 : safeNum(prev?.decreaseCount, 0),
        lastDecreaseAt: safeNum(prev?.currentBalance, 0) > 0 ? nowIso : asText(prev?.lastDecreaseAt, ""),
        lastSeenAt: asText(prev?.lastSeenAt, nowIso)
      };
    }

    const summary = this.buildSummary(nextWallets, snapshot, candidate, existing?.summary || null, nowMs, nowIso);

    return {
      mint: snapshot?.mint,
      supplyUi: safeNum(snapshot?.supplyUi, safeNum(existing?.supplyUi, 0)),
      observedAt: nowIso,
      wallets: nextWallets,
      summary
    };
  }

  buildSummary(wallets = {}, snapshot = {}, candidate = {}, previousSummary = null, nowMs = Date.now(), nowIso = new Date().toISOString()) {
    const rows = Object.values(wallets || {});
    const supplyUi = safeNum(snapshot?.supplyUi, 0);
    const tracked = rows.filter((row) => safeNum(row?.peakBalance, 0) > 0);
    const fresh = tracked.filter((row) => {
      const ageMs = nowMs - (Date.parse(asText(row?.firstSeenAt, nowIso)) || nowMs);
      return ageMs <= 24 * 60 * 60 * 1000 && safeNum(row?.currentBalance, 0) > 0;
    });

    const matured30 = fresh.filter((row) => nowMs - (Date.parse(asText(row?.firstSeenAt, nowIso)) || nowMs) >= 30 * 60 * 1000);
    const retained30 = matured30.filter((row) => safeNum(row?.currentBalance, 0) >= safeNum(row?.initialBalance, 0) * 0.75);
    const matured2h = fresh.filter((row) => nowMs - (Date.parse(asText(row?.firstSeenAt, nowIso)) || nowMs) >= 2 * 60 * 60 * 1000);
    const retained2h = matured2h.filter((row) => safeNum(row?.currentBalance, 0) >= safeNum(row?.initialBalance, 0) * 0.7);

    const freshWalletBuyCount = fresh.length;
    const retention30mPct = matured30.length ? (retained30.length / matured30.length) * 100 : 0;
    const retention2hPct = matured2h.length ? (retained2h.length / matured2h.length) * 100 : 0;
    const netCurrentBalance = fresh.reduce((sum, row) => sum + safeNum(row?.currentBalance, 0), 0);
    const netInitialBalance = fresh.reduce((sum, row) => sum + safeNum(row?.initialBalance, 0), 0);
    const netAccumulationPct = netInitialBalance > 0 ? ((netCurrentBalance - netInitialBalance) / netInitialBalance) * 100 : 0;
    const netControlPct = supplyUi > 0 ? (netCurrentBalance / supplyUi) * 100 : 0;
    const reloadCount = fresh.reduce((sum, row) => sum + safeNum(row?.increaseCount, 0), 0);
    const decreaseCount = fresh.reduce((sum, row) => sum + safeNum(row?.decreaseCount, 0), 0);
    const dipBuyRatio = reloadCount + decreaseCount > 0 ? reloadCount / (reloadCount + decreaseCount) : 0;
    const silentHoldPct = fresh.length
      ? (fresh.filter((row) => safeNum(row?.decreaseCount, 0) === 0).length / fresh.length) * 100
      : 0;

    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, safeNum(candidate?.token?.priceChangeH6, 0));
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, safeNum(candidate?.token?.priceChangeH1, 0));
    const priceM5 = safeNum(candidate?.delta?.priceM5Pct, safeNum(candidate?.token?.priceChangeM5, 0));
    const bottomTouches = clamp(
      Math.round(
        (priceH6 < 0 ? 1 : 0) +
        (Math.abs(priceH1) <= 10 ? 1 : 0) +
        (Math.abs(priceM5) <= 5 ? 1 : 0) +
        (freshWalletBuyCount >= 3 ? 1 : 0)
      ),
      0,
      4
    );

    let quietAccumulationScore = 0;
    if (freshWalletBuyCount >= 3) quietAccumulationScore += 18;
    if (retention30mPct >= 55) quietAccumulationScore += 18;
    if (retention2hPct >= 45) quietAccumulationScore += 12;
    if (netControlPct >= 1) quietAccumulationScore += 14;
    if (netControlPct >= 2.5) quietAccumulationScore += 8;
    if (netAccumulationPct >= 10) quietAccumulationScore += 10;
    if (dipBuyRatio >= 0.58) quietAccumulationScore += 10;
    if (reloadCount >= 2) quietAccumulationScore += 8;
    if (silentHoldPct >= 45) quietAccumulationScore += 8;
    if (bottomTouches >= 3) quietAccumulationScore += 6;

    const quietAccumulationPass =
      freshWalletBuyCount >= 3 &&
      retention30mPct >= 55 &&
      netControlPct >= 1 &&
      dipBuyRatio >= 0.55 &&
      quietAccumulationScore >= 56;

    const bottomPackReversalPass =
      quietAccumulationPass &&
      bottomTouches >= 3 &&
      priceH6 <= -8 &&
      priceH1 > -10 &&
      priceM5 > -3;

    return {
      mint: snapshot?.mint,
      tokenName: asText(candidate?.token?.name, ""),
      observedAt: nowIso,
      trackedWallets: tracked.length,
      freshWalletBuyCount,
      retention30mPct: clamp(retention30mPct, 0, 100),
      retention2hPct: clamp(retention2hPct, 0, 100),
      netAccumulationPct,
      netControlPct,
      reloadCount,
      dipBuyRatio: clamp(dipBuyRatio, 0, 1),
      silentHoldPct: clamp(silentHoldPct, 0, 100),
      bottomTouches,
      quietAccumulationScore: clamp(Math.round(quietAccumulationScore), 0, 99),
      quietAccumulationPass,
      bottomPackReversalPass,
      controlTrendPct: safeNum(previousSummary?.netControlPct, 0) ? netControlPct - safeNum(previousSummary?.netControlPct, 0) : 0
    };
  }
}
