'use strict';

const Level4StorageKeys = require('./Level4StorageKeys');

class Level4CopyTradingEngine {
  /**
   * @param {Object} deps
   * @param {import('./Level4JsonStorage')} deps.storage
   * @param {Console|Object} [deps.logger=console]
   */
  constructor({ storage, logger = console }) {
    if (!storage) {
      throw new Error('Level4CopyTradingEngine requires storage');
    }

    this.storage = storage;
    this.logger = logger;
    this.collection = Level4StorageKeys.COPYTRADING;
  }

  async init() {
    await this.storage.createIfMissing(this.collection, {
      leaders: {},
      followers: {},
      links: {},
      events: [],
    }, {
      schema: 'copytrading-engine',
    });
  }

  async registerLeader(leaderInput) {
    const leaderId = String(leaderInput?.leaderId || '').trim();
    if (!leaderId) throw new Error('leaderId is required');

    const now = new Date().toISOString();

    const envelope = await this.storage.update(
      this.collection,
      (current) => {
        current.leaders ||= {};
        current.followers ||= {};
        current.links ||= {};
        current.events ||= [];

        const prev = current.leaders[leaderId] || null;

        current.leaders[leaderId] = {
          leaderId,
          walletId: leaderInput.walletId || prev?.walletId || null,
          label: leaderInput.label || prev?.label || null,
          chain: leaderInput.chain || prev?.chain || 'solana',
          isActive: leaderInput.isActive !== false,
          strategy: leaderInput.strategy || prev?.strategy || 'mirror',
          riskProfile: leaderInput.riskProfile || prev?.riskProfile || 'balanced',
          createdAt: prev?.createdAt || now,
          updatedAt: now,
          meta: {
            ...(prev?.meta || {}),
            ...(leaderInput.meta || {}),
          },
        };

        return current;
      },
      {
        fallbackData: { leaders: {}, followers: {}, links: {}, events: [] },
        meta: { schema: 'copytrading-engine' },
      }
    );

    return envelope.data.leaders[leaderId];
  }

  async registerFollower(followerInput) {
    const followerId = String(followerInput?.followerId || '').trim();
    if (!followerId) throw new Error('followerId is required');

    const now = new Date().toISOString();

    const envelope = await this.storage.update(
      this.collection,
      (current) => {
        current.leaders ||= {};
        current.followers ||= {};
        current.links ||= {};
        current.events ||= [];

        const prev = current.followers[followerId] || null;

        current.followers[followerId] = {
          followerId,
          walletId: followerInput.walletId || prev?.walletId || null,
          ownerUserId: followerInput.ownerUserId || prev?.ownerUserId || null,
          label: followerInput.label || prev?.label || null,
          chain: followerInput.chain || prev?.chain || 'solana',
          isActive: followerInput.isActive !== false,
          copyMode: followerInput.copyMode || prev?.copyMode || 'proportional',
          maxAllocationUsd: Number.isFinite(followerInput.maxAllocationUsd)
            ? followerInput.maxAllocationUsd
            : (prev?.maxAllocationUsd ?? 0),
          maxOpenPositions: Number.isInteger(followerInput.maxOpenPositions)
            ? followerInput.maxOpenPositions
            : (prev?.maxOpenPositions ?? 3),
          slippageBps: Number.isInteger(followerInput.slippageBps)
            ? followerInput.slippageBps
            : (prev?.slippageBps ?? 150),
          createdAt: prev?.createdAt || now,
          updatedAt: now,
          meta: {
            ...(prev?.meta || {}),
            ...(followerInput.meta || {}),
          },
        };

        return current;
      },
      {
        fallbackData: { leaders: {}, followers: {}, links: {}, events: [] },
        meta: { schema: 'copytrading-engine' },
      }
    );

    return envelope.data.followers[followerId];
  }

  async linkFollowerToLeader(linkInput) {
    const leaderId = String(linkInput?.leaderId || '').trim();
    const followerId = String(linkInput?.followerId || '').trim();

    if (!leaderId) throw new Error('leaderId is required');
    if (!followerId) throw new Error('followerId is required');

    const linkId = `${leaderId}::${followerId}`;
    const now = new Date().toISOString();

    const envelope = await this.storage.update(
      this.collection,
      (current) => {
        current.leaders ||= {};
        current.followers ||= {};
        current.links ||= {};
        current.events ||= [];

        if (!current.leaders[leaderId]) {
          throw new Error(`Leader not found: ${leaderId}`);
        }

        if (!current.followers[followerId]) {
          throw new Error(`Follower not found: ${followerId}`);
        }

        const prev = current.links[linkId] || null;

        current.links[linkId] = {
          linkId,
          leaderId,
          followerId,
          isActive: linkInput.isActive !== false,
          multiplier: Number.isFinite(linkInput.multiplier) ? linkInput.multiplier : (prev?.multiplier ?? 1),
          mode: linkInput.mode || prev?.mode || 'mirror',
          maxTradeUsd: Number.isFinite(linkInput.maxTradeUsd) ? linkInput.maxTradeUsd : (prev?.maxTradeUsd ?? 0),
          minLeaderScore: Number.isFinite(linkInput.minLeaderScore)
            ? linkInput.minLeaderScore
            : (prev?.minLeaderScore ?? 0),
          createdAt: prev?.createdAt || now,
          updatedAt: now,
          meta: {
            ...(prev?.meta || {}),
            ...(linkInput.meta || {}),
          },
        };

        current.events.unshift({
          eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          type: 'link_created_or_updated',
          leaderId,
          followerId,
          linkId,
          createdAt: now,
        });

        current.events = current.events.slice(0, 1000);

        return current;
      },
      {
        fallbackData: { leaders: {}, followers: {}, links: {}, events: [] },
      }
    );

    return envelope.data.links[linkId];
  }

  async getLeader(leaderId) {
    const data = await this.storage.readData(this.collection, {
      leaders: {}, followers: {}, links: {}, events: [],
    });

    return data.leaders?.[leaderId] || null;
  }

  async getFollower(followerId) {
    const data = await this.storage.readData(this.collection, {
      leaders: {}, followers: {}, links: {}, events: [],
    });

    return data.followers?.[followerId] || null;
  }

  async getLink(leaderId, followerId) {
    const data = await this.storage.readData(this.collection, {
      leaders: {}, followers: {}, links: {}, events: [],
    });

    return data.links?.[`${leaderId}::${followerId}`] || null;
  }

  async listLeaderLinks(leaderId) {
    const data = await this.storage.readData(this.collection, {
      leaders: {}, followers: {}, links: {}, events: [],
    });

    return Object.values(data.links || {}).filter((x) => x.leaderId === leaderId);
  }

  async listFollowerLinks(followerId) {
    const data = await this.storage.readData(this.collection, {
      leaders: {}, followers: {}, links: {}, events: [],
    });

    return Object.values(data.links || {}).filter((x) => x.followerId === followerId);
  }

  async disableLink(leaderId, followerId) {
    const linkId = `${leaderId}::${followerId}`;

    const envelope = await this.storage.update(
      this.collection,
      (current) => {
        current.links ||= {};
        const link = current.links[linkId];
        if (!link) throw new Error(`Link not found: ${linkId}`);

        link.isActive = false;
        link.updatedAt = new Date().toISOString();
        return current;
      },
      {
        fallbackData: { leaders: {}, followers: {}, links: {}, events: [] },
      }
    );

    return envelope.data.links[linkId];
  }

  /**
   * Подготавливает решение по копированию сделки.
   * Это пока orchestration/pre-execution слой, без ончейн отправки.
   */
  async buildCopyPlan({ leaderId, trade }) {
    if (!trade || typeof trade !== 'object') {
      throw new Error('trade is required');
    }

    const leader = await this.getLeader(leaderId);
    if (!leader || !leader.isActive) {
      return {
        ok: false,
        reason: 'leader_inactive_or_missing',
        plans: [],
      };
    }

    const links = await this.listLeaderLinks(leaderId);
    const activeLinks = links.filter((x) => x.isActive);

    const plans = [];

    for (const link of activeLinks) {
      const follower = await this.getFollower(link.followerId);
      if (!follower || !follower.isActive) continue;

      const leaderTradeUsd = Number(trade.sizeUsd || 0);
      let copiedUsd = leaderTradeUsd;

      if (follower.copyMode === 'proportional') {
        copiedUsd = leaderTradeUsd * (Number(link.multiplier || 1));
      }

      if (Number(link.maxTradeUsd || 0) > 0) {
        copiedUsd = Math.min(copiedUsd, Number(link.maxTradeUsd));
      }

      if (Number(follower.maxAllocationUsd || 0) > 0) {
        copiedUsd = Math.min(copiedUsd, Number(follower.maxAllocationUsd));
      }

      if (copiedUsd <= 0) continue;

      plans.push({
        planId: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        leaderId,
        followerId: follower.followerId,
        leaderWalletId: leader.walletId,
        followerWalletId: follower.walletId,
        action: trade.action || 'buy',
        symbol: trade.symbol || null,
        ca: trade.ca || null,
        chain: trade.chain || follower.chain || leader.chain || 'solana',
        sizeUsd: Number(copiedUsd.toFixed(2)),
        mode: link.mode || follower.copyMode,
        slippageBps: follower.slippageBps ?? 150,
        createdAt: new Date().toISOString(),
      });
    }

    return {
      ok: true,
      leaderId,
      plans,
    };
  }
}

module.exports = Level4CopyTradingEngine;
