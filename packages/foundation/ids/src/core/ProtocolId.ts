/**
 * ProtocolId - идентификатор протокола prediction market
 *
 * @remarks
 * Используется для идентификации протокола, на котором работает рынок.
 *
 * Известные протоколы:
 * - POLYMARKET_CTF: Polymarket Conditional Tokens Framework
 * - KALSHI: Kalshi protocol
 * - UMA_CTF: UMA Conditional Tokens Framework
 *
 * @example
 * ```typescript
 * const protocolId: ProtocolId = 'POLYMARKET_CTF';
 * ```
 */
export type ProtocolId =
  | 'POLYMARKET_CTF'
  | 'KALSHI'
  | 'UMA_CTF'
  | (string & { readonly __brand: 'ProtocolId' });

/**
 * Type guard для проверки известных протоколов
 */
export function isKnownProtocol(id: string): id is 'POLYMARKET_CTF' | 'KALSHI' | 'UMA_CTF' {
  return id === 'POLYMARKET_CTF' || id === 'KALSHI' || id === 'UMA_CTF';
}
