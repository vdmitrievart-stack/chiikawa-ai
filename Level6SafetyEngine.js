export default class Level6SafetyEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.rugcheckClient = options.rugcheckClient || null;
    this.goplusClient = options.goplusClient || null;

    this.minLiquidityUsd = Number.isFinite(options.minLiquidityUsd)
      ? options.minLiquidityUsd
      : 5000;

    this.maxTop10HolderPct = Number.isFinite(options.maxTop10HolderPct)
      ? options.maxTop10HolderPct
      : 70;

    this.maxCreatorHolderPct = Number.isFinite(options.maxCreatorHolderPct)
      ? options.maxCreatorHolderPct
      : 15;

    this.allowUnknownExternalSources =
      options.allowUnknownExternalSources !== undefined
        ? Boolean(options.allowUnknownExternalSources)
        : true;

    this.enableStrictAuthorityChecks =
      options.enableStrictAuthorityChecks !== undefined
        ? Boolean(options.enableStrictAuthorityChecks)
        : true;
  }

  async evaluateToken(input = {}) {
    const token = this.#normalizeTokenInput(input);

    const local = this.#evaluateLocalSafety(token);
    const external = await this.#evaluateExternalSafety(token);

    const merged = this.#mergeSignals(token, local, external);
    return merged;
  }

  #normalizeTokenInput(input = {}) {
    const topHolders = Array.isArray(input.topHolders) ? input.topHolders : [];

    return {
      symbol: String(input.symbol || "UNKNOWN").trim(),
      name: String(input.name || "").trim(),
      ca: String(input.ca || input.mint || "").trim(),
      chain: String(input.chain || "solana").trim(),
      liquidityUsd: this.#toNumber(input.liquidityUsd, 0),
      fdvUsd: this.#toNumber(input.fdvUsd, 0),
      marketCapUsd: this.#toNumber(input.marketCapUsd, 0),
      top10HolderPct: this.#toNumber(input.top10HolderPct, null),
      creatorHolderPct: this.#toNumber(input.creatorHolderPct, null),
      lpLockedPct: this.#toNumber(input.lpLockedPct, null),
      mintAuthorityEnabled: this.#toBooleanOrNull(input.mintAuthorityEnabled),
      freezeAuthorityEnabled: this.#toBooleanOrNull(input.freezeAuthorityEnabled),
      transferRestrictionRisk: this.#toBooleanOrNull(input.transferRestrictionRisk),
      blacklistRisk: this.#toBooleanOrNull(input.blacklistRisk),
      whitelistRisk: this.#toBooleanOrNull(input.whitelistRisk),
      honeypotLikeRisk: this.#toBooleanOrNull(input.honeypotLikeRisk),
      canRemoveLiquidity: this.#toBooleanOrNull(input.canRemoveLiquidity),
      topHolders,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
    };
  }

  async #evaluateExternalSafety(token) {
    const result = {
      rugcheck: null,
      goplus: null,
      issues: [],
      warnings: [],
      externalScore: null
    };

    if (this.rugcheckClient?.getTokenSafety) {
      try {
        result.rugcheck = await this.rugcheckClient.getTokenSafety(token.ca);
      } catch (error) {
        this.logger.error("Level6SafetyEngine rugcheck error:", error.message);
        result.warnings.push(`rugcheck_error:${error.message}`);
      }
    }

    if (this.goplusClient?.getSolanaTokenSecurity) {
      try {
        result.goplus = await this.goplusClient.getSolanaTokenSecurity(token.ca);
      } catch (error) {
        this.logger.error("Level6SafetyEngine goplus error:", error.message);
        result.warnings.push(`goplus_error:${error.message}`);
      }
    }

    const externalFlags = this.#extractExternalFlags(result.rugcheck, result.goplus);
    result.issues.push(...externalFlags.issues);
    result.warnings.push(...externalFlags.warnings);
    result.externalScore = externalFlags.externalScore;

    return result;
  }

  #extractExternalFlags(rugcheck, goplus) {
    const issues = [];
    const warnings = [];
    let externalScore = 0;

    if (rugcheck && typeof rugcheck === "object") {
      const rcScore = this.#toNumber(
        rugcheck.score ??
          rugcheck.riskScore ??
          rugcheck.trustScore,
        null
      );

      if (rcScore !== null) {
        // Higher is safer if using common 0-100 trust style.
        if (rcScore >= 80) externalScore += 2;
        else if (rcScore >= 60) externalScore += 1;
        else if (rcScore < 40) issues.push("rugcheck_low_score");
        else warnings.push("rugcheck_medium_score");
      }

      const rcRisks = Array.isArray(rugcheck.risks)
        ? rugcheck.risks
        : Array.isArray(rugcheck.warnings)
          ? rugcheck.warnings
          : [];

      for (const risk of rcRisks) {
        const text = String(
          risk?.name || risk?.message || risk?.title || risk || ""
        ).toLowerCase();

        if (!text) continue;

        if (
          text.includes("mint authority") ||
          text.includes("freeze authority") ||
          text.includes("lp unlocked") ||
          text.includes("can mint") ||
          text.includes("high holder concentration") ||
          text.includes("removable liquidity")
        ) {
          issues.push(`rugcheck:${text}`);
        } else {
          warnings.push(`rugcheck:${text}`);
        }
      }
    }

    if (goplus && typeof goplus === "object") {
      const gp = goplus?.result || goplus?.data || goplus;
      const values = JSON.stringify(gp).toLowerCase();

      if (values.includes("blacklist")) warnings.push("goplus:blacklist_signal");
      if (values.includes("whitelist")) warnings.push("goplus:whitelist_signal");
      if (values.includes("mint")) warnings.push("goplus:mint_signal");
      if (values.includes("freeze")) warnings.push("goplus:freeze_signal");

      const restrictive =
        this.#truthyPath(gp, ["is_honeypot"]) ||
        this.#truthyPath(gp, ["transfer_pausable"]) ||
        this.#truthyPath(gp, ["cannot_sell_all"]) ||
        this.#truthyPath(gp, ["trading_cooldown"]) ||
        this.#truthyPath(gp, ["blacklist"]);

      if (restrictive) {
        issues.push("goplus:restrictive_or_honeypot_like");
      } else {
        externalScore += 1;
      }
    }

    return { issues, warnings, externalScore };
  }

  #evaluateLocalSafety(token) {
    const issues = [];
    const warnings = [];
    let localScore = 0;

    if (!token.ca) {
      issues.push("missing_ca");
    }

    if (token.chain !== "solana") {
      warnings.push(`unexpected_chain:${token.chain}`);
    }

    if (token.liquidityUsd >= this.minLiquidityUsd) {
      localScore += 2;
    } else if (token.liquidityUsd > 0) {
      issues.push(`low_liquidity:${token.liquidityUsd}`);
    } else {
      issues.push("missing_liquidity");
    }

    if (token.top10HolderPct !== null) {
      if (token.top10HolderPct <= this.maxTop10HolderPct) {
        localScore += 1;
      } else {
        issues.push(`top10_concentration_high:${token.top10HolderPct}`);
      }
    } else {
      warnings.push("top10_holder_pct_unknown");
    }

    if (token.creatorHolderPct !== null) {
      if (token.creatorHolderPct <= this.maxCreatorHolderPct) {
        localScore += 1;
      } else {
        issues.push(`creator_holder_pct_high:${token.creatorHolderPct}`);
      }
    } else {
      warnings.push("creator_holder_pct_unknown");
    }

    if (token.lpLockedPct !== null) {
      if (token.lpLockedPct >= 90) {
        localScore += 1;
      } else if (token.lpLockedPct < 50) {
        issues.push(`lp_lock_weak:${token.lpLockedPct}`);
      } else {
        warnings.push(`lp_lock_medium:${token.lpLockedPct}`);
      }
    } else {
      warnings.push("lp_lock_unknown");
    }

    if (this.enableStrictAuthorityChecks) {
      if (token.mintAuthorityEnabled === true) {
        issues.push("mint_authority_enabled");
      } else if (token.mintAuthorityEnabled === false) {
        localScore += 1;
      } else {
        warnings.push("mint_authority_unknown");
      }

      if (token.freezeAuthorityEnabled === true) {
        issues.push("freeze_authority_enabled");
      } else if (token.freezeAuthorityEnabled === false) {
        localScore += 1;
      } else {
        warnings.push("freeze_authority_unknown");
      }
    }

    if (token.transferRestrictionRisk === true) {
      issues.push("transfer_restriction_risk");
    }

    if (token.blacklistRisk === true) {
      issues.push("blacklist_risk");
    }

    if (token.whitelistRisk === true) {
      warnings.push("whitelist_risk");
    }

    if (token.honeypotLikeRisk === true) {
      issues.push("honeypot_like_risk");
    }

    if (token.canRemoveLiquidity === true) {
      issues.push("can_remove_liquidity");
    }

    return {
      localScore,
      issues,
      warnings
    };
  }

  #mergeSignals(token, local, external) {
    const allIssues = [...local.issues, ...external.issues];
    const allWarnings = [...local.warnings, ...external.warnings];

    const hardReject =
      allIssues.includes("missing_ca") ||
      allIssues.includes("mint_authority_enabled") ||
      allIssues.includes("freeze_authority_enabled") ||
      allIssues.includes("honeypot_like_risk") ||
      allIssues.includes("can_remove_liquidity") ||
      allIssues.some(x => x.startsWith("low_liquidity")) ||
      allIssues.some(x => x.startsWith("top10_concentration_high")) ||
      allIssues.some(x => x.startsWith("creator_holder_pct_high")) ||
      allIssues.some(x => x.includes("restrictive_or_honeypot_like"));

    const totalScore =
      Number(local.localScore || 0) + Number(external.externalScore || 0);

    let safetyBand = "danger";
    if (!hardReject && totalScore >= 6) safetyBand = "safe";
    else if (!hardReject && totalScore >= 4) safetyBand = "watch";
    else safetyBand = "danger";

    return {
      ok: !hardReject,
      hardReject,
      safetyBand,
      score: totalScore,
      token: {
        symbol: token.symbol,
        ca: token.ca,
        chain: token.chain
      },
      issues: allIssues,
      warnings: allWarnings,
      details: {
        localScore: local.localScore,
        externalScore: external.externalScore,
        liquidityUsd: token.liquidityUsd,
        top10HolderPct: token.top10HolderPct,
        creatorHolderPct: token.creatorHolderPct,
        lpLockedPct: token.lpLockedPct,
        mintAuthorityEnabled: token.mintAuthorityEnabled,
        freezeAuthorityEnabled: token.freezeAuthorityEnabled,
        rugcheck: external.rugcheck,
        goplus: external.goplus
      }
    };
  }

  #truthyPath(obj, path) {
    try {
      let cur = obj;
      for (const key of path) {
        cur = cur?.[key];
      }
      return cur === true || cur === "1" || cur === 1 || cur === "true";
    } catch {
      return false;
    }
  }

  #toBooleanOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const v = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y", "enabled"].includes(v)) return true;
    if (["false", "0", "no", "n", "disabled"].includes(v)) return false;
    return null;
  }

  #toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
}
