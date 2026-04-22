
import fs from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

export default class HolderAccumulationStore {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir = options.baseDir || path.resolve("./runtime-data");
    this.filePath = options.filePath || path.join(this.baseDir, "holder-accumulation-snapshot.json");
    this.state = {
      version: 2,
      walletsByMint: {},
      summariesByMint: {},
      latestMint: "",
      updatedAt: 0
    };
    this.ready = false;
  }

  async initialize() {
    if (this.ready) return;
    await fs.mkdir(this.baseDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        this.state = {
          version: 2,
          walletsByMint: parsed.walletsByMint || {},
          summariesByMint: parsed.summariesByMint || {},
          latestMint: asText(parsed.latestMint, ""),
          updatedAt: Number(parsed.updatedAt || 0)
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.log("holder store load error:", error.message);
      }
    }
    this.ready = true;
  }

  async save() {
    await this.initialize();
    this.state.updatedAt = Date.now();
    try {
      await fs.writeFile(this.filePath, JSON.stringify(clone(this.state), null, 2), "utf8");
      return true;
    } catch (error) {
      this.logger.log("holder store save error:", error.message);
      return false;
    }
  }

  getWalletRecord(mint, tokenAccount) {
    const m = asText(mint);
    const t = asText(tokenAccount);
    return clone(this.state.walletsByMint?.[m]?.[t] || null);
  }

  async setWalletRecord(mint, tokenAccount, record) {
    const m = asText(mint);
    const t = asText(tokenAccount);
    if (!m || !t) return false;
    if (!this.state.walletsByMint[m]) this.state.walletsByMint[m] = {};
    this.state.walletsByMint[m][t] = {
      ...(this.state.walletsByMint[m][t] || {}),
      ...clone(record),
      updatedAt: Date.now()
    };
    return this.save();
  }

  listWalletRecords(mint) {
    const m = asText(mint);
    return Object.values(this.state.walletsByMint?.[m] || {}).map((x) => clone(x));
  }

  getSummary(mint) {
    const m = asText(mint);
    return clone(this.state.summariesByMint?.[m] || null);
  }

  getLatestSummary() {
    if (!this.state.latestMint) return null;
    return this.getSummary(this.state.latestMint);
  }

  async setSummary(mint, summary) {
    const m = asText(mint);
    if (!m) return false;
    this.state.summariesByMint[m] = {
      ...(this.state.summariesByMint[m] || {}),
      ...clone(summary),
      mint: m,
      updatedAt: Date.now()
    };
    this.state.latestMint = m;
    return this.save();
  }
}
