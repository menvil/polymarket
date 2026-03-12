/**
 * CancellationService — пакетная отмена открытых ордеров рынка.
 *
 * @remarks
 * Инкапсулирует инфраструктурные детали отмены: фильтр статусов, батчинг, best-effort логику.
 * `CloseMarketUseCase` делегирует ему отмену и получает `CancellationResult`.
 *
 * ### Алгоритм:
 * 1. Фильтруем ордера с `status === 'OPEN' | 'PARTIALLY_FILLED'`
 * 2. Делим на пакеты по `batchSize` (по умолчанию 10)
 * 3. Каждый пакет — `Promise.allSettled` параллельно
 * 4. Ошибки логируются, не останавливают процесс (best-effort)
 * 5. Возвращаем итог `{ cancelled, failed }`
 *
 * ### Почему `Promise.allSettled` а не `Promise.all`:
 * Нам нужен результат каждого ордера независимо от других.
 * `Promise.all` прерывается при первой ошибке.
 *
 * @example
 * ```typescript
 * const service = new CancellationService(cancelOrderUseCase, { logger }, 10);
 * const result = await service.cancelOpenOrders(orders, accountId, marketId, 'EXPIRED');
 * console.log(`Cancelled: ${result.cancelled}, failed: ${result.failed}`);
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { AccountId, MarketId } from '@polymarket/ids';
import type { Order } from '@polymarket/order';
import type { CancelOrderUseCase } from '@polymarket/use-cases';
import type { MarketCloseReason } from '@polymarket/event-bus';

/**
 * Итог пакетной отмены ордеров.
 */
export interface CancellationResult {
  /** Количество успешно отменённых ордеров */
  readonly cancelled: number;
  /** Количество ордеров с ошибкой отмены */
  readonly failed: number;
}

/**
 * Сервис пакетной best-effort отмены открытых ордеров.
 *
 * @remarks
 * Не является use case — это application service без собственного бизнес-инварианта.
 * Инкапсулирует инфраструктурный параметр `batchSize` и логику батчинга.
 */
export class CancellationService {
  private readonly _logger: ILogger;

  /**
   * @param _cancelOrderUseCase - Use case отмены отдельного ордера
   * @param deps - Зависимости (logger)
   * @param _batchSize - Размер пакета параллельных отмен (по умолчанию 10)
   *
   * @throws {RangeError} Если batchSize < 1
   */
  constructor(
    private readonly _cancelOrderUseCase: CancelOrderUseCase,
    deps: { readonly logger: ILogger },
    private readonly _batchSize = 10,
  ) {
    if (_batchSize < 1) {
      throw new RangeError(`CancellationService: batchSize must be >= 1, got ${_batchSize}`);
    }
    this._logger = deps.logger.child({ component: 'CancellationService' });
  }

  /**
   * Отменяет все открытые ордера из переданного списка (best-effort).
   *
   * @param orders - Все ордера рынка (фильтрация по статусу внутри)
   * @param accountId - ID аккаунта трейдера
   * @param marketId - ID рынка (для логирования)
   * @param reason - Причина закрытия рынка
   * @returns Итог: количество успешно отменённых и упавших ордеров
   *
   * @remarks
   * Метод не бросает — все ошибки логируются и отражаются в `result.failed`.
   * Ордера со статусами, отличными от `OPEN` и `PARTIALLY_FILLED`, пропускаются.
   *
   * @example
   * ```typescript
   * const orders = await orderRepo.getByMarketId(marketId);
   * const result = await cancellationService.cancelOpenOrders(
   *   orders, accountId, marketId, 'EXPIRED',
   * );
   * if (result.failed > 0) {
   *   logger.warn('Some cancellations failed', { failed: result.failed });
   * }
   * ```
   */
  public async cancelOpenOrders(
    orders: readonly Order[],
    accountId: AccountId,
    marketId: MarketId,
    reason: MarketCloseReason,
  ): Promise<CancellationResult> {
    const openOrders = orders.filter((o) => o.canCancel());

    if (openOrders.length === 0) {
      return { cancelled: 0, failed: 0 };
    }

    let failed = 0;

    for (let i = 0; i < openOrders.length; i += this._batchSize) {
      const batch = openOrders.slice(i, i + this._batchSize);
      const results = await Promise.allSettled(
        batch.map((order) =>
          this._cancelOrderUseCase.execute({
            orderId: order.id,
            accountId,
            reason: `Market closed: ${String(reason)}`,
          }),
        ),
      );

      for (let j = 0; j < results.length; j++) {
        const settled = results[j]!;
        const order = batch[j]!;

        if (settled.status === 'rejected') {
          this._logger.warn('Failed to cancel order (best effort)', {
            orderId: String(order.id),
            marketId: String(marketId),
            error: String(settled.reason),
          });
          failed++;
        } else if (!settled.value.ok) {
          this._logger.warn('Failed to cancel order (best effort)', {
            orderId: String(order.id),
            marketId: String(marketId),
            error: settled.value.error.message,
          });
          failed++;
        }
      }
    }

    return { cancelled: openOrders.length - failed, failed };
  }
}
