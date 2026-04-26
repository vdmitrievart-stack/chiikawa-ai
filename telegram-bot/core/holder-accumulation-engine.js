// holder-accumulation-engine.js
import HolderAccumulationStore from "./holder-accumulation-store.js";
import { buildWalletAgeStats, safeNum } from "./wallet-age-intelligence.js";

function nowTs() {
  return Date.now();
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

export default class HolderAccumulationEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.store = options.store || new HolderAccumulationStore({ logger: this.logger });

    // 🔥 Changed threshold from 0.3% → 0.2%
    this.minMeaningfulTrackedSharePct = Number(options.minMeaningfulTrackedSharePct || 0.2);
  }

  async initialize() {
    await this.store.initialize();
  }

  // Expects array of holders: [{ owner, tokenAccount, amount, sharePct }]
  async updateFromSnapshot(mint, holders = []) {
    const m = asText(mint);
    if (!m) return null;

    const existing = this.store.listWalletRecords(m);
    const byKey = new Map();

    for (const row of existing) {
      const key = asText(row.tokenAccount || row.owner);
      if (key) byKey.set(key, row);
    }

    const tracked = [];

    for (const h of holders) {
      const sharePct = safeNum(h.sharePct, 0);
      if (sharePct < this.minMeaningfulTrackedSharePct) continue;

      const tokenAccount = asText(h.tokenAccount || h.owner);
      if (!tokenAccount) continue;

      const prev = byKey.get(tokenAccount) || null;

      const record = {
        mint: m,
        owner: asText(h.owner),
        tokenAccount,
        amount: safeNum(h.amount, 0),
        sharePct,
        firstSeenAt: prev?.firstSeenAt || nowTs(),
        lastSeenAt: nowTs()
      };

      await this.store.setWalletRecord(m, tokenAccount, record);
      tracked.push(record);
    }

    const wallets = this.store.listWalletRecords(m);
    const walletAge = buildWalletAgeStats(wallets);

    const summary = {
      mint: m,
      walletsTracked: wallets.length,
      minTrackedSharePct: this.minMeaningfulTrackedSharePct,
      walletAge
    };

    await this.store.setSummary(m, summary);
    return summary;
  }

  getSummary(mint) {
    return this.store.getSummary(mint);
  }

  getLatestSummary() {
    return this.store.getLatestSummary();
  }
}
