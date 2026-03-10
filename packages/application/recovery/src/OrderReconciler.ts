/**
 * OrderReconciler — сверка локальных ордеров с venue.
 *
 * @remarks
 * Вызывается на старте системы (после PortfolioReplayService) и при
 * переподключении WS, обеспечивая консистентность локального IOrderRepository
 * с актуальным состоянием биржи.
 *
 * ### Алгоритм:
 * 1. Получить все локальные ордера из IOrderRepository.
 * 2. Если ордеров нет — завершить (ничего reconcile-ить).
 * 3. Получить ID всех открытых ордеров от venue через IVenueOrderProvider.
 * 4. Для каждого локального ордера, которого НЕТ на venue:
 *    - применить CANCELLED через OrderUpdateHandler (сохраняет + публикует события).
 * 5. Залогировать статистику.
 *
 * ### Когда вызывать:
 * - **Старт системы**: после PortfolioReplayService, до WS-подписок.
 * - **Reconnect WS**: UserEventFeedAdapter.onReconnect() (Phase 9).
 *
 * ### Идемпотентность:
 * OrderUpdateHandler.handle(CANCELLED) для уже отменённого ордера будет отклонён
 * самой Order entity (order.cancel() вернёт error). OrderUpdateHandler логирует
 * и возвращает без сохранения — безопасно.
 *
 * @example
 * ```typescript
 * const reconciler = new OrderReconciler({
 *   venueOrderProvider,
 *   orderRepo,
 *   orderUpdateHandler,
 *   logger,
 * });
 *
 * // На старте и при reconnect:
 * await reconciler.reconcile(accountId);
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import type { IOrderRepository } from '@polymarket/ports';
import type { OrderUpdateHandler } from '@polymarket/handlers';
import type { IVenueOrderProvider } from './IVenueOrderProvider.js';

/** Зависимости OrderReconciler */
export interface OrderReconcilerDeps {
  readonly venueOrderProvider: IVenueOrderProvider;
  readonly orderRepo: IOrderRepository;
  readonly orderUpdateHandler: OrderUpdateHandler;
  readonly logger: ILogger;
}

/**
 * Сервис сверки локальных ордеров с venue.
 *
 * @remarks
 * Отменяет локальные ордера, которых нет на venue (были закрыты в offline-период).
 */
export class OrderReconciler {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости reconciler-а
   */
  constructor(private readonly _deps: OrderReconcilerDeps) {
    this._logger = _deps.logger.child({ component: 'OrderReconciler' });
  }

  /**
   * Выполняет сверку локальных ордеров с venue.
   *
   * @param accountId - ID аккаунта (для логирования и контекста)
   *
   * @remarks
   * Для каждого локального ордера, отсутствующего на venue,
   * применяет CANCELLED через OrderUpdateHandler.
   * Ордера, присутствующие на venue, остаются без изменений.
   */
  public async reconcile(accountId: AccountId): Promise<void> {
    // Шаг 1: Получить все локальные ордера
    const localOrders = await this._deps.orderRepo.getAll();

    if (localOrders.length === 0) {
      this._logger.info('No local orders to reconcile', {
        accountId: String(accountId),
      });
      return;
    }

    this._logger.info('Starting order reconciliation', {
      accountId: String(accountId),
      localOrderCount: localOrders.length,
    });

    // Шаг 2: Получить ID открытых ордеров от venue
    let venueOrderIds: Set<string>;
    try {
      const ids = await this._deps.venueOrderProvider.getOpenOrderIds();
      venueOrderIds = new Set(ids);
    } catch (err) {
      this._logger.error('Failed to fetch open orders from venue, skipping reconciliation', {
        accountId: String(accountId),
        error: String(err),
      });
      return;
    }

    // Шаг 3: Отменить локальные ордера, отсутствующие на venue
    let cancelledCount = 0;
    let activeCount = 0;

    for (const order of localOrders) {
      const orderId = String(order.id);

      if (venueOrderIds.has(orderId)) {
        activeCount++;
        continue;
      }

      // Ордера нет на venue — применяем CANCELLED
      await this._deps.orderUpdateHandler.handle({
        type: 'CANCELLED',
        orderId: order.id,
        reason: 'Reconciliation: order not found on venue',
      });
      cancelledCount++;

      this._logger.debug('Order cancelled during reconciliation', { orderId });
    }

    // Шаг 4: Залогировать статистику
    this._logger.info('Order reconciliation completed', {
      accountId: String(accountId),
      total: localOrders.length,
      active: activeCount,
      cancelled: cancelledCount,
    });
  }
}
