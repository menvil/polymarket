import type { OnChainProtocolId } from './ProtocolId.js';
import type { ChainId } from './ChainId.js';
import type { ConditionId } from './ConditionId.js';
import type { VenueId } from './VenueId.js';
/**
 * OnChainConditionRef - ссылка на on-chain condition
 *
 * @remarks
 * Используется для on-chain protocols (EVM-based), таких как:
 * - Polymarket CTF (Gnosis CTF на Polygon)
 * - UMA CTF
 * - Gnosis CTF на других chains
 *
 * Содержит всю необходимую информацию для идентификации on-chain condition:
 * - protocolId: какой протокол (POLYMARKET_CTF, UMA_CTF, etc)
 * - chainId: какой blockchain (137 = Polygon, 1 = Ethereum, etc)
 * - conditionId: хеш condition (обычно keccak256)
 *
 * **Инварианты (гарантируются валидацией)**:
 * - `protocolId` НЕ содержит ':' или '\' (проверяется при парсинге через asOnChainProtocolId)
 * - `chainId` НЕ содержит ':' или '\' (numeric, гарантированно безопасен)
 * - `conditionId` НЕ содержит ':' или '\' (проверяется при парсинге через parseConditionId)
 *
 * Благодаря этим инвариантам, сериализация ONCHAIN ref не требует escaping:
 * ```
 * ONCHAIN:protocolId:chainId:conditionId
 * ```
 *
 * @example
 * ```typescript
 * const onChainRef: OnChainConditionRef = {
 *   kind: 'ONCHAIN',
 *   protocolId: 'POLYMARKET_CTF',
 *   chainId: 137 as ChainId,
 *   conditionId: '0xabc123...' as ConditionId
 * };
 * ```
 */
export type OnChainConditionRef = Readonly<{
    /**
     * Discriminator для type narrowing
     */
    readonly kind: 'ONCHAIN';
    /**
     * On-chain протокол (POLYMARKET_CTF, UMA_CTF, GNOSIS_CTF)
     */
    readonly protocolId: OnChainProtocolId;
    /**
     * EVM blockchain network (137 = Polygon, 1 = Ethereum, etc)
     */
    readonly chainId: ChainId;
    /**
     * Уникальный ID condition (обычно keccak256 hash)
     */
    readonly conditionId: ConditionId;
}>;
/**
 * OffChainConditionRef - ссылка на off-chain condition/market
 *
 * @remarks
 * Используется для off-chain venues (regulated exchanges), таких как:
 * - KALSHI (regulated prediction market в США)
 * - PREDICTIT (regulated political prediction market)
 *
 * Off-chain venues не имеют blockchain и используют свои собственные market IDs.
 *
 * @example
 * ```typescript
 * const offChainRef: OffChainConditionRef = {
 *   kind: 'OFFCHAIN',
 *   venueId: 'KALSHI',
 *   marketId: 'KXBTCUSDM-24APR'
 * };
 * ```
 */
export type OffChainConditionRef = Readonly<{
    /**
     * Discriminator для type narrowing
     */
    readonly kind: 'OFFCHAIN';
    /**
     * Off-chain venue (KALSHI, PREDICTIT, etc)
     */
    readonly venueId: VenueId;
    /**
     * Venue-specific market ID
     *
     * @remarks
     * Формат зависит от venue:
     * - KALSHI: 'KXBTCUSDM-24APR'
     * - PREDICTIT: '7456' (numeric ID)
     */
    readonly marketId: string;
}>;
/**
 * ConditionRef - универсальная ссылка на condition
 *
 * @remarks
 * Discriminated union для on-chain и off-chain conditions.
 *
 * ⚠️ ВСЕГДА используй ConditionRef, НИКОГДА не используй голый ConditionId!
 *
 * **On-chain** (kind: 'ONCHAIN'):
 * - Имеет protocolId, chainId, conditionId
 * - Для EVM-based protocols (Polymarket CTF, UMA CTF)
 *
 * **Off-chain** (kind: 'OFFCHAIN'):
 * - Имеет venueId, marketId
 * - Для regulated exchanges (KALSHI, PREDICTIT)
 *
 * @example
 * ```typescript
 * function processCondition(ref: ConditionRef) {
 *   if (ref.kind === 'ONCHAIN') {
 *     // TypeScript знает: ref имеет protocolId, chainId, conditionId
 *     console.log(`On-chain: ${ref.protocolId} on chain ${ref.chainId}`);
 *     console.log(`Condition: ${ref.conditionId}`);
 *   } else {
 *     // TypeScript знает: ref имеет venueId, marketId
 *     console.log(`Off-chain: ${ref.venueId} market ${ref.marketId}`);
 *   }
 * }
 *
 * // On-chain example
 * const polymarket: ConditionRef = {
 *   kind: 'ONCHAIN',
 *   protocolId: 'POLYMARKET_CTF',
 *   chainId: 137 as ChainId,
 *   conditionId: '0xabc123...' as ConditionId
 * };
 *
 * // Off-chain example
 * const kalshi: ConditionRef = {
 *   kind: 'OFFCHAIN',
 *   venueId: 'KALSHI',
 *   marketId: 'KXBTCUSDM-24APR'
 * };
 * ```
 */
export type ConditionRef = OnChainConditionRef | OffChainConditionRef;
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
export declare function isOnChainConditionRef(ref: ConditionRef): ref is OnChainConditionRef;
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
export declare function isOffChainConditionRef(ref: ConditionRef): ref is OffChainConditionRef;
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
export declare function conditionRefEquals(a: ConditionRef, b: ConditionRef): boolean;
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
export declare function conditionRefToString(ref: ConditionRef): string;
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
export declare function parseConditionRef(str: string): ConditionRef | undefined;
//# sourceMappingURL=ConditionRef.d.ts.map