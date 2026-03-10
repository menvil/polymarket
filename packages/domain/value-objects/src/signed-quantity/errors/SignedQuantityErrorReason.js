/**
 * Типизированные причины ошибок для SignedQuantity операций
 *
 * @remarks
 * Используется в InvalidSignedQuantityError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * @example
 * ```typescript
 * import { SignedQuantityErrorReason } from '@polymarket/value-objects/signed-quantity';
 *
 * if (result.error.context?.reason === SignedQuantityErrorReason.NAN) {
 *   console.error('SignedQuantity cannot be NaN');
 * }
 * ```
 */
export var SignedQuantityErrorReason;
(function (SignedQuantityErrorReason) {
    /**
     * Значение NaN
     */
    SignedQuantityErrorReason["NAN"] = "NAN";
    /**
     * Значение не finite (Infinity, -Infinity)
     */
    SignedQuantityErrorReason["NON_FINITE"] = "NON_FINITE";
    /**
     * Ошибка парсинга значения
     *
     * @remarks
     * Возникает при конвертации string/number в Decimal.
     * Обычно содержит context.raw с невалидным значением.
     */
    SignedQuantityErrorReason["INVALID_FORMAT"] = "INVALID_FORMAT";
    /**
     * Деление на ноль
     */
    SignedQuantityErrorReason["DIVISION_BY_ZERO"] = "DIVISION_BY_ZERO";
    /**
     * Отрицательный множитель для операции scale
     *
     * @remarks
     * Scale операция требует неотрицательный rate (>= 0),
     * чтобы предотвратить инверсию знака SignedQuantity.
     */
    SignedQuantityErrorReason["NEGATIVE_SCALE_FACTOR"] = "NEGATIVE_SCALE_FACTOR";
    /**
     * Результат операции пересекает ноль при запрете пересечения
     *
     * @remarks
     * Возникает при adjustBy() с allowCrossZero = false,
     * когда операция меняет знак SignedQuantity (long → short или наоборот).
     */
    SignedQuantityErrorReason["RESULT_CROSSES_ZERO"] = "RESULT_CROSSES_ZERO";
    /**
     * Попытка скорректировать нулевое значение
     *
     * @remarks
     * При adjustBy() с allowCrossZero = false невозможно скорректировать
     * SignedQuantity равный нулю, так как любое изменение пересекает ноль.
     */
    SignedQuantityErrorReason["CANNOT_ADJUST_ZERO"] = "CANNOT_ADJUST_ZERO";
    /**
     * Шаг округления неположительный (stepSize <= 0)
     *
     * @remarks
     * Используется в операциях roundToStep и adjustBy.
     * stepSize должен быть строго положительным числом (> 0).
     * Отличается от INVALID_FORMAT (ошибка парсинга) и NON_FINITE (бесконечность/NaN).
     */
    SignedQuantityErrorReason["NON_POSITIVE_STEP_SIZE"] = "NON_POSITIVE_STEP_SIZE";
})(SignedQuantityErrorReason || (SignedQuantityErrorReason = {}));
//# sourceMappingURL=SignedQuantityErrorReason.js.map