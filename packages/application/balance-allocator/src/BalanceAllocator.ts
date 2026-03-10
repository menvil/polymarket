/**
 * BalanceAllocator — распределение торгового баланса по рынкам.
 *
 * @remarks
 * ### Ответственность:
 * - Отслеживание общего торгового баланса
 * - Равномерная аллокация свободного баланса на новые рынки
 * - Освобождение аллокации с компаундированием реализованного PnL
 * - Проверка доступных слотов
 *
 * ### Архитектура:
 * BalanceAllocator реализует `IBalanceAllocator` из `@polymarket/ports`.
 * Хранит состояние в памяти. Не является персистентным — при рестарте
 * состояние восстанавливается через coordinator из источника истины (биржа/БД).
 *
 * ### Алгоритм аллокации `allocateToNewMarkets(marketIds)`:
 * 1. `tradingBalance = totalBalance * tradingBalanceRatio`
 * 2. `freeBalance = tradingBalance - sum(allocations.values())`
 * 3. `newMarkets = marketIds фильтр (не в allocations)`
 * 4. `availableSlots = maxConcurrentMarkets - allocations.size`
 * 5. `newSlots = min(newMarkets.length, availableSlots)`
 * 6. `newSlots = min(newSlots, floor(freeBalance / minCapital))`
 * 7. `perMarket = freeBalance / newSlots`
 * 8. Если `perMarket < minCapital` → return `[]`
 * 9. Аллоцировать первые `newSlots` рынков
 *
 * ### Компаундирование PnL `releaseWithPnL(marketId, pnl)`:
 * `_totalBalance += pnl.value()` — прибыль увеличивает баланс для реинвестирования,
 * убыток уменьшает для автоматического de-leveraging.
 *
 * @example
 * ```typescript
 * const allocator = new BalanceAllocator({
 *   tradingBalanceRatio: 0.8,
 *   minCapitalPerMarket: Money.of(new Decimal(50), 'USDC'),
 *   maxConcurrentMarkets: 10,
 * });
 *
 * allocator.updateTotalBalance(Money.of(new Decimal(10000), 'USDC'));
 * const results = allocator.allocateToNewMarkets(['mkt-1', 'mkt-2', 'mkt-3']);
 * // results.length = 3, каждый получил ≈ $2666
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { MarketId } from '@polymarket/ids';
import { Money, MoneyService } from '@polymarket/value-objects';
import type {
  IBalanceAllocator,
  AllocationResult,
  AllocationStats,
} from '@polymarket/ports';
import type { BalanceAllocatorConfig } from './BalanceAllocatorConfig.js';

/**
 * Реализация IBalanceAllocator.
 *
 * @remarks
 * Распределяет торговый баланс равномерно по рынкам.
 * Thread-safe только в single-threaded Node.js окружении.
 */
export class BalanceAllocator implements IBalanceAllocator {
  /** Общий баланс аккаунта (включая зарезервированные и свободные средства) */
  private _totalBalance: Money;
  /** Текущие аллокации: marketId → аллоцированная сумма */
  private readonly _allocations = new Map<string, Money>();
  /** Конфигурация аллокатора */
  private readonly _config: BalanceAllocatorConfig;

  /**
   * @param config - Конфигурация параметров аллокации
   * @param initialBalance - Начальный баланс (по умолчанию 0 USDC)
   */
  constructor(
    config: BalanceAllocatorConfig,
    initialBalance: Money = Money.ZERO['USDC'],
  ) {
    this._config = config;
    this._totalBalance = initialBalance;
  }

  /**
   * Аллоцирует свободный баланс на несколько новых рынков.
   *
   * @param marketIds - Список рынков для аллокации
   * @returns Массив AllocationResult. Пустой если нет слотов или средств.
   *
   * @remarks
   * Рынки, уже имеющие аллокацию, пропускаются.
   */
  public allocateToNewMarkets(marketIds: readonly MarketId[]): AllocationResult[] {
    // Фильтруем уже аллоцированные рынки
    const newMarkets = marketIds.filter(
      (id) => !this._allocations.has(String(id)),
    );

    if (newMarkets.length === 0) return [];

    const tradingBalance = this._calcTradingBalance();
    const freeBalance = this._calcFreeBalance(tradingBalance);
    const availableSlots = this._config.maxConcurrentMarkets - this._allocations.size;

    let newSlots = Math.min(newMarkets.length, availableSlots);
    if (newSlots <= 0) return [];

    // Ограничиваем количество слотов доступными средствами
    // Используем Decimal.floor() для точного целочисленного деления без потери точности
    const minCapital = this._config.minCapitalPerMarket.value();
    const freeBalanceDec = freeBalance.value();
    const maxByCapital = freeBalanceDec.isPositive()
      ? freeBalanceDec.div(minCapital).floor().toNumber()
      : 0;
    newSlots = Math.min(newSlots, maxByCapital);

    if (newSlots <= 0) return [];

    // Равномерное распределение по всем доступным слотам (не только по newSlots),
    // чтобы последующие вызовы тоже могли получить аллокацию
    const denominator = Math.max(newSlots, availableSlots);
    const perMarketResult = MoneyService.divide(freeBalance, denominator);
    if (!perMarketResult.ok) return [];
    const perMarket = perMarketResult.value;

    // Проверка минимальной аллокации
    if (perMarket.value().lessThan(minCapital)) return [];

    // Аллоцировать первые newSlots рынков
    const results: AllocationResult[] = [];
    for (let i = 0; i < newSlots; i++) {
      const marketId = newMarkets[i];
      this._allocations.set(String(marketId), perMarket);
      results.push({ marketId, allocatedAmount: perMarket });
    }

    return results;
  }

  /**
   * Добавляет один рынок и аллоцирует ему баланс.
   *
   * @param marketId - ID рынка
   * @returns Ok(AllocationResult) при успехе, Err если нет слотов или средств
   */
  public addMarket(marketId: MarketId): Result<AllocationResult, TradingError> {
    if (!this.canAddMarket()) {
      return Err(new TradingError(
        'Cannot add market: no available slots or insufficient balance',
        { context: { marketId: String(marketId), stats: this.getStats() } },
      ));
    }

    const results = this.allocateToNewMarkets([marketId]);
    if (results.length === 0) {
      return Err(new TradingError(
        'Cannot allocate balance to market: insufficient free balance',
        { context: { marketId: String(marketId) } },
      ));
    }

    return Ok(results[0]);
  }

  /**
   * Освобождает аллокацию и компаундирует PnL в общий баланс.
   *
   * @param marketId - ID рынка
   * @param realizedPnL - Реализованный PnL (может быть отрицательным)
   *
   * @remarks
   * `_totalBalance += realizedPnL` — автоматическое compounding.
   */
  public releaseWithPnL(marketId: MarketId, realizedPnL: Money): void {
    this._allocations.delete(String(marketId));

    // Компаундирование PnL: totalBalance += pnl
    const addResult = MoneyService.add(this._totalBalance, realizedPnL);
    if (addResult.ok) {
      this._totalBalance = addResult.value;
    }
    // При ошибке (разные валюты) — игнорируем PnL, не обновляем баланс
  }

  /**
   * Освобождает аллокацию без компаундирования PnL.
   *
   * @param marketId - ID рынка
   */
  public release(marketId: MarketId): void {
    this._allocations.delete(String(marketId));
  }

  /**
   * Возвращает текущую аллокацию для рынка.
   *
   * @param marketId - ID рынка
   * @returns Аллоцированная сумма или undefined
   */
  public getAllocation(marketId: MarketId): Money | undefined {
    return this._allocations.get(String(marketId));
  }

  /**
   * Обновляет общий баланс.
   *
   * @param newBalance - Новый общий баланс в USDC
   */
  public updateTotalBalance(newBalance: Money): void {
    this._totalBalance = newBalance;
  }

  /**
   * Проверяет, можно ли добавить ещё один рынок.
   *
   * @returns true если есть свободные слоты и достаточно средств
   */
  public canAddMarket(): boolean {
    const hasSlots = this._allocations.size < this._config.maxConcurrentMarkets;
    if (!hasSlots) return false;

    const tradingBalance = this._calcTradingBalance();
    const freeBalance = this._calcFreeBalance(tradingBalance);
    return freeBalance.value().greaterThanOrEqualTo(
      this._config.minCapitalPerMarket.value(),
    );
  }

  /**
   * Возвращает текущую статистику аллокатора.
   *
   * @returns AllocationStats снимок состояния
   */
  public getStats(): AllocationStats {
    const tradingBalance = this._calcTradingBalance();
    const allocatedBalance = this._calcAllocatedBalance();
    const freeBalance = this._calcFreeBalance(tradingBalance);

    const tradingValue = tradingBalance.value();
    const utilization = tradingValue.isZero()
      ? 0
      : allocatedBalance.value().div(tradingValue).toNumber();

    return {
      totalBalance: this._totalBalance,
      tradingBalance,
      allocatedBalance,
      freeBalance,
      utilization,
      activeMarkets: this._allocations.size,
      availableSlots: Math.max(0, this._config.maxConcurrentMarkets - this._allocations.size),
    };
  }

  // ── Приватные вспомогательные методы ─────────────────────────────────────

  /**
   * Вычисляет торговый баланс: totalBalance * tradingBalanceRatio.
   */
  private _calcTradingBalance(): Money {
    const result = MoneyService.multiply(
      this._totalBalance,
      this._config.tradingBalanceRatio,
    );
    return result.ok ? result.value : Money.ZERO['USDC'];
  }

  /**
   * Вычисляет сумму всех аллокаций.
   */
  private _calcAllocatedBalance(): Money {
    let total = Money.ZERO['USDC'];
    for (const allocation of this._allocations.values()) {
      const addResult = MoneyService.add(total, allocation);
      if (addResult.ok) total = addResult.value;
    }
    return total;
  }

  /**
   * Вычисляет свободный баланс: tradingBalance - allocatedBalance.
   */
  private _calcFreeBalance(tradingBalance: Money): Money {
    const allocated = this._calcAllocatedBalance();
    const result = MoneyService.subtract(tradingBalance, allocated);
    // Если результат отрицательный — возвращаем 0 (over-allocated state)
    if (!result.ok || result.value.isNegative()) return Money.ZERO['USDC'];
    return result.value;
  }
}
