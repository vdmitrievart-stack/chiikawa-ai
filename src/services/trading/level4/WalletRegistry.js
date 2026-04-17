'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');

function now() {
  return Date.now();
}

function makeId(prefix = 'wlt') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

class WalletRegistry extends EventEmitter {
  constructor({ logger, storage }) {
    super();

    if (!logger) throw new Error('WalletRegistry: logger is required');

    this.logger = logger;
    this.storage = storage || null;
    this.wallets = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return;

    if (this.storage?.loadWallets) {
      const rows = await this.storage.loadWallets();
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row?.id) this.wallets.set(row.id, row);
        }
      }
    }

    this.started = true;
    this.logger.info('[WalletRegistry] started', {
      wallets: this.wallets.size,
    });
  }

  async stop() {
    if (!this.started) return;

    await this._flush();
    this.started = false;

    this.logger.info('[WalletRegistry] stopped');
  }

  async registerWallet({
    address,
    label,
    ownerType = 'system',
    ownerId = null,
    chain = 'solana',
    role = 'trader',
    enabled = true,
    metadata = {},
    secretRef = null,
  }) {
    if (!address || typeof address !== 'string') {
      throw new Error('WalletRegistry.registerWallet: address is required');
    }

    const existing = this._findByAddress(address.trim());
    if (existing) {
      throw new Error(`WalletRegistry.registerWallet: wallet already exists for address ${address}`);
    }

    const wallet = {
      id: makeId('wlt'),
      address: address.trim(),
      label: label || address.trim().slice(0, 8),
      ownerType,
      ownerId,
      chain,
      role,
      enabled: Boolean(enabled),
      metadata: metadata || {},
      secretRef,
      createdAt: now(),
      updatedAt: now(),
    };

    this.wallets.set(wallet.id, wallet);
    await this._flush();

    this.logger.info('[WalletRegistry] wallet registered', {
      walletId: wallet.id,
      address: wallet.address,
      label: wallet.label,
    });

    this.emit('wallet_updated', {
      action: 'registered',
      walletId: wallet.id,
      address: wallet.address,
      wallet,
    });

    return wallet;
  }

  async updateWallet(walletId, patch = {}) {
    const wallet = this.wallets.get(walletId);
    if (!wallet) {
      throw new Error(`WalletRegistry.updateWallet: wallet not found: ${walletId}`);
    }

    const next = {
      ...wallet,
      ...patch,
      id: wallet.id,
      updatedAt: now(),
    };

    if (patch.address && patch.address !== wallet.address) {
      const existing = this._findByAddress(patch.address);
      if (existing && existing.id !== wallet.id) {
        throw new Error(`WalletRegistry.updateWallet: address already in use: ${patch.address}`);
      }
    }

    this.wallets.set(walletId, next);
    await this._flush();

    this.logger.info('[WalletRegistry] wallet updated', {
      walletId: next.id,
      address: next.address,
      enabled: next.enabled,
    });

    this.emit('wallet_updated', {
      action: 'updated',
      walletId: next.id,
      address: next.address,
      wallet: next,
    });

    return next;
  }

  async deleteWallet(walletId) {
    const wallet = this.wallets.get(walletId);
    if (!wallet) return { ok: true, deleted: false };

    this.wallets.delete(walletId);
    await this._flush();

    this.logger.info('[WalletRegistry] wallet deleted', {
      walletId,
      address: wallet.address,
    });

    this.emit('wallet_updated', {
      action: 'deleted',
      walletId,
      address: wallet.address,
      wallet,
    });

    return { ok: true, deleted: true };
  }

  async getWallet(walletId) {
    return this.wallets.get(walletId) || null;
  }

  async getWalletByAddress(address) {
    return this._findByAddress(address);
  }

  async listWallets(filters = {}) {
    const {
      enabled,
      role,
      ownerType,
      ownerId,
      chain,
    } = filters;

    let rows = Array.from(this.wallets.values());

    if (typeof enabled === 'boolean') {
      rows = rows.filter((x) => x.enabled === enabled);
    }
    if (role) {
      rows = rows.filter((x) => x.role === role);
    }
    if (ownerType) {
      rows = rows.filter((x) => x.ownerType === ownerType);
    }
    if (ownerId) {
      rows = rows.filter((x) => x.ownerId === ownerId);
    }
    if (chain) {
      rows = rows.filter((x) => x.chain === chain);
    }

    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return rows;
  }

  async getStats() {
    const rows = Array.from(this.wallets.values());
    return {
      total: rows.length,
      enabled: rows.filter((x) => x.enabled).length,
      disabled: rows.filter((x) => !x.enabled).length,
      trader: rows.filter((x) => x.role === 'trader').length,
      follower: rows.filter((x) => x.role === 'follower').length,
      leader: rows.filter((x) => x.role === 'leader').length,
    };
  }

  _findByAddress(address) {
    if (!address) return null;
    const normalized = String(address).trim();

    for (const wallet of this.wallets.values()) {
      if (wallet.address === normalized) return wallet;
    }

    return null;
  }

  async _flush() {
    if (this.storage?.saveWallets) {
      await this.storage.saveWallets(Array.from(this.wallets.values()));
    }
  }
}

module.exports = WalletRegistry;
