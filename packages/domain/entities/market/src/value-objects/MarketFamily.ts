/**
 * MarketFamily — семейство внешнего prediction market
 *
 * @remarks
 * Семейство отвечает на вопрос «как устроен этот рынок структурно?»:
 * какой набор исходов он предлагает и какая предметная спецификация к нему
 * прилагается. Это **структурная** характеристика рынка, она не меняется
 * в течение жизни рынка (в отличие от {@link MarketState}, который отражает
 * наблюдаемое внешнее состояние).
 *
 * ### Почему union, а не branded string?
 * Пространство семейств закрытое и маленькое: каждое семейство требует
 * собственной доменной спецификации (для `CRYPTO_UP_DOWN` — актив и
 * длительность серии) и собственной ветки в маппинге Infrastructure → Domain.
 * Открытое множество значений здесь было бы обманом: неизвестное семейство
 * невозможно корректно интерпретировать. Сравни с `VenueId`/`CryptoAssetId` —
 * там пространство значений действительно открытое, поэтому branded ID.
 *
 * ### Поддерживаемые семейства
 * На данный момент поддерживается ровно одно:
 * - `CRYPTO_UP_DOWN` — бинарный рынок «цена актива вырастет/упадёт за окно».
 *
 * Добавление нового семейства — это добавление литерала сюда, ветки в
 * {@link MarketSpec} и ветки в маппинге Infrastructure. Компилятор
 * покажет все места, которые нужно дополнить (exhaustive switch).
 *
 * @example
 * ```typescript
 * const family: MarketFamily = 'CRYPTO_UP_DOWN';
 *
 * if (isValidMarketFamily(raw)) {
 *   // raw типизирован как MarketFamily
 * }
 * ```
 */

/**
 * MarketFamily — допустимые семейства рынков
 *
 * @remarks
 * Сейчас поддерживается единственное семейство `CRYPTO_UP_DOWN`.
 */
export type MarketFamily = 'CRYPTO_UP_DOWN';

/**
 * Список всех допустимых значений MarketFamily
 *
 * @remarks
 * Используется для runtime-валидации в {@link isValidMarketFamily}
 * и для сообщений об ошибках парсинга.
 */
export const MARKET_FAMILY_VALUES: readonly MarketFamily[] = ['CRYPTO_UP_DOWN'] as const;

/**
 * Type guard: проверяет что значение является допустимым MarketFamily
 *
 * @param v - Значение для проверки (обычно из сериализованных данных)
 * @returns true если v — допустимое семейство рынка
 *
 * @example
 * ```typescript
 * isValidMarketFamily('CRYPTO_UP_DOWN'); // → true
 * isValidMarketFamily('SPORTS');         // → false
 * isValidMarketFamily(null);             // → false
 * ```
 */
export function isValidMarketFamily(v: unknown): v is MarketFamily {
  return typeof v === 'string' && (MARKET_FAMILY_VALUES as readonly string[]).includes(v);
}
