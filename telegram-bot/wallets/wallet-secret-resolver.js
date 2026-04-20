export default class WalletSecretResolver {
  constructor(options = {}) {
    this.logger = options.logger || console;
  }

  resolve(secretRef = "") {
    const ref = String(secretRef || "").trim();
    if (!ref) {
      return { ok: false, reason: "empty_secret_ref" };
    }

    if (!ref.startsWith("env:")) {
      return { ok: false, reason: "unsupported_secret_ref" };
    }

    const envName = ref.slice(4).trim();
    if (!envName) {
      return { ok: false, reason: "missing_env_name" };
    }

    const secret = process.env[envName] || "";
    if (!secret) {
      return { ok: false, reason: "env_secret_not_found", envName };
    }

    return {
      ok: true,
      secret,
      envName
    };
  }

  exists(secretRef = "") {
    const result = this.resolve(secretRef);
    return result.ok;
  }
}
