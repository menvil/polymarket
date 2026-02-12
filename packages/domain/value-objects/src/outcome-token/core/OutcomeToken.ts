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
 * Содержит:
 * 1. **Инварианты существования** (проверки при создании):
 *    - conditionRef должен быть OnChainConditionRef (KIND = 'ONCHAIN')
 *    - assetId должен иметь тип OUTCOME_TOKEN
 *
 * 2. **Чистые accessors** (query методы):
 *    - assetId() - полный идентификатор актива
 *    - conditionRef() - извлекается из assetId
 *    - outcomeKey() - извлекается из assetId
 *    - equals() - сравнение двух outcome tokens
 *
 * НЕ содержит:
 * - Балансы (используй TokenBalance)
 * - Количества (используй AssetQuantity)
 * - Settlement логику (используй domain services)
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
 * @example
 * ```typescript
 * import { OutcomeToken } from '@polymarket/value-objects';
 * import { BinaryOutcome, KnownOnChainProtocols, KnownChainIds } from '@polymarket/ids';
 *
 * // ✅ В Core и Facade (throws)
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
 * // Query methods (conditionRef и outcomeKey извлекаются из assetId)
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
  private constructor(private readonly _assetId: AssetId) {}

  /**
   * Создать OutcomeToken из on-chain condition ref и outcome key
   *
   * @param conditionRef - On-chain ссылка на condition
   * @param outcomeKey - Ключ outcome (UP, DOWN, etc)
   * @returns Новый OutcomeToken
   * @throws {OutcomeTokenInvariantViolation} Если нарушены инварианты
   *
   * @remarks
   * Автоматически создает AssetId из conditionRef + outcomeKey.
   * AssetId становится единственным источником данных (Single Source of Truth).
   *
   * Инварианты:
   * - conditionRef должен быть ONCHAIN (проверяется типом)
   * - AssetId создается корректно (гарантируется AssetIdHelpers)
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
    // Validate that conditionRef is on-chain (type system guarantees this)
    if (conditionRef.kind !== 'ONCHAIN') {
      throw new OutcomeTokenInvariantViolation(
        'ConditionRef must be ONCHAIN for outcome tokens',
        { conditionRef, outcomeKey }
      );
    }

    // Create AssetId from conditionRef + outcomeKey
    // AssetId содержит всю информацию - больше ничего хранить не нужно
    const assetId = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);

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
   * Извлекается из AssetId. AssetId типа OUTCOME_TOKEN всегда содержит
   * conditionRef внутри себя, поэтому нет необходимости хранить отдельно.
   *
   * @throws {OutcomeTokenInvariantViolation} Если assetId имеет неверный тип
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
    // AssetId типа OUTCOME_TOKEN содержит conditionRef
    if (this._assetId.type !== 'OUTCOME_TOKEN') {
      throw new OutcomeTokenInvariantViolation(
        'Invalid AssetId type: expected OUTCOME_TOKEN',
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
   * Извлекается из AssetId. AssetId типа OUTCOME_TOKEN всегда содержит
   * outcomeKey внутри себя, поэтому нет необходимости хранить отдельно.
   *
   * @throws {OutcomeTokenInvariantViolation} Если assetId имеет неверный тип
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
    // AssetId типа OUTCOME_TOKEN содержит outcomeKey
    if (this._assetId.type !== 'OUTCOME_TOKEN') {
      throw new OutcomeTokenInvariantViolation(
        'Invalid AssetId type: expected OUTCOME_TOKEN',
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
