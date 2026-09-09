/**
 * Ошибки инвариантов hot state.
 *
 * @remarks
 * Package-local: подходящего типа в общих пакетах нет, а `ValidationError`
 * описывает неверный ВХОД, тогда как здесь нарушается инвариант уже
 * накопленного состояния — это разные вещи для того, кто читает лог.
 */
import { TradingError } from '@polymarket/errors';
import type { InstrumentId, MarketId, VenueId } from '@polymarket/ids';

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

/**
 * Идентичность внутри снимка стакана не совпала с идентичностью события.
 *
 * @remarks
 * Контракт `BOOK_DEPTH` требует, чтобы `venueId`/`marketId`/`instrumentId`
 * события повторяли те же поля самого `Orderbook`. Маршрутизация берётся из
 * payload, а в состояние кладётся snapshot — при расхождении книга рынка Y
 * тихо легла бы под ключом рынка X, и обнаружилось бы это только по
 * необъяснимым ценам в стратегии.
 *
 * Проверка дешёвая, а последствия молчания — нет, поэтому слой закрывается
 * ошибкой: подписки проектора critical, и такое событие останавливает
 * разбор очереди.
 *
 * @example
 * ```typescript
 * throw new BookIdentityMismatchError('instrumentId', payloadInstrument, snapshotInstrument);
 * ```
 */
export class BookIdentityMismatchError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param field - Какое поле идентичности разошлось
   * @param inPayload - Значение в payload события
   * @param inSnapshot - Значение внутри `Orderbook`
   */
  constructor(
    public readonly field: 'venueId' | 'marketId' | 'instrumentId',
    public readonly inPayload: VenueId | MarketId | InstrumentId | undefined,
    public readonly inSnapshot: VenueId | MarketId | InstrumentId | undefined,
  ) {
    super(
      `BOOK_DEPTH identity mismatch on ${field}: payload has ${String(inPayload)}, ` +
        `snapshot has ${String(inSnapshot)}`,
      { context: { field, inPayload, inSnapshot } },
    );
  }
}
