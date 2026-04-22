import TradingKernel from './trading-kernel.js';
import BotRouter from './bot-router.js';
import NotificationService from './notification-service.js';
import {
  getPortfolio,
  getStrategyConfig,
  hydratePortfolioSnapshot,
} from '../portfolio.js';

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fmtSol(v, digits = 4) {
  return `${safeNum(v, 0).toFixed(digits)} SOL`;
}

function withVirtualBase(text, portfolio) {
  const virtualBase = safeNum(portfolio?.startBalance, 0);
  if (!text || typeof text !== 'string') return text;
  if (text.includes('Virtual base:')) return text;
  return text.replace(/^(💰 <b>BALANCE<\/b>|📊 <b>STATUS<\/b>)/, `$1\n\n<b>Virtual base:</b> ${fmtSol(virtualBase)}`);
}

function normalizeNoCandidateText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(
      /Пока не вижу нормального кандидата\.[\s\S]*?GMGN-first сигнал\./g,
      'Пока не вижу нормального кандидата. Продолжаю сканировать рынок.'
    )
    .replace(
      /Пока не вижу нормального кандидата\. Фильтры активны, жду что-то живое\./g,
      'Пока не вижу нормального кандидата. Продолжаю сканировать рынок.'
    );
}

export function applyRuntimeHotfixes() {
  if (globalThis.__CHIIKAWA_RUNTIME_HOTFIX_APPLIED__) return;
  globalThis.__CHIIKAWA_RUNTIME_HOTFIX_APPLIED__ = true;

  const originalKernelStart = TradingKernel.prototype.start;
  TradingKernel.prototype.start = function patchedStart(strategyScope = 'all', mode = 'infinite', chatId = null, userId = null) {
    const before = clone(getPortfolio());
    const runtime = originalKernelStart.call(this, strategyScope, mode, chatId, userId);

    if (before && Array.isArray(before.positions) && Array.isArray(before.closedTrades)) {
      try {
        hydratePortfolioSnapshot({ portfolio: before }, getStrategyConfig(), safeNum(before.startBalance, this.startBalanceSol || 10));
      } catch (error) {
        this.logger?.log?.('hotfix start rehydrate error:', error?.message || error);
      }
    }

    void this.persistSnapshot?.();
    return runtime;
  };

  TradingKernel.prototype.addVirtualBalance = async function addVirtualBalance(amountSol) {
    const amount = Math.max(0, safeNum(amountSol, 0));
    if (amount <= 0) {
      return { ok: false, reason: 'INVALID_AMOUNT', portfolio: getPortfolio() };
    }

    const current = clone(getPortfolio());
    const next = {
      ...current,
      startBalance: safeNum(current.startBalance, 0) + amount,
      cash: safeNum(current.cash, 0) + amount,
    };

    hydratePortfolioSnapshot({ portfolio: next }, getStrategyConfig(), next.startBalance);
    await this.persistSnapshot?.();
    return { ok: true, amount, portfolio: getPortfolio() };
  };

  TradingKernel.prototype.withdrawVirtualBalance = async function withdrawVirtualBalance(amountSol) {
    const amount = Math.max(0, safeNum(amountSol, 0));
    if (amount <= 0) {
      return { ok: false, reason: 'INVALID_AMOUNT', portfolio: getPortfolio() };
    }

    const current = clone(getPortfolio());
    const freeCash = Math.max(0, safeNum(current.cash, 0));
    const applied = Math.min(amount, freeCash);
    if (applied <= 0) {
      return { ok: false, reason: 'NO_FREE_CASH', portfolio: current };
    }

    const next = {
      ...current,
      startBalance: Math.max(0, safeNum(current.startBalance, 0) - applied),
      cash: Math.max(0, safeNum(current.cash, 0) - applied),
    };

    hydratePortfolioSnapshot({ portfolio: next }, getStrategyConfig(), next.startBalance);
    await this.persistSnapshot?.();
    return { ok: true, amount: applied, requested: amount, portfolio: getPortfolio() };
  };

  const originalBuildBalanceText = TradingKernel.prototype.buildBalanceText;
  TradingKernel.prototype.buildBalanceText = function patchedBuildBalanceText() {
    return withVirtualBase(originalBuildBalanceText.call(this), getPortfolio());
  };

  const originalBuildStatusText = TradingKernel.prototype.buildStatusText;
  TradingKernel.prototype.buildStatusText = function patchedBuildStatusText() {
    return withVirtualBase(originalBuildStatusText.call(this), getPortfolio());
  };

  const originalCanEmitNotice = TradingKernel.prototype.canEmitNotice;
  TradingKernel.prototype.canEmitNotice = function patchedCanEmitNotice(key, cooldownMs = 15 * 60 * 1000) {
    const keyText = String(key || '');
    if (keyText.includes('no_candidate')) {
      cooldownMs = Math.max(cooldownMs, 20 * 60 * 1000);
    }
    return originalCanEmitNotice.call(this, key, cooldownMs);
  };

  const originalNotificationSendText = NotificationService.prototype.sendText;
  NotificationService.prototype.sendText = async function patchedNotificationSendText(text, extra = {}) {
    return originalNotificationSendText.call(this, normalizeNoCandidateText(text), extra);
  };

  const originalKeyboard = BotRouter.prototype.keyboard;
  BotRouter.prototype.keyboard = function patchedKeyboard() {
    const base = originalKeyboard.call(this) || { keyboard: [] };
    const rows = Array.isArray(base.keyboard) ? [...base.keyboard] : [];
    const hasButtons = rows.some(
      (row) => Array.isArray(row) && row.includes('➕ Add Balance') && row.includes('➖ Withdraw Balance')
    );
    if (!hasButtons) {
      rows.splice(Math.max(0, rows.length - 2), 0, ['➕ Add Balance', '➖ Withdraw Balance']);
    }
    return { ...base, keyboard: rows };
  };

  const originalHandleMessage = BotRouter.prototype.handleMessage;
  BotRouter.prototype.handleMessage = async function patchedHandleMessage(msg) {
    const chatId = msg?.chat?.id;
    const text = String(msg?.text || '').trim();
    const lower = text.toLowerCase();

    if (chatId != null) {
      const mode = this.getChatMode(chatId);
      if (mode?.mode === 'awaiting_add_balance') {
        const amount = safeNum(text, NaN);
        if (!Number.isFinite(amount) || amount <= 0) {
          await this.sendMessage(chatId, 'Введите положительную сумму в SOL, например <code>2.5</code>.', {
            reply_markup: this.keyboard(),
          });
          return;
        }
        this.clearChatMode(chatId);
        const result = await this.kernel.addVirtualBalance(amount);
        await this.sendMessage(
          chatId,
          `✅ <b>Виртуальный баланс пополнен</b>\n\nДобавлено: ${fmtSol(result.amount)}\nVirtual base: ${fmtSol(result.portfolio?.startBalance)}\nFree cash: ${fmtSol(result.portfolio?.cash)}\nEquity: ${fmtSol(result.portfolio?.equity)}`,
          { reply_markup: this.keyboard() }
        );
        return;
      }

      if (mode?.mode === 'awaiting_withdraw_balance') {
        const amount = safeNum(text, NaN);
        if (!Number.isFinite(amount) || amount <= 0) {
          await this.sendMessage(chatId, 'Введите положительную сумму в SOL, например <code>1.2</code>.', {
            reply_markup: this.keyboard(),
          });
          return;
        }
        this.clearChatMode(chatId);
        const result = await this.kernel.withdrawVirtualBalance(amount);
        if (!result.ok) {
          const message = result.reason === 'NO_FREE_CASH'
            ? 'Недостаточно свободного кэша для вывода из симуляции.'
            : 'Не удалось уменьшить виртуальный баланс.';
          await this.sendMessage(chatId, `⚠️ ${message}`, { reply_markup: this.keyboard() });
          return;
        }
        await this.sendMessage(
          chatId,
          `✅ <b>Виртуальный баланс уменьшен</b>\n\nСписано: ${fmtSol(result.amount)}\nVirtual base: ${fmtSol(result.portfolio?.startBalance)}\nFree cash: ${fmtSol(result.portfolio?.cash)}\nEquity: ${fmtSol(result.portfolio?.equity)}`,
          { reply_markup: this.keyboard() }
        );
        return;
      }
    }

    if (
      lower === '➕ add balance'.toLowerCase() ||
      lower === '/addbalance' ||
      lower === 'add balance' ||
      lower === 'пополнить баланс'
    ) {
      this.setChatMode(chatId, 'awaiting_add_balance');
      await this.sendMessage(chatId, 'Введите сумму пополнения в SOL, например <code>2.5</code>.', {
        reply_markup: this.keyboard(),
      });
      return;
    }

    if (
      lower === '➖ withdraw balance'.toLowerCase() ||
      lower === '/withdrawbalance' ||
      lower === 'withdraw balance' ||
      lower === 'вывести баланс'
    ) {
      this.setChatMode(chatId, 'awaiting_withdraw_balance');
      await this.sendMessage(chatId, 'Введите сумму вывода в SOL, например <code>1.2</code>.', {
        reply_markup: this.keyboard(),
      });
      return;
    }

    return originalHandleMessage.call(this, msg);
  };
}
