/**
 * OrderService — операции над Order aggregate.
 *
 * @remarks
 * Тонкая обёртка над Order aggregate для использования в use-cases.
 * Отвечает за:
 * - Применение Fill к Order (applyFill)
 * - Отмену Order (cancel)
 * - Сохранение Order в репозитории
 *
 * Не содержит бизнес-логики — делегирует всё доменному объекту.
 *
 * @example
 * ```typescript
 * const service = new OrderService(orderRepo, logger);
 * const result = await service.applyFill(order, fillData);
 * if (result.ok) {
 *   // inspect result.value — сохранение уже произошло внутри applyFill
 *   console.log(result.value.status);
 * }
 * ```
 */

import type { Result } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IOrderRepository } from '@polymarket/ports';
import type { Order, FillData } from '@polymarket/order';

/** Сервис операций над Order */
export class OrderService {
  private readonly _logger: ILogger;

  /**
   * @param orderRepo - Репозиторий заявок
   * @param logger - Logger (дочерний контекст 'OrderService' добавляется автоматически)
   */
  constructor(
    private readonly _orderRepo: IOrderRepository,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'OrderService' });
  }

  /**
   * Применяет fill к заявке и сохраняет обновлённое состояние.
   *
   * @param order - Заявка для обновления
   * @param fillData - Данные исполнения
   * @returns Ok(updatedOrder) или Err(TradingError) при нарушении инварианта
   *
   * @remarks
   * Переходы: OPEN → PARTIALLY_FILLED, OPEN/PARTIALLY_FILLED → FILLED.
   * При успехе сохраняет заявку в репозиторий.
   */
  public async applyFill(order: Order, fillData: FillData): Promise<Result<Order, TradingError>> {
    const result = order.applyFill(fillData);
    if (!result.ok) {
      this._logger.warn('Failed to apply fill to order', {
        orderId: String(order.id),
        fillId: String(fillData.id),
        error: result.error.message,
      });
      return result;
    }
    await this._orderRepo.save(result.value);
    this._logger.debug('Fill applied to order', {
      orderId: String(order.id),
      fillId: String(fillData.id),
      newStatus: result.value.status,
    });
    return result;
  }

  /**
   * Отменяет заявку и сохраняет обновлённое состояние.
   *
   * @param order - Заявка для отмены
   * @param reason - Причина отмены (опционально)
   * @returns Ok(cancelledOrder) или Err(TradingError) если отмена невозможна
   *
   * @remarks
   * Переход: OPEN/PARTIALLY_FILLED → CANCELED.
   * При успехе сохраняет заявку в репозиторий.
   */
  public async cancel(order: Order, reason?: string): Promise<Result<Order, TradingError>> {
    const result = order.cancel(reason);
    if (!result.ok) {
      this._logger.warn('Failed to cancel order', {
        orderId: String(order.id),
        status: order.status,
        error: result.error.message,
      });
      return result;
    }
    await this._orderRepo.save(result.value);
    this._logger.info('Order cancelled', {
      orderId: String(order.id),
      reason: reason ?? 'User cancelled',
    });
    return result;
  }

  /**
   * Сохраняет заявку в репозиторий.
   *
   * @param order - Заявка для сохранения
   * @returns Promise, завершающийся при успешном сохранении
   */
  public async save(order: Order): Promise<void> {
    await this._orderRepo.save(order);
  }
}
