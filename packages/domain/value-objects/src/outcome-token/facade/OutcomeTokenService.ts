import { Result, Ok, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import type { ConditionRef, OutcomeKey } from '@polymarket/ids';
import { OutcomeToken } from '../core/index.js';
import { InvalidOutcomeTokenError, OutcomeTokenErrorReason } from '../errors/index.js';

/**
 * Фасад для работы с OutcomeToken - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с outcome tokens.
 * Оркестрирует Core + error handling.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы OutcomeTokenService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.cause - для core исключений: { name, message, stack? }
 * - context.reason - типизированная причина (OutcomeTokenErrorReason)
 *
 * @example
 * ```typescript
 * import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
 * import { BinaryOutcome, KnownOnChainProtocols } from '@polymarket/ids';
 *
 * const onChainRef: OnChainConditionRef = {
 *   kind: 'ONCHAIN',
 *   protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
 *   chainId: 137,
 *   conditionId: '0xabc...'
 * };
 *
 * const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
 * if (result.ok) {
 *   const token = result.value;
 *   console.log(token.outcomeKey()); // 'UP'
 * } else {
 *   console.error(result.error.message);
 *   console.error(result.error.context?.reason);
 * }
 * ```
 */
export class OutcomeTokenService {
  /**
   * Создать OutcomeToken из condition reference и outcome key
   *
   * @param conditionRef - Ссылка на condition (on-chain или off-chain)
   * @param outcomeKey - Ключ outcome (UP, DOWN, etc)
   * @param source - Источник ошибки (опционально)
   * @returns Result с OutcomeToken или InvalidOutcomeTokenError
   *
   * @remarks
   * Никогда не бросает исключения - всегда возвращает Result.
   *
   * **Type narrowing**: Принимает `ConditionRef` (union type) и проверяет что это
   * `OnChainConditionRef` (kind === 'ONCHAIN'). Это единственное место где должна
   * происходить эта проверка - core доверяет типам и не дублирует валидацию.
   *
   * Возможные ошибки:
   * - NOT_ONCHAIN_CONDITION: если conditionRef.kind !== 'ONCHAIN'
   * - INVALID_OUTCOME_KEY: если outcomeKey невалидный (из AssetIdHelpers)
   *
   * @example
   * ```typescript
   * // Правильный тип - создаётся успешно
   * const onChainRef: OnChainConditionRef = { kind: 'ONCHAIN', ... };
   * const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
   *
   * // Неправильный тип - возвращает NOT_ONCHAIN_CONDITION
   * const offChainRef: OffChainConditionRef = { kind: 'OFFCHAIN', ... };
   * const result = OutcomeTokenService.create(offChainRef, BinaryOutcome.UP);
   * if (!result.ok) {
   *   console.log(result.error.context?.reason); // NOT_ONCHAIN_CONDITION
   * }
   * ```
   */
  public static create(
    conditionRef: ConditionRef,
    outcomeKey: OutcomeKey,
    source: ErrorSource = ErrorSource.SERVICE_CALL
  ): Result<OutcomeToken, InvalidOutcomeTokenError> {
    // Type narrowing: OutcomeToken только для on-chain conditions
    if (conditionRef.kind !== 'ONCHAIN') {
      return Err(
        new InvalidOutcomeTokenError(
          `OutcomeToken requires on-chain condition, got: ${conditionRef.kind}`,
          {
            reason: OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION,
            details: { conditionRef, outcomeKey },
          },
          source
        )
      );
    }

    // После проверки TypeScript знает: conditionRef это OnChainConditionRef
    try {
      // Create OutcomeToken (может бросить Error из AssetIdHelpers если outcomeKey невалидный)
      const token = OutcomeToken.of(conditionRef, outcomeKey);

      return Ok(token);
    } catch (error) {
      // Ловим ошибки из AssetIdHelpers.fromOutcomeToken (невалидный outcomeKey)
      return Err(
        new InvalidOutcomeTokenError(
          `Failed to create OutcomeToken: ${error instanceof Error ? error.message : String(error)}`,
          {
            reason: OutcomeTokenErrorReason.INVALID_OUTCOME_KEY,
            details: {
              conditionRef,
              outcomeKey,
              error: error instanceof Error ? error.message : String(error),
            },
          },
          source
        )
      );
    }
  }

  /**
   * Сравнить два OutcomeToken на равенство
   *
   * @param a - Первый OutcomeToken
   * @param b - Второй OutcomeToken
   * @returns true если tokens представляют одинаковый актив
   *
   * @remarks
   * Never throws - безопасная утилита для сравнения.
   * Использует метод equals() из OutcomeToken core.
   *
   * @example
   * ```typescript
   * const token1Result = OutcomeTokenService.create(ref, BinaryOutcome.UP);
   * const token2Result = OutcomeTokenService.create(ref, BinaryOutcome.UP);
   *
   * if (token1Result.ok && token2Result.ok) {
   *   const same = OutcomeTokenService.equals(token1Result.value, token2Result.value);
   *   console.log(same); // → true
   * }
   * ```
   */
  public static equals(a: OutcomeToken, b: OutcomeToken): boolean {
    return a.equals(b);
  }
}
