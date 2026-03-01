/**
 * Параметры для создания Order
 *
 * @remarks
 * Типы используемые при создании Order через Order.create().
 * Включает как обязательные, так и опциональные параметры.
 */

import type { Price, Quantity, Side } from '@polymarket/value-objects';
import type { AssetId, OrderId } from '@polymarket/ids';
import type { OrderStatus } from '../value-objects/OrderStatus';
import type { OrderFill } from '../value-objects/OrderFill';

/**
 * Полные параметры для создания Order
 *
 * @remarks
 * Используется в Order.create().
 * Все поля валидируются перед созданием Order.
 * asset заменяет отдельные marketId + tokenId.
 */
export interface OrderParams {
  readonly id: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly status: OrderStatus;
  readonly timestamp: Date;
  readonly strategyId?: string;
  readonly fill?: OrderFill;
  readonly reason?: string;
}

/**
 * Параметры для создания новой заявки (PENDING)
 *
 * @remarks
 * Упрощенная версия для создания новой заявки.
 * Статус автоматически PENDING, fill пустой.
 * asset заменяет отдельные marketId + tokenId.
 */
export interface CreateOrderParams {
  readonly id: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly strategyId?: string;
}
