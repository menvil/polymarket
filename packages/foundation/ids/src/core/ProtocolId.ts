/**
 * OnChainProtocolId - идентификатор on-chain протокола
 *
 * @remarks
 * Используется ТОЛЬКО для on-chain protocols (EVM-based).
 *
 * Branded string для extensibility: можно добавлять новые protocols
 * без изменения foundation layer.
 *
 * Известные on-chain протоколы:
 * - POLYMARKET_CTF: Gnosis Conditional Token Framework на Polygon
 * - UMA_CTF: UMA Conditional Token Framework
 * - GNOSIS_CTF: Generic Gnosis CTF на любом EVM chain
 *
 * ⚠️ ВАЖНО: Off-chain venues (KALSHI, PREDICTIT) НЕ являются protocols
 * и используют OffChainConditionRef вместо OnChainConditionRef.
 *
 * @example
 * ```typescript
 * import { KnownOnChainProtocols } from '@polymarket/ids';
 *
 * const protocolId = KnownOnChainProtocols.POLYMARKET_CTF;
 *
 * // Extensible: можно использовать custom protocols
 * const customProtocol = 'MY_CUSTOM_CTF' as OnChainProtocolId;
 * ```
 */
export type OnChainProtocolId = string & { readonly __brand: 'OnChainProtocolId' };

/**
 * Type guard для проверки известных on-chain протоколов
 *
 * @param id - Строка для проверки
 * @returns true если id является известным on-chain протоколом
 *
 * @example
 * ```typescript
 * if (isKnownOnChainProtocol('POLYMARKET_CTF')) {
 *   // это известный on-chain protocol
 * }
 * ```
 */
export function isKnownOnChainProtocol(id: string): id is OnChainProtocolId {
  return (
    id === 'POLYMARKET_CTF' ||
    id === 'UMA_CTF' ||
    id === 'GNOSIS_CTF'
  );
}

/**
 * Константы для известных on-chain протоколов
 *
 * @example
 * ```typescript
 * const protocol = KnownOnChainProtocols.POLYMARKET_CTF;
 * ```
 */
export const KnownOnChainProtocols = {
  POLYMARKET_CTF: 'POLYMARKET_CTF' as OnChainProtocolId,
  UMA_CTF: 'UMA_CTF' as OnChainProtocolId,
  GNOSIS_CTF: 'GNOSIS_CTF' as OnChainProtocolId,
} as const;

/**
 * Legacy type alias для обратной совместимости
 *
 * @deprecated Используй OnChainProtocolId вместо ProtocolId
 */
export type ProtocolId = OnChainProtocolId;

/**
 * Legacy function для обратной совместимости
 *
 * @deprecated Используй isKnownOnChainProtocol
 */
export const isKnownProtocol = isKnownOnChainProtocol;
