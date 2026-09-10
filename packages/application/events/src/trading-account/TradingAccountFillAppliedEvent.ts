/**
 * Экономический эффект исполнения УЖЕ применён к аккаунту.
 *
 * @remarks
 * Отличие от старого `FILL_RECEIVED` принципиальное и не сводится к
 * переименованию:
 *
 * ```text
 * FILL_RECEIVED               исполнение получено и ЕЩЁ должно быть обработано
 * TRADING_ACCOUNT_FILL_APPLIED  экономика уже посчитана, вот итог
 * ```
 *
 * Это два разных уровня семантики, поэтому старое событие остаётся своему
 * потребителю, а приватное состояние строится только на новом.
 *
 * ### Почему нет `venueId`/`accountId` в payload
 *
 * Они уже есть в canonical `Fill` (`fill.venueId`, `fill.accountId`) —
 * исполнение по построению знает, чьё оно и где произошло. Продублировать их
 * в payload значило бы завести два места, которые обязаны совпадать, и
 * проверку на их расхождение.
 *
 * ### Почему `order` опционален
 *
 * Исполнение может прийти по заявке, которую приватное состояние ещё не
 * видело (пропущенное обновление, восстановление после разрыва). Тогда
 * producer передаёт только итоговый `Fill` + `Portfolio`. Если же та же
 * операция обновила и заявку — она идёт ТЕМ ЖЕ событием, чтобы состояние
 * не увидело исполнение без соответствующего `filledSize`.
 *
 * ### Producer
 *
 * Пока нет: будущий процессор приватных наблюдений публикует событие после
 * успешного применения экономики исполнения.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_ACCOUNT_FILL_APPLIED',
 *   payload: { fill, portfolio, order },
 *   metadata: metadataGenerator.nextChild(parentMetadata),
 * } satisfies TradingAccountFillAppliedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Fill } from '@polymarket/fill';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';

export type TradingAccountFillAppliedEvent = MessageEnvelope<
  'TRADING_ACCOUNT_FILL_APPLIED',
  {
    /**
     * Canonical факт исполнения — immutable и самодостаточный.
     *
     * @remarks
     * Несёт собственную идентичность аккаунта и площадки, поэтому
     * маршрутизация события берётся из него.
     */
    readonly fill: Fill;
    /** Портфель ПОСЛЕ применения экономики этого исполнения */
    readonly portfolio: Portfolio;
    /**
     * Заявка ПОСЛЕ применения того же исполнения, если она обновилась.
     *
     * @remarks
     * `order.id === fill.orderId`, `order.accountId === fill.accountId`,
     * `order.asset === fill.tokenId` — иначе событие описывает две разные
     * вещи сразу, и потребитель обязан его отвергнуть целиком.
     */
    readonly order?: Order;
  }
>;
