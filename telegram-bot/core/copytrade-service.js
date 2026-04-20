function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function isBadDevVerdict(verdict) {
  const v = asText(verdict).toLowerCase();
  return v === "bad" || v === "danger" || v === "risky";
}

function isStrongNarrative(verdict) {
  const v = asText(verdict).toLowerCase();
  return v === "strong" || v === "good" || v === "ok";
}

function isFiniteNumber(v) {
  return Number.isFinite(Number(v));
}

function resolveConcentrationInfo(candidate) {
  const holdersValueRaw = candidate?.holders?.concentration;
  const walletValueRaw = candidate?.wallet?.concentration;

  const hasHoldersValue = isFiniteNumber(holdersValueRaw);
  const hasWalletValue = isFiniteNumber(walletValueRaw);

  if (hasHoldersValue) {
    return {
      value: safeNum(holdersValueRaw, 0),
      isProxy: false,
      source: "holders"
    };
  }

  if (hasWalletValue) {
    return {
      value: safeNum(walletValueRaw, 0),
      isProxy: true,
      source: "wallet_proxy"
    };
  }

  return {
    value: 0,
    isProxy: true,
    source: "unknown"
  };
}

export default class CopytradeService {
  constructor(options = {}) {
    this.copytradeManager = options.copytradeManager;
    this.gmgnLeaderIntel = options.gmgnLeaderIntel;
    this.logger = options.logger || console;

    this.rules = {
      leaderMinScore: safeNum(options.leaderMinScore, 70),
      copytradeTokenMinScore: safeNum(options.copytradeTokenMinScore, 72),
      maxFollowDelaySec: safeNum(options.maxFollowDelaySec, 90),
      maxPriceExtensionPct: safeNum(options.maxPriceExtensionPct, 18),
      maxRugRisk: safeNum(options.maxRugRisk, 45),
      minLiquidityUsd: safeNum(options.minLiquidityUsd, 12000),

      // было слишком жестко: 42 сразу hard reject
      concentrationSafeMax: safeNum(options.concentrationSafeMax, 42),
      concentrationProbeMax: safeNum(options.concentrationProbeMax, 70),
      concentrationHardRejectAbove: safeNum(options.concentrationHardRejectAbove, 70),
      proxyConcentrationHardRejectAbove: safeNum(
        options.proxyConcentrationHardRejectAbove,
        85
      ),

      hardRejectBotActivity: safeNum(options.hardRejectBotActivity, 55),
      hardRejectCorpseScore: safeNum(options.hardRejectCorpseScore, 70),
      maxDistributionScore: safeNum(options.maxDistributionScore, 26),
      minSocialCount: safeNum(options.minSocialCount, 1),
      copytradeProbeOnlyOnBorderline:
        options.copytradeProbeOnlyOnBorderline !== false,
      copytradeHardStopPct: safeNum(options.copytradeHardStopPct, 7),
      leaderPenaltyOnRejectedTrap: safeNum(options.leaderPenaltyOnRejectedTrap, 6),
      leaderPenaltyOnHardTrap: safeNum(options.leaderPenaltyOnHardTrap, 12),
      leaderRewardOnAcceptedQuality: safeNum(options.leaderRewardOnAcceptedQuality, 2),

      entryUsesLeader: options.entryUsesLeader !== false,
      exitUsesLeaderMode: asText(options.exitUsesLeaderMode, "soft_only"),
      leaderSellTightensStop: options.leaderSellTightensStop !== false,
      leaderSellImmediateExit: options.leaderSellImmediateExit === true,
      ownTpPriority: options.ownTpPriority !== false,
      ownTrailPriority: options.ownTrailPriority !== false
    };
  }

  ensureLeaderShape(leader) {
    if (!leader) return null;

    if (leader.rejectedTrapCount == null) leader.rejectedTrapCount = 0;
    if (leader.acceptedGoodCount == null) leader.acceptedGoodCount = 0;
    if (!leader.lastSyncAt) leader.lastSyncAt = nowIso();

    return leader;
  }

  async syncLeaderScores(runtimeConfig) {
    const leaders = this.copytradeManager.listLeaders(runtimeConfig);
    if (!leaders.length) return [];

    const intel = await this.gmgnLeaderIntel.refreshMany(
      leaders.map((x) => x.address)
    );

    for (const row of intel) {
      this.copytradeManager.setLeaderScore(runtimeConfig, row.address, row.score);
      const leader = runtimeConfig?.copytrade?.leaders?.find(
        (x) => x.address === row.address
      );
      this.ensureLeaderShape(leader);
      if (leader) {
        leader.lastIntel = clone(row);
        leader.lastSyncAt = nowIso();
      }
    }

    this.copytradeManager.refreshLeaderStates(runtimeConfig);
    return intel;
  }

  pickLeader(runtimeConfig) {
    const leader =
      this.copytradeManager.pickBestLeader(runtimeConfig) || null;

    return leader ? this.ensureLeaderShape(leader) : null;
  }

  canTradeCopy(runtimeConfig, candidate = null, context = {}) {
    const leader = this.pickLeader(runtimeConfig);
    if (!leader) {
      return {
        allow: false,
        mode: "reject",
        reason: "NO_LEADER",
        reasons: ["No copytrade leader available"],
        leader: null,
        adjustedPlan: null
      };
    }

    if (!this.copytradeManager.isLeaderTradable(runtimeConfig, leader.address)) {
      return {
        allow: false,
        mode: "reject",
        reason: "LEADER_NOT_TRADABLE",
        reasons: [`Leader ${leader.address} is not tradable now`],
        leader,
        adjustedPlan: null
      };
    }

    if (!candidate) {
      return {
        allow: true,
        mode: "allow",
        reason: "LEADER_OK_NO_TOKEN_CHECK",
        reasons: ["Leader passed base checks"],
        leader,
        adjustedPlan: null
      };
    }

    const verdict = this.evaluateCopytradeEntry(runtimeConfig, candidate, context, leader);
    return {
      ...verdict,
      leader
    };
  }

  evaluateCopytradeEntry(runtimeConfig, candidate, context = {}, leader = null) {
    const rules = this.rules;

    const tokenScore = safeNum(candidate?.score, 0);
    const rugRisk = safeNum(candidate?.rug?.risk, 0);
    const corpseScore = safeNum(candidate?.corpse?.score, 0);
    const isCorpse = Boolean(candidate?.corpse?.isCorpse);
    const falseBounce = Boolean(candidate?.falseBounce?.rejected);
    const devVerdict = candidate?.developer?.verdict || "";
    const liquidityUsd =
      safeNum(candidate?.token?.liquidity, 0) ||
      safeNum(candidate?.liquidity?.usd, 0);

    const concentrationInfo = resolveConcentrationInfo(candidate);
    const concentration = safeNum(concentrationInfo.value, 0);
    const concentrationIsProxy = Boolean(concentrationInfo.isProxy);

    const botActivity = safeNum(candidate?.bots?.botActivity, 0);
    const distribution = safeNum(candidate?.distribution?.score, 0);
    const accumulation = safeNum(candidate?.accumulation?.score, 0);
    const absorption = safeNum(candidate?.absorption?.score, 0);
    const deltaPrice = safeNum(candidate?.delta?.priceDeltaPct, 0);
    const socialCount = safeNum(candidate?.socials?.socialCount, 0);
    const hasTwitter = Boolean(candidate?.socials?.links?.twitter);
    const hasTelegram = Boolean(candidate?.socials?.links?.telegram);
    const hasWebsite = Boolean(candidate?.socials?.links?.website);
    const narrativeVerdict = candidate?.narrative?.verdict || "";
    const tokenType = candidate?.mechanics?.tokenType || "";
    const rewardModel = candidate?.mechanics?.rewardModel || "";

    const followDelaySec = safeNum(context?.followDelaySec, 0);
    const priceExtensionPct = safeNum(
      context?.priceExtensionPct,
      Math.max(0, deltaPrice)
    );

    const reasons = [];
    const softReasons = [];
    const hardReasons = [];

    if (tokenScore < rules.copytradeTokenMinScore) {
      softReasons.push(`tokenScore ${tokenScore} < ${rules.copytradeTokenMinScore}`);
    }

    if (rugRisk > rules.maxRugRisk) {
      hardReasons.push(`rugRisk ${rugRisk} > ${rules.maxRugRisk}`);
    }

    if (isCorpse || corpseScore >= rules.hardRejectCorpseScore) {
      hardReasons.push("corpse risk too high");
    }

    if (falseBounce) {
      hardReasons.push("false bounce rejected");
    }

    if (isBadDevVerdict(devVerdict)) {
      hardReasons.push("developer verdict is bad");
    }

    if (liquidityUsd < rules.minLiquidityUsd) {
      softReasons.push(`liquidity ${liquidityUsd} < ${rules.minLiquidityUsd}`);
    }

    // новая мягкая логика концентрации
    if (concentration > 0) {
      if (concentrationIsProxy) {
        if (concentration > rules.proxyConcentrationHardRejectAbove) {
          hardReasons.push(
            `holder concentration proxy ${concentration} > ${rules.proxyConcentrationHardRejectAbove}`
          );
        } else if (concentration > rules.concentrationSafeMax) {
          softReasons.push(
            `holder concentration proxy ${concentration} > ${rules.concentrationSafeMax}`
          );
        }
      } else {
        if (concentration > rules.concentrationHardRejectAbove) {
          hardReasons.push(
            `holder concentration ${concentration} > ${rules.concentrationHardRejectAbove}`
          );
        } else if (concentration > rules.concentrationSafeMax) {
          softReasons.push(
            `holder concentration ${concentration} > ${rules.concentrationSafeMax}`
          );
        }
      }
    }

    if (botActivity >= rules.hardRejectBotActivity) {
      hardReasons.push(
        `bot activity ${botActivity} >= ${rules.hardRejectBotActivity}`
      );
    }

    if (distribution > rules.maxDistributionScore) {
      softReasons.push(
        `distribution ${distribution} > ${rules.maxDistributionScore}`
      );
    }

    if (followDelaySec > rules.maxFollowDelaySec) {
      softReasons.push(
        `follow delay ${followDelaySec}s > ${rules.maxFollowDelaySec}s`
      );
    }

    if (priceExtensionPct > rules.maxPriceExtensionPct) {
      hardReasons.push(
        `price extension ${priceExtensionPct}% > ${rules.maxPriceExtensionPct}%`
      );
    }

    const socialsOk =
      socialCount >= rules.minSocialCount || hasTwitter || hasTelegram || hasWebsite;

    if (!socialsOk) {
      softReasons.push("social layer too weak");
    }

    if (!isStrongNarrative(narrativeVerdict) && !socialsOk) {
      softReasons.push("narrative not strong");
    }

    if (accumulation <= 0 && absorption <= 0 && distribution >= 20) {
      softReasons.push("flow structure weak for follow");
    }

    if (hardReasons.length) {
      reasons.push(...hardReasons, ...softReasons);
      return {
        allow: false,
        mode: "reject",
        reason: "COPYTRAP_HARD_REJECT",
        reasons,
        adjustedPlan: {
          forceStopLossPct: rules.copytradeHardStopPct
        }
      };
    }

    if (softReasons.length && rules.copytradeProbeOnlyOnBorderline) {
      reasons.push(...softReasons);
      return {
        allow: true,
        mode: "probe_only",
        reason: "COPYTRAP_BORDERLINE",
        reasons,
        adjustedPlan: {
          forceEntryMode: "PROBE",
          forceStopLossPct: rules.copytradeHardStopPct
        }
      };
    }

    reasons.push(
      "leader accepted",
      "token score ok",
      "rug risk ok",
      "timing acceptable",
      "copytrade filter passed"
    );

    if (tokenType) reasons.push(`tokenType ${tokenType}`);
    if (rewardModel && rewardModel !== "None") reasons.push(`rewardModel ${rewardModel}`);

    return {
      allow: true,
      mode: "allow",
      reason: "COPYTRAP_PASS",
      reasons,
      adjustedPlan: {
        forceStopLossPct: rules.copytradeHardStopPct
      }
    };
  }

  registerRejectedTrap(runtimeConfig, leaderAddress, severity = "soft") {
    const leader = runtimeConfig?.copytrade?.leaders?.find(
      (x) => x.address === leaderAddress
    );
    if (!leader) return null;

    this.ensureLeaderShape(leader);

    const penalty =
      severity === "hard"
        ? this.rules.leaderPenaltyOnHardTrap
        : this.rules.leaderPenaltyOnRejectedTrap;

    leader.score = clamp(safeNum(leader.score, 0) - penalty, 0, 100);
    leader.rejectedTrapCount += 1;
    leader.lastSyncAt = nowIso();

    if (leader.score < this.rules.leaderMinScore) {
      leader.cooldownUntil = new Date(
        Date.now() + safeNum(runtimeConfig?.copytrade?.cooldownMinutes, 180) * 60 * 1000
      ).toISOString();
      leader.state = "cooldown";
    }

    return clone(leader);
  }

  registerAcceptedQuality(runtimeConfig, leaderAddress) {
    const leader = runtimeConfig?.copytrade?.leaders?.find(
      (x) => x.address === leaderAddress
    );
    if (!leader) return null;

    this.ensureLeaderShape(leader);

    leader.score = clamp(
      safeNum(leader.score, 0) + this.rules.leaderRewardOnAcceptedQuality,
      0,
      100
    );
    leader.acceptedGoodCount += 1;
    leader.lastSyncAt = nowIso();

    return clone(leader);
  }

  buildExecutionModeText() {
    const r = this.rules;
    return `🧠 <b>Execution Model</b>
entry by leader: ${r.entryUsesLeader ? "yes" : "no"}
exit by bot strategy: yes
leader sell mode: ${asText(r.exitUsesLeaderMode, "soft_only")}
leader sell tightens stop: ${r.leaderSellTightensStop ? "yes" : "no"}
leader sell immediate exit: ${r.leaderSellImmediateExit ? "yes" : "no"}
own TP priority: ${r.ownTpPriority ? "yes" : "no"}
own trail priority: ${r.ownTrailPriority ? "yes" : "no"}`;
  }

  buildCopytradeText(runtimeConfig) {
    const leaders = this.copytradeManager.listLeaders(runtimeConfig);
    const r = this.rules;

    const lines = ["📋 <b>Copytrade</b>", ""];
    lines.push(`enabled: ${runtimeConfig.copytrade.enabled ? "yes" : "no"}`);
    lines.push(
      `rescoring: ${runtimeConfig.copytrade.rescoringEnabled ? "yes" : "no"}`
    );
    lines.push(`leader min score: ${r.leaderMinScore}`);
    lines.push(`token min score: ${r.copytradeTokenMinScore}`);
    lines.push(`max delay sec: ${r.maxFollowDelaySec}`);
    lines.push(`max extension pct: ${r.maxPriceExtensionPct}`);
    lines.push(`max rug risk: ${r.maxRugRisk}`);
    lines.push(`min liquidity usd: ${r.minLiquidityUsd}`);
    lines.push(`concentration safe max: ${r.concentrationSafeMax}`);
    lines.push(`concentration probe max: ${r.concentrationProbeMax}`);
    lines.push(`concentration hard reject above: ${r.concentrationHardRejectAbove}`);
    lines.push(`copytrade hard stop pct: ${r.copytradeHardStopPct}`);
    lines.push("");
    lines.push(this.buildExecutionModeText());
    lines.push("");

    if (!leaders.length) {
      lines.push("leaders: none");
    } else {
      for (const leader of leaders) {
        this.ensureLeaderShape(leader);
        lines.push(
          `• <b>${leader.address}</b>
state: ${leader.state}
score: ${safeNum(leader.score)}
source: ${asText(leader.source, "manual")}
rejected traps: ${safeNum(leader.rejectedTrapCount)}
accepted good: ${safeNum(leader.acceptedGoodCount)}
last sync: ${asText(leader.lastSyncAt, "-")}`
        );
        lines.push("");
      }
    }

    lines.push(`<code>/addleader</code>`);
    return lines.join("\n");
  }

  async buildLeaderHealthText(runtimeConfig) {
    const leaders = this.copytradeManager.listLeaders(runtimeConfig);
    if (!leaders.length) {
      return `🫀 <b>Leader Health</b>

leaders: none`;
    }

    const intel = await this.gmgnLeaderIntel.refreshMany(
      leaders.map((x) => x.address)
    );

    const lines = ["🫀 <b>Leader Health</b>", ""];
    for (const row of intel) {
      const leader = runtimeConfig?.copytrade?.leaders?.find(
        (x) => x.address === row.address
      );
      this.ensureLeaderShape(leader);

      lines.push(
        `• <b>${row.address}</b>
state: ${row.state}
score: ${safeNum(row.score)}
recent winrate: ${safeNum(row.recentWinrate)}%
recent pnl: ${safeNum(row.recentPnlPct)}%
max drawdown: ${safeNum(row.maxDrawdownPct)}%
rejected traps: ${safeNum(leader?.rejectedTrapCount)}
accepted good: ${safeNum(leader?.acceptedGoodCount)}
source: ${asText(row.source, "-")}
last sync: ${asText(row.lastSyncAt, "-")}`
      );
      lines.push("");
    }

    return lines.join("\n");
  }

  buildGmgnStatusText() {
    const h = this.gmgnLeaderIntel.getHealth();
    return `🛰 <b>GMGN Status</b>

enabled: ${h.enabled ? "yes" : "no"}
mode: ${asText(h.mode, "-")}
auto refresh sec: ${safeNum(h.autoRefreshSec)}
min recent winrate: ${safeNum(h.minRecentWinrate)}
min recent pnl pct: ${safeNum(h.minRecentPnlPct)}
max drawdown pct: ${safeNum(h.maxLeaderDrawdownPct)}
cooldown min: ${safeNum(h.cooldownMin)}
cached leaders: ${safeNum(h.cachedLeaders)}`;
  }
}
