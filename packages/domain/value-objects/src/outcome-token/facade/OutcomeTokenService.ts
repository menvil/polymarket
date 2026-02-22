import { Result, Ok } from '@polymarket/result';
import { InvalidOutcomeTokenError, wrapOp } from '@polymarket/errors';
import type { ConditionRef, OutcomeKey } from '@polymarket/ids';
import { OutcomeToken } from '../core/index.js';

/**
 * Фасад для работы с OutcomeToken - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с outcome tokens.
 * Оркестрирует Core + error handling.
 *
 * **Контракт "Never Throw":**
 * Методы создания (create) ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Утилиты (equals) возвращают простые типы (boolean) и тоже не бросают исключения.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.cause - для core/math исключений: { name, message, stack? }
 * - context дополнительная информация (входные данные, etc)
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
 *   console.error(result.error.context);
 * }
 * ```
 */
export class OutcomeTokenService {
  /**
   * Название сервиса для error tracking
   * @internal
   */
  private static readonly SERVICE_NAME = 'OutcomeTokenService';

  /**
   * Создать OutcomeToken из condition reference и outcome key
   *
   * @param conditionRef - Ссылка на condition (on-chain или off-chain)
   * @param outcomeKey - Ключ outcome (UP, DOWN, etc)
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
   * - Если conditionRef.kind !== 'ONCHAIN' (тип не подходит для OutcomeToken)
   * - Если AssetIdHelpers.fromOutcomeToken() бросит (невалидные conditionRef/outcomeKey)
   *
   * Все ошибки проходят через wrapOp → гарантирован полный error context (op, opChain, cause).
   *
   * @example
   * ```typescript
   * // Правильный тип - создаётся успешно
   * const onChainRef: OnChainConditionRef = { kind: 'ONCHAIN', ... };
   * const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
   *
   * // Неправильный тип - возвращает ошибку
   * const offChainRef: OffChainConditionRef = { kind: 'OFFCHAIN', ... };
   * const result = OutcomeTokenService.create(offChainRef, BinaryOutcome.UP);
   * if (!result.ok) {
   *   console.log(result.error.message); // OutcomeToken requires on-chain condition
   *   console.log(result.error.context?.op); // 'create'
   * }
   * ```
   */
  public static create(
    conditionRef: ConditionRef,
    outcomeKey: OutcomeKey
  ): Result<OutcomeToken, InvalidOutcomeTokenError> {
    return wrapOp(
      OutcomeTokenService.SERVICE_NAME,
      'create',
      { conditionRef, outcomeKey },
      () => {
        // Type narrowing: OutcomeToken только для on-chain conditions
        if (conditionRef.kind !== 'ONCHAIN') {
          throw new InvalidOutcomeTokenError(
            (ctx) => `OutcomeToken requires on-chain condition, got: ${ctx.conditionRefKind}`,
            {
              context: {
                kind: 'not_onchain_condition',
                conditionRefKind: conditionRef.kind,
                outcomeKey: String(outcomeKey)
              }
            }
          );
        }

        // После проверки TypeScript знает: conditionRef это OnChainConditionRef
        // Может бросить Error из AssetIdHelpers.fromOutcomeToken()
        const token = OutcomeToken.of(conditionRef, outcomeKey);
        return Ok(token);
      },
      InvalidOutcomeTokenError
    );
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
