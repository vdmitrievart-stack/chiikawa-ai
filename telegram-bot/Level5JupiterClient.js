export default class Level5JupiterClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || "https://api.jup.ag/swap/v2";
    this.apiKey = options.apiKey || process.env.JUP_API_KEY || "";
    this.fetchImpl = options.fetchImpl || fetch;
    this.defaultTimeoutMs = Number.isFinite(options.defaultTimeoutMs)
      ? options.defaultTimeoutMs
      : 15_000;
  }

  #headers(extra = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...extra
    };

    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    return headers;
  }

  async #request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.defaultTimeoutMs);

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method || "GET",
        headers: this.#headers(options.headers),
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(`Jupiter API ${path} failed: ${JSON.stringify(data)}`);
      }

      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getOrder({
    inputMint,
    outputMint,
    amount,
    taker,
    slippageBps = 100,
    swapMode = "ExactIn"
  }) {
    const qs = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amount),
      taker,
      swapMode,
      slippageBps: String(slippageBps)
    });

    return this.#request(`/order?${qs.toString()}`, {
      method: "GET"
    });
  }

  async executeOrder({
    requestId,
    signedTransaction
  }) {
    return this.#request("/execute", {
      method: "POST",
      body: {
        requestId,
        signedTransaction
      }
    });
  }
}
