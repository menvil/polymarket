/**
 * MarketJSON — сериализованное представление канонического Market
 *
 * @remarks
 * Форма, в которой canonical Market хранится в БД, кэше или передаётся по сети:
 * только JSON-примитивы, никаких VO и никаких классов.
 *
 * ### Почему отдельный тип, а не «просто unknown»
 * `MarketParser.from()` принимает `unknown` — он обязан выдерживать мусор из
 * внешнего источника. Но контракт того, что мы **сами пишем**, должен быть
 * явным и проверяемым компилятором: `MarketViewModel.toJSON()` возвращает
 * `MarketJSON`, и тот же самый тип парсер разбирает обратно. Без него
 * сериализация и парсинг разъезжаются молча — ровно то, что раньше и произошло
 * со старой парой `expirationMs`/`expirationDate`.
 *
 * ### Чего здесь нет
 * Vendor-полей. `MarketJSON` — сериализация **канонического** рынка, а не
 * Gamma/RTDS/SDK-объекта. Маппинг vendor → Domain делает Infrastructure,
 * и его промежуточные формы сюда не попадают.
 *
 * @example
 * ```typescript
 * const json = MarketViewModel.toJSON(market);
 * await db.save(JSON.stringify(json));
 *
 * const snapshotResult = MarketParser.from(JSON.parse(await db.load(id)));
 * ```
 */

/**
 * MarketOutcomeIndexJSON — сериализованная позиция исхода
 *
 * @remarks
 * Литералы объявлены здесь, а не импортированы из `value-objects`, — намеренно.
 * `MarketJSON` фиксирует **формат хранения**, который переживает переименования
 * в домене: если доменный литерал когда-нибудь изменится, несовпадение вылезет
 * ошибкой компиляции в `MarketViewModel.toJSON()`, а не молча поменяет формат
 * уже записанных данных. Ровно за этим wire-тип и отделён от доменного.
 */
export type MarketOutcomeIndexJSON = 0 | 1;

/**
 * MarketOutcomeJSON — сериализованный исход рынка
 */
export interface MarketOutcomeJSON {
  /** Позиция в наборе исходов */
  readonly index: MarketOutcomeIndexJSON;
  /** Человекочитаемая метка исхода */
  readonly label: string;
  /** Canonical identity инструмента этого исхода */
  readonly instrumentId: string;
}

/**
 * MarketStateJSON — сериализованное состояние рынка
 *
 * @remarks
 * Discriminated union, а не «`status: string` + необязательный индекс»:
 * `resolvedOutcomeIndex` физически существует только в варианте RESOLVED.
 * Плоская форма позволяла бы записать `{status: 'ACTIVE', resolvedOutcomeIndex: 1}`
 * — состояние, которого в домене не бывает, — и такой мусор дошёл бы до парсера
 * вместо того, чтобы не собраться.
 */
export type MarketStateJSON =
  | { readonly status: 'ACTIVE' }
  | { readonly status: 'CLOSED' }
  | {
    readonly status: 'RESOLVED';
    /** Индекс победившего исхода */
    readonly resolvedOutcomeIndex: MarketOutcomeIndexJSON;
  };

/**
 * MarketFamilyJSON — сериализованное семейство рынка
 *
 * @remarks
 * Литерал продублирован из домена сознательно — см. {@link MarketOutcomeIndexJSON}.
 */
export type MarketFamilyJSON = 'CRYPTO_UP_DOWN';

/**
 * MarketCryptoSpecJSON — сериализованная спецификация семейства `CRYPTO_UP_DOWN`
 */
export interface MarketCryptoSpecJSON {
  /** Базовый криптоактив (`'btc'`, `'eth'`, ...) */
  readonly asset: string;
  /** Номинальная длительность серии рынка в миллисекундах */
  readonly duration: number;
}

/**
 * MarketJSON — сериализованный канонический рынок
 *
 * @remarks
 * Временные метки — epoch milliseconds (number), как и в
 * `TimestampSerializer.toJSON()`. ISO-строки намеренно не используются:
 * один формат времени на весь проект дешевле, чем два.
 */
export interface MarketJSON {
  /** Идентификатор рынка в пространстве имён площадки */
  readonly id: string;
  /** Площадка, на которой наблюдается рынок */
  readonly venueId: string;
  /** URL-safe слаг рынка; поле отсутствует, если площадка слаг не публикует */
  readonly slug?: string;
  /** Вопрос рынка */
  readonly question: string;
  /** Запланированное начало торгов — epoch milliseconds */
  readonly startsAt: number;
  /** Запланированное окончание торгов — epoch milliseconds */
  readonly expiresAt: number;
  /** Подтверждённое внешнее состояние рынка */
  readonly state: MarketStateJSON;
  /** Исходы рынка: ровно два */
  readonly outcomes: readonly [MarketOutcomeJSON, MarketOutcomeJSON];
  /** Семейство рынка */
  readonly family: MarketFamilyJSON;
  /** Спецификация семейства `CRYPTO_UP_DOWN` */
  readonly crypto?: MarketCryptoSpecJSON;
}
