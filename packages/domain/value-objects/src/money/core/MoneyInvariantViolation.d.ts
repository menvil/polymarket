import { MoneyErrorReason } from '../errors/MoneyErrorReason.js';
/**
 * Исключение, выбрасываемое при нарушении инвариантов Money.
 *
 * @remarks
 * ## Инварианты Money (проверяются УЖЕ существующего Decimal + currency):
 * - Валюта должна быть поддерживаемой (USDC)
 * - Сумма должна быть конечным числом (finite)
 * - Сумма должна быть валидным числом (не NaN)
 * - Сумма не должна превышать MAX_AMOUNT (1e15)
 *
 * ## НЕ инвариант:
 * - Формат входных данных (парсинг number/string делается в MoneyService)
 *
 * Это исключение используется только внутри core слоя Money.
 * Facade слой (MoneyService) ловит это исключение и преобразует в Result.
 *
 * @example
 * ```typescript
 * throw new MoneyInvariantViolation('Amount exceeds maximum', MoneyErrorReason.EXCEEDS_MAX_AMOUNT);
 * ```
 */
export declare class MoneyInvariantViolation extends Error {
    readonly reason: MoneyErrorReason.UNSUPPORTED_CURRENCY | MoneyErrorReason.NAN | MoneyErrorReason.NON_FINITE | MoneyErrorReason.EXCEEDS_MAX_AMOUNT;
    constructor(message: string, reason: MoneyInvariantViolation['reason']);
}
//# sourceMappingURL=MoneyInvariantViolation.d.ts.map