import { asOnChainProtocolId } from './ProtocolId.js';
import { parseChainId } from './ChainId.js';
import { parseConditionId } from './ConditionId.js';
import { asVenueId } from './VenueId.js';
import { escapeId, unescapeId, splitEscaped } from './utils/escaping.js';
/**
 * Type guard для проверки что ref является on-chain
 *
 * @param ref - ConditionRef для проверки
 * @returns true если ref является OnChainConditionRef
 *
 * @example
 * ```typescript
 * if (isOnChainConditionRef(ref)) {
 *   // TypeScript knows: ref has protocolId, chainId, conditionId
 *   const rpcUrl = getRpcUrl(ref.chainId);
 * }
 * ```
 */
export function isOnChainConditionRef(ref) {
    return ref.kind === 'ONCHAIN';
}
/**
 * Type guard для проверки что ref является off-chain
 *
 * @param ref - ConditionRef для проверки
 * @returns true если ref является OffChainConditionRef
 *
 * @example
 * ```typescript
 * if (isOffChainConditionRef(ref)) {
 *   // TypeScript knows: ref has venueId, marketId
 *   const apiUrl = getVenueApiUrl(ref.venueId);
 * }
 * ```
 */
export function isOffChainConditionRef(ref) {
    return ref.kind === 'OFFCHAIN';
}
/**
 * Сравнение двух ConditionRef на равенство
 *
 * @param a - Первая ссылка
 * @param b - Вторая ссылка
 * @returns true если ссылки идентичны
 *
 * @example
 * ```typescript
 * const ref1: ConditionRef = { kind: 'ONCHAIN', ... };
 * const ref2: ConditionRef = { kind: 'ONCHAIN', ... };
 *
 * if (conditionRefEquals(ref1, ref2)) {
 *   console.log('Same condition');
 * }
 * ```
 */
export function conditionRefEquals(a, b) {
    // Разные kinds - точно не равны
    if (a.kind !== b.kind) {
        return false;
    }
    if (a.kind === 'ONCHAIN' && b.kind === 'ONCHAIN') {
        return (a.protocolId === b.protocolId &&
            a.chainId === b.chainId &&
            a.conditionId === b.conditionId);
    }
    if (a.kind === 'OFFCHAIN' && b.kind === 'OFFCHAIN') {
        return a.venueId === b.venueId && a.marketId === b.marketId;
    }
    /* c8 ignore next */
    return false;
}
/**
 * Преобразование ConditionRef в строку для логирования
 *
 * @param ref - ConditionRef для преобразования
 * @returns Строковое представление
 *
 * @example
 * ```typescript
 * const onChain: OnChainConditionRef = { kind: 'ONCHAIN', ... };
 * console.log(conditionRefToString(onChain));
 * // → "ONCHAIN:POLYMARKET_CTF:137:0xabc123"
 *
 * const offChain: OffChainConditionRef = { kind: 'OFFCHAIN', ... };
 * console.log(conditionRefToString(offChain));
 * // → "OFFCHAIN:KALSHI:KXBTCUSDM-24APR"
 * ```
 */
export function conditionRefToString(ref) {
    if (ref.kind === 'ONCHAIN') {
        // ONCHAIN: protocolId, chainId, conditionId гарантированно НЕ содержат ':'
        // (проверяется валидацией), поэтому escaping не нужен
        return `ONCHAIN:${ref.protocolId}:${ref.chainId}:${ref.conditionId}`;
    }
    else {
        // OFFCHAIN: marketId может содержать ':', поэтому escape необходим
        const escapedMarketId = escapeId(ref.marketId);
        return `OFFCHAIN:${ref.venueId}:${escapedMarketId}`;
    }
}
/**
 * Парсинг ConditionRef из строки
 *
 * @param str - Строка в формате conditionRefToString()
 * @returns ConditionRef или undefined если формат неверный
 *
 * @example
 * ```typescript
 * const onChain = parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:0xabc123');
 * // → { kind: 'ONCHAIN', protocolId: 'POLYMARKET_CTF', chainId: 137, conditionId: '0xabc123' }
 *
 * const offChain = parseConditionRef('OFFCHAIN:KALSHI:KXBTCUSDM-24APR');
 * // → { kind: 'OFFCHAIN', venueId: 'KALSHI', marketId: 'KXBTCUSDM-24APR' }
 * ```
 */
export function parseConditionRef(str) {
    // Защита от non-string runtime-ввода через as any
    if (typeof str !== 'string') {
        return undefined;
    }
    // Сначала определяем kind через simple split (kind никогда не содержит ':')
    const firstColon = str.indexOf(':');
    if (firstColon === -1) {
        return undefined;
    }
    const kind = str.substring(0, firstColon);
    if (kind === 'ONCHAIN') {
        // ONCHAIN формат: ONCHAIN:protocolId:chainId:conditionId
        // protocolId, chainId, conditionId НЕ содержат ':' (гарантировано валидацией),
        // поэтому простой split() безопасен
        const parts = str.split(':');
        if (parts.length !== 4) {
            return undefined;
        }
        const [, protocolIdRaw, chainIdStr, conditionId] = parts;
        // Валидация и парсинг OnChainProtocolId (поддерживает custom protocols)
        const protocolId = asOnChainProtocolId(protocolIdRaw);
        if (!protocolId) {
            return undefined;
        }
        // Валидация ChainId
        const validatedChainId = parseChainId(chainIdStr);
        if (!validatedChainId) {
            return undefined;
        }
        // Валидация и нормализация ConditionId
        const validatedConditionId = parseConditionId(conditionId);
        if (!validatedConditionId) {
            return undefined;
        }
        return Object.freeze({
            kind: 'ONCHAIN',
            protocolId,
            chainId: validatedChainId,
            conditionId: validatedConditionId,
        });
    }
    if (kind === 'OFFCHAIN') {
        // OFFCHAIN формат: OFFCHAIN:venueId:marketId
        // marketId МОЖЕТ содержать escaped ':' (\:), поэтому используем splitEscaped
        // Передаём только подстроку после первого ':' (т.е. "venueId:marketId"),
        // чтобы not re-parse the 'OFFCHAIN' prefix
        const rest = str.substring(firstColon + 1);
        const parts = splitEscaped(rest);
        if (parts.length !== 2) {
            return undefined;
        }
        const [venueIdStr, escapedMarketId] = parts;
        // Валидация VenueId
        const validatedVenueId = asVenueId(venueIdStr);
        if (!validatedVenueId) {
            return undefined;
        }
        // Unescape marketId (splitEscaped возвращает escaped части)
        const marketId = unescapeId(escapedMarketId);
        // Валидация marketId: не пустой, не длиннее 256 символов, без control characters
        if (marketId.length === 0 || marketId.length > 256) {
            return undefined;
        }
        for (let i = 0; i < marketId.length; i++) {
            const code = marketId.charCodeAt(i);
            if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
                return undefined;
            }
        }
        return Object.freeze({
            kind: 'OFFCHAIN',
            venueId: validatedVenueId,
            marketId,
        });
    }
    return undefined;
}
//# sourceMappingURL=ConditionRef.js.map