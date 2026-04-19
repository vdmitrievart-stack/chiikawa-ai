'use strict';

const EventEmitter = require('events');

class TradingLevel4Engine extends EventEmitter {
  constructor({
    logger,
    walletRegistry,
    copytradingService,
    scoringEngine,
    tradeExecutor,
    riskManager,
    storage,
  }) {
    super();

    if (!logger) throw new Error('TradingLevel4Engine: logger is required');
    if (!walletRegistry) throw new Error('TradingLevel4Engine: walletRegistry is required');
    if (!copytradingService) throw new Error('TradingLevel4Engine: copytradingService is required');
    if (!scoringEngine) throw new Error('TradingLevel4Engine: scoringEngine is required');

    this.logger = logger;
    this.walletRegistry = walletRegistry;
    this.copytradingService = copytradingService;
    this.scoringEngine = scoringEngine;
    this.tradeExecutor = tradeExecutor || null;
    this.riskManager = riskManager || null;
    this.storage = storage || null;

    this.started = false;
    this._boundOnLeaderSignal = this._onLeaderSignal.bind(this);
    this._boundOnWalletUpdated = this._onWalletUpdated.bind(this);
    this._boundOnCopyEvent = this._onCopyEvent.bind(this);
  }

  async start() {
    if (this.started) {
      this.logger.warn('[TradingLevel4Engine] start called but engine already started');
      return;
    }

    this.logger.info('[TradingLevel4Engine] starting Level 4 engine');

    try {
      await this.walletRegistry.start?.();
      await this.copytradingService.start?.();
      await this.scoringEngine.start?.();

      this.copytradingService.on('leader_signal', this._boundOnLeaderSignal);
      this.walletRegistry.on('wallet_updated', this._boundOnWalletUpdated);
      this.copytradingService.on('copy_event', this._boundOnCopyEvent);

      this.started = true;

      this.logger.info('[TradingLevel4Engine] Level 4 engine started');
      this.emit('started');
    } catch (error) {
      this.logger.error('[TradingLevel4Engine] failed to start', {
        error: error?.message || String(error),
        stack: error?.stack || null,
      });
      throw error;
    }
  }

  async stop() {
    if (!this.started) {
      this.logger.warn('[TradingLevel4Engine] stop called but engine not started');
      return;
    }

    this.logger.info('[TradingLevel4Engine] stopping Level 4 engine');

    this.copytradingService.off('leader_signal', this._boundOnLeaderSignal);
    this.walletRegistry.off('wallet_updated', this._boundOnWalletUpdated);
    this.copytradingService.off('copy_event', this._boundOnCopyEvent);

    await this.copytradingService.stop?.();
    await this.scoringEngine.stop?.();
    await this.walletRegistry.stop?.();

    this.started = false;

    this.logger.info('[TradingLevel4Engine] Level 4 engine stopped');
    this.emit('stopped');
  }

  async getSystemState() {
    const [walletStats, copyStats, scoreStats] = await Promise.all([
      this.walletRegistry.getStats?.() || {},
      this.copytradingService.getStats?.() || {},
      this.scoringEngine.getStats?.() || {},
    ]);

    return {
      started: this.started,
      wallets: walletStats,
      copytrading: copyStats,
      scoring: scoreStats,
      timestamp: Date.now(),
    };
  }

  async registerTradingWallet(payload) {
    const wallet = await this.walletRegistry.registerWallet(payload);
    this.emit('wallet_registered', wallet);
    return wallet;
  }

  async updateTradingWallet(walletId, patch) {
    const wallet = await this.walletRegistry.updateWallet(walletId, patch);
    this.emit('wallet_changed', wallet);
    return wallet;
  }

  async listTradingWallets(filters = {}) {
    return this.walletRegistry.listWallets(filters);
  }

  async subscribeToLeader({
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
    const sub = await this.copytradingService.createSubscription({
      followerWalletId,
      leaderAddress,
      allocationMode,
      allocationValue,
      maxBuySol,
      maxSlippageBps,
      enabled,
      tags,
      createdBy,
    });

    this.emit('copy_subscription_created', sub);
    return sub;
  }

  async updateLeaderSubscription(subscriptionId, patch) {
    const sub = await this.copytradingService.updateSubscription(subscriptionId, patch);
    this.emit('copy_subscription_updated', sub);
    return sub;
  }

  async deleteLeaderSubscription(subscriptionId) {
    const result = await this.copytradingService.deleteSubscription(subscriptionId);
    this.emit('copy_subscription_deleted', { subscriptionId });
    return result;
  }

  async listLeaderSubscriptions(filters = {}) {
    return this.copytradingService.listSubscriptions(filters);
  }

  async rescoreLeader(leaderAddress) {
    const score = await this.scoringEngine.scoreLeader(leaderAddress);
    this.emit('leader_rescored', score);
    return score;
  }

  async rescoreToken(tokenAddress) {
    const score = await this.scoringEngine.scoreToken(tokenAddress);
    this.emit('token_rescored', score);
    return score;
  }

  async scoreTrade(tradePayload) {
    const score = await this.scoringEngine.scoreTrade(tradePayload);
    this.emit('trade_scored', score);
    return score;
  }

  async _onLeaderSignal(signal) {
    try {
      this.logger.info('[TradingLevel4Engine] leader signal received', {
        leaderAddress: signal?.leaderAddress,
        action: signal?.action,
        tokenAddress: signal?.tokenAddress,
      });

      const score = await this.scoringEngine.scoreTrade({
        source: 'copytrading_signal',
        leaderAddress: signal?.leaderAddress,
        tokenAddress: signal?.tokenAddress,
        action: signal?.action,
        marketCap: signal?.marketCap || null,
        liquidityUsd: signal?.liquidityUsd || null,
        volume1mUsd: signal?.volume1mUsd || null,
        volume5mUsd: signal?.volume5mUsd || null,
        top10HolderPct: signal?.top10HolderPct || null,
        devHoldingPct: signal?.devHoldingPct || null,
        walletAgeHours: signal?.walletAgeHours || null,
        pnl30dPct: signal?.pnl30dPct || null,
        winRate30dPct: signal?.winRate30dPct || null,
      });

      if (this.riskManager?.shouldRejectTrade) {
        const riskDecision = await this.riskManager.shouldRejectTrade({
          signal,
          score,
        });

        if (riskDecision?.reject) {
          this.logger.warn('[TradingLevel4Engine] trade rejected by risk manager', {
            reason: riskDecision.reason || 'unknown',
            leaderAddress: signal?.leaderAddress,
            tokenAddress: signal?.tokenAddress,
          });

          this.emit('trade_rejected', {
            signal,
            score,
            reason: riskDecision.reason || 'risk_rejected',
          });
          return;
        }
      }

      const executionResult = await this.copytradingService.processLeaderSignal(signal, score, this.tradeExecutor);

      this.emit('trade_processed', {
        signal,
        score,
        executionResult,
      });
    } catch (error) {
      this.logger.error('[TradingLevel4Engine] _onLeaderSignal failed', {
        error: error?.message || String(error),
        stack: error?.stack || null,
      });

      this.emit('error', {
        scope: 'leader_signal',
        error,
        signal,
      });
    }
  }

  async _onWalletUpdated(event) {
    try {
      this.logger.info('[TradingLevel4Engine] wallet updated', {
        walletId: event?.walletId,
        address: event?.address,
      });

      if (this.storage?.appendAuditLog) {
        await this.storage.appendAuditLog({
          type: 'wallet_updated',
          payload: event,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      this.logger.error('[TradingLevel4Engine] _onWalletUpdated failed', {
        error: error?.message || String(error),
      });
    }
  }

  async _onCopyEvent(event) {
    try {
      if (this.storage?.appendAuditLog) {
        await this.storage.appendAuditLog({
          type: 'copy_event',
          payload: event,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      this.logger.error('[TradingLevel4Engine] _onCopyEvent failed', {
        error: error?.message || String(error),
      });
    }
  }
}

module.exports = TradingLevel4Engine;
