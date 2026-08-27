import { SpreadErrorReason } from '../errors/SpreadErrorReason.js';

/**
 * Типизированные причины нарушения инвариантов Spread
 *
 * @remarks
 * Ограничивает reason поле SpreadInvariantViolation только инвариантными причинами.
 * В текущей архитектуре существует только один инвариант: bid <= ask.
 *
 * OutcomePrice объекты уже валидированы при создании, поэтому проверка
 * "валидности" bid/ask невозможна и не нужна в Spread конструкторе.
 */
export type SpreadInvariantReason = typeof SpreadErrorReason.BID_GREATER_THAN_ASK;

/**
 * Исключение при нарушении инвариантов Spread
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Использует типизированный SpreadInvariantReason для строгой типизации причин.
 * Это подмножество SpreadErrorReason, ограниченное только инвариантными нарушениями.
 *
 * Единственная возможная причина (invariant violation):
 * - BID_GREATER_THAN_ASK: bid > ask (нарушение основного инварианта спреда)
 *
 * @remarks
 * INVALID_BID и INVALID_ASK НЕ являются инвариантами Spread, потому что:
 * - OutcomePrice объекты уже валидированы при создании
 * - TypeScript гарантирует корректность типов параметров
 * - Невалидный OutcomePrice не может существовать в runtime
 *
 * Архитектура error handling:
 * - Core бросает только SpreadInvariantViolation с BID_GREATER_THAN_ASK
 * - Rules возвращают Result с другими reasons (WIDTH_TOO_SMALL, WIDTH_TOO_LARGE)
 * - Facade возвращает Result с операционными reasons (INVALID_AMOUNT, INVALID_FORMAT, etc.)
 *
 * @example
 * ```typescript
 * // В Core:
 * if (bid.value().greaterThan(ask.value())) {
 *   throw new SpreadInvariantViolation(
 *     `Bid ${bid} cannot be greater than ask ${ask}`,
 *     SpreadErrorReason.BID_GREATER_THAN_ASK
 *   );
 * }
 *
 * // В Facade:
 * try {
 *   const spread = Spread.of(bid, ask);
 *   return Ok(spread);
 * } catch (error) {
 *   if (error instanceof SpreadInvariantViolation) {
 *     // error.reason имеет тип SpreadInvariantReason (type-safe!)
 *     return Err(new InvalidSpreadError(error.message, {
 *       context: { reason: error.reason }
 *     }));
 *   }
 * }
 * ```
 */
export class SpreadInvariantViolation extends Error {
  public readonly reason: SpreadInvariantReason;

  constructor(message: string, reason: SpreadInvariantReason) {
    super(`Spread invariant violation: ${message}`);
    this.name = 'SpreadInvariantViolation';
    this.reason = reason;
    Object.setPrototypeOf(this, SpreadInvariantViolation.prototype);
  }
}
