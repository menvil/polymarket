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
 * MarketOutcomeJSON — сериализованный исход рынка
 */
export interface MarketOutcomeJSON {
  /** Позиция в наборе исходов (0 или 1) */
  readonly index: number;
  /** Человекочитаемая метка исхода */
  readonly label: string;
  /** Canonical identity инструмента этого исхода */
  readonly instrumentId: string;
}

/**
 * MarketStateJSON — сериализованное состояние рынка
 *
 * @remarks
 * `resolvedOutcomeIndex` присутствует только при `status === 'RESOLVED'`;
 * в остальных случаях поле отсутствует, а не равно `null`.
 */
export interface MarketStateJSON {
  /** `'ACTIVE' | 'CLOSED' | 'RESOLVED'` */
  readonly status: string;
  /** Индекс победившего исхода — только для RESOLVED */
  readonly resolvedOutcomeIndex?: number;
}

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
  readonly family: string;
  /** Спецификация семейства `CRYPTO_UP_DOWN` */
  readonly crypto?: MarketCryptoSpecJSON;
}
