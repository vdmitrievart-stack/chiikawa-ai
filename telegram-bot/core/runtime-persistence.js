import fs from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class RuntimePersistence {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir = options.baseDir || path.resolve("./runtime-data");
    this.filePath =
      options.filePath || path.join(this.baseDir, "bot-runtime-snapshot.json");
  }

  async ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  async loadSnapshot() {
    await this.ensureDir();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.log("runtime load error:", error.message);
      }
      return null;
    }
  }

  async saveSnapshot(snapshot) {
    await this.ensureDir();
    try {
      const payload = clone({
        savedAt: new Date().toISOString(),
        ...snapshot
      });
      await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
      return true;
    } catch (error) {
      this.logger.log("runtime save error:", error.message);
      return false;
    }
  }
}
