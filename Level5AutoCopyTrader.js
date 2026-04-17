import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";

export default class Level5AutoCopyTrader {
  constructor(options = {}) {
    if (!options.kernel) {
      throw new Error("Level5AutoCopyTrader requires kernel");
    }

    if (!options.executionEngine) {
      throw new Error("Level5AutoCopyTrader requires executionEngine");
    }

    this.kernel = options.kernel;
    this.executionEngine = options.executionEngine;
    this.logger = options.logger || console;

    this.rpcUrl =
      options.rpcUrl ||
      process.env.SOLANA_RPC_URL ||
      "https://api.mainnet-beta.solana.com";

    this.connection =
      options.connection ||
      new Connection(this.rpcUrl, {
        commitment: "confirmed",
        wsEndpoint: this.#deriveWsUrl(this.rpcUrl)
      });

    this.stateDir =
      options.stateDir ||
      path.join(process.cwd(), "data", "level5");

    this.stateFile = path.join(this.stateDir, "autocopy-state.json");

    this.pollLimit = Number.isFinite(options.pollLimit) ? options.pollLimit : 5;
    this.copyCooldownMs = Number.isFinite(options.copyCooldownMs) ? options.copyCooldownMs : 15_000;
    this.maxProcessed = Number.isFinite(options.maxProcessed) ? options.maxProcessed : 2000;
    this.pruneKeep = Number.isFinite(options.pruneKeep) ? options.pruneKeep : 1500;
    this.defaultDetectMint = options.defaultDetectMint || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    this.state = this.#loadState();

    this._walletSubs = new Map();
    this._running = false;
    this._pollInFlight = new Set();
    this._copyLocks = new Map();
    this.initializedAt = new Date().toISOString();
  }

  #deriveWsUrl(rpcUrl) {
    if (!rpcUrl) return undefined;
    if (rpcUrl.startsWith("https://")) return rpcUrl.replace(/^https:\/\//, "wss://");
    if (rpcUrl.startsWith("http://")) return rpcUrl.replace(/^http:\/\//, "ws://");
    return undefined;
  }

  #loadState() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });

      if (!fs.existsSync(this.stateFile)) {
        const initial = {
          watchedLeaders: {},
          processedSignatures: {},
          lastCopyAtByLeader: {},
          stats: {
            signalsSeen: 0,
            signalsParsed: 0,
            copyRuns: 0,
            executionAttempts: 0,
            executionSuccess: 0,
            executionFail: 0
          },
          updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(this.stateFile, JSON.stringify(initial, null, 2), "utf8");
        return initial;
      }

      const raw = fs.readFileSync(this.stateFile, "utf8");
      const parsed = JSON.parse(raw);

      return {
        watchedLeaders: parsed?.watchedLeaders && typeof parsed.watchedLeaders === "object"
          ? parsed.watchedLeaders
          : {},
        processedSignatures: parsed?.processedSignatures && typeof parsed.processedSignatures === "object"
          ? parsed.processedSignatures
          : {},
        lastCopyAtByLeader: parsed?.lastCopyAtByLeader && typeof parsed.lastCopyAtByLeader === "object"
          ? parsed.lastCopyAtByLeader
          : {},
        stats: parsed?.stats && typeof parsed.stats === "object"
          ? parsed.stats
          : {
              signalsSeen: 0,
              signalsParsed: 0,
              copyRuns: 0,
              executionAttempts: 0,
              executionSuccess: 0,
              executionFail: 0
            },
        updatedAt: parsed?.updatedAt || new Date().toISOString()
      };
    } catch (error) {
      this.logger.error("Level5AutoCopyTrader loadState error:", error.message);
      return {
        watchedLeaders: {},
        processedSignatures: {},
        lastCopyAtByLeader: {},
        stats: {
          signalsSeen: 0,
          signalsParsed: 0,
          copyRuns: 0,
          executionAttempts: 0,
          executionSuccess: 0,
          executionFail: 0
        },
        updatedAt: new Date().toISOString()
      };
    }
  }

  #saveState() {
    try {
      this.state.updatedAt = new Date().toISOString();
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
    } catch (error) {
      this.logger.error("Level5AutoCopyTrader saveState error:", error.message);
    }
  }

  #incStat(key, amount = 1) {
    this.state.stats[key] = Number(this.state.stats[key] || 0) + amount;
  }

  isRunning() {
    return this._running;
  }

  getHealth() {
    return {
      ok: true,
      initializedAt: this.initializedAt,
      running: this._running,
      watchedLeaders: this._walletSubs.size,
      dryRun: this.executionEngine?.isDryRun ?? true,
      rpcUrl: this.rpcUrl,
      stats: { ...(this.state.stats || {}) }
    };
  }

  async start() {
    if (this._running) {
      return { ok: true, message: "AutoCopy already running" };
    }

    this._running = true;
    await this.syncLeaderSubscriptions();

    return {
      ok: true,
      message: "AutoCopy started"
    };
  }

  async stop() {
    for (const [leaderId, sub] of this._walletSubs.entries()) {
      try {
        await this.connection.removeAccountChangeListener(sub.subscriptionId);
      } catch (error) {
        this.logger.warn(`remove subscription failed for ${leaderId}:`, error.message);
      }
    }

    this._walletSubs.clear();
    this._running = false;

    return {
      ok: true,
      message: "AutoCopy stopped"
    };
  }

  async syncLeaderSubscriptions() {
    const copyState = await this.#getCopyState();
    const activeLeaders = Object.values(copyState.leaders || {}).filter(x => x.isActive);
    const activeLeaderIds = new Set(activeLeaders.map(x => x.leaderId));

    for (const [leaderId, sub] of this._walletSubs.entries()) {
      if (!activeLeaderIds.has(leaderId)) {
        try {
          await this.connection.removeAccountChangeListener(sub.subscriptionId);
        } catch (error) {
          this.logger.warn(`unsubscribe failed ${leaderId}:`, error.message);
        }
        this._walletSubs.delete(leaderId);
      }
    }

    for (const leader of activeLeaders) {
      if (this._walletSubs.has(leader.leaderId)) continue;
      if (!leader.walletId) continue;

      const wallet = await this.kernel.wallets.getWallet(leader.walletId);
      if (!wallet?.address) continue;

      await this.watchLeaderWallet(leader.leaderId, wallet.address);
    }

    return {
      ok: true,
      watched: this._walletSubs.size
    };
  }

  async watchLeaderWallet(leaderId, walletAddress) {
    let publicKey;
    try {
      publicKey = new PublicKey(walletAddress);
    } catch (error) {
      return {
        ok: false,
        error: `Invalid wallet for leader ${leaderId}: ${walletAddress}`
      };
    }

    const subscriptionId = this.connection.onAccountChange(
      publicKey,
      async () => {
        if (!this._running) return;
        if (this._pollInFlight.has(leaderId)) return;

        this._pollInFlight.add(leaderId);
        try {
          await this.pollLeaderRecentTransactions(leaderId, walletAddress);
        } catch (error) {
          this.logger.error(`pollLeaderRecentTransactions failed for ${leaderId}:`, error.message);
        } finally {
          this._pollInFlight.delete(leaderId);
        }
      },
      "confirmed"
    );

    this._walletSubs.set(leaderId, {
      subscriptionId,
      walletAddress
    });

    this.state.watchedLeaders[leaderId] = {
      walletAddress,
      subscribedAt: new Date().toISOString()
    };
    this.#saveState();

    return {
      ok: true,
      leaderId,
      walletAddress,
      subscriptionId
    };
  }

  async pollLeaderRecentTransactions(leaderId, walletAddress) {
    const publicKey = new PublicKey(walletAddress);
    const signatures = await this.connection.getSignaturesForAddress(
      publicKey,
      { limit: this.pollLimit },
      "confirmed"
    );

    for (const sigInfo of signatures) {
      const signature = sigInfo.signature;
      if (this.state.processedSignatures[signature]) continue;

      this.#incStat("signalsSeen", 1);

      this.state.processedSignatures[signature] = {
        leaderId,
        at: new Date().toISOString()
      };
      this.#saveState();

      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });

      if (!tx) continue;

      const parsed = await this.tryBuildLeaderTradeEvent(leaderId, walletAddress, tx, signature);
      if (!parsed.ok) continue;

      this.#incStat("signalsParsed", 1);
      await this.processLeaderTrade(parsed.trade);
    }

    this.#pruneProcessedSignatures();
  }

  #pruneProcessedSignatures() {
    const entries = Object.entries(this.state.processedSignatures);
    if (entries.length <= this.maxProcessed) return;

    entries.sort((a, b) => {
      const ta = Date.parse(a[1]?.at || 0);
      const tb = Date.parse(b[1]?.at || 0);
      return tb - ta;
    });

    const keep = entries.slice(0, this.pruneKeep);
    this.state.processedSignatures = Object.fromEntries(keep);
    this.#saveState();
  }

  async tryBuildLeaderTradeEvent(leaderId, walletAddress, tx, signature) {
    try {
      const meta = tx.meta;
      const message = tx.transaction?.message;

      if (!meta || !message) {
        return { ok: false, reason: "missing_meta_or_message" };
      }

      const accountKeys = message.staticAccountKeys || message.accountKeys || [];
      const keyStrings = accountKeys.map(k => k.toBase58());
      const ownerIndex = keyStrings.findIndex(x => x === walletAddress);

      if (ownerIndex === -1) {
        return { ok: false, reason: "wallet_not_in_accounts" };
      }

      const preBalances = meta.preBalances || [];
      const postBalances = meta.postBalances || [];
      const preLamports = Number(preBalances[ownerIndex] || 0);
      const postLamports = Number(postBalances[ownerIndex] || 0);
      const deltaLamports = postLamports - preLamports;

      if (deltaLamports === 0) {
        return { ok: false, reason: "no_native_balance_change" };
      }

      const trade = {
        leaderId,
        signature,
        walletAddress,
        detectedAt: new Date().toISOString(),
        chain: "solana",
        side: deltaLamports < 0 ? "buy" : "sell",
        sizeLamportsAbs: Math.abs(deltaLamports),
        sizeSolAbs: Math.abs(deltaLamports) / 1_000_000_000,
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: this.defaultDetectMint,
        amountAtomic: Math.max(1, Math.floor(Math.abs(deltaLamports))),
        sizeUsd: 0,
        raw: {
          slot: tx.slot,
          err: meta.err || null
        }
      };

      return {
        ok: true,
        trade
      };
    } catch (error) {
      return {
        ok: false,
        reason: `parse_error:${error.message}`
      };
    }
  }

  #isLeaderCooldownActive(leaderId) {
    const last = Number(this.state.lastCopyAtByLeader[leaderId] || 0);
    return Date.now() - last < this.copyCooldownMs;
  }

  #markLeaderCopied(leaderId) {
    this.state.lastCopyAtByLeader[leaderId] = Date.now();
    this.#saveState();
  }

  async processLeaderTrade(leaderTrade) {
    if (!this._running) {
      return { ok: false, reason: "autocopy_not_running" };
    }

    if (this._copyLocks.get(leaderTrade.leaderId)) {
      return { ok: false, reason: "leader_copy_locked" };
    }

    if (this.#isLeaderCooldownActive(leaderTrade.leaderId)) {
      return { ok: false, reason: "leader_cooldown_active" };
    }

    this._copyLocks.set(leaderTrade.leaderId, true);

    try {
      const copyPlan = await this.kernel.buildCopyPlan({
        leaderId: leaderTrade.leaderId,
        trade: {
          action: leaderTrade.side,
          symbol: "AUTO",
          ca: null,
          chain: "solana",
          sizeUsd: leaderTrade.sizeUsd || 0
        }
      });

      if (!copyPlan.ok || !Array.isArray(copyPlan.plans) || !copyPlan.plans.length) {
        return {
          ok: false,
          reason: "no_copy_plans"
        };
      }

      this.#incStat("copyRuns", 1);
      this.#markLeaderCopied(leaderTrade.leaderId);

      const executions = [];

      for (const plan of copyPlan.plans) {
        this.#incStat("executionAttempts", 1);

        try {
          const result = await this.executionEngine.executeTrade({
            side: plan.action,
            inputMint: leaderTrade.inputMint,
            outputMint: leaderTrade.outputMint,
            amountAtomic: leaderTrade.amountAtomic,
            sizeUsd: plan.sizeUsd || 0,
            slippageBps: plan.slippageBps || 100
          });

          if (result?.ok) {
            this.#incStat("executionSuccess", 1);
          } else {
            this.#incStat("executionFail", 1);
          }

          executions.push({
            followerId: plan.followerId,
            ok: Boolean(result.ok),
            result
          });
        } catch (error) {
          this.#incStat("executionFail", 1);
          executions.push({
            followerId: plan.followerId,
            ok: false,
            error: error.message
          });
        }
      }

      this.#saveState();

      return {
        ok: true,
        leaderTrade,
        executions
      };
    } finally {
      this._copyLocks.delete(leaderTrade.leaderId);
    }
  }

  async manualCopyNow({
    leaderId,
    inputMint,
    outputMint,
    amountAtomic,
    sizeUsd = 0,
    slippageBps = 100,
    side = "buy"
  }) {
    const copyPlan = await this.kernel.buildCopyPlan({
      leaderId,
      trade: {
        action: side,
        symbol: "MANUAL",
        ca: null,
        chain: "solana",
        sizeUsd
      }
    });

    if (!copyPlan.ok) return copyPlan;

    const results = [];

    for (const plan of copyPlan.plans || []) {
      this.#incStat("executionAttempts", 1);

      try {
        const result = await this.executionEngine.executeTrade({
          side,
          inputMint,
          outputMint,
          amountAtomic,
          sizeUsd: plan.sizeUsd || sizeUsd,
          slippageBps: plan.slippageBps || slippageBps
        });

        if (result?.ok) {
          this.#incStat("executionSuccess", 1);
        } else {
          this.#incStat("executionFail", 1);
        }

        results.push({
          followerId: plan.followerId,
          ok: Boolean(result.ok),
          result
        });
      } catch (error) {
        this.#incStat("executionFail", 1);
        results.push({
          followerId: plan.followerId,
          ok: false,
          error: error.message
        });
      }
    }

    this.#saveState();

    return {
      ok: true,
      leaderId,
      dryRun: this.executionEngine?.isDryRun ?? true,
      results
    };
  }

  async #getCopyState() {
    const data = await this.kernel.storage.readData("copytrading", {
      leaders: {},
      followers: {},
      links: {},
      events: []
    });

    return data || {
      leaders: {},
      followers: {},
      links: {},
      events: []
    };
  }
}
