'use strict';

class ScoringEngine {
  constructor({ logger, storage }) {
    if (!logger) throw new Error('ScoringEngine: logger is required');

    this.logger = logger;
    this.storage = storage || null;
    this.started = false;
  }

  async start() {
    this.started = true;
    this.logger.info('[ScoringEngine] started');
  }

  async stop() {
    this.started = false;
    this.logger.info('[ScoringEngine] stopped');
  }

  async getStats() {
    return {
      started: this.started,
      version: 'level4-v1',
      timestamp: Date.now(),
    };
  }

  async scoreTrade(input = {}) {
    const factors = [];
    let total = 50;

    const liquidityUsd = this._num(input.liquidityUsd);
    const volume1mUsd = this._num(input.volume1mUsd);
    const volume5mUsd = this._num(input.volume5mUsd);
    const top10HolderPct = this._num(input.top10HolderPct);
    const devHoldingPct = this._num(input.devHoldingPct);
    const walletAgeHours = this._num(input.walletAgeHours);
    const pnl30dPct = this._num(input.pnl30dPct);
    const winRate30dPct = this._num(input.winRate30dPct);

    if (liquidityUsd >= 50000) {
      total += 12;
      factors.push({ factor: 'liquidity', value: liquidityUsd, impact: +12 });
    } else if (liquidityUsd >= 20000) {
      total += 7;
      factors.push({ factor: 'liquidity', value: liquidityUsd, impact: +7 });
    } else if (liquidityUsd < 8000) {
      total -= 12;
      factors.push({ factor: 'liquidity', value: liquidityUsd, impact: -12 });
    }

    if (volume1mUsd >= 20000) {
      total += 10;
      factors.push({ factor: 'volume1m', value: volume1mUsd, impact: +10 });
    } else if (volume1mUsd >= 7000) {
      total += 5;
      factors.push({ factor: 'volume1m', value: volume1mUsd, impact: +5 });
    } else if (volume1mUsd > 0 && volume1mUsd < 1500) {
      total -= 8;
      factors.push({ factor: 'volume1m', value: volume1mUsd, impact: -8 });
    }

    if (volume5mUsd >= 100000) {
      total += 10;
      factors.push({ factor: 'volume5m', value: volume5mUsd, impact: +10 });
    } else if (volume5mUsd >= 30000) {
      total += 5;
      factors.push({ factor: 'volume5m', value: volume5mUsd, impact: +5 });
    }

    if (top10HolderPct > 65) {
      total -= 15;
      factors.push({ factor: 'holder_concentration', value: top10HolderPct, impact: -15 });
    } else if (top10HolderPct > 45) {
      total -= 7;
      factors.push({ factor: 'holder_concentration', value: top10HolderPct, impact: -7 });
    } else if (top10HolderPct > 0 && top10HolderPct <= 25) {
      total += 4;
      factors.push({ factor: 'holder_concentration', value: top10HolderPct, impact: +4 });
    }

    if (devHoldingPct > 20) {
      total -= 14;
      factors.push({ factor: 'dev_holding', value: devHoldingPct, impact: -14 });
    } else if (devHoldingPct > 10) {
      total -= 7;
      factors.push({ factor: 'dev_holding', value: devHoldingPct, impact: -7 });
    } else if (devHoldingPct >= 0 && devHoldingPct <= 3) {
      total += 4;
      factors.push({ factor: 'dev_holding', value: devHoldingPct, impact: +4 });
    }

    if (walletAgeHours >= 168) {
      total += 4;
      factors.push({ factor: 'wallet_age', value: walletAgeHours, impact: +4 });
    } else if (walletAgeHours > 0 && walletAgeHours < 6) {
      total -= 8;
      factors.push({ factor: 'wallet_age', value: walletAgeHours, impact: -8 });
    }

    if (pnl30dPct >= 80) {
      total += 8;
      factors.push({ factor: 'leader_pnl_30d', value: pnl30dPct, impact: +8 });
    } else if (pnl30dPct < -20) {
      total -= 8;
      factors.push({ factor: 'leader_pnl_30d', value: pnl30dPct, impact: -8 });
    }

    if (winRate30dPct >= 65) {
      total += 6;
      factors.push({ factor: 'leader_winrate_30d', value: winRate30dPct, impact: +6 });
    } else if (winRate30dPct > 0 && winRate30dPct < 35) {
      total -= 8;
      factors.push({ factor: 'leader_winrate_30d', value: winRate30dPct, impact: -8 });
    }

    total = Math.max(0, Math.min(100, Math.round(total)));

    const grade = this._grade(total);
    const decision = this._decision(total);

    const result = {
      type: 'trade_score',
      score: total,
      grade,
      decision,
      factors,
      input,
      timestamp: Date.now(),
    };

    await this._persistScore(result);
    return result;
  }

  async scoreLeader(leaderAddress) {
    const result = {
      type: 'leader_score',
      leaderAddress,
      score: 60,
      grade: 'B',
      decision: 'watch',
      factors: [
        { factor: 'baseline', impact: 0, value: 'awaiting_live_metrics' },
      ],
      timestamp: Date.now(),
    };

    await this._persistScore(result);
    return result;
  }

  async scoreToken(tokenAddress) {
    const result = {
      type: 'token_score',
      tokenAddress,
      score: 55,
      grade: 'B-',
      decision: 'watch',
      factors: [
        { factor: 'baseline', impact: 0, value: 'awaiting_live_metrics' },
      ],
      timestamp: Date.now(),
    };

    await this._persistScore(result);
    return result;
  }

  _grade(score) {
    if (score >= 90) return 'A+';
    if (score >= 80) return 'A';
    if (score >= 70) return 'B+';
    if (score >= 60) return 'B';
    if (score >= 50) return 'B-';
    if (score >= 40) return 'C';
    if (score >= 30) return 'D';
    return 'F';
  }

  _decision(score) {
    if (score >= 80) return 'strong_execute';
    if (score >= 65) return 'execute';
    if (score >= 50) return 'watch';
    return 'reject';
  }

  _num(value) {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  async _persistScore(row) {
    try {
      if (this.storage?.appendScore) {
        await this.storage.appendScore(row);
      }
    } catch (error) {
      this.logger.error('[ScoringEngine] failed to persist score', {
        error: error?.message || String(error),
      });
    }
  }
}

module.exports = ScoringEngine;
