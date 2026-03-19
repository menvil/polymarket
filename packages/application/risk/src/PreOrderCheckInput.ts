/**
 * Входные данные для пре-трейд риск-проверки.
 *
 * @remarks
 * Намеренно отделён от PlaceOrderInput:
 * PlaceOrderUseCase маппирует PlaceOrderInput → PreOrderCheckInput,
 * добавляя portfolio и openOrdersCount из хранилищ.
 * OrderRiskChecker не знает ничего об use-cases.
 *
 * @example
 * ```typescript
 * const input: PreOrderCheckInput = {
 *   portfolio,
 *   openOrdersCount: orderRepository.countByStrategyId(strategyId),
 *   side: Side.BUY,
 *   price,
 *   size,
 *   instrumentId,
 *   strategyId: 'my-strategy',
 * };
 * const result = checker.checkBeforeOrder(input);
 * ```
 */
import type { Portfolio } from '@polymarket/portfolio';
import type { InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';

export interface PreOrderCheckInput {
  /** Текущий portfolio пользователя */
  readonly portfolio: Portfolio;
  /** Количество открытых ордеров (из IOrderRepository.countByStrategyId()) */
  readonly openOrdersCount: number;
  /** Сторона ордера */
  readonly side: Side;
  /** Цена ордера */
  readonly price: Price;
  /** Объём ордера */
  readonly size: Quantity;
  /** ID торгового инструмента */
  readonly instrumentId: InstrumentId;
  /** ID стратегии (опционально — для per-strategy лимитов) */
  readonly strategyId?: string;
  /** Время до экспирации рынка (ms, опционально — для minTimeToExpiryMs проверки) */
  readonly timeToExpiryMs?: number;
}
