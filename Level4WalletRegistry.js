import Level4StorageKeys from "./Level4StorageKeys.js";

class Level4WalletRegistry {
  /**
   * @param {Object} deps
   * @param {import('./Level4JsonStorage.js').default} deps.storage
   */
  constructor({ storage }) {
    if (!storage) {
      throw new Error("Level4WalletRegistry requires storage");
    }

    this.storage = storage;
    this.collection = Level4StorageKeys.WALLETS;
  }

  async init() {
    await this.storage.createIfMissing(
      this.collection,
      {
        wallets: {}
      },
      {
        schema: "wallet-registry"
      }
    );
  }

  async listWallets() {
    const data = await this.storage.readData(this.collection, { wallets: {} });
    return Object.values(data.wallets || {});
  }

  async getWallet(walletId) {
    const data = await this.storage.readData(this.collection, { wallets: {} });
    return data.wallets?.[walletId] || null;
  }

  async upsertWallet(walletInput) {
    if (!walletInput || typeof walletInput !== "object") {
      throw new Error("upsertWallet requires walletInput object");
    }

    const walletId = String(walletInput.walletId || walletInput.id || "").trim();
    if (!walletId) {
      throw new Error("walletId is required");
    }

    const address = String(walletInput.address || "").trim();
    if (!address) {
      throw new Error("wallet address is required");
    }

    const ownerUserId =
      walletInput.ownerUserId != null ? String(walletInput.ownerUserId) : null;

    const now = new Date().toISOString();

    const envelope = await this.storage.update(
      this.collection,
      current => {
        current.wallets ||= {};

        const prev = current.wallets[walletId] || null;

        current.wallets[walletId] = {
          walletId,
          ownerUserId,
          address,
          chain: walletInput.chain || "solana",
          label: walletInput.label || prev?.label || null,
          role: walletInput.role || prev?.role || "trader",
          tags: Array.isArray(walletInput.tags) ? walletInput.tags : prev?.tags || [],
          isActive: walletInput.isActive !== false,
          visibility: walletInput.visibility || prev?.visibility || "private",
          createdAt: prev?.createdAt || now,
          updatedAt: now,
          meta: {
            ...(prev?.meta || {}),
            ...(walletInput.meta || {})
          }
        };

        return current;
      },
      {
        fallbackData: { wallets: {} },
        meta: { schema: "wallet-registry" }
      }
    );

    return envelope.data.wallets[walletId];
  }

  async setWalletActive(walletId, isActive) {
    const id = String(walletId || "").trim();
    if (!id) throw new Error("walletId is required");

    const envelope = await this.storage.update(
      this.collection,
      current => {
        current.wallets ||= {};
        const wallet = current.wallets[id];
        if (!wallet) throw new Error(`Wallet not found: ${id}`);

        wallet.isActive = Boolean(isActive);
        wallet.updatedAt = new Date().toISOString();
        return current;
      },
      {
        fallbackData: { wallets: {} }
      }
    );

    return envelope.data.wallets[id];
  }

  async removeWallet(walletId) {
    const id = String(walletId || "").trim();
    if (!id) throw new Error("walletId is required");

    const envelope = await this.storage.update(
      this.collection,
      current => {
        current.wallets ||= {};
        delete current.wallets[id];
        return current;
      },
      {
        fallbackData: { wallets: {} }
      }
    );

    return envelope.data;
  }

  async findWalletByAddress(address) {
    const needle = String(address || "").trim().toLowerCase();
    if (!needle) return null;

    const wallets = await this.listWallets();
    return wallets.find(w => String(w.address || "").toLowerCase() === needle) || null;
  }

  async listWalletsByOwner(ownerUserId) {
    const ownerId = String(ownerUserId || "").trim();
    if (!ownerId) return [];

    const wallets = await this.listWallets();
    return wallets.filter(w => String(w.ownerUserId || "") === ownerId);
  }
}

export default Level4WalletRegistry;
