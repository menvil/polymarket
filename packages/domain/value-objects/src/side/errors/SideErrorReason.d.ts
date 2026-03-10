/**
 * Типизированные причины ошибок для Side операций
 *
 * @remarks
 * Используется в ValidationError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * Для Side набор ошибок минимален, так как это простой enum type.
 *
 * @example
 * ```typescript
 * import { SideErrorReason } from '@polymarket/value-objects';
 *
 * const result = SideService.fromString('INVALID');
 * if (!result.ok && result.error.context?.reason === SideErrorReason.INVALID_VALUE) {
 *   console.error('Invalid side value provided');
 * }
 * ```
 */
export declare enum SideErrorReason {
    /**
     * Значение является строкой, но не является валидным Side
     *
     * @remarks
     * Возникает ТОЛЬКО когда runtime-значение является string, но не входит в ALL_SIDES:
     * - 'buy' (lowercase)
     * - 'INVALID'
     * - пустая строка
     * - любой другой string кроме тех что в ALL_SIDES
     *
     * Для не-string типов (включая runtime `as any` в fromString/fromJSON)
     * всегда возвращается INVALID_TYPE.
     */
    INVALID_VALUE = "INVALID_VALUE",
    /**
     * Значение не является строкой (не string)
     *
     * @remarks
     * Возникает при ЛЮБОМ методе парсинга когда runtime-значение не является string:
     * - fromUnknown(123) — явно не string
     * - fromString(123 as any) — TypeScript type erasure через as any
     * - fromJSON(null as any) — аналогично
     *
     * Типы: number, boolean, symbol, function, null, undefined, object, array.
     * context.actualTag содержит `Object.prototype.toString` для точной диагностики.
     */
    INVALID_TYPE = "INVALID_TYPE"
}
//# sourceMappingURL=SideErrorReason.d.ts.map