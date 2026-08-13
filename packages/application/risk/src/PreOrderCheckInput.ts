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
 *   // number, а не Promise — вызывающая сторона уже await-нула счётчик.
 *   openOrdersCount: await orderRepository.countByStrategyId(strategyId),
 *   side: 'BUY', // Side — строковый union ('BUY' | 'SELL'), не enum
 *   price,
 *   size,
 *   instrumentId,
 *   // Обязателен: pending BUY-экспозиция по инструменту (0, если нет/SELL).
 *   pendingBuyQuantityForInstrument: Quantity.of(new Decimal(0)),
 *   strategyId: 'my-strategy',
 *   timeToExpiryMs: 300_000, // опционально; undefined = данные недоступны
 * };
 * const result = checker.checkBeforeOrder(input);
 * ```
 */
import type { Portfolio } from '@polymarket/portfolio';
import type { InstrumentId, StrategyId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';

/**
 * Входные данные пре-трейд риск-проверки.
 *
 * @remarks
 * Назначение и пример конструирования — см. докблок модуля выше.
 */
export interface PreOrderCheckInput {
  /** Текущий portfolio пользователя */
  readonly portfolio: Portfolio;
  /**
   * Количество открытых ордеров для проверки `maxOpenOrders`.
   *
   * @remarks
   * ### Текущая семантика (per-strategy, НЕ account-wide):
   * `PlaceOrderUseCase` передаёт сюда `await orderRepo.countByStrategyId(strategyId)`
   * — счётчик локальных Order по `strategyId` (при `strategyId === undefined`
   * считаются ордера без стратегии). Это НЕ полный account-wide active-commitment
   * счётчик:
   * - submissions в статусе `UNKNOWN`/`VENUE_ACCEPTED` БЕЗ локального Order в него
   *   НЕ входят (Order ещё не сохранён);
   * - ордера ДРУГИХ стратегий того же аккаунта не учитываются.
   *
   * Account-wide active-commitment политика (дедупликация OrderRepository +
   * submission journal) — отдельная будущая задача, здесь намеренно не вводится.
   * Должно быть валидным целым `>= 0` (иначе `RISK_INPUT_INCOMPLETE`).
   */
  readonly openOrdersCount: number;
  /** Сторона ордера */
  readonly side: Side;
  /** Цена ордера */
  readonly price: Price;
  /** Объём ордера */
  readonly size: Quantity;
  /** ID торгового инструмента */
  readonly instrumentId: InstrumentId;
  /**
   * Суммарное КОЛИЧЕСТВО ТОКЕНОВ по уже held BUY-резервациям того же
   * (accountId, instrumentId) — pending BUY-экспозиция по инструменту.
   *
   * @remarks
   * Authoritative-агрегат из submission journal (см.
   * `IOrderSubmissionRepository.getPendingBuyQuantityForInstrument`): резервации
   * под ещё не исполненные/ambiguous BUY-ордера НЕ отражены в
   * `portfolio.getPosition()` (позиция появляется только после fill). Без учёта
   * этого слагаемого `maxPositionSize` проверялся бы только по исполненной части
   * и пропускал бы поток одновременных BUY, суммарно пробивающих лимит.
   *
   * Проекция позиции для `maxPositionSize`:
   * `filledQuantity + pendingBuyQuantityForInstrument + newBuyQuantity`.
   *
   * Для SELL не используется (position/exposure gates для SELL пропускаются).
   * Precheck вне lock передаёт `0` (fail-fast; authoritative-значение считается
   * под mutex в `PlaceOrderUseCase`).
   */
  readonly pendingBuyQuantityForInstrument: Quantity;
  /** ID стратегии (опционально — для per-strategy лимитов) */
  readonly strategyId?: StrategyId;
  /**
   * Время до экспирации рынка (ms). `undefined` = данные недоступны.
   *
   * @remarks
   * Fail-closed: для BUY при включённом `minTimeToExpiryMs` отсутствие значения
   * (`undefined`) даёт `RISK_INPUT_INCOMPLETE`. SELL не блокируется даже при
   * `undefined`. Отрицательное значение = рынок уже истёк → `TOO_CLOSE_TO_EXPIRY`
   * для BUY.
   */
  readonly timeToExpiryMs?: number;
}
