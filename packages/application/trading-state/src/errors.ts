/**
 * Ошибки инвариантов hot state.
 *
 * @remarks
 * Package-local: подходящего типа в общих пакетах нет, а `ValidationError`
 * описывает неверный ВХОД, тогда как здесь нарушается инвариант уже
 * накопленного состояния — это разные вещи для того, кто читает лог.
 */
import { TradingError } from '@polymarket/errors';
import type { InstrumentId, MarketId } from '@polymarket/ids';

/**
 * Market-scoped инструмент пришёл с другим рынком, чем зарегистрирован.
 *
 * @remarks
 * Молча перенести инструмент между рынками нельзя: это либо ошибка
 * маршрутизации в адаптере, либо коллизия идентификаторов, и в обоих
 * случаях дальнейшее состояние будет неверным. Отказ обязан быть видимым —
 * подписки проектора critical, и такая ошибка останавливает разбор очереди
 * вместо того, чтобы дать торговать по испорченному состоянию.
 *
 * @example
 * ```typescript
 * // instrument YES зарегистрирован за market X, приходит событие с market Y
 * throw new InstrumentMarketConflictError(yes, marketX, marketY);
 * ```
 */
export class InstrumentMarketConflictError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param instrumentId - Инструмент, вокруг которого конфликт
   * @param registeredMarketId - Рынок, за которым он уже закреплён
   * @param incomingMarketId - Рынок из пришедшего события
   */
  constructor(
    public readonly instrumentId: InstrumentId,
    public readonly registeredMarketId: MarketId,
    public readonly incomingMarketId: MarketId,
  ) {
    super(
      `Instrument ${instrumentId} is owned by market ${registeredMarketId}, ` +
        `but an event arrived for market ${incomingMarketId}`,
      {
        context: { instrumentId, registeredMarketId, incomingMarketId },
      },
    );
  }
}
