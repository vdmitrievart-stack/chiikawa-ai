import fs from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

export default class GMGNOrderStateStore {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseDir = options.baseDir || path.resolve("./runtime-data");
    this.filePath =
      options.filePath || path.join(this.baseDir, "gmgn-order-state-store.json");

    this.state = {
      orders: []
    };

    this.validStatuses = new Set([
      "created",
      "submitted",
      "filled",
      "partial",
      "failed",
      "cancelled"
    ]);

    this.validOperations = new Set([
      "open",
      "close",
      "partial"
    ]);
  }

  async ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  async load() {
    await this.ensureDir();

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      this.state = {
        orders: ensureArray(parsed?.orders)
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.log("gmgn order store load error:", error.message);
      }
      this.state = { orders: [] };
    }

    return this.getState();
  }

  async save() {
    await this.ensureDir();

    try {
      await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
      return true;
    } catch (error) {
      this.logger.log("gmgn order store save error:", error.message);
      return false;
    }
  }

  getState() {
    return clone(this.state);
  }

  listOrders() {
    return clone(this.state.orders || []);
  }

  listRecentOrders(limit = 20) {
    return this.listOrders()
      .sort((a, b) => {
        const at = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
        const bt = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
        return bt - at;
      })
      .slice(0, limit);
  }

  listOpenOrders() {
    return this.listOrders().filter((row) =>
      ["created", "submitted", "partial"].includes(asText(row?.status).toLowerCase())
    );
  }

  listOrdersByWallet(walletId) {
    const id = asText(walletId);
    return this.listOrders().filter((row) => asText(row?.walletId) === id);
  }

  listOrdersByStrategy(strategy) {
    const key = asText(strategy);
    return this.listOrders().filter((row) => asText(row?.strategy) === key);
  }

  listOrdersByTokenCa(tokenCa) {
    const ca = asText(tokenCa);
    return this.listOrders().filter((row) => asText(row?.token?.ca) === ca);
  }

  getOrderByOrderId(orderId) {
    const id = asText(orderId);
    return clone(
      (this.state.orders || []).find((row) => asText(row?.orderId) === id) || null
    );
  }

  getOrderByClientOrderId(clientOrderId) {
    const id = asText(clientOrderId);
    return clone(
      (this.state.orders || []).find((row) => asText(row?.clientOrderId) === id) || null
    );
  }

  findOrder({ orderId, clientOrderId }) {
    if (orderId) {
      const byOrderId = this.getOrderByOrderId(orderId);
      if (byOrderId) return byOrderId;
    }

    if (clientOrderId) {
      const byClientOrderId = this.getOrderByClientOrderId(clientOrderId);
      if (byClientOrderId) return byClientOrderId;
    }

    return null;
  }

  normalizeStatus(status) {
    const s = asText(status, "created").toLowerCase();
    return this.validStatuses.has(s) ? s : "created";
  }

  normalizeOperation(operation) {
    const op = asText(operation, "open").toLowerCase();
    return this.validOperations.has(op) ? op : "open";
  }

  buildStatusEvent(status, patch = {}) {
    return {
      status: this.normalizeStatus(status),
      at: nowIso(),
      reason: asText(patch.reason, ""),
      note: asText(patch.note, ""),
      filledPct: safeNum(patch.filledPct, 0),
      filledAmount: safeNum(patch.filledAmount, 0),
      filledValueUsd: safeNum(patch.filledValueUsd, 0),
      signature: asText(patch.signature, ""),
      raw: clone(patch.raw || null)
    };
  }

  normalizeOrder(input = {}) {
    const status = this.normalizeStatus(input.status || "created");
    const createdAt = asText(input.createdAt, nowIso());

    return {
      orderId: asText(input.orderId, ""),
      clientOrderId: asText(input.clientOrderId, ""),
      walletId: asText(input.walletId, ""),
      gmgnWalletId: asText(input.gmgnWalletId, ""),
      gmgnAccountId: asText(input.gmgnAccountId, ""),
      strategy: asText(input.strategy, ""),
      operation: this.normalizeOperation(input.operation || "open"),
      side: asText(input.side, ""),
      status,
      token: clone(input.token || {}),
      size: {
        amountSol: safeNum(input?.size?.amountSol, 0),
        amountUsd: safeNum(input?.size?.amountUsd, 0),
        tokenAmount: safeNum(input?.size?.tokenAmount, 0)
      },
      pricing: {
        expectedEntryPrice: safeNum(input?.pricing?.expectedEntryPrice, 0),
        executedEntryPrice: safeNum(input?.pricing?.executedEntryPrice, 0),
        expectedExitPrice: safeNum(input?.pricing?.expectedExitPrice, 0),
        executedExitPrice: safeNum(input?.pricing?.executedExitPrice, 0),
        slippagePct: safeNum(input?.pricing?.slippagePct, 0)
      },
      metrics: {
        pnlHintPct: safeNum(input?.metrics?.pnlHintPct, 0),
        pnlHintSol: safeNum(input?.metrics?.pnlHintSol, 0),
        soldFraction: safeNum(input?.metrics?.soldFraction, 0)
      },
      source: asText(input.source, "gmgn"),
      mode: asText(input.mode, "live"),
      note: asText(input.note, ""),
      reason: asText(input.reason, ""),
      signature: asText(input.signature, ""),
      createdAt,
      updatedAt: asText(input.updatedAt, createdAt),
      history: ensureArray(input.history),
      raw: clone(input.raw || null)
    };
  }

  async createOrder(input = {}) {
    const normalized = this.normalizeOrder(input);

    if (!normalized.orderId && !normalized.clientOrderId) {
      throw new Error("createOrder requires orderId or clientOrderId");
    }

    const existing = this.findOrder({
      orderId: normalized.orderId,
      clientOrderId: normalized.clientOrderId
    });

    if (existing) {
      return this.upsertOrder(normalized);
    }

    if (!normalized.history.length) {
      normalized.history.push(
        this.buildStatusEvent(normalized.status, {
          reason: normalized.reason,
          note: normalized.note,
          signature: normalized.signature,
          raw: normalized.raw
        })
      );
    }

    this.state.orders.push(normalized);
    await this.save();

    return this.findOrder({
      orderId: normalized.orderId,
      clientOrderId: normalized.clientOrderId
    });
  }

  async upsertOrder(input = {}) {
    const normalized = this.normalizeOrder(input);

    if (!normalized.orderId && !normalized.clientOrderId) {
      throw new Error("upsertOrder requires orderId or clientOrderId");
    }

    const idx = (this.state.orders || []).findIndex(
      (row) =>
        (normalized.orderId && asText(row?.orderId) === normalized.orderId) ||
        (normalized.clientOrderId &&
          asText(row?.clientOrderId) === normalized.clientOrderId)
    );

    if (idx === -1) {
      return this.createOrder(normalized);
    }

    const prev = this.state.orders[idx];
    const next = {
      ...prev,
      ...normalized,
      token: { ...(prev.token || {}), ...(normalized.token || {}) },
      size: { ...(prev.size || {}), ...(normalized.size || {}) },
      pricing: { ...(prev.pricing || {}), ...(normalized.pricing || {}) },
      metrics: { ...(prev.metrics || {}), ...(normalized.metrics || {}) },
      updatedAt: nowIso()
    };

    const prevHistory = ensureArray(prev.history);
    const nextHistory = ensureArray(normalized.history);

    next.history = [...prevHistory, ...nextHistory];

    this.state.orders[idx] = next;
    await this.save();

    return this.findOrder({
      orderId: next.orderId,
      clientOrderId: next.clientOrderId
    });
  }

  async setStatus(identifier = {}, status, patch = {}) {
    const target = this.findOrder(identifier);
    if (!target) return null;

    const nextStatus = this.normalizeStatus(status);

    const idx = (this.state.orders || []).findIndex(
      (row) =>
        (target.orderId && asText(row?.orderId) === asText(target.orderId)) ||
        (target.clientOrderId &&
          asText(row?.clientOrderId) === asText(target.clientOrderId))
    );

    if (idx === -1) return null;

    const row = this.state.orders[idx];
    const history = ensureArray(row.history);

    history.push(this.buildStatusEvent(nextStatus, patch));

    row.status = nextStatus;
    row.updatedAt = nowIso();

    if (patch.operation != null) row.operation = this.normalizeOperation(patch.operation);
    if (patch.reason != null) row.reason = asText(patch.reason, row.reason || "");
    if (patch.note != null) row.note = asText(patch.note, row.note || "");
    if (patch.signature != null) row.signature = asText(patch.signature, row.signature || "");

    if (patch.token) {
      row.token = { ...(row.token || {}), ...clone(patch.token) };
    }

    if (patch.size) {
      row.size = {
        ...(row.size || {}),
        amountSol:
          patch.size.amountSol != null
            ? safeNum(patch.size.amountSol, 0)
            : safeNum(row?.size?.amountSol, 0),
        amountUsd:
          patch.size.amountUsd != null
            ? safeNum(patch.size.amountUsd, 0)
            : safeNum(row?.size?.amountUsd, 0),
        tokenAmount:
          patch.size.tokenAmount != null
            ? safeNum(patch.size.tokenAmount, 0)
            : safeNum(row?.size?.tokenAmount, 0)
      };
    }

    if (patch.pricing) {
      row.pricing = {
        ...(row.pricing || {}),
        expectedEntryPrice:
          patch.pricing.expectedEntryPrice != null
            ? safeNum(patch.pricing.expectedEntryPrice, 0)
            : safeNum(row?.pricing?.expectedEntryPrice, 0),
        executedEntryPrice:
          patch.pricing.executedEntryPrice != null
            ? safeNum(patch.pricing.executedEntryPrice, 0)
            : safeNum(row?.pricing?.executedEntryPrice, 0),
        expectedExitPrice:
          patch.pricing.expectedExitPrice != null
            ? safeNum(patch.pricing.expectedExitPrice, 0)
            : safeNum(row?.pricing?.expectedExitPrice, 0),
        executedExitPrice:
          patch.pricing.executedExitPrice != null
            ? safeNum(patch.pricing.executedExitPrice, 0)
            : safeNum(row?.pricing?.executedExitPrice, 0),
        slippagePct:
          patch.pricing.slippagePct != null
            ? safeNum(patch.pricing.slippagePct, 0)
            : safeNum(row?.pricing?.slippagePct, 0)
      };
    }

    if (patch.metrics) {
      row.metrics = {
        ...(row.metrics || {}),
        pnlHintPct:
          patch.metrics.pnlHintPct != null
            ? safeNum(patch.metrics.pnlHintPct, 0)
            : safeNum(row?.metrics?.pnlHintPct, 0),
        pnlHintSol:
          patch.metrics.pnlHintSol != null
            ? safeNum(patch.metrics.pnlHintSol, 0)
            : safeNum(row?.metrics?.pnlHintSol, 0),
        soldFraction:
          patch.metrics.soldFraction != null
            ? safeNum(patch.metrics.soldFraction, 0)
            : safeNum(row?.metrics?.soldFraction, 0)
      };
    }

    if (patch.raw != null) {
      row.raw = clone(patch.raw);
    }

    row.history = history;

    await this.save();

    return this.findOrder({
      orderId: row.orderId,
      clientOrderId: row.clientOrderId
    });
  }

  async markSubmitted(identifier = {}, patch = {}) {
    return this.setStatus(identifier, "submitted", patch);
  }

  async markFilled(identifier = {}, patch = {}) {
    return this.setStatus(identifier, "filled", patch);
  }

  async markPartial(identifier = {}, patch = {}) {
    return this.setStatus(identifier, "partial", patch);
  }

  async markFailed(identifier = {}, patch = {}) {
    return this.setStatus(identifier, "failed", patch);
  }

  async markCancelled(identifier = {}, patch = {}) {
    return this.setStatus(identifier, "cancelled", patch);
  }

  countByStatus() {
    const counters = {
      created: 0,
      submitted: 0,
      filled: 0,
      partial: 0,
      failed: 0,
      cancelled: 0
    };

    for (const row of this.state.orders || []) {
      const s = this.normalizeStatus(row?.status);
      counters[s] += 1;
    }

    return counters;
  }

  countByOperation() {
    const counters = {
      open: 0,
      close: 0,
      partial: 0
    };

    for (const row of this.state.orders || []) {
      const op = this.normalizeOperation(row?.operation);
      counters[op] += 1;
    }

    return counters;
  }

  buildOrdersText(limit = 15, runtimeConfig = {}) {
    const rows = this.listRecentOrders(limit);
    const isRu = String(runtimeConfig?.language || "en").toLowerCase().startsWith("ru");

    if (!rows.length) {
      return isRu
        ? `📦 <b>GMGN-ордера</b>

нет ордеров`
        : `📦 <b>GMGN Orders</b>

none`;
    }

    const lines = [isRu ? "📦 <b>GMGN-ордера</b>" : "📦 <b>GMGN Orders</b>", ""];

    for (const row of rows) {
      lines.push(
        isRu
          ? `• <b>${asText(row.clientOrderId || row.orderId, "-")}</b>
Операция: ${asText(row.operation, "-")}
Статус: <b>${asText(row.status, "-")}</b>
Кошелёк: ${asText(row.walletId, "-")}
GMGN wallet ID: ${asText(row.gmgnWalletId, "-")}
Стратегия: ${asText(row.strategy, "-")}
Сторона: ${asText(row.side, "-")}
Токен: ${asText(row?.token?.name || row?.token?.ca, "-")}
Размер SOL: ${safeNum(row?.size?.amountSol, 0)}
Размер токена: ${safeNum(row?.size?.tokenAmount, 0)}
Ожидаемый вход: ${safeNum(row?.pricing?.expectedEntryPrice, 0)}
Фактический вход: ${safeNum(row?.pricing?.executedEntryPrice, 0)}
Ожидаемый выход: ${safeNum(row?.pricing?.expectedExitPrice, 0)}
Фактический выход: ${safeNum(row?.pricing?.executedExitPrice, 0)}
PnL hint %: ${safeNum(row?.metrics?.pnlHintPct, 0)}
PnL hint SOL: ${safeNum(row?.metrics?.pnlHintSol, 0)}
Доля продажи: ${safeNum(row?.metrics?.soldFraction, 0)}
Заметка: ${asText(row.note, "-")}
Обновлено: ${asText(row.updatedAt, "-")}`
          : `• <b>${asText(row.clientOrderId || row.orderId, "-")}</b>
operation: ${asText(row.operation, "-")}
status: ${asText(row.status, "-")}
wallet: ${asText(row.walletId, "-")}
gmgnWalletId: ${asText(row.gmgnWalletId, "-")}
strategy: ${asText(row.strategy, "-")}
side: ${asText(row.side, "-")}
token: ${asText(row?.token?.name || row?.token?.ca, "-")}
amountSol: ${safeNum(row?.size?.amountSol, 0)}
tokenAmount: ${safeNum(row?.size?.tokenAmount, 0)}
expectedEntry: ${safeNum(row?.pricing?.expectedEntryPrice, 0)}
executedEntry: ${safeNum(row?.pricing?.executedEntryPrice, 0)}
expectedExit: ${safeNum(row?.pricing?.expectedExitPrice, 0)}
executedExit: ${safeNum(row?.pricing?.executedExitPrice, 0)}
pnlHintPct: ${safeNum(row?.metrics?.pnlHintPct, 0)}
pnlHintSol: ${safeNum(row?.metrics?.pnlHintSol, 0)}
soldFraction: ${safeNum(row?.metrics?.soldFraction, 0)}
note: ${asText(row.note, "-")}
updatedAt: ${asText(row.updatedAt, "-")}`
      );
      lines.push("");
    }

    return lines.join("\n");
  }
}
