import GMGNLeaderIntelService from "../gmgn/gmgn-leader-intel-service.js";

export default class CopytradeManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.gmgnLeaderIntel =
      options.gmgnLeaderIntel ||
      new GMGNLeaderIntelService({
        client: options.gmgnClient,
        logger: this.logger
      });
    this.copytradingService = options.copytradingService || null;
    this.walletRegistry = options.walletRegistry || null;
    this.cooldowns = new Map();
  }

  async evaluateLeader(address, runtimeConfig) {
    const intel = await this.gmgnLeaderIntel.getLeaderIntel(address);
    const cfg = runtimeConfig?.copytrade || {};
    const now = Date.now();
    const cooldown = this.cooldowns.get(address) || 0;

    let allowed = true;
    let reason = "leader_ok";

    if (cooldown > now) {
      allowed = false;
      reason = "leader_in_cooldown";
    } else if (intel.score < (cfg.minLeaderScore || 70)) {
      allowed = false;
      reason = "leader_score_too_low";
      this.cooldowns.set(address, now + (cfg.cooldownMinutes || 90) * 60 * 1000);
    } else if (intel.maxDrawdownPct > (cfg.maxLeaderDrawdownPct || 18)) {
      allowed = false;
      reason = "leader_drawdown_too_high";
      this.cooldowns.set(address, now + (cfg.cooldownMinutes || 90) * 60 * 1000);
    }

    return {
      ok: true,
      allowed,
      reason,
      intel
    };
  }

  async listSubscriptions() {
    if (!this.copytradingService?.listSubscriptions) return [];
    return this.copytradingService.listSubscriptions({});
  }

  async buildCandidates(runtimeConfig) {
    const subs = await this.listSubscriptions();
    const results = [];

    for (const sub of subs) {
      const leaderCheck = await this.evaluateLeader(sub.leaderAddress, runtimeConfig);
      results.push({ subscription: sub, leaderCheck });
    }

    return results;
  }
}
