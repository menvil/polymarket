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
export declare class OutcomeTokenInvariantViolation extends Error {
    readonly context?: unknown;
    constructor(message: string, context?: unknown);
}
//# sourceMappingURL=OutcomeTokenInvariantViolation.d.ts.map