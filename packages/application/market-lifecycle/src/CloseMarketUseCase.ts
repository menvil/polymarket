/**
 * CloseMarketUseCase — закрытие рынка с отменой ордеров и освобождением баланса.
 *
 * @remarks
 * ### Алгоритм:
 * 1. `orderRepo.getByStrategyId(String(marketId))` → открытые ордера рынка
 * 2. Для каждого открытого ордера: `cancelOrderUseCase.execute(...)` (best-effort)
 * 3. `balanceAllocator.releaseWithPnL(marketId, pnl)` → освободить баланс с PnL
 *    или `balanceAllocator.release(marketId)` → без PnL если не указан
 * 4. `eventBus.publish({ type: 'MARKET_CLOSED', ... })`
 * 5. Вернуть Ok(void)
 *
 * ### Best-effort отмена:
 * Ошибки при отмене отдельных ордеров логируются, но не останавливают процесс.
 * Reconciliation позаботится об оставшихся ордерах.
 *
 * @example
 * ```typescript
 * const useCase = new CloseMarketUseCase({
 *   balanceAllocator, orderRepo, cancelOrderUseCase, eventBus, clock, logger,
 * });
 *
 * await useCase.execute({
 *   marketId: 'mkt-abc',
 *   accountId,
 *   reason: 'EXPIRED',
 *   realizedPnL: Money.of(new Decimal(150), 'USDC'),
 * });
 * ```
 */
import type { Result } from '@polymarket/result';
import { Ok } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { AccountId, MarketId } from '@polymarket/ids';
import { Money, TimestampService } from '@polymarket/value-objects';
import type { IClock } from '@polymarket/time';
import type { IBalanceAllocator, IOrderRepository } from '@polymarket/ports';
import type { IEventBus, MarketCloseReason } from '@polymarket/event-bus';
import type { CancelOrderUseCase } from '@polymarket/use-cases';

/** Зависимости CloseMarketUseCase */
export interface CloseMarketDeps {
  readonly balanceAllocator: IBalanceAllocator;
  readonly orderRepo: IOrderRepository;
  readonly cancelOrderUseCase: CancelOrderUseCase;
  readonly eventBus: IEventBus;
  readonly clock: IClock;
  readonly logger: ILogger;
}

/** Входные данные для CloseMarketUseCase */
export interface CloseMarketInput {
  /** ID рынка для закрытия */
  readonly marketId: MarketId;
  /** ID аккаунта трейдера */
  readonly accountId: AccountId;
  /** Причина закрытия */
  readonly reason: MarketCloseReason;
  /** Реализованный PnL (если доступен; если нет — баланс освобождается без PnL) */
  readonly realizedPnL?: Money;
}

/**
 * Use case закрытия рынка.
 *
 * @remarks
 * Отменяет открытые ордера, освобождает аллокацию с PnL и публикует MARKET_CLOSED.
 */
export class CloseMarketUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: CloseMarketDeps) {
    this._logger = _deps.logger.child({ component: 'CloseMarketUseCase' });
  }

  /**
   * Закрывает рынок: отменяет ордера, освобождает баланс, публикует событие.
   *
   * @param input - Входные данные с marketId и причиной
   * @returns Ok(void) при успехе
   *
   * @remarks
   * Ошибки отмены отдельных ордеров не возвращают Err — они логируются.
   * Событие MARKET_CLOSED публикуется даже при частичных ошибках отмены.
   */
  public async execute(input: CloseMarketInput): Promise<Result<void, TradingError>> {
    this._logger.info('Closing market', {
      marketId: String(input.marketId),
      reason: input.reason,
    });

    // Шаг 1: Получить ордера рынка
    // Соглашение: strategyId = String(marketId) в контексте координатора
    const orders = await this._deps.orderRepo.getByStrategyId(String(input.marketId));

    // Фильтр — только открытые ордера
    const openOrders = orders.filter(
      (order) => order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED',
    );

    // Шаг 2: Best-effort отмена ордеров
    let cancelErrorCount = 0;
    for (const order of openOrders) {
      const cancelResult = await this._deps.cancelOrderUseCase.execute({
        orderId: order.id,
        accountId: input.accountId,
        reason: `Market closed: ${input.reason}`,
      });
      if (!cancelResult.ok) {
        this._logger.warn('Failed to cancel order during market close (best effort)', {
          orderId: String(order.id),
          marketId: String(input.marketId),
          error: cancelResult.error.message,
        });
        cancelErrorCount++;
      }
    }

    if (cancelErrorCount > 0) {
      this._logger.warn('Some orders failed to cancel during market close', {
        marketId: String(input.marketId),
        failedCount: cancelErrorCount,
        totalCount: openOrders.length,
      });
    }

    // Шаг 3: Освободить аллокацию
    if (input.realizedPnL !== undefined) {
      this._deps.balanceAllocator.releaseWithPnL(input.marketId, input.realizedPnL);
    } else {
      this._deps.balanceAllocator.release(input.marketId);
    }

    // Шаг 4: Создать timestamp
    const now = this._deps.clock.now();
    const timestampResult = TimestampService.create(now.getTime());

    if (!timestampResult.ok) {
      this._logger.error('Failed to create timestamp for MARKET_CLOSED event', {
        marketId: String(input.marketId),
        error: timestampResult.error.message,
      });
      // Не возвращаем Err — рынок уже закрыт (ордера отменены, баланс освобождён)
      return Ok(undefined);
    }

    // Шаг 5: Опубликовать MARKET_CLOSED событие
    const realizedPnL = input.realizedPnL ?? Money.ZERO['USDC'];
    try {
      await this._deps.eventBus.publish({
        type: 'MARKET_CLOSED',
        marketId: input.marketId,
        reason: input.reason,
        realizedPnL,
        timestamp: timestampResult.value,
      });
    } catch (err) {
      this._logger.error('Failed to publish MARKET_CLOSED event', {
        marketId: String(input.marketId),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this._logger.info('Market closed', {
      marketId: String(input.marketId),
      reason: input.reason,
      cancelledOrders: openOrders.length - cancelErrorCount,
    });

    return Ok(undefined);
  }
}
