/**
 * OpenMarketUseCase — открытие нового рынка с аллокацией баланса.
 *
 * @remarks
 * ### Алгоритм:
 * 1. `balanceAllocator.addMarket(marketId)` → аллоцировать баланс
 *    - Если Err (нет слотов / средств) → вернуть Err
 * 2. `eventBus.publish({ type: 'MARKET_OPENED', ... })`
 * 3. Вернуть Ok(AllocationResult)
 *
 * ### Использование:
 * Вызывается `StrategyCoordinator._discover()` для каждого нового инструмента.
 *
 * @example
 * ```typescript
 * const useCase = new OpenMarketUseCase({
 *   balanceAllocator, eventBus, clock, logger,
 * });
 *
 * const result = await useCase.execute({
 *   marketId: 'mkt-abc',
 *   strategyId: 'quoter-1',
 *   accountId,
 * });
 * if (result.ok) {
 *   console.log('Market opened:', result.value.allocatedAmount.toNumber());
 * }
 * ```
 */
import type { Result } from '@polymarket/result';
import { Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { AccountId, MarketId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import { TimestampService } from '@polymarket/value-objects';
import type { IBalanceAllocator, AllocationResult } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';

/** Зависимости OpenMarketUseCase */
export interface OpenMarketDeps {
  readonly balanceAllocator: IBalanceAllocator;
  readonly eventBus: IEventBus;
  readonly clock: IClock;
  readonly logger: ILogger;
}

/** Входные данные для OpenMarketUseCase */
export interface OpenMarketInput {
  /** ID рынка для открытия */
  readonly marketId: MarketId;
  /** ID стратегии для этого рынка */
  readonly strategyId: string;
  /** ID аккаунта трейдера */
  readonly accountId: AccountId;
}

/**
 * Use case открытия нового рынка.
 *
 * @remarks
 * Аллоцирует баланс через IBalanceAllocator и публикует MARKET_OPENED событие.
 */
export class OpenMarketUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: OpenMarketDeps) {
    this._logger = _deps.logger.child({ component: 'OpenMarketUseCase' });
  }

  /**
   * Открывает рынок: аллоцирует баланс и публикует событие.
   *
   * @param input - Входные данные с marketId и strategyId
   * @returns Ok(AllocationResult) при успехе, Err если нет слотов или средств
   *
   * @throws Не бросает — все ошибки через Result
   */
  public async execute(input: OpenMarketInput): Promise<Result<AllocationResult, TradingError>> {
    this._logger.info('Opening market', {
      marketId: String(input.marketId),
      strategyId: input.strategyId,
    });

    // Шаг 1: Аллоцировать баланс
    const allocationResult = this._deps.balanceAllocator.addMarket(input.marketId);
    if (!allocationResult.ok) {
      this._logger.warn('Cannot open market: allocation failed', {
        marketId: String(input.marketId),
        error: allocationResult.error.message,
      });
      return Err(allocationResult.error);
    }

    const allocation = allocationResult.value;

    // Шаг 2: Создать timestamp
    const now = this._deps.clock.now();
    const timestampResult = TimestampService.create(now.getTime());
    if (!timestampResult.ok) {
      return Err(new TradingError(
        `Failed to create timestamp: ${timestampResult.error.message}`,
        { context: { marketId: String(input.marketId) } },
      ));
    }

    // Шаг 3: Опубликовать MARKET_OPENED событие
    try {
      await this._deps.eventBus.publish({
        type: 'MARKET_OPENED',
        marketId: input.marketId,
        strategyId: input.strategyId,
        allocatedBalance: allocation.allocatedAmount,
        timestamp: timestampResult.value,
      });
    } catch (err) {
      // Событие не опубликовано, но аллокация прошла — логируем, не прерываем
      this._logger.error('Failed to publish MARKET_OPENED event', {
        marketId: String(input.marketId),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this._logger.info('Market opened successfully', {
      marketId: String(input.marketId),
      strategyId: input.strategyId,
      allocatedAmount: allocation.allocatedAmount.toNumber(),
    });

    return allocationResult;
  }
}
