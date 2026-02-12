import type { AssetId, OnChainConditionRef, OutcomeKey } from '@polymarket/ids';
import { AssetIdHelpers, assetIdEquals } from '@polymarket/ids';
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
 * **Иммутабельность (гарантии)**:
 * - AssetId защищен через Object.freeze() на уровне @polymarket/ids
 * - Вложенные объекты (conditionRef) также заморожены (deep freeze)
 * - Попытка мутации через `as any` или `@ts-ignore` бросит исключение в strict mode
 * - Это критично для value object pattern: невозможно нарушить инварианты после создания
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
  /**
   * Private constructor с проверкой инвариантов
   *
   * @param _assetId - AssetId для хранения (Single Source of Truth)
   * @throws {OutcomeTokenInvariantViolation} Если assetId нарушает инварианты
   *
   * @remarks
   * Инварианты проверяются ОДИН РАЗ при создании:
   * - assetId.type === 'OUTCOME_TOKEN'
   *
   * После создания accessor'ы могут НЕ проверять - инварианты гарантированы.
   *
   * Используй публичные фабрики: of() или fromAssetId()
   */
  private constructor(private readonly _assetId: AssetId) {
    // Инвариант: AssetId должен быть типа OUTCOME_TOKEN
    if (_assetId.type !== 'OUTCOME_TOKEN') {
      throw new OutcomeTokenInvariantViolation(
        'OutcomeToken requires AssetId of type OUTCOME_TOKEN',
        { assetId: _assetId }
      );
    }

    // После этой проверки гарантировано:
    // - this._assetId.type === 'OUTCOME_TOKEN'
    // - this._assetId.conditionRef существует и является OnChainConditionRef
    // - this._assetId.outcomeKey существует
    //
    // Accessor'ы могут просто возвращать поля без проверок
  }

  /**
   * Создать OutcomeToken из AssetId
   *
   * @param assetId - AssetId с type OUTCOME_TOKEN
   * @returns Новый OutcomeToken
   * @throws {OutcomeTokenInvariantViolation} Если assetId.type !== 'OUTCOME_TOKEN'
   *
   * @remarks
   * Фабрика для создания из готового AssetId (например, из adapters/infrastructure).
   *
   * Constructor проверит инвариант: assetId.type === 'OUTCOME_TOKEN'
   *
   * @example
   * ```typescript
   * const assetId = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
   * const token = OutcomeToken.fromAssetId(assetId);
   * ```
   */
  public static fromAssetId(assetId: AssetId): OutcomeToken {
    // Constructor проверит инварианты
    return new OutcomeToken(assetId);
  }

  /**
   * Создать OutcomeToken из on-chain condition ref и outcome key
   *
   * @param conditionRef - On-chain ссылка на condition
   * @param outcomeKey - Ключ outcome (UP, DOWN, etc)
   * @returns Новый OutcomeToken
   * @throws {OutcomeTokenInvariantViolation} Если AssetId создан некорректно
   * @throws {Error} Если AssetIdHelpers.fromOutcomeToken() бросит (невалидный outcomeKey)
   *
   * @remarks
   * Фабрика для создания из domain объектов (conditionRef + outcomeKey).
   *
   * Автоматически создает AssetId из conditionRef + outcomeKey.
   * AssetId становится единственным источником данных (Single Source of Truth).
   *
   * **Гарантии типа**:
   * - conditionRef имеет тип OnChainConditionRef → kind === 'ONCHAIN' гарантировано TypeScript
   * - Проверка kind в runtime НЕ нужна (доверяем типам)
   * - Если данные могут быть невалидными (JSON/API), валидация должна быть в facade
   *
   * **Может бросить**:
   * - Error из AssetIdHelpers.fromOutcomeToken() если outcomeKey невалидный
   * - OutcomeTokenInvariantViolation из constructor если AssetId создан некорректно
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
  public static of(
    conditionRef: OnChainConditionRef,
    outcomeKey: OutcomeKey
  ): OutcomeToken {
    // Create AssetId from conditionRef + outcomeKey (доверяем AssetIdHelpers)
    const assetId = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);

    // Constructor проверит инвариант: assetId.type === 'OUTCOME_TOKEN'
    return new OutcomeToken(assetId);
  }

  /**
   * Asset ID для этого outcome token
   *
   * @returns AssetId с type OUTCOME_TOKEN
   *
   * @example
   * ```typescript
   * const assetId = token.assetId();
   * // → { type: 'OUTCOME_TOKEN', conditionRef: {...}, outcomeKey: 'UP' }
   * ```
   */
  public assetId(): AssetId {
    return this._assetId;
  }

  /**
   * On-chain condition reference
   *
   * @returns OnChainConditionRef (протокол, chain, condition ID)
   *
   * @remarks
   * Извлекается из AssetId.
   *
   * **Проверка типа**: Присутствует для TypeScript type narrowing (AssetId это union type).
   * В runtime эта проверка никогда не должна сработать - инварианты гарантированы constructor'ом.
   *
   * @example
   * ```typescript
   * const ref = token.conditionRef();
   * console.log(ref.protocolId); // 'POLYMARKET_CTF'
   * console.log(ref.chainId); // 137
   * console.log(ref.conditionId); // '0xabc...'
   * ```
   */
  public conditionRef(): OnChainConditionRef {
    // Type narrowing для TypeScript (AssetId это union: CURRENCY | OUTCOME_TOKEN)
    // В runtime это никогда не должно произойти - инварианты проверены в constructor
    if (this._assetId.type !== 'OUTCOME_TOKEN') {
      throw new OutcomeTokenInvariantViolation(
        'Invariant violation: AssetId must be OUTCOME_TOKEN (this should never happen)',
        { assetId: this._assetId }
      );
    }

    return this._assetId.conditionRef;
  }

  /**
   * Outcome key (UP, DOWN, etc)
   *
   * @returns OutcomeKey
   *
   * @remarks
   * Извлекается из AssetId.
   *
   * **Проверка типа**: Присутствует для TypeScript type narrowing (AssetId это union type).
   * В runtime эта проверка никогда не должна сработать - инварианты гарантированы constructor'ом.
   *
   * @example
   * ```typescript
   * const key = token.outcomeKey();
   * if (key === BinaryOutcome.UP) {
   *   console.log('This is an UP token');
   * }
   * ```
   */
  public outcomeKey(): OutcomeKey {
    // Type narrowing для TypeScript (AssetId это union: CURRENCY | OUTCOME_TOKEN)
    // В runtime это никогда не должно произойти - инварианты проверены в constructor
    if (this._assetId.type !== 'OUTCOME_TOKEN') {
      throw new OutcomeTokenInvariantViolation(
        'Invariant violation: AssetId must be OUTCOME_TOKEN (this should never happen)',
        { assetId: this._assetId }
      );
    }

    return this._assetId.outcomeKey;
  }

  /**
   * Сравнение двух OutcomeToken на равенство
   *
   * @param other - Другой OutcomeToken для сравнения
   * @returns true если tokens представляют одинаковый актив
   *
   * @remarks
   * Использует assetIdEquals() для сравнения AssetId.
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
  public equals(other: OutcomeToken): boolean {
    return assetIdEquals(this._assetId, other._assetId);
  }
}
