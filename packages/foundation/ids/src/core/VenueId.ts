/**
 * VenueId - идентификатор venue (биржи/платформы)
 *
 * @remarks
 * Общий идентификатор venue для использования в балансах, аккаунтах.
 *
 * Используется для ответа на вопрос: "ГДЕ находятся деньги/токены?"
 *
 * Branded string для extensibility: можно добавлять новые venues
 * без изменения foundation layer.
 *
 * Известные venues:
 * - POLYMARKET: Polymarket prediction market
 * - KALSHI: Kalshi prediction market
 *
 * @example
 * ```typescript
 * import { KnownVenues, accountIdFromVenue } from '@polymarket/ids';
 *
 * const venue = KnownVenues.POLYMARKET;
 *
 * // Balance на конкретном venue
 * // accountIdFromVenue возвращает Result, нужно unwrap
 * // accountIdFromVenue возвращает Result — нужно проверить ok
 * const venueResult = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
 * const balance = venueResult.ok ? {
 *   venueId: KnownVenues.POLYMARKET,
 *   accountId: venueResult.value,
 *   amount: 10000
 * } : undefined;
 *
 * // Extensible: можно использовать custom venues
 * const customVenue = 'MY_CUSTOM_VENUE' as VenueId;
 * ```
 */
export type VenueId = string & { readonly __brand: 'VenueId' };

/**
 * Известные venues
 */
export const KnownVenues = {
  POLYMARKET: 'POLYMARKET' as VenueId,
  KALSHI: 'KALSHI' as VenueId,
} as const;

/**
 * Set известных venues для быстрой проверки
 * @internal
 */
const KNOWN_VENUE_SET = new Set<string>(Object.values(KnownVenues));

/**
 * Type guard для проверки известных venues
 *
 * @param id - Строка для проверки
 * @returns true если id является известным venue
 *
 * @remarks
 * Проверяет только известные venues (POLYMARKET, KALSHI).
 * Для проверки формата custom venues используй asVenueId().
 *
 * @example
 * ```typescript
 * isKnownVenue('POLYMARKET'); // → true
 * isKnownVenue('CUSTOM_VENUE'); // → false (неизвестный venue)
 * ```
 */
export function isKnownVenue(id: string): id is VenueId {
  return KNOWN_VENUE_SET.has(id);
}

/**
 * Валидация и парсинг VenueId
 *
 * @param raw - Строка для парсинга
 * @returns VenueId или undefined если формат невалидный
 *
 * @remarks
 * Валидирует формат VenueId:
 * - Только uppercase буквы, цифры, подчеркивания
 * - Длина 1-32 символа
 * - Не может начинаться с цифры
 * - НЕ содержит ':' или '\' (гарантия для round-trip сериализации)
 *
 * Формат гарантирует отсутствие ':' и '\' — это обеспечивает
 * корректную round-trip сериализацию в ConditionRef и AccountId,
 * где эти символы используются как разделители.
 *
 * Поддерживает как известные venues (POLYMARKET, KALSHI),
 * так и кастомные venues с валидным форматом.
 *
 * Для строгой проверки только известных venues используй isKnownVenue().
 *
 * @example
 * ```typescript
 * asVenueId('POLYMARKET'); // → 'POLYMARKET' as VenueId
 * asVenueId('MY_CUSTOM_VENUE'); // → 'MY_CUSTOM_VENUE' as VenueId
 * asVenueId('invalid-venue'); // → undefined (содержит дефис)
 * asVenueId('123VENUE'); // → undefined (начинается с цифры)
 * asVenueId(''); // → undefined (пустая строка)
 * asVenueId('has:colon'); // → undefined (содержит ':')
 * ```
 */
export function asVenueId(raw: string): VenueId | undefined {
  // Формат: uppercase буквы, цифры, подчеркивания, 1-32 символа, не начинается с цифры
  // Regex автоматически запрещает ':' и '\' (не входят в [A-Z0-9_])
  if (!/^[A-Z_][A-Z0-9_]{0,31}$/.test(raw)) {
    return undefined;
  }

  return raw as VenueId;
}
