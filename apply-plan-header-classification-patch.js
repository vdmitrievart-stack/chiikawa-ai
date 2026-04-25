import fs from "node:fs";
import path from "node:path";

const TARGET = path.resolve("telegram-bot/core/candidate-service.js");

function fail(msg) {
  console.error("❌ Patch failed:", msg);
  process.exit(1);
}

if (!fs.existsSync(TARGET)) {
  fail(`File not found: ${TARGET}. Run this from repository root.`);
}

let src = fs.readFileSync(TARGET, "utf8");

function findMethodRange(source, signature) {
  const idx = source.indexOf(signature);
  if (idx === -1) return null;

  const braceStart = source.indexOf("{", idx);
  if (braceStart === -1) return null;

  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start: idx, end: i + 1 };
      }
    }
  }

  return null;
}

function insertBefore(signature, block, marker) {
  if (src.includes(marker)) {
    console.log(`Already patched: ${marker}`);
    return;
  }

  const idx = src.indexOf(signature);
  if (idx === -1) fail(`Cannot find signature: ${signature}`);
  src = src.slice(0, idx) + block + "\n\n  " + src.slice(idx);
}

function replaceExact(oldText, newText, label) {
  if (src.includes(newText)) {
    console.log(`Already patched: ${label}`);
    return;
  }
  if (!src.includes(oldText)) fail(`Cannot find block for: ${label}`);
  src = src.replace(oldText, newText);
  console.log(`Patched: ${label}`);
}

const helperBlock = `  // PATCH_PLAN_CLASSIFICATION_HEADER_START
  getAntiRugBadge(candidate = {}) {
    const anti = candidate?.antiRug || {};
    const verdictRaw = String(anti?.verdict || "").toUpperCase();
    const rugRisk = safeNum(candidate?.rug?.risk, 0);
    const corpseScore = safeNum(candidate?.corpse?.score, 0);
    const isCorpse = Boolean(candidate?.corpse?.isCorpse);

    let verdict =
      verdictRaw ||
      (isCorpse || rugRisk >= 80 ? "HARD_BLOCK" :
        rugRisk >= 65 ? "SOFT_BLOCK" :
        rugRisk >= 50 || corpseScore >= 50 ? "RISKY" :
        rugRisk >= 35 || corpseScore >= 35 ? "WATCH" :
        "CLEAN");

    let emoji = "🟢";
    if (verdict === "HARD_BLOCK") emoji = "🔴";
    else if (verdict === "SOFT_BLOCK") emoji = "🟠";
    else if (verdict === "RISKY") emoji = "🟠";
    else if (verdict === "WATCH") emoji = "🟡";

    const riskScore = anti?.riskScore != null
      ? safeNum(anti.riskScore, 0)
      : Math.max(rugRisk, corpseScore);

    return {
      emoji,
      verdict,
      riskScore
    };
  }

  shouldPreferReversalOverRunner(candidate = {}) {
    const holder = candidate?.holderAccumulation || {};
    const packaging = candidate?.packaging || {};
    const reversal = candidate?.reversal || {};
    const migration = candidate?.migration || {};
    const token = candidate?.token || {};

    const priceM5 = safeNum(candidate?.delta?.priceM5Pct, safeNum(token?.priceChangeM5, 0));
    const priceH1 = safeNum(candidate?.delta?.priceH1Pct, safeNum(token?.priceChangeH1, 0));
    const priceH6 = safeNum(candidate?.delta?.priceH6Pct, safeNum(token?.priceChangeH6, 0));
    const priceH24 = safeNum(candidate?.delta?.priceH24Pct, safeNum(token?.priceChangeH24, 0));
    const pairAgeMin = safeNum(migration?.pairAgeMin, 0);

    const quietAccumulation =
      Boolean(holder?.quietAccumulationPass) ||
      Boolean(packaging?.quietAccumulation) ||
      Boolean(reversal?.quietAccumulation);

    const bottomPack =
      Boolean(holder?.bottomPackReversalPass) ||
      Boolean(packaging?.bottomPack) ||
      Boolean(reversal?.bottomPack);

    const packagingReversal =
      Boolean(packaging?.priorityWatch) ||
      Boolean(packaging?.probeEligible) ||
      Boolean(packaging?.warehouseLike);

    const oldBase =
      pairAgeMin >= 360 &&
      pairAgeMin <= 14400 &&
      priceH24 <= 35 &&
      priceH6 <= 20;

    const postFlushReclaim =
      (priceH6 < 0 || priceH24 < -10) &&
      priceH1 > -4 &&
      priceM5 >= -2;

    const trueContinuation =
      priceH1 >= 8 &&
      priceH6 >= 18 &&
      priceH24 >= 25 &&
      !quietAccumulation &&
      !bottomPack &&
      !packagingReversal &&
      !postFlushReclaim;

    if (trueContinuation) return false;

    return Boolean(
      reversal?.allow ||
      quietAccumulation ||
      bottomPack ||
      packagingReversal ||
      oldBase ||
      postFlushReclaim
    );
  }

  getMainPlanLabel(plans = [], candidate = {}) {
    const list = Array.isArray(plans) ? plans : [];
    const nonCopy = list.filter((p) => p?.strategyKey && p.strategyKey !== "copytrade");

    if (this.shouldPreferReversalOverRunner(candidate)) {
      const reversalPlan = nonCopy.find((p) =>
        p.strategyKey === "reversal" ||
        String(p?.planName || "").toLowerCase().includes("reversal") ||
        String(p?.planName || "").toLowerCase().includes("packaging")
      );
      if (reversalPlan) return "REVERSAL";
    }

    const preferred =
      nonCopy.find((p) => p.strategyKey === "scalp") ||
      nonCopy.find((p) => p.strategyKey === "migration_survivor") ||
      nonCopy.find((p) => p.strategyKey === "runner") ||
      nonCopy[0] ||
      list[0];

    if (!preferred?.strategyKey) return "WATCH";

    if (preferred.strategyKey === "migration_survivor") return "MIGRATION_SURVIVOR";
    return String(preferred.strategyKey).toUpperCase();
  }

  buildTopSignalHeader(candidate = {}, plans = []) {
    const anti = this.getAntiRugBadge(candidate);
    const mainPlan = this.getMainPlanLabel(plans, candidate);
    const planLine = (plans || []).map((p) => p.strategyKey).filter(Boolean).join(", ") || "none";
    const reversalScore = safeNum(candidate?.reversal?.score, 0);
    const runnerScore = safeNum(candidate?.runnerLike?.score, 0);
    const packagingScore = safeNum(candidate?.packaging?.score, 0);

    return \`
\${anti.emoji} <b>Anti-rug:</b> <b>\${escapeHtml(anti.verdict)}</b> / \${safeNum(anti.riskScore, 0)}
🎯 <b>Main plan:</b> <b>\${escapeHtml(mainPlan)}</b>
📌 <b>Plans:</b> \${escapeHtml(planLine)}
↩️ <b>Reversal score:</b> \${reversalScore} | 🏃 <b>Runner-like:</b> \${runnerScore} | 📦 <b>Packaging:</b> \${packagingScore}\`;
  }
  // PATCH_PLAN_CLASSIFICATION_HEADER_END`;

insertBefore("buildPlans(candidate, strategyScope = \"all\")", helperBlock, "PATCH_PLAN_CLASSIFICATION_HEADER_START");

const oldRunnerCondition = `if (
      score >= 84 &&
      safeNum(candidate?.delta?.priceH1Pct, 0) > 0 &&
      safeNum(candidate?.absorption?.score, 0) >= 8
    ) {`;

const newRunnerCondition = `if (
      score >= 84 &&
      safeNum(candidate?.delta?.priceH1Pct, 0) > 0 &&
      safeNum(candidate?.absorption?.score, 0) >= 8 &&
      !this.shouldPreferReversalOverRunner(candidate)
    ) {`;

replaceExact(oldRunnerCondition, newRunnerCondition, "runner condition avoids reversal-like bases");

const oldHeroStart = `return \`🧭 <b>\${escapeHtml(token.name || token.symbol || "UNKNOWN")}</b>
chain: \${escapeHtml(token.chainId || "-")}
score: \${safeNum(candidate?.score, 0)}`;

const newHeroStart = `const topHeader = this.buildTopSignalHeader(candidate, []);
    return \`🧭 <b>\${escapeHtml(token.name || token.symbol || "UNKNOWN")}</b>
\${topHeader}
chain: \${escapeHtml(token.chainId || "-")}
score: \${safeNum(candidate?.score, 0)}`;

replaceExact(oldHeroStart, newHeroStart, "hero caption top header");

const oldAnalysisStart = `return \`🔎 <b>ANALYSIS</b>

Token: \${escapeHtml(token.name || token.symbol || "UNKNOWN")}`;

const newAnalysisStart = `return \`🔎 <b>ANALYSIS</b>
\${this.buildTopSignalHeader(candidate, plans)}

Token: \${escapeHtml(token.name || token.symbol || "UNKNOWN")}`;

replaceExact(oldAnalysisStart, newAnalysisStart, "analysis top header");

fs.writeFileSync(TARGET, src, "utf8");
console.log("✅ Plan classification + top header patch applied to:", TARGET);
