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
import type { MarketStatus } from '@polymarket/market';
import type { Timestamp } from '@polymarket/timestamp';
import type { DecimalPrice } from '@polymarket/value-objects';
import type { TradingMarketLifecycleStatus } from './lifecycle.js';
import type { TradingMarketStructureDifference } from './marketStructure.js';

/**
 * Принимаемый рынок заявляет инструмент, уже принадлежащий другому рынку.
 *
 * @remarks
 * Возникает при admission: инструменты исходов известны из canonical
 * `Market.outcomes`, и оба обязаны быть свободны. Занятый `instrumentId`
 * означает либо коллизию идентификаторов, либо ошибку в discovery — и в
 * обоих случаях дальнейшее состояние было бы неверным. Молча перенести
 * инструмент нельзя: часть истории осталась бы за старым рынком, и оба
 * состояния стали бы неправильными.
 *
 * Отказ приходит ДО любой мутации, поэтому конфликт по ВТОРОМУ исходу не
 * оставляет за собой ни первого инструмента, ни самого рынка.
 *
 * Подписки проектора critical, поэтому отказ виден публикующей стороне как
 * `Err` из `publish()`, а не теряется. Что с ним делает живой контур — вопрос
 * композиции, он решается отдельно и до включения Strategy.
 *
 * @example
 * ```typescript
 * // instrument YES зарегистрирован за market X, admission market Y заявляет его же
 * throw new InstrumentMarketConflictError(yes, marketX, marketY);
 * ```
 */
export class InstrumentMarketConflictError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param instrumentId - Инструмент, вокруг которого конфликт
   * @param registeredMarketId - Рынок, за которым он уже закреплён
   * @param incomingMarketId - Рынок, который пытались принять
   */
  constructor(
    public readonly instrumentId: InstrumentId,
    public readonly registeredMarketId: MarketId,
    public readonly incomingMarketId: MarketId,
  ) {
    super(
      `Instrument ${instrumentId} is owned by market ${registeredMarketId}, ` +
        `but market ${incomingMarketId} claims it too`,
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

/**
 * Рынок уже принят торговым рантаймом.
 *
 * @remarks
 * Повторный `TRADING_MARKET_ADMITTED` — не обновление metadata и не
 * идемпотентное наблюдение. Admission создаёт состояние рынка с нуля:
 * жизненный цикл, оба инструмента, записи индекса. Принять его второй раз
 * значило бы либо стереть уже накопленную warm history, либо молча оставить
 * старое состояние, притворившись, что мутация была.
 *
 * Обновлять сохранённый `Market` умеет только `TRADING_MARKET_RESOLVED` — и
 * только при совпадении trading-critical структуры.
 *
 * @example
 * ```typescript
 * throw new TradingMarketAlreadyAdmittedError(marketId, 'ACTIVE');
 * ```
 */
export class TradingMarketAlreadyAdmittedError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param marketId - Рынок, по которому пришло повторное admission
   * @param currentStatus - Статус, в котором рынок находится сейчас
   */
  constructor(
    public readonly marketId: MarketId,
    public readonly currentStatus: TradingMarketLifecycleStatus,
  ) {
    super(
      `Trading market ${marketId} is already admitted (current lifecycle status ` +
        `${currentStatus}); admission is not an update`,
      { context: { marketId, currentStatus } },
    );
  }
}

/**
 * Рынок принимается не до открытия торгов.
 *
 * @remarks
 * Инвариант рантайма: рынок Polymarket всегда приобретается ДО открытия.
 * Ровно в `startsAt` уже поздно — стакан к этому моменту обязан быть
 * разогретым, а подписка установленной.
 *
 * Mid-market catch-up мы не поддерживаем сознательно: рынок, к которому
 * подключились посреди жизни, имеет пустую предысторию, и решения по нему
 * несравнимы с решениями по нормально принятому рынку.
 *
 * @example
 * ```typescript
 * throw new TradingMarketAdmissionTimingError(marketId, admittedAt, market.startsAt);
 * ```
 */
export class TradingMarketAdmissionTimingError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param marketId - Рынок, который пытались принять
   * @param admittedAt - Момент admission (`metadata.createdAt`)
   * @param startsAt - Начало торгов по расписанию рынка
   */
  constructor(
    public readonly marketId: MarketId,
    public readonly admittedAt: Timestamp,
    public readonly startsAt: Timestamp,
  ) {
    super(
      `Trading market ${marketId} must be admitted strictly before startsAt: ` +
        `admitted at ${admittedAt.toISO()}, market starts at ${startsAt.toISO()}`,
      {
        context: { marketId, admittedAt: admittedAt.toISO(), startsAt: startsAt.toISO() },
      },
    );
  }
}

/**
 * Рынок внешне уже не пригоден к admission.
 *
 * @remarks
 * Принять можно только рынок, который площадка публикует как `ACTIVE`.
 * `CLOSED`/`RESOLVED` означают, что торги на площадке уже кончились: заводить
 * под такой рынок торговое состояние нечем и не для чего.
 *
 * Это единственное место, где внешнее `Market.state` влияет на наш жизненный
 * цикл, — и влияет на ВХОД в него, а не на переходы внутри. Дальше два
 * lifecycle идут независимо: `market.state = ACTIVE` при нашем
 * `TRADING_CLOSED` полностью законно.
 *
 * @example
 * ```typescript
 * throw new TradingMarketAdmissionStateError(marketId, 'RESOLVED');
 * ```
 */
export class TradingMarketAdmissionStateError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param marketId - Рынок, который пытались принять
   * @param venueStatus - Внешнее состояние рынка на площадке
   */
  constructor(
    public readonly marketId: MarketId,
    public readonly venueStatus: MarketStatus,
  ) {
    super(
      `Trading market ${marketId} cannot be admitted: venue state is ${venueStatus}, ` +
        `expected ACTIVE`,
      { context: { marketId, venueStatus } },
    );
  }
}

/**
 * Что именно не так с запрошенным переходом жизненного цикла.
 *
 * @remarks
 * - `NOT_ADMITTED` — рынка нет в торговом состоянии: lifecycle-событие пришло
 *   раньше admission либо по чужому рынку;
 * - `PHASE` — переход запрещён из текущего статуса (строгий FSM);
 * - `TIMING` — переход нарушает временной инвариант;
 * - `PAYLOAD` — payload события не соответствует переходу (например,
 *   `TRADING_MARKET_RESOLVED` с неразрешённым рынком).
 */
export type TradingMarketTransitionViolation = 'NOT_ADMITTED' | 'PHASE' | 'TIMING' | 'PAYLOAD';

/**
 * Переход жизненного цикла отвергнут.
 *
 * @remarks
 * Один тип на все переходы намеренно: разница между «активировали дважды» и
 * «финализировали до резолюции» — это значения полей, а не разные виды
 * отказа. Отдельный класс на каждую пару статусов дал бы двадцать классов с
 * одинаковым телом.
 *
 * Отказ ВСЕГДА возвращается до мутации: рынок, жизненный цикл, инструменты,
 * индексы и версия остаются нетронутыми.
 *
 * @example
 * ```typescript
 * // Активация из ACTIVE — фаза не та
 * throw new TradingMarketLifecycleTransitionError(marketId, 'ACTIVE', 'ACTIVE', 'PHASE');
 * // Финализация рынка, которого нет в состоянии
 * throw new TradingMarketLifecycleTransitionError(marketId, 'FINALIZED', undefined, 'NOT_ADMITTED');
 * ```
 */
export class TradingMarketLifecycleTransitionError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param marketId - Рынок, по которому пришло lifecycle-событие
   * @param target - Статус, в который просили перейти
   * @param current - Текущий статус; `undefined`, если рынок не принят
   * @param violation - Причина отказа
   * @param detail - Уточнение для лога (нарушенный инвариант, времена)
   */
  constructor(
    public readonly marketId: MarketId,
    public readonly target: TradingMarketLifecycleStatus,
    public readonly current: TradingMarketLifecycleStatus | undefined,
    public readonly violation: TradingMarketTransitionViolation,
    public readonly detail?: string,
  ) {
    super(
      `Trading market ${marketId} cannot transition ${current ?? 'NOT_ADMITTED'} → ${target} ` +
        `(${violation})${detail === undefined ? '' : `: ${detail}`}`,
      {
        context: {
          marketId,
          target,
          current: current ?? null,
          violation,
          ...(detail === undefined ? {} : { detail }),
        },
      },
    );
  }
}

/**
 * Наблюдение пришло по инструменту, которого у принятого рынка нет.
 *
 * @remarks
 * Это не «чужой рынок» — рынок как раз наш, принятый. Инструменты рынка
 * известны из canonical `Market.outcomes` с самого admission, поэтому третий
 * `instrumentId` под тем же `marketId` означает нарушение canonical
 * маршрутизации: либо адаптер собрал событие неверно, либо идентификаторы
 * коллизировали.
 *
 * Слой закрывается ошибкой, а не создаёт инструмент: созданный «на всякий
 * случай» третий ряд принял бы данные, которые не относятся ни к одному
 * исходу, и стратегия читала бы их как рыночные.
 *
 * Проверка идёт по структуре рынка ДО проверки фазы: нарушение маршрутизации
 * остаётся нарушением и после остановки торгов, тогда как поздние наблюдения
 * по ЗАКОННОМУ инструменту — норма и просто игнорируются.
 *
 * @example
 * ```typescript
 * throw new UnknownTradingMarketInstrumentError(marketId, other, [yes, no]);
 * ```
 */
export class UnknownTradingMarketInstrumentError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param marketId - Принятый рынок из события
   * @param instrumentId - Инструмент, которого у рынка нет
   * @param marketInstrumentIds - Инструменты исходов рынка
   */
  constructor(
    public readonly marketId: MarketId,
    public readonly instrumentId: InstrumentId,
    public readonly marketInstrumentIds: readonly InstrumentId[],
  ) {
    super(
      `Instrument ${instrumentId} does not belong to admitted trading market ${marketId} ` +
        `(outcome instruments: ${marketInstrumentIds.join(', ')})`,
      { context: { marketId, instrumentId, marketInstrumentIds: [...marketInstrumentIds] } },
    );
  }
}

/**
 * Пришедший рынок отличается от принятого trading-critical структурой.
 *
 * @remarks
 * `TRADING_MARKET_RESOLVED` заменяет сохранённый `Market` целиком, поэтому
 * структура обязана совпасть: расписание, позиции и `InstrumentId` исходов,
 * семейство и его спецификация. Иначе накопленная история инструментов и
 * будущие ордера относились бы к структуре, которой в состоянии больше нет.
 *
 * `question`/`slug` в сравнение НЕ входят: площадка вправе уточнить
 * формулировку, и это не меняет предмет торговли. `state` тем более —
 * его изменение и есть смысл резолюции.
 *
 * @example
 * ```typescript
 * throw new TradingMarketStructureConflictError(marketId, {
 *   field: 'startsAt',
 *   admitted: '2026-09-01T12:00:00.000Z',
 *   incoming: '2026-09-01T12:05:00.000Z',
 * });
 * ```
 */
export class TradingMarketStructureConflictError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param marketId - Рынок, по которому пришло событие
   * @param difference - Первое найденное расхождение структуры
   */
  constructor(
    public readonly marketId: MarketId,
    public readonly difference: TradingMarketStructureDifference,
  ) {
    super(
      `Trading market ${marketId} structure conflict on ${difference.field}: ` +
        `admitted ${difference.admitted}, incoming ${difference.incoming}`,
      {
        context: {
          marketId,
          field: difference.field,
          admitted: difference.admitted,
          incoming: difference.incoming,
        },
      },
    );
  }
}
