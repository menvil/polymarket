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
 * import { KnownVenues } from '@polymarket/ids';
 *
 * const venue = KnownVenues.POLYMARKET;
 *
 * // Balance на конкретном venue
 * const balance = {
 *   venueId: KnownVenues.POLYMARKET,
 *   accountId: accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123'),
 *   amount: 10000
 * };
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
 * Type guard для проверки известных venues
 *
 * @param id - Строка для проверки
 * @returns true если id является известным venue
 *
 * @example
 * ```typescript
 * if (isKnownVenue('POLYMARKET')) {
 *   // это известный venue
 * }
 * ```
 */
export function isKnownVenue(id: string): id is VenueId {
  return id === 'POLYMARKET' || id === 'KALSHI';
}
