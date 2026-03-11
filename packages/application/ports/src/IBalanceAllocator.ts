/**
 * Порт: распределитель торгового баланса по рынкам.
 *
 * @remarks
 * `IBalanceAllocator` — application-layer порт (Dependency Inversion).
 * Инфраструктурная реализация `BalanceAllocator` в `@polymarket/balance-allocator`
 * реализует этот интерфейс.
 *
 * ### Ответственность:
 * - Отслеживание общего торгового баланса
 * - Аллокация свободного баланса на новые рынки
 * - Освобождение аллокации с компаундированием PnL
 * - Проверка доступных слотов и лимитов
 *
 * ### Использование:
 * - `MarketDiscoveryPublisher._discover()` → `OpenMarketUseCase` — аллокация на новые рынки
 * - `OpenMarketUseCase` — `addMarket()` при открытии рынка
 * - `CloseMarketUseCase` — `releaseWithPnL()` при закрытии рынка
 *
 * @see {@link BalanceAllocator} — реализация в `@polymarket/balance-allocator`
 */
import type { Result } from '@polymarket/result';
import type { TradingError } from '@polymarket/errors';
import type { MarketId } from '@polymarket/ids';
import type { Money } from '@polymarket/value-objects';

/**
 * Результат аллокации баланса на рынок.
 */
export interface AllocationResult {
  /** ID рынка */
  readonly marketId: MarketId;
  /** Аллоцированная сумма в USDC */
  readonly allocatedAmount: Money;
}

/**
 * Статистика аллокатора в текущий момент.
 */
export interface AllocationStats {
  /** Общий баланс аккаунта */
  readonly totalBalance: Money;
  /** Торговый баланс (totalBalance * tradingBalanceRatio) */
  readonly tradingBalance: Money;
  /** Сумма всех текущих аллокаций */
  readonly allocatedBalance: Money;
  /** Свободный баланс (tradingBalance - allocatedBalance) */
  readonly freeBalance: Money;
  /** Текущий уровень утилизации [0, 1] */
  readonly utilization: number;
  /** Количество активных рынков */
  readonly activeMarkets: number;
  /** Доступных слотов для новых рынков */
  readonly availableSlots: number;
}

/**
 * Порт: распределитель торгового баланса по рынкам.
 *
 * @example
 * ```typescript
 * allocator.updateTotalBalance(Money.of(new Decimal(10000), 'USDC'));
 *
 * const results = allocator.allocateToNewMarkets(['market-1', 'market-2']);
 * // results: [{ marketId: 'market-1', allocatedAmount: Money($800) }, ...]
 *
 * // При закрытии рынка с прибылью $50:
 * allocator.releaseWithPnL('market-1', Money.of(new Decimal(50)));
 * ```
 */
export interface IBalanceAllocator {
  /**
   * Аллоцирует свободный баланс на несколько новых рынков.
   *
   * @param marketIds - Список рынков для аллокации
   * @returns Массив AllocationResult для рынков, которые получили аллокацию.
   *          Пустой массив если недостаточно средств или нет слотов.
   *
   * @remarks
   * Уже аллоцированные рынки из списка пропускаются.
   * Если `perMarket < minCapital` → вернуть `[]`.
   */
  allocateToNewMarkets(marketIds: readonly MarketId[]): AllocationResult[];

  /**
   * Добавляет один рынок и аллоцирует ему баланс.
   *
   * @param marketId - ID рынка
   * @returns Ok(AllocationResult) при успехе, Err если нет слотов или средств
   *
   * @remarks
   * Используется `OpenMarketUseCase` для явного добавления одного рынка.
   */
  addMarket(marketId: MarketId): Result<AllocationResult, TradingError>;

  /**
   * Освобождает аллокацию и компаундирует PnL в общий баланс.
   *
   * @param marketId - ID рынка
   * @param realizedPnL - Реализованный PnL (может быть отрицательным)
   *
   * @throws {TradingError} Если realizedPnL в другой валюте чем totalBalance —
   *   currency mismatch является invariant violation (архитектурная ошибка конфигурации).
   *
   * @remarks
   * `_totalBalance += realizedPnL` — баланс растёт при прибыли, уменьшается при убытке.
   * Если рынок не найден в аллокациях — только применяет PnL к балансу.
   */
  releaseWithPnL(marketId: MarketId, realizedPnL: Money): void;

  /**
   * Освобождает аллокацию без компаундирования PnL.
   *
   * @param marketId - ID рынка
   */
  release(marketId: MarketId): void;

  /**
   * Возвращает текущую аллокацию для рынка.
   *
   * @param marketId - ID рынка
   * @returns Аллоцированная сумма или undefined если рынок не аллоцирован
   */
  getAllocation(marketId: MarketId): Money | undefined;

  /**
   * Обновляет общий баланс (после ребалансировки / депозита / вывода).
   *
   * @param newBalance - Новый общий баланс в USDC
   * @returns Ok(void) при успехе, Err если новый баланс вызывает over-allocation
   *   (newBalance < allocatedBalance). Caller должен закрыть часть позиций.
   */
  updateTotalBalance(newBalance: Money): Result<void, TradingError>;

  /**
   * Восстанавливает аллокации из снимка состояния (после рестарта).
   *
   * @param snapshot - Снимок аллокаций: marketId → аллоцированная сумма
   * @returns Ok(void) при успешном восстановлении
   * @returns Err(TradingError) если снимок нарушает инварианты:
   *   - `snapshot.size > maxConcurrentMarkets`
   *   - сумма аллокаций превышает торговый баланс
   *   - валюты аллокаций не совпадают с валютой баланса
   *
   * @remarks
   * Используется при старте для восстановления состояния из персистентного хранилища.
   * Полностью заменяет текущие аллокации снимком (не мержит).
   * Состояние не изменяется при ошибке валидации.
   */
  restoreAllocations(snapshot: ReadonlyMap<MarketId, Money>): Result<void, TradingError>;

  /**
   * Проверяет, можно ли добавить ещё один рынок.
   *
   * @returns true если есть свободные слоты и достаточно средств
   */
  canAddMarket(): boolean;

  /**
   * Возвращает текущую статистику аллокатора.
   *
   * @returns AllocationStats снимок текущего состояния
   */
  getStats(): AllocationStats;
}
