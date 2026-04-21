function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function avg(rows = []) {
  if (!rows.length) return 0;
  return rows.reduce((sum, x) => sum + safeNum(x, 0), 0) / rows.length;
}

function pctChange(current, previous) {
  const prev = safeNum(previous, 0);
  if (prev <= 0) return 0;
  return ((safeNum(current, 0) - prev) / prev) * 100;
}

function snapshotBottomRange(records = []) {
  if (!records.length) return { bottom: 0, max: 0 };
  let bottom = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const row of records) {
    const px = safeNum(row?.price, 0);
    if (px > 0) {
      bottom = Math.min(bottom, px);
      max = Math.max(max, px);
    }
  }
  if (!Number.isFinite(bottom)) bottom = 0;
  return { bottom, max };
}

export default class QuietAccumulationEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.maxSnapshots = safeNum(options.maxSnapshots, 96);
    this.lookbackMs = safeNum(options.lookbackMs, 6 * 60 * 60 * 1000);
    this.state = new Map();
  }

  prune(ca) {
    const row = this.state.get(ca);
    if (!row) return;

    const minTs = Date.now() - this.lookbackMs;
    row.snapshots = (row.snapshots || []).filter((snap) => safeNum(snap?.ts, 0) >= minTs);
    if (row.snapshots.length > this.maxSnapshots) {
      row.snapshots = row.snapshots.slice(-this.maxSnapshots);
    }
  }

  observe(token = {}, extra = {}) {
    const ca = String(token?.ca || "").trim();
    if (!ca) {
      return this.buildEmpty();
    }

    const ts = Date.now();
    const price = safeNum(token?.price, 0);
    const record = {
      ts,
      price,
      volumeM5: safeNum(token?.volumeM5, 0),
      volumeH1: safeNum(token?.volumeH1, 0),
      volumeH24: safeNum(token?.volumeH24, token?.volume, 0),
      txnsM5: safeNum(token?.txnsM5, 0),
      txnsH1: safeNum(token?.txnsH1, 0),
      txnsH24: safeNum(token?.txnsH24, token?.txns, 0),
      buyPressureM5: safeNum(extra?.buyPressureM5, 0),
      buyPressureH1: safeNum(extra?.buyPressureH1, 0),
      buyPressureH24: safeNum(extra?.buyPressureH24, 0),
      priceM5: safeNum(token?.priceChangeM5, 0),
      priceH1: safeNum(token?.priceChangeH1, 0),
      priceH6: safeNum(token?.priceChangeH6, 0),
      priceH24: safeNum(token?.priceChangeH24, 0),
      liquidity: safeNum(token?.liquidity, 0)
    };

    const holderIntel = extra?.holderIntel || null;
    const row = this.state.get(ca) || { snapshots: [], lastControlPct: 0 };
    row.snapshots.push(record);
    this.state.set(ca, row);
    this.prune(ca);

    return this.evaluate(ca, holderIntel);
  }

  evaluate(ca, holderIntel = null) {
    const row = this.state.get(ca) || { snapshots: [], lastControlPct: 0 };
    const records = row.snapshots || [];
    if (!records.length) return this.buildEmpty();

    const recent = records.slice(-8);
    const recentShort = records.slice(-4);
    const earlier = records.slice(-12, -4);

    const { bottom, max } = snapshotBottomRange(records);
    const bottomBand = bottom > 0 ? bottom * 1.08 : 0;
    const bottomTouches = bottomBand > 0
      ? records.filter((snap) => safeNum(snap?.price, 0) > 0 && safeNum(snap?.price, 0) <= bottomBand).length
      : 0;

    const firstBottomTouch = bottomBand > 0
      ? records.find((snap) => safeNum(snap?.price, 0) > 0 && safeNum(snap?.price, 0) <= bottomBand)
      : null;

    const baseMinutes = firstBottomTouch
      ? Math.max(0, (Date.now() - safeNum(firstBottomTouch?.ts, Date.now())) / 60000)
      : 0;

    const rangeCompressionPct = bottom > 0
      ? ((Math.max(max, bottom) - bottom) / bottom) * 100
      : 0;

    const avgBuyRecent = avg(recentShort.map((x) => x.buyPressureM5 || x.buyPressureH1));
    const avgBuyEarlier = earlier.length
      ? avg(earlier.map((x) => x.buyPressureM5 || x.buyPressureH1))
      : avg(recent.map((x) => x.buyPressureH1));
    const buyPressureTrend = avgBuyRecent - avgBuyEarlier;

    const avgTxnsRecent = avg(recentShort.map((x) => x.txnsM5 || x.txnsH1));
    const avgTxnsEarlier = earlier.length
      ? avg(earlier.map((x) => x.txnsM5 || x.txnsH1))
      : avg(recent.map((x) => x.txnsH1));
    const txnsTrendPct = pctChange(avgTxnsRecent, avgTxnsEarlier);

    const avgVolRecent = avg(recentShort.map((x) => x.volumeM5 || x.volumeH1));
    const avgVolEarlier = earlier.length
      ? avg(earlier.map((x) => x.volumeM5 || x.volumeH1))
      : avg(recent.map((x) => x.volumeH1));
    const volumeTrendPct = pctChange(avgVolRecent, avgVolEarlier);

    const lowsRecent = recent.slice(-3).map((x) => safeNum(x?.price, 0)).filter(Boolean);
    const lowsEarlier = recent.slice(0, Math.max(1, recent.length - 3)).map((x) => safeNum(x?.price, 0)).filter(Boolean);
    const higherLow = lowsRecent.length && lowsEarlier.length
      ? Math.min(...lowsRecent) >= Math.min(...lowsEarlier) * 0.995
      : false;

    let reloadCount = 0;
    for (let i = 1; i < records.length; i += 1) {
      const prev = records[i - 1];
      const curr = records[i];
      const prevBottomish = safeNum(prev?.price, 0) > 0 && safeNum(prev?.price, 0) <= bottomBand;
      if (
        prevBottomish &&
        safeNum(prev?.priceM5, 0) <= 0 &&
        safeNum(curr?.priceM5, 0) > 0 &&
        safeNum(curr?.buyPressureM5, 0) >= 55
      ) {
        reloadCount += 1;
      }
    }

    const sellerAbsorptionScore = clamp(
      Math.round(
        bottomTouches * 8 +
        Math.max(0, buyPressureTrend) * 2 +
        Math.max(0, txnsTrendPct) * 0.12 +
        (higherLow ? 12 : 0)
      ),
      0,
      99
    );

    let signalSource = "proxy";
    let freshWalletBuyCount = clamp(Math.round(avgTxnsRecent * 0.7), 0, 999);
    let retention30mPct = clamp(42 + bottomTouches * 4 + Math.max(0, buyPressureTrend) * 2 + (higherLow ? 6 : 0), 12, 92);
    let retention2hPct = clamp(retention30mPct - 8 + Math.max(0, volumeTrendPct) * 0.04, 8, 90);
    let netControlPct = clamp(3 + bottomTouches * 1.7 + Math.max(0, buyPressureTrend) * 0.7 + Math.max(0, volumeTrendPct) * 0.03, 0, 45);
    let dipBuyRatioPct = clamp(45 + Math.max(0, buyPressureTrend) * 2.2 + reloadCount * 4, 10, 95);

    if (holderIntel && Array.isArray(holderIntel.wallets) && holderIntel.wallets.length) {
      signalSource = "wallet_live";
      const wallets = holderIntel.wallets;
      freshWalletBuyCount = wallets.length;
      const retained30 = wallets.filter((w) => safeNum(w?.holdMinutes, 0) >= 30 && safeNum(w?.soldPct, 0) <= 35).length;
      const retained120 = wallets.filter((w) => safeNum(w?.holdMinutes, 0) >= 120 && safeNum(w?.soldPct, 0) <= 45).length;
      const totalNetPct = wallets.reduce((sum, w) => sum + safeNum(w?.balancePct, 0), 0);
      const dipBuyCount = wallets.filter((w) => safeNum(w?.reloadCount, 0) > 0).length;

      retention30mPct = wallets.length ? (retained30 / wallets.length) * 100 : 0;
      retention2hPct = wallets.length ? (retained120 / wallets.length) * 100 : 0;
      netControlPct = totalNetPct;
      dipBuyRatioPct = wallets.length ? (dipBuyCount / wallets.length) * 100 : 0;
      reloadCount = wallets.reduce((sum, w) => sum + safeNum(w?.reloadCount, 0), 0);
    }

    const controlTrendPct = clamp(netControlPct - safeNum(row.lastControlPct, 0), -20, 20);
    row.lastControlPct = netControlPct;

    const quietPackagingScore = clamp(
      Math.round(
        bottomTouches * 7 +
        Math.min(baseMinutes, 180) * 0.12 +
        Math.max(0, buyPressureTrend) * 2 +
        Math.max(0, txnsTrendPct) * 0.1 +
        Math.max(0, volumeTrendPct) * 0.06 +
        retention30mPct * 0.22 +
        retention2hPct * 0.12 +
        netControlPct * 0.8 +
        reloadCount * 4 +
        (higherLow ? 8 : 0)
      ),
      0,
      99
    );

    const pass = (
      quietPackagingScore >= 60 &&
      bottomTouches >= 3 &&
      baseMinutes >= 20 &&
      retention30mPct >= 54 &&
      netControlPct >= 7
    );

    const watch = !pass && quietPackagingScore >= 45 && bottomTouches >= 2;

    return {
      pass,
      watch,
      score: quietPackagingScore,
      signalSource,
      primaryMode: pass ? "bottom_pack_reversal" : watch ? "quiet_base_watch" : "",
      freshWalletBuyCount,
      retention30mPct: clamp(retention30mPct, 0, 100),
      retention2hPct: clamp(retention2hPct, 0, 100),
      netControlPct: clamp(netControlPct, 0, 100),
      controlTrendPct,
      dipBuyRatioPct: clamp(dipBuyRatioPct, 0, 100),
      reloadCount,
      bottomTouches,
      baseMinutes,
      rangeCompressionPct: clamp(rangeCompressionPct, 0, 500),
      buyPressureTrend,
      txnsTrendPct,
      volumeTrendPct,
      sellerAbsorptionScore,
      higherLow
    };
  }

  buildEmpty() {
    return {
      pass: false,
      watch: false,
      score: 0,
      signalSource: "proxy",
      primaryMode: "",
      freshWalletBuyCount: 0,
      retention30mPct: 0,
      retention2hPct: 0,
      netControlPct: 0,
      controlTrendPct: 0,
      dipBuyRatioPct: 0,
      reloadCount: 0,
      bottomTouches: 0,
      baseMinutes: 0,
      rangeCompressionPct: 0,
      buyPressureTrend: 0,
      txnsTrendPct: 0,
      volumeTrendPct: 0,
      sellerAbsorptionScore: 0,
      higherLow: false
    };
  }
}
