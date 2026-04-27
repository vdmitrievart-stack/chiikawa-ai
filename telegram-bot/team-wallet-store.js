import fs from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default class TeamWalletStore {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir = options.baseDir || path.resolve("./runtime-data");
    this.filePath = options.filePath || path.join(this.baseDir, "team-wallet-intel-snapshot.json");
    this.maxSnapshotsPerMint = Number(options.maxSnapshotsPerMint || 720);
    this.state = {
      version: 1,
      snapshotsByMint: {},
      devHistoryByWallet: {},
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
          version: 1,
          snapshotsByMint: parsed.snapshotsByMint || {},
          devHistoryByWallet: parsed.devHistoryByWallet || {},
          latestMint: asText(parsed.latestMint, ""),
          updatedAt: safeNum(parsed.updatedAt, 0)
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.log?.("team wallet store load error:", error.message);
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
      this.logger.log?.("team wallet store save error:", error.message);
      return false;
    }
  }

  getSnapshots(mint) {
    const m = asText(mint);
    return (this.state.snapshotsByMint?.[m] || []).map((x) => clone(x));
  }

  getLatestSnapshot(mint) {
    const rows = this.getSnapshots(mint);
    return rows.length ? rows[rows.length - 1] : null;
  }

  async addSnapshot(mint, snapshot) {
    await this.initialize();
    const m = asText(mint);
    if (!m) return false;
    if (!this.state.snapshotsByMint[m]) this.state.snapshotsByMint[m] = [];
    this.state.snapshotsByMint[m].push(clone({ ...snapshot, mint: m, updatedAt: Date.now() }));
    this.state.snapshotsByMint[m] = this.state.snapshotsByMint[m]
      .sort((a, b) => safeNum(a.updatedAt, 0) - safeNum(b.updatedAt, 0))
      .slice(-this.maxSnapshotsPerMint);
    this.state.latestMint = m;
    return this.save();
  }

  getComparisonSnapshot(mint, agoMs, now = Date.now()) {
    const rows = this.getSnapshots(mint);
    if (!rows.length) return null;
    const target = now - safeNum(agoMs, 0);
    let best = null;
    for (const row of rows) {
      const ts = safeNum(row?.updatedAt, 0);
      if (!ts || ts > target) continue;
      if (!best || ts > safeNum(best?.updatedAt, 0)) best = row;
    }
    return best;
  }

  getDevHistory(wallet) {
    const w = asText(wallet);
    return clone(this.state.devHistoryByWallet?.[w] || null);
  }

  async setDevHistory(wallet, history) {
    await this.initialize();
    const w = asText(wallet);
    if (!w) return false;
    this.state.devHistoryByWallet[w] = clone({ ...history, wallet: w, updatedAt: Date.now() });
    return this.save();
  }
}
