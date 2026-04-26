// accumulation-scan-hotfix.js (FULL VERSION WITH WALLET CLUSTER)

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 2) {
  const p = 10 ** d;
  return Math.round((safeNum(v) + Number.EPSILON) * p) / p;
}

function fmtPct(v, d = 2) {
  return `${round(v, d)}%`;
}

function fmtNum(v, d = 2) {
  return `${round(v, d)}`;
}

function green(t) { return `✅ ${t}` }
function yellow(t) { return `🟡 ${t}` }
function red(t) { return `🚩 ${t}` }

// ===================== MAIN REPORT =====================

export function buildAccumulationReport(result) {
  const analyzed = result?.analyzed || {};
  const token = analyzed?.token || {};
  const holder = analyzed?.holderAccumulation || {};
  const wc = holder?.walletCluster;

  let text = `📦📦📦📦📦👀📢👀📦📦📦📦📦 PACKAGING DETECTED
🧺 ACCUMULATION SCAN — PACKAGING

<b>${escapeHtml(token.name || token.symbol || "UNKNOWN")}</b>
<code>${escapeHtml(token.ca || "")}</code>

Цена ${safeNum(token.price)} | FDV ${safeNum(token.fdv)} | Ликвидность ${safeNum(token.liquidity)}
Объём 1ч/24ч ${safeNum(token.volumeH1)} / ${safeNum(token.volumeH24)}

<b>📦 Holder accumulation</b>
Кошельков — ${safeNum(holder.trackedWallets)}
Новая когорта — ${safeNum(holder.freshWalletBuyCount)}
Удержание 30м / 2ч — ${fmtPct(holder.retention30mPct)} / ${fmtPct(holder.retention2hPct)}
Чистое накопление — ${fmtPct(holder.netAccumulationPct)}
Контроль когорты — ${fmtPct(holder.netControlPct)}
Reload — ${safeNum(holder.reloadCount)} | Bottom — ${safeNum(holder.bottomTouches)}
`;

  // ===================== WALLET CLUSTER =====================

  if (wc) {
    text += `
👛 <b>Wallet Cluster Intelligence</b>

Risk: ${wc.clusterRisk} (${wc.clusterRiskScore})

Young wallets ≤7d: ${fmtPct(wc.youngSupplyPct)}
Very young ≤3d: ${fmtPct(wc.veryYoungSupplyPct)}

Same-day wallets: ${wc.sameDayClusterCount}
Same-day supply: ${fmtPct(wc.sameDayClusterSupplyPct)}

Same-buy (15m): ${wc.sameBuyWindowClusterCount}
Same-buy supply: ${fmtPct(wc.sameBuyWindowSupplyPct)}

Same funding wallets: ${wc.sameFundingClusterCount}
Funding supply: ${fmtPct(wc.sameFundingSupplyPct)}

Similarity (CV): ${fmtNum(wc.sameDayBuySizeCv, 3)}
Avg wallet age: ${fmtNum(wc.avgAgeDays, 1)}d
`;

    if (wc.reasons?.length) {
      text += `Signals: ${escapeHtml(wc.reasons.slice(0, 3).join(" | "))}\n`;
    }
  } else {
    text += `\n🟡 Wallet Cluster Intelligence: нет данных\n`;
  }

  return text;
}
