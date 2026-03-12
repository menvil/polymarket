/**
 * BalanceAllocator — распределение торгового баланса по рынкам.
 *
 * @remarks
 * ### Ответственность:
 * - Отслеживание общего торгового баланса
 * - Равномерная аллокация свободного баланса на новые рынки
 * - Освобождение аллокации с компаундированием реализованного PnL
 * - Восстановление состояния после рестарта (restoreAllocations)
 *
 * ### Архитектура:
 * Stateful coordinator — хранит state аллокаций в памяти.
 * Не персистентен: при рестарте состояние восстанавливается через `restoreAllocations(snapshot)`.
 *
 * ### Алгоритм аллокации `allocateToNewMarkets(marketIds)`:
 * 1. `tradingBalance = totalBalance * tradingBalanceRatio`
 * 2. `freeBalance = tradingBalance - sum(allocations.values())`
 * 3. `newMarkets = deduplicate(marketIds).filter(не в allocations)`
 * 4. `availableSlots = maxConcurrentMarkets - allocations.size`
 * 5. `newSlots = min(newMarkets.length, availableSlots)`
 * 6. `newSlots = min(newSlots, floor(freeBalance / minCapital))`
 * 7. `perMarket = freeBalance / max(newSlots, availableSlots)`
 *    — делим на все доступные слоты, резервируя капитал для будущих аллокаций
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
 *   tradingBalanceRatio: Ratio.of(new Decimal('0.8')),
 *   minCapitalPerMarket: Money.of(new Decimal(50), 'USDC'),
 *   maxConcurrentMarkets: 10,
 * });
 *
 * allocator.updateTotalBalance(Money.of(new Decimal(10000), 'USDC'));
 * const results = allocator.allocateToNewMarkets(['mkt-1', 'mkt-2', 'mkt-3']);
 * // results.length = 3, каждый получил ≈ $800 (8000/10)
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { MarketId } from '@polymarket/ids';
import { Money, MoneyService } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
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
 * Использует `MarketId` как ключ Map напрямую (branded string, без String() конверсии).
 */
export class BalanceAllocator implements IBalanceAllocator {
  /** Общий баланс аккаунта (включая зарезервированные и свободные средства) */
  private _totalBalance: Money;
  /** Текущие аллокации: marketId → аллоцированная сумма */
  private readonly _allocations = new Map<MarketId, Money>();
  /** Конфигурация аллокатора */
  private readonly _config: BalanceAllocatorConfig;
  /** Логгер (опционально) */
  private readonly _logger: ILogger | undefined;

  /**
   * @param config - Конфигурация параметров аллокации
   * @param initialBalance - Начальный баланс (по умолчанию 0 USDC)
   * @param logger - Опциональный логгер для диагностики
   */
  constructor(
    config: BalanceAllocatorConfig,
    initialBalance: Money = Money.ZERO['USDC'],
    logger?: ILogger,
  ) {
    this._config = config;
    this._totalBalance = initialBalance;
    this._logger = logger?.child({ component: 'BalanceAllocator' });
  }

  /**
   * Аллоцирует свободный баланс на несколько новых рынков.
   *
   * @param marketIds - Список рынков для аллокации (дубликаты игнорируются)
   * @returns Массив AllocationResult. Пустой если нет слотов или средств.
   *
   * @remarks
   * Рынки, уже имеющие аллокацию, пропускаются.
   * Дубликаты в marketIds дедуплицируются через Set.
   */
  public allocateToNewMarkets(marketIds: readonly MarketId[]): AllocationResult[] {
    // Дедупликация входного списка, затем фильтрация уже аллоцированных
    const uniqueIds = [...new Set(marketIds)];
    const newMarkets = uniqueIds.filter((id) => !this._allocations.has(id));

    if (newMarkets.length === 0) return [];

    const tradingBalance = this._calcTradingBalance();
    const freeBalance = this._calcFreeBalance(tradingBalance);
    const availableSlots = this._config.maxConcurrentMarkets - this._allocations.size;

    let newSlots = Math.min(newMarkets.length, availableSlots);
    if (newSlots <= 0) return [];

    // Ограничиваем количество слотов доступными средствами
    const maxByCapital = this._countAffordableSlots(freeBalance, this._config.minCapitalPerMarket);
    newSlots = Math.min(newSlots, maxByCapital);

    if (newSlots <= 0) return [];

    // Равномерное распределение по всем доступным слотам (не только по newSlots),
    // чтобы резервировать капитал для будущих аллокаций
    const denominator = Math.max(newSlots, availableSlots);
    const perMarketResult = MoneyService.divide(freeBalance, denominator);
    if (!perMarketResult.ok) return [];
    const perMarket = perMarketResult.value;

    if (perMarket.value().lessThan(this._config.minCapitalPerMarket.value())) return [];

    const results: AllocationResult[] = [];
    for (let i = 0; i < newSlots; i++) {
      const marketId = newMarkets[i];
      this._allocations.set(marketId, perMarket);
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
    if (this._allocations.has(marketId)) {
      return Err(new TradingError(
        'Cannot add market: market is already allocated',
        { context: { marketId: String(marketId) } },
      ));
    }

    const results = this.allocateToNewMarkets([marketId]);
    if (results.length === 0) {
      return Err(new TradingError(
        'Cannot add market: no available slots or insufficient balance',
        { context: { marketId: String(marketId), stats: this.getStats() } },
      ));
    }

    return Ok(results[0]!);
  }

  /**
   * Освобождает аллокацию и компаундирует PnL в общий баланс.
   *
   * @param marketId - ID рынка
   * @param realizedPnL - Реализованный PnL (может быть отрицательным)
   *
   * @throws {TradingError} Если realizedPnL в другой валюте чем totalBalance.
   *   Currency mismatch — invariant violation (архитектурная ошибка конфигурации).
   *
   * @remarks
   * `_totalBalance += realizedPnL` — автоматическое compounding.
   */
  public releaseWithPnL(marketId: MarketId, realizedPnL: Money): void {
    // Сначала проверяем валюту и вычисляем новый баланс — до мутации состояния.
    // Это обеспечивает атомарность: либо всё успешно, либо состояние не меняется.
    const addResult = MoneyService.add(this._totalBalance, realizedPnL);
    if (!addResult.ok) {
      // Currency mismatch — это invariant violation, не recoverable runtime ошибка.
      // Молча терять деньги недопустимо: бросаем явно.
      throw new TradingError(
        `releaseWithPnL: currency mismatch — totalBalance is ${this._totalBalance.currency()}, PnL is ${realizedPnL.currency()}`,
        { context: { marketId: String(marketId), error: addResult.error.message } },
      );
    }

    // Применяем PnL к балансу, затем освобождаем аллокацию.
    this._totalBalance = addResult.value;
    this._allocations.delete(marketId);
  }

  /**
   * Освобождает аллокацию без компаундирования PnL.
   *
   * @param marketId - ID рынка
   */
  public release(marketId: MarketId): void {
    this._allocations.delete(marketId);
  }

  /**
   * Возвращает текущую аллокацию для рынка.
   *
   * @param marketId - ID рынка
   * @returns Аллоцированная сумма или undefined
   */
  public getAllocation(marketId: MarketId): Money | undefined {
    return this._allocations.get(marketId);
  }

  /**
   * Обновляет общий баланс и проверяет инвариант over-allocation.
   *
   * @param newBalance - Новый общий баланс в USDC
   * @returns Ok(void) при успехе
   * @returns Err(TradingError) если новый баланс меньше суммы текущих аллокаций.
   *   Caller должен закрыть часть позиций перед вызовом.
   *
   * @remarks
   * Баланс может уменьшиться (вывод средств, убытки) — это нормально.
   * Over-allocation (newBalance < allocatedBalance) — критическое состояние.
   */
  public updateTotalBalance(newBalance: Money): Result<void, TradingError> {
    const tradingBalance = MoneyService.multiply(newBalance, this._config.tradingBalanceRatio.toNumber());
    if (!tradingBalance.ok) {
      return Err(new TradingError('Failed to compute trading balance', {
        context: { error: tradingBalance.error.message },
      }));
    }

    const allocatedBalance = this._calcAllocatedBalance();
    const subtractResult = MoneyService.subtract(tradingBalance.value, allocatedBalance);

    if (!subtractResult.ok || subtractResult.value.isNegative()) {
      return Err(new TradingError(
        'updateTotalBalance: new balance would cause over-allocation — close some positions first',
        {
          context: {
            newBalance: newBalance.toNumber(),
            tradingBalance: tradingBalance.value.toNumber(),
            allocatedBalance: allocatedBalance.toNumber(),
          },
        },
      ));
    }

    this._totalBalance = newBalance;
    this._logger?.info('Total balance updated', {
      newBalance: newBalance.toNumber(),
      tradingBalance: tradingBalance.value.toNumber(),
      allocatedBalance: allocatedBalance.toNumber(),
    });
    return Ok(undefined);
  }

  /**
   * Восстанавливает аллокации из снимка состояния (после рестарта).
   *
   * @param snapshot - Снимок аллокаций: marketId → аллоцированная сумма
   * @returns Ok(void) при успешном восстановлении
   * @returns Err(TradingError) если снимок нарушает инварианты:
   *   - `snapshot.size > maxConcurrentMarkets`
   *   - сумма аллокаций превышает текущий торговый баланс
   *
   * @remarks
   * Полностью заменяет текущие аллокации снимком (не мержит).
   * Валидирует инварианты перед применением — состояние не меняется при ошибке.
   * Используется при старте для восстановления состояния из персистентного хранилища.
   */
  public restoreAllocations(snapshot: ReadonlyMap<MarketId, Money>): Result<void, TradingError> {
    if (snapshot.size > this._config.maxConcurrentMarkets) {
      return Err(new TradingError(
        'restoreAllocations: snapshot exceeds maxConcurrentMarkets',
        {
          context: {
            snapshotSize: snapshot.size,
            maxConcurrentMarkets: this._config.maxConcurrentMarkets,
          },
        },
      ));
    }

    // Вычисляем сумму аллокаций из снимка
    let snapshotTotal = Money.ZERO[this._totalBalance.currency()];
    for (const amount of snapshot.values()) {
      const addResult = MoneyService.add(snapshotTotal, amount);
      if (!addResult.ok) {
        return Err(new TradingError(
          'restoreAllocations: currency mismatch in snapshot',
          { context: { error: addResult.error.message } },
        ));
      }
      snapshotTotal = addResult.value;
    }

    const tradingBalance = this._calcTradingBalance();
    const subtractResult = MoneyService.subtract(tradingBalance, snapshotTotal);
    if (!subtractResult.ok || subtractResult.value.isNegative()) {
      return Err(new TradingError(
        'restoreAllocations: snapshot total exceeds trading balance',
        {
          context: {
            snapshotTotal: snapshotTotal.toNumber(),
            tradingBalance: tradingBalance.toNumber(),
          },
        },
      ));
    }

    this._allocations.clear();
    for (const [marketId, amount] of snapshot) {
      this._allocations.set(marketId, amount);
    }
    this._logger?.info('Allocations restored from snapshot', {
      count: snapshot.size,
      markets: [...snapshot.keys()].map(String),
    });
    return Ok(undefined);
  }

  /**
   * Проверяет, можно ли добавить ещё один рынок.
   *
   * @returns true если есть свободные слоты и достаточно средств
   */
  public canAddMarket(): boolean {
    const availableSlots = this._config.maxConcurrentMarkets - this._allocations.size;
    if (availableSlots <= 0) return false;

    const tradingBalance = this._calcTradingBalance();
    const freeBalance = this._calcFreeBalance(tradingBalance);

    const perMarketResult = MoneyService.divide(freeBalance, availableSlots);
    if (!perMarketResult.ok) return false;

    return perMarketResult.value.value().greaterThanOrEqualTo(
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
      this._config.tradingBalanceRatio.toNumber(),
    );
    return result.ok ? result.value : Money.ZERO[this._totalBalance.currency()];
  }

  /**
   * Вычисляет сумму всех аллокаций.
   */
  private _calcAllocatedBalance(): Money {
    let total = Money.ZERO[this._totalBalance.currency()];
    for (const allocation of this._allocations.values()) {
      const addResult = MoneyService.add(total, allocation);
      if (!addResult.ok) {
        throw new TradingError(
          `_calcAllocatedBalance: currency mismatch — totalBalance is ${this._totalBalance.currency()}, allocation is ${allocation.currency()}`,
          { context: { error: addResult.error.message } },
        );
      }
      total = addResult.value;
    }
    return total;
  }

  /**
   * Вычисляет свободный баланс: tradingBalance - allocatedBalance.
   */
  private _calcFreeBalance(tradingBalance: Money): Money {
    const allocated = this._calcAllocatedBalance();
    const result = MoneyService.subtract(tradingBalance, allocated);
    if (!result.ok || result.value.isNegative()) return Money.ZERO[this._totalBalance.currency()];
    return result.value;
  }

  /**
   * Вычисляет количество слотов, которые можно аллоцировать при заданной стоимости слота.
   *
   * @param balance - Доступный баланс
   * @param slotCost - Стоимость одного слота
   * @returns Количество целых слотов (0 если баланс не положительный)
   *
   * @remarks
   * Инкапсулирует работу с Decimal внутри класса — вызывающий код оперирует
   * только VO Money, не зная о деталях деления.
   */
  private _countAffordableSlots(balance: Money, slotCost: Money): number {
    const balanceDec = balance.value();
    if (!balanceDec.isPositive()) return 0;
    const slotCostDec = slotCost.value();
    if (!slotCostDec.isPositive()) return 0;
    return balanceDec.div(slotCostDec).floor().toNumber();
  }
}
