import fs from "fs";
import path from "path";

const STORE_FILE = path.resolve("./tracked-wallets.json");

const DEFAULT_STATE = {
  wallets: []
};

function loadState() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      return { ...DEFAULT_STATE };
    }

    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      wallets: Array.isArray(parsed.wallets) ? parsed.wallets : []
    };
  } catch (error) {
    console.error("tracked-wallet-store load error:", error.message);
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("tracked-wallet-store save error:", error.message);
  }
}

const state = loadState();

function normalizeAddress(address) {
  return String(address || "").trim();
}

export function isProbablySolanaAddress(address) {
  const a = normalizeAddress(address);
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
}

export function listTrackedWallets() {
  return [...state.wallets].sort((a, b) => {
    const ta = Number(b.addedAt || 0);
    const tb = Number(a.addedAt || 0);
    return ta - tb;
  });
}

export function getTrackedWallet(address) {
  const a = normalizeAddress(address);
  return state.wallets.find(w => w.address === a) || null;
}

export function addTrackedWallet(address, addedBy = "admin") {
  const a = normalizeAddress(address);

  if (!isProbablySolanaAddress(a)) {
    return {
      ok: false,
      error: "Invalid Solana wallet address format"
    };
  }

  const existing = getTrackedWallet(a);
  if (existing) {
    return {
      ok: true,
      wallet: existing,
      alreadyExisted: true
    };
  }

  const wallet = {
    address: a,
    alias: null,
    enabled: true,
    notes: "",
    score: null,
    winRate: null,
    roi: null,
    copiedTrades: 0,
    addedAt: Date.now(),
    addedBy
  };

  state.wallets.push(wallet);
  saveState(state);

  return {
    ok: true,
    wallet,
    alreadyExisted: false
  };
}

export function removeTrackedWallet(address) {
  const a = normalizeAddress(address);
  const before = state.wallets.length;
  state.wallets = state.wallets.filter(w => w.address !== a);
  saveState(state);

  return {
    ok: true,
    removed: state.wallets.length < before
  };
}

export function updateTrackedWallet(address, patch = {}) {
  const wallet = getTrackedWallet(address);
  if (!wallet) {
    return { ok: false, error: "Wallet not found" };
  }

  Object.assign(wallet, patch);
  saveState(state);

  return { ok: true, wallet };
}
