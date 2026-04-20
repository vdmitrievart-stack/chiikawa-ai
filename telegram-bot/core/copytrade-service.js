export default class CopytradeService {
  constructor(options = {}) {
    this.copytradeManager = options.copytradeManager;
    this.gmgnLeaderIntel = options.gmgnLeaderIntel;
    this.logger = options.logger || console;
  }

  async syncLeaderScores(runtimeConfig) {
    const leaders = this.copytradeManager.listLeaders(runtimeConfig);
    if (!leaders.length) return [];

    const intel = await this.gmgnLeaderIntel.refreshMany(leaders.map((x) => x.address));
    for (const row of intel) {
      this.copytradeManager.setLeaderScore(runtimeConfig, row.address, row.score);
    }
    this.copytradeManager.refreshLeaderStates(runtimeConfig);
    return intel;
  }

  canTradeCopy(runtimeConfig) {
    const leaderEval = this.copytradeManager.pickBestLeader(runtimeConfig);
    if (!leaderEval) return false;
    return this.copytradeManager.isLeaderTradable(runtimeConfig, leaderEval.address);
  }

  buildCopytradeText(runtimeConfig) {
    const leaders = this.copytradeManager.listLeaders(runtimeConfig);
    const lines = ["📋 <b>Copytrade</b>", ""];
    lines.push(`enabled: ${runtimeConfig.copytrade.enabled ? "yes" : "no"}`);
    lines.push(`rescoring: ${runtimeConfig.copytrade.rescoringEnabled ? "yes" : "no"}`);
    lines.push(`min score: ${runtimeConfig.copytrade.minLeaderScore}`);
    lines.push(`cooldown min: ${runtimeConfig.copytrade.cooldownMinutes}`);
    lines.push("");

    if (!leaders.length) {
      lines.push("leaders: none");
    } else {
      for (const leader of leaders) {
        lines.push(
          `• <b>${leader.address}</b>
state: ${leader.state}
score: ${leader.score}
source: ${leader.source || "manual"}
last sync: ${leader.lastSyncAt || "-"}`
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

    const intel = await this.gmgnLeaderIntel.refreshMany(leaders.map((x) => x.address));
    const lines = ["🫀 <b>Leader Health</b>", ""];
    for (const row of intel) {
      lines.push(
        `• <b>${row.address}</b>
state: ${row.state}
score: ${row.score}
recent winrate: ${row.recentWinrate}%
recent pnl: ${row.recentPnlPct}%
max drawdown: ${row.maxDrawdownPct}%
source: ${row.source}
last sync: ${row.lastSyncAt}`
      );
      lines.push("");
    }
    return lines.join("\n");
  }

  buildGmgnStatusText() {
    const h = this.gmgnLeaderIntel.getHealth();
    return `🛰 <b>GMGN Status</b>

enabled: ${h.enabled ? "yes" : "no"}
mode: ${h.mode}
auto refresh sec: ${h.autoRefreshSec}
min recent winrate: ${h.minRecentWinrate}
min recent pnl pct: ${h.minRecentPnlPct}
max drawdown pct: ${h.maxLeaderDrawdownPct}
cooldown min: ${h.cooldownMin}
cached leaders: ${h.cachedLeaders}`;
  }
}
