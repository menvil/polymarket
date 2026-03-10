/**
 * OutcomeTokenInvariantViolation - нарушение инварианта OutcomeToken
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Возможные причины:
 * - ConditionRef не является OnChainConditionRef
 * - Некорректное создание AssetId
 *
 * @example
 * ```typescript
 * throw new OutcomeTokenInvariantViolation(
 *   'ConditionRef must be ONCHAIN for outcome tokens',
 *   { conditionRef, outcomeKey }
 * );
 * ```
 */
export class OutcomeTokenInvariantViolation extends Error {
    context;
    constructor(message, context) {
        super(`OutcomeToken invariant violation: ${message}`);
        Object.setPrototypeOf(this, OutcomeTokenInvariantViolation.prototype);
        this.name = 'OutcomeTokenInvariantViolation';
        this.context = context;
    }
}
//# sourceMappingURL=OutcomeTokenInvariantViolation.js.map