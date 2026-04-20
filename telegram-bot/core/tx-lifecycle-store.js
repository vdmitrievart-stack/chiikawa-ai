import fs from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class TxLifecycleStore {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir = options.baseDir || path.resolve("./runtime-data");
    this.filePath = options.filePath || path.join(this.baseDir, "tx-lifecycle.json");
    this.state = {
      intents: []
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
      this.state = parsed && typeof parsed === "object" ? parsed : { intents: [] };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.log("tx store load error:", error.message);
      }
      this.state = { intents: [] };
    }
    return this.state;
  }

  async save() {
    await this.ensureDir();
    try {
      await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
      return true;
    } catch (error) {
      this.logger.log("tx store save error:", error.message);
      return false;
    }
  }

  listIntents() {
    return clone(this.state.intents || []);
  }

  listPendingIntents() {
    return this.listIntents().filter((x) =>
      ["created", "quoted", "awaiting_approval", "signed", "submitted"].includes(x.status)
    );
  }

  getIntent(intentId) {
    return clone((this.state.intents || []).find((x) => x.intentId === intentId) || null);
  }

  async upsertIntent(intent) {
    const row = clone(intent);
    const idx = (this.state.intents || []).findIndex((x) => x.intentId === row.intentId);

    if (idx === -1) {
      this.state.intents.push(row);
    } else {
      this.state.intents[idx] = {
        ...this.state.intents[idx],
        ...row,
        updatedAt: new Date().toISOString()
      };
    }

    await this.save();
    return this.getIntent(row.intentId);
  }

  async setStatus(intentId, status, patch = {}) {
    const idx = (this.state.intents || []).findIndex((x) => x.intentId === intentId);
    if (idx === -1) return null;

    this.state.intents[idx] = {
      ...this.state.intents[idx],
      ...clone(patch),
      status,
      updatedAt: new Date().toISOString()
    };

    await this.save();
    return this.getIntent(intentId);
  }
}
