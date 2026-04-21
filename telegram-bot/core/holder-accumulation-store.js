import fs from "node:fs/promises";
import path from "node:path";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class HolderAccumulationStore {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir = options.baseDir || path.resolve("./runtime-data");
    this.filePath = options.filePath || path.join(this.baseDir, "holder-accumulation-store.json");
    this.state = {
      tokens: {},
      updatedAt: ""
    };
  }

  async ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  async load() {
    await this.ensureDir();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        tokens: parsed?.tokens || {},
        updatedAt: asText(parsed?.updatedAt, "")
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.log("holder store load error:", error.message);
      }
    }
    return clone(this.state);
  }

  async save() {
    await this.ensureDir();
    this.state.updatedAt = new Date().toISOString();
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    return true;
  }

  getTokenState(mint) {
    return clone(this.state.tokens[asText(mint)] || null);
  }

  setTokenState(mint, value) {
    const key = asText(mint);
    if (!key) return null;
    this.state.tokens[key] = clone(value);
    return this.getTokenState(key);
  }

  listTokenStates() {
    return Object.entries(this.state.tokens || {}).map(([mint, row]) => ({ mint, ...clone(row) }));
  }

  summarizeTopTracked(limit = 5) {
    const rows = this.listTokenStates()
      .map((row) => ({ mint: row.mint, summary: row.summary || null }))
      .filter((row) => row.summary)
      .sort((a, b) => safeNum(b.summary?.quietAccumulationScore, 0) - safeNum(a.summary?.quietAccumulationScore, 0))
      .slice(0, limit);

    return rows.map((row) => ({ mint: row.mint, ...clone(row.summary) }));
  }
}
