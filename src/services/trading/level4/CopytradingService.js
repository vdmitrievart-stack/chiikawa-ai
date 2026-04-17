'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');

function makeId(prefix = 'sub') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function now() {
  return Date.now();
}

class CopytradingService extends EventEmitter {
  constructor({
    logger,
    storage,
    walletRegistry,
  }) {
    super();

    if (!logger) throw new Error('CopytradingService: logger is required');
    if (!walletRegistry) throw new Error('CopytradingService: walletRegistry is required');

    this.logger = logger;
    this.storage = storage || null;
    this.walletRegistry = walletRegistry;

    this.subscriptions = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return;

    if (this.storage?.loadCopySubscriptions) {
      const rows = await this.storage.loadCopySubscriptions();
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row?.id) {
            this.subscriptions.set(row.id, row);
          }
        }
      }
    }

    this.started = true;
    this.logger.info('[CopytradingService] started', {
      subscriptions: this.subscriptions.size,
    });
  }

  async stop() {
    if (!this.started) return;
    await this._flush();
    this.started = false;
    this.logger.info('[CopytradingService] stopped');
  }

  async createSubscription({
    followerWalletId,
    leaderAddress,
    allocationMode = 'percent',
    allocationValue = 100,
    maxBuySol = null,
    maxSlippageBps = 1200,
    enabled = true,
    tags = [],
    createdBy = 'system',
  }) {
    if (!followerWalletId) {
      throw new Error('CopytradingService.createSubscription: followerWalletId is required');
    }
    if (!leaderAddress) {
      throw new Error('CopytradingService.createSubscription: leaderAddress is required');
    }

    const followerWallet = await this.walletRegistry.getWallet(followerWalletId);
    if (!followerWallet) {
      throw new Error(`CopytradingService.createSubscription: follower wallet not found: ${followerWalletId}`);
    }

    const existing = await this._findSubscriptionByPair(followerWalletId, leaderAddress);
    if (existing) {
      throw new Error(`CopytradingService.createSubscription: subscription already exists for follower=${followerWalletId} leader=${leaderAddress}`);
    }

    const row = {
      id: makeId('sub'),
      followerWalletId,
      leaderAddress: String(leaderAddress).trim(),
      allocationMode,
      allocationValue,
      maxBuySol,
      maxSlippageBps,
      enabled: Boolean(enabled),
      tags: Array.isArray(tags) ? tags : [],
      createdBy,
      createdAt: now(),
      updatedAt: now(),
    };

    this.subscriptions.set(row.id, row);
    await this._flush();

    this.logger.info('[CopytradingService] subscription created', {
      subscriptionId: row.id,
      followerWalletId: row.followerWalletId,
      leaderAddress: row.leaderAddress,
    });

    return row;
  }

  async updateSubscription(subscriptionId, patch = {}) {
    const row = this.subscriptions.get(subscriptionId);
    if (!row) {
      throw new Error(`CopytradingService.updateSubscription: subscription not found: ${subscriptionId}`);
    }

    const next = {
      ...row,
      ...patch,
      id: row.id,
      updatedAt: now(),
    };

    this.subscriptions.set(subscriptionId, next);
    await this._flush();

    this.logger.info('[CopytradingService] subscription updated', {
      subscriptionId: next.id,
      enabled: next.enabled,
    });

    return next;
  }

  async deleteSubscription(subscriptionId) {
    const exists = this.subscriptions.get(subscriptionId);
    if (!exists) return { ok: true, deleted: false };

    this.subscriptions.delete(subscriptionId);
    await this._flush();

    this.logger.info('[CopytradingService] subscription deleted', {
      subscriptionId,
    });

    return { ok: true, deleted: true };
  }

  async listSubscriptions(filters = {}) {
    const {
      enabled,
      followerWalletId,
      leaderAddress,
    } = filters;

    let rows = Array.from(this.subscriptions.values());

    if (typeof enabled === 'boolean') {
      rows = rows.filter((x) => x.enabled === enabled);
    }
    if (followerWalletId) {
      rows = rows.filter((x) => x.followerWalletId === followerWalletId);
    }
    if (leaderAddress) {
      rows = rows.filter((x) => x.leaderAddress === leaderAddress);
    }

    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return rows;
  }

  async getStats() {
    const rows = Array.from(this.subscriptions.values());
    return {
      total: rows.length,
      enabled: rows.filter((x) => x.enabled).length,
      disabled: rows.filter((x) => !x.enabled).length,
      uniqueLeaders: new Set(rows.map((x) => x.leaderAddress)).size,
      uniqueFollowers: new Set(rows.map((x) => x.followerWalletId)).size,
    };
  }

  /**
   * Внешние watchers / onchain-listeners могут кидать сюда сигнал лидера.
   */
  async ingestLeaderSignal(signal) {
    if (!signal?.leaderAddress) {
      throw new Error('CopytradingService.ingestLeaderSignal: leaderAddress is required');
    }

    this.emit('leader_signal', {
      ...signal,
      leaderAddress: String(signal.leaderAddress).trim(),
      receivedAt: Date.now(),
    });
  }

  /**
   * Оркестратор вызывает это уже после scoring / risk check.
   */
  async processLeaderSignal(signal, score, tradeExecutor) {
    const leaderAddress = String(signal?.leaderAddress || '').trim();
    const action = signal?.action || 'buy';
    const tokenAddress = signal?.tokenAddress || null;

    if (!leaderAddress) {
      throw new Error('CopytradingService.processLeaderSignal: leaderAddress is required');
    }

    const subscriptions = (await this.listSubscriptions({
      enabled: true,
      leaderAddress,
    })) || [];

    if (!subscriptions.length) {
      this.logger.info('[CopytradingService] no active subscriptions for leader', {
        leaderAddress,
      });

      return {
        ok: true,
        matched: 0,
        executed: 0,
        skipped: 0,
        results: [],
      };
    }

    const results = [];

    for (const sub of subscriptions) {
      try {
        const followerWallet = await this.walletRegistry.getWallet(sub.followerWalletId);

        if (!followerWallet) {
          results.push({
            subscriptionId: sub.id,
            status: 'skipped',
            reason: 'follower_wallet_not_found',
          });
          continue;
        }

        if (!followerWallet.enabled) {
          results.push({
            subscriptionId: sub.id,
            status: 'skipped',
            reason: 'follower_wallet_disabled',
          });
          continue;
        }

        const executionPlan = this._buildExecutionPlan({
          signal,
          score,
          subscription: sub,
          followerWallet,
        });

        if (!tradeExecutor?.executeCopyTrade) {
          results.push({
            subscriptionId: sub.id,
            status: 'simulated',
            executionPlan,
          });

          this.emit('copy_event', {
            type: 'simulated_copy_trade',
            subscriptionId: sub.id,
            followerWalletId: followerWallet.id,
            leaderAddress,
            tokenAddress,
            action,
            executionPlan,
            score,
            timestamp: now(),
          });

          continue;
        }

        const execResult = await tradeExecutor.executeCopyTrade(executionPlan);

        results.push({
          subscriptionId: sub.id,
          status: 'executed',
          executionPlan,
          execResult,
        });

        this.emit('copy_event', {
          type: 'executed_copy_trade',
          subscriptionId: sub.id,
          followerWalletId: followerWallet.id,
          leaderAddress,
          tokenAddress,
          action,
          executionPlan,
          score,
          execResult,
          timestamp: now(),
        });
      } catch (error) {
        this.logger.error('[CopytradingService] processLeaderSignal item failed', {
          subscriptionId: sub.id,
          error: error?.message || String(error),
        });

        results.push({
          subscriptionId: sub.id,
          status: 'failed',
          reason: error?.message || 'unknown_error',
        });

        this.emit('copy_event', {
          type: 'copy_trade_failed',
          subscriptionId: sub.id,
          leaderAddress,
          tokenAddress,
          action,
          score,
          error: error?.message || String(error),
          timestamp: now(),
        });
      }
    }

    return {
      ok: true,
      matched: subscriptions.length,
      executed: results.filter((x) => x.status === 'executed').length,
      skipped: results.filter((x) => x.status === 'skipped').length,
      simulated: results.filter((x) => x.status === 'simulated').length,
      failed: results.filter((x) => x.status === 'failed').length,
      results,
    };
  }

  _buildExecutionPlan({ signal, score, subscription, followerWallet }) {
    const leaderSizeSol = Number(signal?.sizeSol || 0);
    let copySizeSol = 0;

    if (subscription.allocationMode === 'percent') {
      copySizeSol = leaderSizeSol * (Number(subscription.allocationValue || 0) / 100);
    } else if (subscription.allocationMode === 'fixed_sol') {
      copySizeSol = Number(subscription.allocationValue || 0);
    } else {
      copySizeSol = leaderSizeSol;
    }

    if (subscription.maxBuySol && copySizeSol > subscription.maxBuySol) {
      copySizeSol = subscription.maxBuySol;
    }

    return {
      source: 'copytrading',
      followerWalletId: followerWallet.id,
      followerAddress: followerWallet.address,
      leaderAddress: subscription.leaderAddress,
      tokenAddress: signal?.tokenAddress || null,
      action: signal?.action || 'buy',
      sizeSol: Number(copySizeSol || 0),
      maxSlippageBps: Number(subscription.maxSlippageBps || 1200),
      score,
      rawSignal: signal,
      createdAt: now(),
    };
  }

  async _findSubscriptionByPair(followerWalletId, leaderAddress) {
    for (const row of this.subscriptions.values()) {
      if (
        row.followerWalletId === followerWalletId &&
        row.leaderAddress === String(leaderAddress).trim()
      ) {
        return row;
      }
    }
    return null;
  }

  async _flush() {
    if (this.storage?.saveCopySubscriptions) {
      await this.storage.saveCopySubscriptions(Array.from(this.subscriptions.values()));
    }
  }
}

module.exports = CopytradingService;
