import { AssetIdHelpers } from '@polymarket/ids';
import { OutcomeTokenInvariantViolation } from './OutcomeTokenInvariantViolation.js';
/**
 * Core OutcomeToken Value Object
 *
 * @remarks
 * Представляет tokenized position в on-chain prediction market.
 *
 * Outcome token это ERC-1155 токен который представляет позицию в конкретном
 * исходе (outcome) условия (condition). Например, "YES" или "NO" (теперь "UP" или "DOWN")
 * токен для рынка "BTC > $100k on 2025-12-31".
 *
 * **⚠️ ВАЖНО**: OutcomeToken только для **on-chain** markets!
 * Off-chain venues (KALSHI, PREDICTIT) не имеют tokenized positions.
 *
 * **Инварианты (проверяются в constructor)**:
 * 1. AssetId должен иметь type === 'OUTCOME_TOKEN'
 * 2. После создания инварианты гарантированы - accessor'ы не проверяют
 *
 * **Внутреннее представление**: Только AssetId (Single Source of Truth)
 * - conditionRef и outcomeKey извлекаются из assetId при обращении
 * - Это гарантирует согласованность и устраняет избыточность данных
 *
 * **Иммутабельность**:
 * - Гарантируется через defensive copy в fromAssetId()
 * - Внешний AssetId пересоздаётся через AssetIdHelpers, не сохраняется напрямую
 * - После создания OutcomeToken нет публичных методов для изменения состояния
 *
 * **Публичные фабрики**:
 * - `of(conditionRef, outcomeKey)` - создание из domain объектов
 * - `fromAssetId(assetId)` - создание из AssetId (для infrastructure/adapters)
 *
 * **Чистые accessors** (без проверок - инварианты гарантированы constructor'ом):
 * - `assetId()` - полный идентификатор актива
 * - `conditionRef()` - извлекается из assetId
 * - `outcomeKey()` - извлекается из assetId
 * - `equals()` - сравнение двух outcome tokens
 *
 * НЕ содержит:
 * - Балансы (используй TokenBalance)
 * - Количества (используй AssetQuantity)
 * - Settlement логику (используй domain services)
 *
 * @example
 * ```typescript
 * import { OutcomeToken } from '@polymarket/value-objects';
 * import { BinaryOutcome, KnownOnChainProtocols, KnownChainIds } from '@polymarket/ids';
 *
 * // ✅ Создание из domain объектов
 * const onChainRef: OnChainConditionRef = {
 *   kind: 'ONCHAIN',
 *   protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
 *   chainId: KnownChainIds.POLYGON,
 *   conditionId: '0xabc123...' as ConditionId
 * };
 *
 * const upToken = OutcomeToken.of(onChainRef, BinaryOutcome.UP);
 * const downToken = OutcomeToken.of(onChainRef, BinaryOutcome.DOWN);
 *
 * // ✅ Создание из AssetId (для adapters/infrastructure)
 * const assetId = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
 * const token = OutcomeToken.fromAssetId(assetId);
 *
 * // Query methods (просто извлекают из assetId без проверок)
 * console.log(upToken.assetId()); // { type: 'OUTCOME_TOKEN', ... }
 * console.log(upToken.outcomeKey()); // 'UP'
 * console.log(upToken.conditionRef()); // { kind: 'ONCHAIN', ... }
 *
 * // Comparison
 * upToken.equals(downToken); // → false
 *
 * // ❌ В публичном коде - используй OutcomeTokenService:
 * const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
 * if (!result.ok) {
 *   console.error(result.error);
 * }
 * ```
 */
export class OutcomeToken {
    _assetId;
    /**
     * Private constructor - принимает канонический OutcomeTokenAssetId
     *
     * @param _assetId - OutcomeTokenAssetId (канонический, прошедший через AssetIdHelpers)
     *
     * @remarks
     * Используй публичные фабрики: of() или fromAssetId()
     */
    constructor(_assetId) {
        this._assetId = _assetId;
    }
    /**
     * Приватная фабрика для создания из канонического AssetId
     *
     * @param assetId - Канонический OutcomeTokenAssetId (из AssetIdHelpers.fromOutcomeToken)
     * @returns Новый OutcomeToken
     *
     * @remarks
     * Вызывается из of() и fromAssetId() после создания канонического AssetId.
     * НЕ делает повторную каноникализацию - доверяет что assetId уже канонический.
     */
    static fromCanonicalAssetId(assetId) {
        return new OutcomeToken(assetId);
    }
    /**
     * Создать OutcomeToken из AssetId
     *
     * @param assetId - AssetId с type OUTCOME_TOKEN
     * @returns Новый OutcomeToken
     * @throws {OutcomeTokenInvariantViolation} Если assetId.type !== 'OUTCOME_TOKEN'
     * @throws {Error} Если AssetIdHelpers.fromOutcomeToken() бросит при пересоздании
     *
     * @remarks
     * Фабрика для создания из готового AssetId (например, из adapters/infrastructure).
     *
     * **Defensive copy**: Пересоздаёт AssetId через AssetIdHelpers для гарантии иммутабельности.
     * Входной assetId может быть из ненадёжного источника (JSON, parseAssetId).
     *
     * **Может бросить**:
     * - OutcomeTokenInvariantViolation если assetId.type !== 'OUTCOME_TOKEN'
     * - Error из AssetIdHelpers.fromOutcomeToken() если conditionRef/outcomeKey невалидны
     *
     * @example
     * ```typescript
     * const assetId = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
     * const token = OutcomeToken.fromAssetId(assetId);
     * ```
     */
    static fromAssetId(assetId) {
        // Type narrowing: проверяем что assetId типа OUTCOME_TOKEN
        if (assetId.type !== 'OUTCOME_TOKEN') {
            throw new OutcomeTokenInvariantViolation('OutcomeToken requires AssetId of type OUTCOME_TOKEN', { assetId });
        }
        // Defensive copy: пересоздаём AssetId через AssetIdHelpers
        // Это гарантирует иммутабельность + каноническую форму
        const canonicalResult = AssetIdHelpers.fromOutcomeToken(assetId.conditionRef, assetId.outcomeKey);
        if (!canonicalResult.ok) {
            throw new OutcomeTokenInvariantViolation('OutcomeToken: failed to canonicalize AssetId via AssetIdHelpers.fromOutcomeToken', { assetId, cause: canonicalResult.error });
        }
        // fromOutcomeToken ГАРАНТИРОВАННО возвращает OUTCOME_TOKEN
        return OutcomeToken.fromCanonicalAssetId(canonicalResult.value);
    }
    /**
     * Создать OutcomeToken из on-chain condition ref и outcome key
     *
     * @param conditionRef - On-chain ссылка на condition
     * @param outcomeKey - Ключ outcome (UP, DOWN, etc)
     * @returns Новый OutcomeToken
     * @throws {Error} Если AssetIdHelpers.fromOutcomeToken() бросит
     *
     * @remarks
     * Фабрика для создания из domain объектов (conditionRef + outcomeKey).
     *
     * Автоматически создает канонический AssetId из conditionRef + outcomeKey.
     * AssetId становится единственным источником данных (Single Source of Truth).
     *
     * **Гарантии типа**:
     * - conditionRef имеет тип OnChainConditionRef → kind === 'ONCHAIN' гарантировано TypeScript
     * - Проверка kind в runtime НЕ нужна (доверяем типам)
     * - Если данные могут быть невалидными (JSON/API), валидация должна быть в facade
     *
     * **Может бросить**:
     * - Error из AssetIdHelpers.fromOutcomeToken() если inputs невалидны
     *
     * @example
     * ```typescript
     * const onChainRef: OnChainConditionRef = {
     *   kind: 'ONCHAIN',
     *   protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
     *   chainId: 137,
     *   conditionId: '0xabc...'
     * };
     *
     * const token = OutcomeToken.of(onChainRef, BinaryOutcome.UP);
     * ```
     */
    static of(conditionRef, outcomeKey) {
        // Создаём канонический AssetId (доверяем AssetIdHelpers)
        const assetIdResult = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);
        if (!assetIdResult.ok) {
            throw new OutcomeTokenInvariantViolation('OutcomeToken: failed to create AssetId via AssetIdHelpers.fromOutcomeToken', { conditionRef, outcomeKey, cause: assetIdResult.error });
        }
        // fromOutcomeToken ГАРАНТИРОВАННО возвращает OUTCOME_TOKEN
        // Напрямую передаём в приватную фабрику - без повторной каноникализации
        return OutcomeToken.fromCanonicalAssetId(assetIdResult.value);
    }
    /**
     * Asset ID для этого outcome token
     *
     * @returns OutcomeTokenAssetId (тип OUTCOME_TOKEN гарантирован)
     *
     * @example
     * ```typescript
     * const assetId = token.assetId();
     * // → { type: 'OUTCOME_TOKEN', conditionRef: {...}, outcomeKey: 'UP' }
     * ```
     */
    assetId() {
        return this._assetId;
    }
    /**
     * On-chain condition reference
     *
     * @returns OnChainConditionRef (протокол, chain, condition ID)
     *
     * @remarks
     * Извлекается из AssetId без проверок - инварианты гарантированы fromAssetId().
     *
     * Поле _assetId имеет тип OutcomeTokenAssetId → conditionRef всегда существует.
     *
     * @example
     * ```typescript
     * const ref = token.conditionRef();
     * console.log(ref.protocolId); // 'POLYMARKET_CTF'
     * console.log(ref.chainId); // 137
     * console.log(ref.conditionId); // '0xabc...'
     * ```
     */
    conditionRef() {
        // Никаких проверок - доверяем типу OutcomeTokenAssetId
        return this._assetId.conditionRef;
    }
    /**
     * Outcome key (UP, DOWN, etc)
     *
     * @returns OutcomeKey
     *
     * @remarks
     * Извлекается из AssetId без проверок - инварианты гарантированы fromAssetId().
     *
     * Поле _assetId имеет тип OutcomeTokenAssetId → outcomeKey всегда существует.
     *
     * @example
     * ```typescript
     * const key = token.outcomeKey();
     * if (key === BinaryOutcome.UP) {
     *   console.log('This is an UP token');
     * }
     * ```
     */
    outcomeKey() {
        // Никаких проверок - доверяем типу OutcomeTokenAssetId
        return this._assetId.outcomeKey;
    }
    /**
     * Сравнение двух OutcomeToken на равенство
     *
     * @param other - Другой OutcomeToken для сравнения
     * @returns true если tokens представляют одинаковый актив
     *
     * @remarks
     * Использует AssetIdHelpers.equals() для сравнения AssetId.
     * Два outcome token равны если имеют одинаковый conditionRef и outcomeKey.
     *
     * @example
     * ```typescript
     * const token1 = OutcomeToken.of(ref, BinaryOutcome.UP);
     * const token2 = OutcomeToken.of(ref, BinaryOutcome.UP);
     * const token3 = OutcomeToken.of(ref, BinaryOutcome.DOWN);
     *
     * token1.equals(token2); // → true
     * token1.equals(token3); // → false
     * ```
     */
    equals(other) {
        return AssetIdHelpers.equals(this._assetId, other._assetId);
    }
}
//# sourceMappingURL=OutcomeToken.js.map