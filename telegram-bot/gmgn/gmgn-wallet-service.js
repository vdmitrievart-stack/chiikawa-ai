function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

export default class GMGNWalletService {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.defaults = {
      strategyWallets: {
        scalp: ["wallet_scalp_main"],
        reversal: ["wallet_reversal_main"],
        runner: ["wallet_runner_main"],
        copytrade: ["wallet_copytrade_main"]
      },
      requiredWalletFields: ["gmgnWalletId"],
      allowFallbackToAnyEnabledWallet: true
    };
  }

  getWallets(runtimeConfig) {
    return runtimeConfig?.wallets || {};
  }

  getStrategyRouting(runtimeConfig) {
    const configRouting = runtimeConfig?.strategyRouting || {};
    return {
      ...clone(this.defaults.strategyWallets),
      ...clone(configRouting)
    };
  }

  getWallet(runtimeConfig, walletId) {
    return this.getWallets(runtimeConfig)[walletId] || null;
  }

  listWalletIds(runtimeConfig) {
    return Object.keys(this.getWallets(runtimeConfig));
  }

  listEnabledWalletIds(runtimeConfig) {
    return this.listWalletIds(runtimeConfig).filter((walletId) => {
      const wallet = this.getWallet(runtimeConfig, walletId);
      return Boolean(wallet?.enabled);
    });
  }

  listWalletsForStrategy(runtimeConfig, strategyKey) {
    const routing = this.getStrategyRouting(runtimeConfig);
    const configured = Array.isArray(routing?.[strategyKey]) ? routing[strategyKey] : [];
    const ids = unique(configured);

    return ids
      .map((walletId) => ({
        walletId,
        wallet: this.getWallet(runtimeConfig, walletId)
      }))
      .filter((row) => row.wallet);
  }

  getPrimaryWalletId(runtimeConfig, strategyKey) {
    const candidates = this.listWalletsForStrategy(runtimeConfig, strategyKey);

    const active = candidates.find((row) => {
      const wallet = row.wallet || {};
      return (
        wallet.enabled &&
        this.walletSupportsStrategy(wallet, strategyKey) &&
        this.isGMGNWalletReady(wallet).ok
      );
    });

    if (active) return active.walletId;

    if (this.defaults.allowFallbackToAnyEnabledWallet) {
      const fallback = this.listEnabledWalletIds(runtimeConfig)
        .map((walletId) => ({
          walletId,
          wallet: this.getWallet(runtimeConfig, walletId)
        }))
        .find((row) => {
          const wallet = row.wallet || {};
          return (
            this.walletSupportsStrategy(wallet, strategyKey) &&
            this.isGMGNWalletReady(wallet).ok
          );
        });

      if (fallback) return fallback.walletId;
    }

    return null;
  }

  walletSupportsStrategy(wallet, strategyKey) {
    const allowed = Array.isArray(wallet?.allowedStrategies)
      ? wallet.allowedStrategies
      : [];
    return allowed.includes(strategyKey);
  }

  isGMGNWalletReady(wallet) {
    if (!wallet) {
      return { ok: false, reason: "wallet_missing" };
    }

    if (!wallet.enabled) {
      return { ok: false, reason: "wallet_disabled" };
    }

    if (asText(wallet.executionBackend || "gmgn").toLowerCase() !== "gmgn") {
      return { ok: false, reason: "wallet_not_gmgn_backend" };
    }

    for (const field of this.defaults.requiredWalletFields) {
      if (!asText(wallet?.[field])) {
        return { ok: false, reason: `missing_${field}` };
      }
    }

    return { ok: true, reason: "ok" };
  }

  validateWalletForStrategy(runtimeConfig, walletId, strategyKey) {
    const wallet = this.getWallet(runtimeConfig, walletId);

    if (!wallet) {
      return { ok: false, reason: "wallet_not_found" };
    }

    if (!wallet.enabled) {
      return { ok: false, reason: "wallet_disabled" };
    }

    if (!this.walletSupportsStrategy(wallet, strategyKey)) {
      return { ok: false, reason: "strategy_not_allowed" };
    }

    const gmgnReady = this.isGMGNWalletReady(wallet);
    if (!gmgnReady.ok) {
      return gmgnReady;
    }

    return {
      ok: true,
      reason: "ok",
      walletId,
      wallet: clone(wallet)
    };
  }

  validateWalletForAnyUse(runtimeConfig, walletId) {
    const wallet = this.getWallet(runtimeConfig, walletId);

    if (!wallet) {
      return { ok: false, reason: "wallet_not_found" };
    }

    if (!wallet.enabled) {
      return { ok: false, reason: "wallet_disabled" };
    }

    return this.isGMGNWalletReady(wallet);
  }

  getWalletExecutionProfile(runtimeConfig, walletId) {
    const wallet = this.getWallet(runtimeConfig, walletId);
    if (!wallet) return null;

    return {
      walletId,
      label: asText(wallet.label, walletId),
      role: asText(wallet.role, "trader"),
      executionBackend: asText(wallet.executionBackend || "gmgn", "gmgn"),
      executionMode: asText(wallet.executionMode || "live", "live"),
      gmgnWalletId: asText(wallet.gmgnWalletId, ""),
      gmgnAccountId: asText(wallet.gmgnAccountId, ""),
      publicKey: asText(wallet.publicKey || wallet.address, ""),
      allowedStrategies: clone(wallet.allowedStrategies || []),
      enabled: Boolean(wallet.enabled)
    };
  }

  buildWalletSummaryText(runtimeConfig) {
    const wallets = this.getWallets(runtimeConfig);
    const lines = ["👛 <b>GMGN Wallet Mapping</b>", ""];

    for (const [walletId, wallet] of Object.entries(wallets)) {
      const readiness = this.isGMGNWalletReady(wallet);

      lines.push(
        `• <b>${walletId}</b>
label: ${asText(wallet.label, "-")}
role: ${asText(wallet.role, "-")}
enabled: ${wallet.enabled ? "yes" : "no"}
backend: ${asText(wallet.executionBackend || "gmgn", "gmgn")}
mode: ${asText(wallet.executionMode || "live", "live")}
gmgnWalletId: ${asText(wallet.gmgnWalletId, "-")}
gmgnAccountId: ${asText(wallet.gmgnAccountId, "-")}
publicKey: ${asText(wallet.publicKey || wallet.address, "-")}
strategies: ${asText((wallet.allowedStrategies || []).join(", "), "-")}
ready: ${readiness.ok ? "yes" : "no"} (${asText(readiness.reason, "unknown")})`
      );
      lines.push("");
    }

    return lines.join("\n");
  }

  buildStrategyMappingText(runtimeConfig) {
    const routing = this.getStrategyRouting(runtimeConfig);
    const strategyKeys = ["scalp", "reversal", "runner", "copytrade"];
    const lines = ["🧭 <b>Strategy → GMGN Wallets</b>", ""];

    for (const strategyKey of strategyKeys) {
      const mapped = Array.isArray(routing[strategyKey]) ? routing[strategyKey] : [];
      const primary = this.getPrimaryWalletId(runtimeConfig, strategyKey);

      lines.push(
        `• <b>${strategyKey}</b>
mapped: ${mapped.length ? mapped.join(", ") : "-"}
primary: ${asText(primary, "-")}`
      );
      lines.push("");
    }

    return lines.join("\n");
  }

  getWalletBalanceHints(runtimeConfig, walletId) {
    const wallet = this.getWallet(runtimeConfig, walletId);
    if (!wallet) return null;

    return {
      walletId,
      balanceSol: safeNum(wallet.balanceSol, 0),
      availableSol: safeNum(wallet.availableSol, safeNum(wallet.balanceSol, 0)),
      lastBalanceSyncAt: asText(wallet.lastBalanceSyncAt, ""),
      status: asText(wallet.status, wallet.enabled ? "enabled" : "disabled")
    };
  }

  setWalletBalanceHints(runtimeConfig, walletId, patch = {}) {
    const wallet = this.getWallet(runtimeConfig, walletId);
    if (!wallet) return false;

    if (patch.balanceSol != null) wallet.balanceSol = safeNum(patch.balanceSol, 0);
    if (patch.availableSol != null) wallet.availableSol = safeNum(patch.availableSol, 0);
    if (patch.lastBalanceSyncAt != null) wallet.lastBalanceSyncAt = asText(patch.lastBalanceSyncAt, "");
    if (patch.status != null) wallet.status = asText(patch.status, "");

    return true;
  }

  setGMGNWalletId(runtimeConfig, walletId, gmgnWalletId) {
    const wallet = this.getWallet(runtimeConfig, walletId);
    if (!wallet) return false;
    wallet.gmgnWalletId = asText(gmgnWalletId, "");
    return true;
  }

  setGMGNAccountId(runtimeConfig, walletId, gmgnAccountId) {
    const wallet = this.getWallet(runtimeConfig, walletId);
    if (!wallet) return false;
    wallet.gmgnAccountId = asText(gmgnAccountId, "");
    return true;
  }

  setExecutionMode(runtimeConfig, walletId, executionMode) {
    const wallet = this.getWallet(runtimeConfig, walletId);
    if (!wallet) return false;
    wallet.executionMode = asText(executionMode, wallet.executionMode || "live");
    return true;
  }

  setExecutionBackend(runtimeConfig, walletId, executionBackend) {
    const wallet = this.getWallet(runtimeConfig, walletId);
    if (!wallet) return false;
    wallet.executionBackend = asText(executionBackend, wallet.executionBackend || "gmgn");
    return true;
  }
}
