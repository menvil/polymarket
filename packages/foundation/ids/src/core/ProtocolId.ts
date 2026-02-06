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
 * Set известных on-chain протоколов для быстрой проверки
 * @internal
 */
const KNOWN_PROTOCOL_SET = new Set<string>(Object.values(KnownOnChainProtocols));

/**
 * Type guard для проверки известных on-chain протоколов
 *
 * @param id - Строка для проверки
 * @returns true если id является известным on-chain протоколом
 *
 * @remarks
 * Проверяет только известные протоколы (POLYMARKET_CTF, UMA_CTF, GNOSIS_CTF).
 * Для проверки формата custom protocols используй asOnChainProtocolId().
 *
 * @example
 * ```typescript
 * isKnownOnChainProtocol('POLYMARKET_CTF'); // → true
 * isKnownOnChainProtocol('CUSTOM_PROTO'); // → false (неизвестный protocol)
 * ```
 */
export function isKnownOnChainProtocol(id: string): id is OnChainProtocolId {
  return KNOWN_PROTOCOL_SET.has(id);
}

/**
 * Валидация и парсинг OnChainProtocolId
 *
 * @param raw - Строка для парсинга
 * @returns OnChainProtocolId или undefined если формат невалидный
 *
 * @remarks
 * Валидирует формат OnChainProtocolId:
 * - Только uppercase буквы, цифры, подчеркивания
 * - Длина 1-32 символа
 * - Не может начинаться с цифры
 * - НЕ содержит ':' или '\' (гарантия для round-trip сериализации)
 *
 * Поддерживает как известные protocols (POLYMARKET_CTF, UMA_CTF, GNOSIS_CTF),
 * так и кастомные protocols с валидным форматом.
 *
 * Для строгой проверки только известных protocols используй isKnownOnChainProtocol().
 *
 * @example
 * ```typescript
 * asOnChainProtocolId('POLYMARKET_CTF'); // → 'POLYMARKET_CTF' as OnChainProtocolId
 * asOnChainProtocolId('CUSTOM_PROTO'); // → 'CUSTOM_PROTO' as OnChainProtocolId
 * asOnChainProtocolId('invalid-proto'); // → undefined (содержит дефис)
 * asOnChainProtocolId('123PROTO'); // → undefined (начинается с цифры)
 * asOnChainProtocolId(''); // → undefined (пустая строка)
 * asOnChainProtocolId('has:colon'); // → undefined (содержит ':')
 * ```
 */
export function asOnChainProtocolId(raw: string): OnChainProtocolId | undefined {
  // Формат: uppercase буквы, цифры, подчеркивания, 1-32 символа, не начинается с цифры
  // Regex автоматически запрещает ':' и '\' (не входят в [A-Z0-9_])
  if (!/^[A-Z_][A-Z0-9_]{0,31}$/.test(raw)) {
    return undefined;
  }

  return raw as OnChainProtocolId;
}

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
