/**
 * MarketDuration — номинальная длительность серии рынков (branded milliseconds)
 *
 * @remarks
 * Внешние площадки публикуют crypto Up/Down рынки **сериями** фиксированной
 * номинальной длительности: 5-минутные, часовые и т.д. Номинальная длительность —
 * это структурная характеристика рынка (то, к какой серии он принадлежит),
 * и она известна из описания рынка ещё до того, как площадка сообщит
 * фактические границы окна.
 *
 * ### Почему это НЕ то же самое, что `expiresAt - startsAt`
 * `Market.duration()` возвращает **фактический** запланированный интервал
 * рынка. `MarketDuration` — **номинал серии**. Обычно они совпадают, но
 * совпадение не гарантируется: площадка может сдвинуть `startDate`/`endDate`
 * конкретного рынка на секунды (задержка публикации, выравнивание по TWAP-окну),
 * оставив рынок в той же 5-минутной серии.
 *
 * Поэтому Market хранит оба значения и **не** проверяет их на равенство:
 * номинал — это классификация, расписание — наблюдаемый факт. Приравнивание
 * их сделало бы невозможным описание реального рынка со сдвинутым окном.
 *
 * ### Почему branded number, а не VO-класс
 * `docs/architecture/boundary-contract.md`, Решение 3 запрещает заводить
 * VO-класс для длительностей: производная длительность считается через
 * `Timestamp.diffMs` (так и работает `Market.duration()`), а самостоятельная
 * величина остаётся `number(ms)`. Номинал серии — как раз вторая категория:
 * он не производная двух `Timestamp`, а свойство рынка. Единственное, чего
 * ему не хватало как голому `number` — инварианта «положительное целое»,
 * поэтому здесь branded-тип с парсером и ничего сверх того: ни класса,
 * ни `Decimal`, ни facade.
 *
 * @example
 * ```typescript
 * const fiveMinutes = asMarketDuration(5 * 60_000);   // → MarketDuration
 * const hourly = asMarketDuration(60 * 60_000);       // → MarketDuration
 *
 * asMarketDuration(0);      // → undefined (нулевая длительность)
 * asMarketDuration(-1000);  // → undefined (отрицательная)
 * asMarketDuration(1.5);    // → undefined (не целое число миллисекунд)
 * ```
 */

/**
 * MarketDuration — номинальная длительность серии рынков в миллисекундах
 */
export type MarketDuration = number & { readonly __brand: 'MarketDuration' };

/**
 * Верхняя граница номинальной длительности — 365 суток в миллисекундах
 *
 * @internal
 * @remarks
 * Защита от мусорных значений (перепутанные секунды/миллисекунды,
 * epoch-таймстемп, попавший в поле длительности).
 */
const MAX_MARKET_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Валидация и парсинг MarketDuration
 *
 * @param ms - Длительность в миллисекундах
 * @returns MarketDuration или `undefined`, если значение невалидно
 *
 * @remarks
 * Инварианты:
 * - конечное число (не NaN, не Infinity);
 * - целое число миллисекунд;
 * - строго положительное (рынок нулевой длительности не имеет смысла);
 * - не больше 365 суток (защита от перепутанных единиц измерения).
 *
 * @example
 * ```typescript
 * const duration = asMarketDuration(300_000);
 * if (duration !== undefined) {
 *   console.log(duration); // 300000 typed as MarketDuration
 * }
 * ```
 */
export function asMarketDuration(ms: number): MarketDuration | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || !Number.isInteger(ms)) {
    return undefined;
  }
  if (ms <= 0 || ms > MAX_MARKET_DURATION_MS) {
    return undefined;
  }
  return ms as MarketDuration;
}
