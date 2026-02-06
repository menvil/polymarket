import { Result, Ok, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import type { OnChainConditionRef, OutcomeKey } from '@polymarket/ids';
import { OutcomeToken, OutcomeTokenInvariantViolation } from '../core/index.js';
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
   * Создать OutcomeToken из on-chain condition и outcome key
   *
   * @param conditionRef - On-chain ссылка на condition
   * @param outcomeKey - Ключ outcome (UP, DOWN, etc)
   * @param source - Источник ошибки (опционально)
   * @returns Result с OutcomeToken или InvalidOutcomeTokenError
   *
   * @remarks
   * Никогда не бросает исключения - всегда возвращает Result.
   *
   * Возможные ошибки:
   * - NOT_ONCHAIN_CONDITION: если conditionRef.kind !== 'ONCHAIN'
   * - INVALID_CONDITION_REF: если conditionRef некорректен
   * - INVALID_OUTCOME_KEY: если outcomeKey некорректен
   *
   * @example
   * ```typescript
   * const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
   * if (!result.ok) {
   *   if (result.error.context?.reason === OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION) {
   *     console.error('OutcomeToken requires on-chain condition');
   *   }
   * }
   * ```
   */
  public static create(
    conditionRef: OnChainConditionRef,
    outcomeKey: OutcomeKey,
    source: ErrorSource = ErrorSource.SERVICE_CALL
  ): Result<OutcomeToken, InvalidOutcomeTokenError> {
    try {
      // Validate conditionRef kind
      if (conditionRef.kind !== 'ONCHAIN') {
        return Err(
          new InvalidOutcomeTokenError(
            `ConditionRef must be ONCHAIN for outcome tokens, got: ${conditionRef.kind}`,
            {
              reason: OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION,
              details: { conditionRef, outcomeKey },
            },
            source
          )
        );
      }

      // Create OutcomeToken (may throw OutcomeTokenInvariantViolation)
      const token = OutcomeToken.of(conditionRef, outcomeKey);

      return Ok(token);
    } catch (error) {
      // Catch OutcomeTokenInvariantViolation and other unexpected errors
      if (error instanceof OutcomeTokenInvariantViolation) {
        return Err(
          new InvalidOutcomeTokenError(
            `Failed to create OutcomeToken: ${error.message}`,
            {
              reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF,
              details: { conditionRef, outcomeKey },
            },
            source
          )
        );
      }

      // Unexpected error
      return Err(
        new InvalidOutcomeTokenError(
          `Unexpected error creating OutcomeToken: ${error instanceof Error ? error.message : String(error)}`,
          {
            details: { conditionRef, outcomeKey, error: String(error) },
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
