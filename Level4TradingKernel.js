import path from "path";
import Level4JsonStorage from "./Level4JsonStorage.js";
import Level4WalletRegistry from "./Level4WalletRegistry.js";
import Level4CopyTradingEngine from "./Level4CopyTradingEngine.js";
import Level4ScoringEngine from "./Level4ScoringEngine.js";

class Level4TradingKernel {
  /**
   * @param {Object} options
   * @param {string} [options.baseDir]
   * @param {Console|Object} [options.logger=console]
   */
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir = options.baseDir || path.join(process.cwd(), "data", "trading");

    this.storage = new Level4JsonStorage({
      baseDir: this.baseDir,
      namespace: "level4",
      enableBackups: true,
      backupLimit: 25,
      pretty: true,
      logger: this.logger
    });

    this.wallets = new Level4WalletRegistry({
      storage: this.storage
    });

    this.copytrading = new Level4CopyTradingEngine({
      storage: this.storage,
      logger: this.logger
    });

    this.scoring = new Level4ScoringEngine({
      storage: this.storage
    });

    this._initialized = false;
  }

  async init() {
    if (this._initialized) return this;

    await this.storage.init();
    await this.wallets.init();
    await this.copytrading.init();
    await this.scoring.init();

    this._initialized = true;
    this._safeLog("info", "[Level4TradingKernel] initialized");

    return this;
  }

  async healthCheck() {
    const storageHealth = await this.storage.healthCheck();

    return {
      ok: Boolean(storageHealth.ok),
      kernel: "level4-trading",
      initialized: this._initialized,
      checkedAt: new Date().toISOString(),
      storage: storageHealth
    };
  }

  async registerLeaderWithWallet({
    leaderId,
    walletId,
    address,
    label,
    ownerUserId = null,
    chain = "solana"
  }) {
    await this.init();

    const wallet = await this.wallets.upsertWallet({
      walletId,
      address,
      label,
      ownerUserId,
      chain,
      role: "leader",
      visibility: "private",
      isActive: true
    });

    const leader = await this.copytrading.registerLeader({
      leaderId,
      walletId: wallet.walletId,
      label,
      chain,
      isActive: true
    });

    return { wallet, leader };
  }

  async registerFollowerWithWallet({
    followerId,
    walletId,
    address,
    label,
    ownerUserId,
    chain = "solana",
    maxAllocationUsd = 0,
    maxOpenPositions = 3,
    slippageBps = 150
  }) {
    await this.init();

    const wallet = await this.wallets.upsertWallet({
      walletId,
      address,
      label,
      ownerUserId,
      chain,
      role: "follower",
      visibility: "private",
      isActive: true
    });

    const follower = await this.copytrading.registerFollower({
      followerId,
      walletId: wallet.walletId,
      ownerUserId,
      label,
      chain,
      isActive: true,
      copyMode: "proportional",
      maxAllocationUsd,
      maxOpenPositions,
      slippageBps
    });

    return { wallet, follower };
  }

  async linkCopyRelationship({
    leaderId,
    followerId,
    multiplier = 1,
    maxTradeUsd = 0,
    minLeaderScore = 0,
    mode = "mirror"
  }) {
    await this.init();

    return this.copytrading.linkFollowerToLeader({
      leaderId,
      followerId,
      multiplier,
      maxTradeUsd,
      minLeaderScore,
      mode,
      isActive: true
    });
  }

  async buildCopyPlan(payload) {
    await this.init();
    return this.copytrading.buildCopyPlan(payload);
  }

  async updateLeaderMetrics(leaderId, metrics) {
    await this.init();
    return this.scoring.upsertLeaderMetrics(leaderId, metrics);
  }

  async getTopLeaders(limit = 10) {
    await this.init();
    return this.scoring.listTopLeaders(limit);
  }

  _safeLog(method, message) {
    try {
      if (this.logger && typeof this.logger[method] === "function") {
        this.logger[method](message);
      } else {
        console.log(message);
      }
    } catch {
      // no-op
    }
  }
}

export default Level4TradingKernel;
