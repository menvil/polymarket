/**
 * Order Finite State Machine (FSM)
 *
 * @remarks
 * OrderFSM - центральный dispatcher для всех переходов состояния Order.
 * Связывает OrderChange events с соответствующими handlers.
 *
 * ### Архитектура:
 * ```
 * Order.accept() → OrderChange{ACCEPTED} → OrderFSM.apply() → handleAccepted() → new Order
 * ```
 *
 * ### Преимущества FSM подхода:
 * - Централизованная логика переходов
 * - Type-safe discriminated unions (OrderChange)
 * - Легко тестировать каждый handler отдельно
 * - Ясная трассировка изменений состояния
 * - Exhaustiveness checking от TypeScript
 *
 * ### Использование:
 * OrderFSM используется ВНУТРИ Order class для обработки transitions.
 * Публичные методы Order (accept, reject, cancel и т.д.) создают OrderChange
 * и делегируют обработку в OrderFSM.
 *
 * @example
 * ```typescript
 * import { OrderFSM } from './OrderFSM';
 * import type { OrderChange } from './OrderChange';
 *
 * // Внутри Order._transition():
 * const change: OrderChange = { type: 'ACCEPTED' };
 * const result = OrderFSM.apply(orderData, change);
 * if (result.ok) {
 *   return Order.create(result.value);
 * }
 * ```
 */

import { Result, Err } from '@polymarket/result';
import type { OrderChange } from '../../types/OrderChange';
import type { OrderData } from './handlers';
import {
  handleAccepted,
  handleRejected,
  handleCancelled,
  handleExpired,
  handleTradeApplied,
  type TradeParams,
} from './handlers';

/**
 * Класс OrderFSM - диспетчер переходов состояния
 *
 * @remarks
 * Static-only class. Все методы статические.
 * Не создавайте экземпляры этого класса.
 */
export class OrderFSM {
  /**
   * Приватный конструктор - запрещает создание экземпляров
   */
  private constructor() {
    throw new Error('OrderFSM is a static class. Do not instantiate.');
  }

  /**
   * Применяет OrderChange к текущему состоянию Order
   *
   * @param order - Текущие данные заявки
   * @param change - Объект OrderChange описывающий изменение
   * @returns Result<OrderData, Error> с новыми данными или ошибкой
   *
   * @remarks
   * Это главный entry point FSM.
   * Использует discriminated union для type-safe dispatch.
   *
   * Процесс:
   * 1. Pattern match на change.type
   * 2. Вызов соответствующего handler
   * 3. Handler валидирует переход
   * 4. Handler возвращает новые OrderData
   * 5. Order создается из OrderData (не здесь, а в Order._transition)
   *
   * TypeScript exhaustiveness check гарантирует что все типы OrderChange обработаны.
   *
   * @example
   * ```typescript
   * const change: OrderChange = { type: 'ACCEPTED' };
   * const result = OrderFSM.apply(orderData, change);
   * if (result.ok) {
   *   console.log(result.value.status); // 'OPEN'
   * }
   * ```
   */
  public static apply(order: OrderData, change: OrderChange): Result<OrderData, Error> {
    switch (change.type) {
      case 'ACCEPTED':
        return handleAccepted(order);

      case 'REJECTED':
        return handleRejected(order, change.reason);

      case 'CANCELLED':
        return handleCancelled(order, change.reason);

      case 'EXPIRED':
        return handleExpired(order);

      case 'TRADE_APPLIED': {
        // Конвертируем Trade в TradeParams
        const tradeParams: TradeParams = {
          id: change.trade.id,
          marketId: change.trade.marketId,
          tokenId: change.trade.tokenId,
          side: change.trade.side,
          orderId: change.trade.orderId,
          size: change.trade.size,
          price: change.trade.price,
        };
        return handleTradeApplied(order, tradeParams);
      }

      default: {
        // TypeScript exhaustiveness check
        // Если мы сюда попали - значит забыли обработать какой-то тип OrderChange
        const _exhaustive: never = change;
        return Err(new Error(`Unhandled OrderChange type: ${(_exhaustive as any).type}`));
      }
    }
  }
}
