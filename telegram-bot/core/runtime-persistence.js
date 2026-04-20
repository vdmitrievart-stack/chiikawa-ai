import fs from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class RuntimePersistence {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir = options.baseDir || path.resolve("./runtime-data");
    this.runtimePath =
      options.runtimePath || path.join(this.baseDir, "bot-runtime-snapshot.json");
    this.portfolioPath =
      options.portfolioPath || path.join(this.baseDir, "bot-portfolio-snapshot.json");
  }

  async ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  async loadJson(filePath) {
    await this.ensureDir();
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.log("persistence load error:", error.message);
      }
      return null;
    }
  }

  async saveJson(filePath, payload) {
    await this.ensureDir();
    try {
      await fs.writeFile(filePath, JSON.stringify(clone(payload), null, 2), "utf8");
      return true;
    } catch (error) {
      this.logger.log("persistence save error:", error.message);
      return false;
    }
  }

  async loadRuntimeSnapshot() {
    return this.loadJson(this.runtimePath);
  }

  async saveRuntimeSnapshot(snapshot) {
    return this.saveJson(this.runtimePath, {
      savedAt: new Date().toISOString(),
      ...snapshot
    });
  }

  async loadPortfolioSnapshot() {
    return this.loadJson(this.portfolioPath);
  }

  async savePortfolioSnapshot(snapshot) {
    return this.saveJson(this.portfolioPath, {
      savedAt: new Date().toISOString(),
      ...snapshot
    });
  }
}
