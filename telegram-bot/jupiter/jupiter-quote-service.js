function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default class JupiterQuoteService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseUrl = options.baseUrl || process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";
    this.mockMode = options.mockMode ?? (process.env.JUPITER_MOCK_MODE !== "false");
    this.defaultSlippageBps = safeNum(process.env.JUPITER_DEFAULT_SLIPPAGE_BPS, 100);
    this.solMint = "So11111111111111111111111111111111111111112";
  }

  uiAmountToLamports(solAmount) {
    return Math.round(safeNum(solAmount) * 1_000_000_000);
  }

  async getSwapQuote({
    inputMint,
    outputMint,
    amount,
    slippageBps
  }) {
    if (this.mockMode) {
      return this.buildMockQuote({
        inputMint,
        outputMint,
        amount,
        slippageBps
      });
    }

    const url = new URL("/v6/quote", this.baseUrl);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", String(amount));
    url.searchParams.set("slippageBps", String(slippageBps || this.defaultSlippageBps));

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Jupiter quote HTTP ${res.status}`);
    }

    return res.json();
  }

  async buildSwapPayload({
    quoteResponse,
    userPublicKey
  }) {
    if (this.mockMode) {
      return {
        swapTransaction: null,
        lastValidBlockHeight: null,
        prioritizationFeeLamports: 0,
        simulationError: null,
        mode: "mock"
      };
    }

    const res = await fetch(new URL("/v6/swap", this.baseUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true
      })
    });

    if (!res.ok) {
      throw new Error(`Jupiter swap HTTP ${res.status}`);
    }

    return res.json();
  }

  async buildOpenSwapPlan({
    tokenMint,
    amountSol,
    userPublicKey,
    slippageBps
  }) {
    const amount = this.uiAmountToLamports(amountSol);

    const quote = await this.getSwapQuote({
      inputMint: this.solMint,
      outputMint: tokenMint,
      amount,
      slippageBps: slippageBps || this.defaultSlippageBps
    });

    const swapPayload = await this.buildSwapPayload({
      quoteResponse: quote,
      userPublicKey
    });

    return {
      side: "BUY",
      quote,
      swapPayload
    };
  }

  async buildCloseSwapPlan({
    tokenMint,
    amountRaw,
    userPublicKey,
    slippageBps
  }) {
    const quote = await this.getSwapQuote({
      inputMint: tokenMint,
      outputMint: this.solMint,
      amount: amountRaw,
      slippageBps: slippageBps || this.defaultSlippageBps
    });

    const swapPayload = await this.buildSwapPayload({
      quoteResponse: quote,
      userPublicKey
    });

    return {
      side: "SELL",
      quote,
      swapPayload
    };
  }

  buildMockQuote({ inputMint, outputMint, amount, slippageBps }) {
    return {
      inputMint,
      outputMint,
      inAmount: String(amount),
      outAmount: String(Math.max(1, Math.floor(safeNum(amount) * 0.97))),
      otherAmountThreshold: String(Math.max(1, Math.floor(safeNum(amount) * 0.95))),
      swapMode: "ExactIn",
      slippageBps: safeNum(slippageBps, this.defaultSlippageBps),
      priceImpactPct: "0.25",
      routePlan: [
        {
          swapInfo: {
            ammKey: "mock-amm",
            label: "mock-jupiter-route",
            inputMint,
            outputMint,
            inAmount: String(amount),
            outAmount: String(Math.max(1, Math.floor(safeNum(amount) * 0.97))),
            feeAmount: "1000",
            feeMint: inputMint
          },
          percent: 100
        }
      ],
      contextSlot: 0,
      timeTaken: 0.01,
      mode: "mock"
    };
  }
}
