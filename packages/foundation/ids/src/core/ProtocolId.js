/**
 * Константы для известных on-chain протоколов
 *
 * @example
 * ```typescript
 * const protocol = KnownOnChainProtocols.POLYMARKET_CTF;
 * ```
 */
export const KnownOnChainProtocols = {
    POLYMARKET_CTF: 'POLYMARKET_CTF',
    UMA_CTF: 'UMA_CTF',
    GNOSIS_CTF: 'GNOSIS_CTF',
};
/**
 * Set известных on-chain протоколов для быстрой проверки
 * @internal
 */
const KNOWN_PROTOCOL_SET = new Set(Object.values(KnownOnChainProtocols));
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
export function isKnownOnChainProtocol(id) {
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
export function asOnChainProtocolId(raw) {
    // Формат: uppercase буквы, цифры, подчеркивания, 1-32 символа, не начинается с цифры
    // Regex автоматически запрещает ':' и '\' (не входят в [A-Z0-9_])
    if (!/^[A-Z_][A-Z0-9_]{0,31}$/.test(raw)) {
        return undefined;
    }
    return raw;
}
//# sourceMappingURL=ProtocolId.js.map