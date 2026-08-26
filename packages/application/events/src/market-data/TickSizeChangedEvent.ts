/**
 * Venue изменил шаг цены (tick size) инструмента.
 *
 * @remarks
 * Tick size определяет, какие цены вообще ПРЕДСТАВИМЫ в стакане и какие
 * лимитные цены venue примет. Его изменение — не диагностика, а вход
 * последующего execution: ордер, выставленный по старому шагу, будет
 * отвергнут. Поэтому событие canonical, а не лог.
 *
 * ### Почему `Price`, а не отдельный `TickSize` VO
 *
 * Шаг цены — величина ТОГО ЖЕ домена, что и цена outcome-токена
 * (`0.01`/`0.001`/`0.0001`), и он обязан быть кратен базовому тику
 * `Price.MIN`. Правила проверки шага уже живут в модуле `Price`
 * (`ValidateTickSize`, `ValidateTickSizeMultipleOfBaseTick`), поэтому
 * заводить второй тип для того же домена значило бы раздвоить инвариант.
 * Lifecycle/бизнес-логики у tick size нет — сущностью он не является.
 *
 * ### `oldTickSize` опционален
 *
 * Vendor не гарантирует предыдущее значение (в SDK-контракте
 * `old_tick_size` nullable/optional). Отсутствие означает «venue не
 * сообщил прежний шаг», и выдумывать его нельзя.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003).
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { Price } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

export type TickSizeChangedEvent = MessageEnvelope<
  'TICK_SIZE_CHANGED',
  {
    /** ID рынка (condition_id) */
    readonly marketId: MarketId;
    /** ID токена (UP/DOWN outcome token) */
    readonly instrumentId: InstrumentId;
    /** Прежний шаг цены — `undefined`, если venue его не сообщил */
    readonly oldTickSize: Price | undefined;
    /** Новый шаг цены */
    readonly newTickSize: Price;
    /** Timestamp изменения */
    readonly timestamp: Timestamp;
  }
>;
