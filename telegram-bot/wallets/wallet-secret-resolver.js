export default class WalletSecretResolver {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.env = options.env || process.env;
    this.secretProviders = options.secretProviders || {};
  }

  resolve(secretRef = "") {
    const ref = String(secretRef || "").trim();
    if (!ref) {
      return { ok: false, reason: "missing_secret_ref" };
    }

    if (ref.startsWith("env:")) {
      const key = ref.slice(4);
      const value = this.env[key] || "";
      if (!value) return { ok: false, reason: `env_secret_missing:${key}` };
      return { ok: true, secret: value, source: `env:${key}` };
    }

    const provider = this.secretProviders[ref];
    if (typeof provider === "function") {
      try {
        const value = provider();
        if (!value) return { ok: false, reason: `provider_empty:${ref}` };
        return { ok: true, secret: value, source: `provider:${ref}` };
      } catch (error) {
        return { ok: false, reason: `provider_error:${error.message}` };
      }
    }

    return { ok: false, reason: `unsupported_secret_ref:${ref}` };
  }
}
