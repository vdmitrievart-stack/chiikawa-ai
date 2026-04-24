// ==============================
// TRADING KERNEL (PATCHED)
// anti-spam / anti-repeat version
// ==============================

import { analyzeToken } from "../scan-engine.js";
import { getPortfolio, openPosition, closePosition } from "../portfolio.js";

const COOLDOWN_MS = 5 * 60 * 1000; // 5 минут блокировки токена
const MAX_REPEAT = 2; // максимум 2 раза подряд

let state = {
  lastToken: null,
  lastTradeTime: 0,
  seen: new Map(), // ca -> timestamp
  repeatCount: 0,
};

// ==============================
// MAIN LOOP STEP
// ==============================
export async function runCycle(tokens, ctx) {
  try {
    const now = Date.now();

    // фильтр cooldown
    tokens = tokens.filter(t => {
      const last = state.seen.get(t.ca);
      if (!last) return true;
      return now - last > COOLDOWN_MS;
    });

    if (tokens.length === 0) {
      ctx.log("⚠️ No tokens after cooldown filter");
      return;
    }

    // анализ
    const analyzed = [];
    for (const t of tokens) {
      const a = await analyzeToken(t);
      if (a) analyzed.push(a);
    }

    if (!analyzed.length) return;

    // сортировка по score
    analyzed.sort((a, b) => b.score - a.score);

    const best = analyzed[0];

    // ==========================
    // АНТИ-ПОВТОР ЛОГИКА
    // ==========================
    if (state.lastToken === best.ca) {
      state.repeatCount++;

      if (state.repeatCount >= MAX_REPEAT) {
        ctx.log(`🚫 Skip spam token: ${best.symbol}`);

        // берём следующий токен
        if (analyzed.length > 1) {
          const alt = analyzed[1];
          return executeTrade(alt, ctx);
        }

        return;
      }
    } else {
      state.repeatCount = 0;
    }

    return executeTrade(best, ctx);

  } catch (e) {
    console.error("runCycle error:", e);
  }
}

// ==============================
// EXECUTE TRADE
// ==============================
async function executeTrade(token, ctx) {
  const portfolio = getPortfolio();

  state.lastToken = token.ca;
  state.lastTradeTime = Date.now();
  state.seen.set(token.ca, Date.now());

  ctx.log(`🔎 ANALYSIS ${token.symbol}`);

  // ===== ПРОСТАЯ СТРАТЕГИЯ =====
  if (token.expectedEdge < 2) {
    ctx.log(`❌ Skip (low edge ${token.expectedEdge}%)`);
    return;
  }

  const size = portfolio.balance * 0.18;

  const position = openPosition({
    ca: token.ca,
    symbol: token.symbol,
    entry: token.price,
    size,
  });

  ctx.log(`🚀 ENTRY ${token.symbol}`);

  // имитация холда
  setTimeout(() => {
    const current = token.price * (1 + (Math.random() - 0.5) * 0.05);

    const pnl = ((current - position.entry) / position.entry) * 100;

    closePosition(position.id, current);

    ctx.log(`🏁 EXIT ${token.symbol} | PnL: ${pnl.toFixed(2)}%`);
  }, 60_000);
}
