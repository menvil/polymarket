import { TokenBalanceErrorReason } from '../errors/TokenBalanceErrorReason.js';

/**
 * Исключение при нарушении инвариантов TokenBalance
 *
 * @remarks
 * Бросается ТОЛЬКО из Core слоя при создании TokenBalance через конструктор/фабрику.
 * Означает что внутренний стейт будет некорректным и объект не может существовать.
 *
 * Core НЕ использует Result<T, E> - бросает исключения напрямую.
 * Facade перехватывает исключения и конвертирует в Result.Err с InvalidTokenBalanceError.
 *
 * @example
 * ```typescript
 * // В Core (internal)
 * if (condition) {
 *   throw new TokenBalanceInvariantViolation('Cannot create TokenBalance', reason);
 * }
 *
 * // В Facade (catching)
 * try {
 *   const balance = TokenBalance.of(token, amount);
 *   return Ok(balance);
 * } catch (error) {
 *   if (error instanceof TokenBalanceInvariantViolation) {
 *     return Err(new InvalidTokenBalanceError(...));
 *   }
 * }
 * ```
 */
export class TokenBalanceInvariantViolation extends Error {
  constructor(
    message: string,
    public readonly reason?: TokenBalanceErrorReason
  ) {
    super(message);
    Object.setPrototypeOf(this, TokenBalanceInvariantViolation.prototype);
    this.name = 'TokenBalanceInvariantViolation';
  }
}
