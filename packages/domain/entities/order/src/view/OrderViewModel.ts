/**
 * View Model для Order
 *
 * @remarks
 * Отвечает за сериализацию Order в различные представления:
 * - JSON для API responses
 * - Readable string для логирования
 * - Summary для UI списков
 *
 * Не содержит бизнес-логики, только форматирование.
 *
 * @example
 * ```typescript
 * import { OrderViewModel } from './OrderViewModel';
 *
 * const json = OrderViewModel.toJSON(order);
 * const readable = OrderViewModel.toReadable(order);
 * const summary = OrderViewModel.toSummary(order);
 * ```
 */

import type { Order } from '../Order';

/**
 * Summary представление Order для UI списков
 */
export interface OrderSummary {
  readonly id: string;
  readonly status: string;
  readonly side: string;
  readonly price: number;
  readonly size: number;
  readonly filled: number;
  readonly remaining: number;
  readonly fillPercentage: number;
}

/**
 * Класс OrderViewModel - сериализация Order
 */
export class OrderViewModel {
  /**
   * Приватный конструктор - static-only class
   */
  private constructor() {
    throw new Error('OrderViewModel is a static class');
  }

  /**
   * Преобразует Order в JSON для API
   *
   * @param order - Order для сериализации
   * @returns Plain object
   *
   * @remarks
   * Включает все поля Order + вычисляемые поля.
   * Подходит для JSON.stringify().
   *
   * @example
   * ```typescript
   * const json = OrderViewModel.toJSON(order);
   * console.log(JSON.stringify(json, null, 2));
   * ```
   */
  public static toJSON(order: Order): Record<string, unknown> {
    return {
      id: order.id,
      marketId: order.marketId,
      tokenId: order.tokenId,
      side: order.side,
      price: order.price.value().toNumber(),
      size: order.size.value().toNumber(),
      status: order.status,
      timestamp: order.timestamp.toISOString(),
      strategyId: order.strategyId,
      fill: {
        filledSize: order.fill.getFilledSize().value().toNumber(),
        averageFillPrice: order.fill.getAverageFillPrice()?.value().toNumber(),
        fillIds: Array.from(order.fill.getFillIds()),
        fillCount: order.fill.getTradeCount(),
      },
      reason: order.reason,
      // Вычисляемые поля
      notional: order.getNotional().toNumber(),
      remainingSize: order.getRemainingSize().value().toNumber(),
      fillPercentage: order.getFillPercentage().toNumber(),
    };
  }

  /**
   * Преобразует Order в читаемую строку
   *
   * @param order - Order для форматирования
   * @returns Читаемая строка
   *
   * @remarks
   * Используется для логирования и отладки.
   *
   * @example
   * ```typescript
   * console.log(OrderViewModel.toReadable(order));
   * // "Order[order-123]: BUY 100 @ 0.65 (OPEN) - 30% filled"
   * ```
   */
  public static toReadable(order: Order): string {
    const fillInfo = order.fill.isEmpty()
      ? 'unfilled'
      : `${order.getFillPercentage().toFixed(1)}% filled`;

    return `Order[${order.id}]: ${order.side} ${order.size.value().toNumber()} @ ${order.price.value().toNumber()} (${
      order.status
    }) - ${fillInfo}`;
  }

  /**
   * Преобразует Order в summary для UI списков
   *
   * @param order - Order для summary
   * @returns OrderSummary объект
   *
   * @remarks
   * Минимальный набор полей для отображения в таблицах/списках.
   * Все числа в примитивных типах для простоты.
   *
   * @example
   * ```typescript
   * const summary = OrderViewModel.toSummary(order);
   * console.log(`${summary.id}: ${summary.status}`);
   * ```
   */
  public static toSummary(order: Order): OrderSummary {
    return {
      id: order.id,
      status: order.status,
      side: order.side,
      price: order.price.value().toNumber(),
      size: order.size.value().toNumber(),
      filled: order.fill.getFilledSize().value().toNumber(),
      remaining: order.getRemainingSize().value().toNumber(),
      fillPercentage: order.getFillPercentage().toNumber(),
    };
  }
}
