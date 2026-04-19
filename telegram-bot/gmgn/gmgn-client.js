export default class GMGNClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.GMGN_API_BASE_URL || "";
    this.apiKey = options.apiKey || process.env.GMGN_API_KEY || "";
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 12000;
    this.logger = options.logger || console;
  }

  get enabled() {
    return Boolean(this.baseUrl);
  }

  async request(path, searchParams = {}) {
    if (!this.enabled) {
      return { ok: false, reason: "gmgn_not_configured" };
    }

    const url = new URL(path, this.baseUrl);
    Object.entries(searchParams || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        signal: controller.signal
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!res.ok) {
        return { ok: false, reason: `http_${res.status}`, data };
      }

      return { ok: true, data };
    } catch (error) {
      return { ok: false, reason: error.message || "gmgn_request_failed" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchLeaderStats(address) {
    return this.request("/leaders/stats", { address });
  }

  async fetchLeaderRecentTrades(address) {
    return this.request("/leaders/trades", { address, limit: 50 });
  }

  async searchHotWallets(chain = "solana") {
    return this.request("/wallets/hot", { chain });
  }

  async fetchTokenFlow(ca) {
    return this.request("/token/flow", { ca });
  }
}
