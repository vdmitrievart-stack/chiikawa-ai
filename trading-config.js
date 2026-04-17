export const TRADING_DEFAULTS = {
  mode: "confirm", // off | confirm | auto
  enabled: false,
  killSwitch: false,

  maxPositionSol: 0.1,
  dailyMaxLossSol: 0.3,
  maxOpenPositions: 2,

  buybotAlertMinUsd: 40,
  minWalletScore: 60,
  minTokenScore: 70,

  copyWalletsEnabled: true,
  freshMemeMaxSol: 0.05,

  publicAnnounceBuys: true,
  publicPinBuyPosts: true
};

export function normalizeTradingMode(value) {
  const mode = String(value || "").toLowerCase().trim();
  if (["off", "confirm", "auto"].includes(mode)) return mode;
  return "confirm";
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
