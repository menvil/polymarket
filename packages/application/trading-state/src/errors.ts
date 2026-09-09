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
import type { DecimalPrice } from '@polymarket/value-objects';

/**
 * Market-scoped инструмент пришёл с другим рынком, чем зарегистрирован.
 *
 * @remarks
 * Молча перенести инструмент между рынками нельзя: это либо ошибка
 * маршрутизации в адаптере, либо коллизия идентификаторов, и в обоих
 * случаях дальнейшее состояние будет неверным. Подписки проектора critical,
 * поэтому отказ виден публикующей стороне как `Err` из `publish()`, а не
 * теряется. Что с ним делает живой контур — вопрос композиции, он решается
 * отдельно и до включения Strategy.
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
 * ошибкой. Подписки проектора critical: отказ возвращается публикующей
 * стороне как `Err` из `publish()`, а не глотается шиной. Что с этим делает
 * живой контур — вопрос композиции, он решается отдельно и до включения
 * Strategy.
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

/**
 * Цена пришла не в том домене, который соответствует владельцу ряда.
 *
 * @remarks
 * Ценовой домен однозначно следует из маршрута: market-scoped наблюдение
 * принадлежит рынку предсказаний (`OutcomePrice`, диапазон (0, 1)), shared —
 * площадке актива (`AssetPrice`, без верхней границы). Canonical-событие
 * несёт общий `DecimalPrice`, и сужение делается на границе.
 *
 * Несовпадение означает ошибку маршрутизации в адаптере: цена BTC поехала в
 * рынок предсказаний либо доля исхода — в ленту биржи. Положить её в ряд
 * значило бы отдать стратегии величину другой размерности.
 *
 * Проверено на записанных данных: 7 163 758 ценовых уровней Polymarket из
 * run-05 укладываются в [0.001, 0.999], то есть законных нарушений нет.
 *
 * @example
 * ```typescript
 * throw new PriceDomainMismatchError('OutcomePrice', assetPrice);
 * ```
 */
export class PriceDomainMismatchError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param expected - Домен, которого требует владелец ряда
   * @param received - Цена, пришедшая в наблюдении
   */
  constructor(
    public readonly expected: 'OutcomePrice' | 'AssetPrice',
    public readonly received: DecimalPrice,
  ) {
    super(
      `Price domain mismatch: expected ${expected}, got ${received.constructor.name} ` +
        `with value ${received.value().toString()}`,
      { context: { expected, actual: received.constructor.name } },
    );
  }
}
