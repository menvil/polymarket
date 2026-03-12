/**
 * CloseMarketUseCase — закрытие рынка с отменой ордеров и освобождением баланса.
 *
 * @remarks
 * ### Алгоритм:
 * 1. `orderRepo.getByMarketId(marketId)` → открытые ордера рынка
 * 2. Параллельная best-effort отмена пакетами по `CANCEL_BATCH_SIZE` ордеров
 * 3. Идемпотентное освобождение баланса:
 *    - Если `getAllocation(marketId) !== undefined` → `releaseWithPnL` / `release`
 *    - Иначе → warn и пропуск (рынок уже был закрыт ранее)
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
   * Операция идемпотентна: повторный вызов для уже закрытого рынка безопасен.
   */
  public async execute(input: CloseMarketInput): Promise<Result<void, TradingError>> {
    this._logger.info('Closing market', {
      marketId: String(input.marketId),
      reason: input.reason,
    });

    // Шаг 1: Получить ордера рынка через типизированный метод репозитория
    const orders = await this._deps.orderRepo.getByMarketId(input.marketId);

    // Фильтр — только открытые ордера
    const openOrders = orders.filter(
      (order) => order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED',
    );

    // Шаг 2: Параллельная best-effort отмена пакетами
    const CANCEL_BATCH_SIZE = 10;
    let cancelErrorCount = 0;

    for (let i = 0; i < openOrders.length; i += CANCEL_BATCH_SIZE) {
      const batch = openOrders.slice(i, i + CANCEL_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((order) =>
          this._deps.cancelOrderUseCase.execute({
            orderId: order.id,
            accountId: input.accountId,
            reason: `Market closed: ${input.reason}`,
          }),
        ),
      );

      for (let j = 0; j < results.length; j++) {
        const settled = results[j]!;
        const order = batch[j]!;
        if (settled.status === 'rejected') {
          this._logger.warn('Failed to cancel order during market close (best effort)', {
            orderId: String(order.id),
            marketId: String(input.marketId),
            error: String(settled.reason),
          });
          cancelErrorCount++;
        } else if (!settled.value.ok) {
          this._logger.warn('Failed to cancel order during market close (best effort)', {
            orderId: String(order.id),
            marketId: String(input.marketId),
            error: settled.value.error.message,
          });
          cancelErrorCount++;
        }
      }
    }

    if (cancelErrorCount > 0) {
      this._logger.warn('Some orders failed to cancel during market close', {
        marketId: String(input.marketId),
        failedCount: cancelErrorCount,
        totalCount: openOrders.length,
      });
    }

    // Шаг 3: Идемпотентное освобождение аллокации
    // Если рынок уже был закрыт ранее — аллокация отсутствует, пропускаем
    const currentAllocation = this._deps.balanceAllocator.getAllocation(input.marketId);
    if (currentAllocation !== undefined) {
      if (input.realizedPnL !== undefined) {
        this._deps.balanceAllocator.releaseWithPnL(input.marketId, input.realizedPnL);
      } else {
        this._deps.balanceAllocator.release(input.marketId);
      }
    } else {
      this._logger.warn('Market not allocated — skipping balance release (idempotent close)', {
        marketId: String(input.marketId),
      });
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
    const realizedPnL = input.realizedPnL ?? Money.ZERO.USDC;
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
        err: err instanceof Error ? err : new Error(String(err)),
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
