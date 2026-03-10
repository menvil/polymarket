import { OutcomeToken } from '../core/OutcomeToken.js';
/**
 * Форматтер для OutcomeToken
 *
 * @remarks
 * Предоставляет методы для форматирования OutcomeToken в строки
 * для UI и логирования.
 *
 * Все методы безопасны и не бросают исключений.
 *
 * @example
 * ```typescript
 * import { OutcomeTokenService, OutcomeTokenFormatter } from '@polymarket/value-objects/outcome-token';
 * import { BinaryOutcome } from '@polymarket/ids';
 *
 * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
 *
 * const display = OutcomeTokenFormatter.toDisplayString(token);
 * console.log(display);  // "UP (POLYMARKET_CTF:137:0xabc...)"
 *
 * const short = OutcomeTokenFormatter.toShortString(token);
 * console.log(short);    // "UP"
 * ```
 */
export declare class OutcomeTokenFormatter {
    /**
     * Форматирует OutcomeToken как полную строку с деталями
     *
     * @remarks
     * Включает outcomeKey и сокращенную информацию о condition.
     * Используется для логирования и диагностики.
     *
     * @param token - OutcomeToken для форматирования
     * @returns Отформатированная строка
     *
     * @example
     * ```typescript
     * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
     *
     * const str = OutcomeTokenFormatter.toString(token);
     * // → "OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc123...:UP"
     * ```
     */
    static toString(token: OutcomeToken): string;
    /**
     * Форматирует OutcomeToken для отображения в UI
     *
     * @remarks
     * Более читаемый формат с outcomeKey и кратким описанием protocol/chain.
     * Используется для UI элементов.
     *
     * @param token - OutcomeToken для форматирования
     * @returns Human-readable строка
     *
     * @example
     * ```typescript
     * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
     *
     * const display = OutcomeTokenFormatter.toDisplayString(token);
     * // → "UP (POLYMARKET_CTF:137:0xabc...)"
     * ```
     */
    static toDisplayString(token: OutcomeToken): string;
    /**
     * Форматирует OutcomeToken в краткую строку (только outcome key)
     *
     * @remarks
     * Минимальное представление - только ключ outcome.
     * Используется для компактного отображения в таблицах и списках.
     *
     * @param token - OutcomeToken для форматирования
     * @returns Краткая строка (только outcome key)
     *
     * @example
     * ```typescript
     * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
     *
     * const short = OutcomeTokenFormatter.toShortString(token);
     * // → "UP"
     * ```
     */
    static toShortString(token: OutcomeToken): string;
    /**
     * Форматирует OutcomeToken с полной информацией о condition
     *
     * @remarks
     * Включает все детали condition ref для debug/logging.
     * Используется для подробного логирования.
     *
     * @param token - OutcomeToken для форматирования
     * @returns Детальная строка с полной информацией
     *
     * @example
     * ```typescript
     * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
     *
     * const verbose = OutcomeTokenFormatter.toVerboseString(token);
     * // → "OutcomeToken[outcomeKey=UP, condition=ONCHAIN:POLYMARKET_CTF:137:0xabc...]"
     * ```
     */
    static toVerboseString(token: OutcomeToken): string;
}
//# sourceMappingURL=OutcomeTokenFormatter.d.ts.map