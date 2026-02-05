/**
 * VenueId - идентификатор venue (биржи/платформы)
 *
 * @remarks
 * Общий идентификатор venue для использования в балансах, аккаунтах.
 *
 * Используется для ответа на вопрос: "ГДЕ находятся деньги/токены?"
 *
 * Известные venues:
 * - POLYMARKET: Polymarket prediction market
 * - KALSHI: Kalshi prediction market
 *
 * @example
 * ```typescript
 * const venue: VenueId = 'POLYMARKET';
 *
 * // Balance на конкретном venue
 * const balance = {
 *   venueId: 'POLYMARKET' as VenueId,
 *   accountId: '0x1234...' as AccountId,
 *   amount: 10000
 * };
 * ```
 */
export type VenueId = 'POLYMARKET' | 'KALSHI' | (string & { readonly __brand: 'VenueId' });

/**
 * Известные venues
 */
export const KnownVenues = {
  POLYMARKET: 'POLYMARKET' as VenueId,
  KALSHI: 'KALSHI' as VenueId,
} as const;

/**
 * Type guard для проверки известных venues
 */
export function isKnownVenue(id: string): id is 'POLYMARKET' | 'KALSHI' {
  return id === 'POLYMARKET' || id === 'KALSHI';
}
