function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

export default class CopytradeManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
  }

  ensureConfig(runtimeConfig) {
    if (!runtimeConfig.copytrade) {
      runtimeConfig.copytrade = {
        enabled: true,
        rescoringEnabled: true,
        minLeaderScore: 70,
        cooldownMinutes: 180,
        leaders: []
      };
    }

    if (!Array.isArray(runtimeConfig.copytrade.leaders)) {
      runtimeConfig.copytrade.leaders = [];
    }

    return runtimeConfig.copytrade;
  }

  addLeader(runtimeConfig, address, source = "manual") {
    const cfg = this.ensureConfig(runtimeConfig);
    const normalized = String(address || "").trim();

    const exists = cfg.leaders.find((x) => x.address === normalized);
    if (exists) return exists;

    const row = {
      address: normalized,
      state: "watch",
      score: 70,
      source,
      lastSyncAt: nowIso(),
      cooldownUntil: null
    };

    cfg.leaders.push(row);
    return row;
  }

  listLeaders(runtimeConfig) {
    const cfg = this.ensureConfig(runtimeConfig);
    return [...cfg.leaders].sort((a, b) => safeNum(b.score) - safeNum(a.score));
  }

  refreshLeaderStates(runtimeConfig) {
    const cfg = this.ensureConfig(runtimeConfig);
    const now = Date.now();

    for (const leader of cfg.leaders) {
      const cooldownUntil = leader.cooldownUntil ? Date.parse(leader.cooldownUntil) : 0;

      if (cooldownUntil && cooldownUntil > now) {
        leader.state = "cooldown";
      } else if (safeNum(leader.score) >= safeNum(cfg.minLeaderScore, 70) + 8) {
        leader.state = "active";
      } else if (safeNum(leader.score) >= safeNum(cfg.minLeaderScore, 70)) {
        leader.state = "watch";
      } else if (safeNum(leader.score) >= 40) {
        leader.state = "watch";
      } else {
        leader.state = "ignored";
      }

      leader.lastSyncAt = nowIso();
    }

    return cfg.leaders;
  }

  setLeaderScore(runtimeConfig, address, score) {
    const cfg = this.ensureConfig(runtimeConfig);
    const leader = cfg.leaders.find((x) => x.address === address);
    if (!leader) return null;

    leader.score = safeNum(score, leader.score);
    leader.lastSyncAt = nowIso();

    if (leader.score < safeNum(cfg.minLeaderScore, 70)) {
      const cooldownMin = safeNum(cfg.cooldownMinutes, 180);
      leader.cooldownUntil = new Date(Date.now() + cooldownMin * 60 * 1000).toISOString();
      leader.state = "cooldown";
    }

    return leader;
  }

  isLeaderTradable(runtimeConfig, address) {
    const cfg = this.ensureConfig(runtimeConfig);
    if (!cfg.enabled) return false;

    const leader = cfg.leaders.find((x) => x.address === address);
    if (!leader) return false;

    this.refreshLeaderStates(runtimeConfig);
    return leader.state === "active" || leader.state === "watch";
  }

  pickBestLeader(runtimeConfig) {
    const leaders = this.listLeaders(runtimeConfig);
    this.refreshLeaderStates(runtimeConfig);

    return leaders.find((x) => x.state === "active") ||
      leaders.find((x) => x.state === "watch") ||
      null;
  }
}
