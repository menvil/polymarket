/**
 * Типизированные причины ошибок для Balance операций
 *
 * @remarks
 * Используется в InvalidBalanceError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * **Преимущества:**
 * - ✅ Compile-time проверка на опечатки
 * - ✅ Автодополнение в IDE
 * - ✅ Exhaustive checking в switch statements
 * - ✅ Безопасный рефакторинг через "Rename Symbol"
 *
 * **Категории ошибок:**
 *
 * 1. **Недостаточно средств:**
 *    - INSUFFICIENT_FUNDS - недостаточно available для reserve
 *    - INSUFFICIENT_RESERVED - недостаточно reserved для unfreezeReserved/consumeReserved
 *
 * 2. **Валидация валюты:**
 *    - CURRENCY_MISMATCH - несовпадение валют
 *    - UNSUPPORTED_CURRENCY - неизвестная валюта
 *
 * 3. **Нарушение инвариантов:**
 *    - NEGATIVE_AVAILABLE - available amount < 0
 *    - NEGATIVE_RESERVED - reserved amount < 0
 *    - NAN - amount является NaN
 *    - NON_FINITE - amount не является finite (Infinity / -Infinity)
 *    - TOTAL_EXCEEDS_MAX_AMOUNT - available + reserved > Money.MAX_AMOUNT
 *
 * 4. **Ошибки парсинга:**
 *    - INVALID_FORMAT - ошибка парсинга входных данных
 *
 * @example
 * ```typescript
 * import { BalanceErrorReason } from '@polymarket/value-objects/balance';
 *
 * // Type-safe проверка ошибок
 * if (result.error.context?.reason === BalanceErrorReason.INSUFFICIENT_FUNDS) {
 *   console.log('Not enough available funds');
 * }
 *
 * // Exhaustive checking в switch
 * switch (result.error.context?.reason) {
 *   case BalanceErrorReason.INSUFFICIENT_FUNDS:
 *     console.log('Available funds too low');
 *     break;
 *   case BalanceErrorReason.INSUFFICIENT_RESERVED:
 *     console.log('Reserved funds too low');
 *     break;
 *   case BalanceErrorReason.CURRENCY_MISMATCH:
 *     console.log('Currency mismatch detected');
 *     break;
 *   case BalanceErrorReason.NEGATIVE_AVAILABLE:
 *     console.log('Available cannot be negative');
 *     break;
 *   case BalanceErrorReason.NEGATIVE_RESERVED:
 *     console.log('Reserved cannot be negative');
 *     break;
 *   case BalanceErrorReason.NAN:
 *     console.log('Amount is NaN');
 *     break;
 *   case BalanceErrorReason.NON_FINITE:
 *     console.log('Amount is not finite');
 *     break;
 *   case BalanceErrorReason.TOTAL_EXCEEDS_MAX_AMOUNT:
 *     console.log('Total exceeds maximum allowed amount');
 *     break;
 *   case BalanceErrorReason.UNSUPPORTED_CURRENCY:
 *     console.log('Currency not supported');
 *     break;
 *   case BalanceErrorReason.INVALID_FORMAT:
 *     console.log('Invalid input format');
 *     break;
 *   // TypeScript проверит что все cases покрыты
 * }
 *
 * // Использование в Rules
 * return Err(
 *   new InvalidBalanceError('Cannot reserve funds', {
 *     context: {
 *       reason: BalanceErrorReason.INSUFFICIENT_FUNDS,
 *       requested: 1000,
 *       available: 500
 *     }
 *   })
 * );
 * ```
 */
export var BalanceErrorReason;
(function (BalanceErrorReason) {
    /**
     * Недостаточно available средств для резервирования
     *
     * @remarks
     * Возникает в операции reserve() когда reserveAmount > available.
     * Используется в ValidateReserveAmount rule.
     *
     * Контекст обычно содержит:
     * - requested: number - запрошенная сумма
     * - available: number - доступная сумма
     */
    BalanceErrorReason["INSUFFICIENT_FUNDS"] = "INSUFFICIENT_FUNDS";
    /**
     * Недостаточно reserved средств для размораживания или списания
     *
     * @remarks
     * Возникает в операциях unfreezeReserved() или consumeReserved() когда amount > reserved.
     * Используется в ValidateReleaseAmount rule.
     *
     * Контекст обычно содержит:
     * - requested: number - запрошенная сумма для размораживания/списания
     * - reserved: number - зарезервированная сумма
     */
    BalanceErrorReason["INSUFFICIENT_RESERVED"] = "INSUFFICIENT_RESERVED";
    /**
     * Несовпадение валют между балансом и операндом
     *
     * @remarks
     * Возникает когда валюта amount не совпадает с валютой баланса
     * в операциях reserve/unfreezeReserved/consumeReserved/updateAvailable.
     * Используется в ValidateCurrencyMatch rule.
     *
     * Контекст обычно содержит:
     * - expected: string - ожидаемая валюта баланса
     * - actual: string - фактическая валюта amount
     */
    BalanceErrorReason["CURRENCY_MISMATCH"] = "CURRENCY_MISMATCH";
    /**
     * Available amount отрицательный
     *
     * @remarks
     * Нарушение Core инварианта: available >= 0.
     * Бросается из Balance.of() constructor.
     *
     * Контекст обычно содержит:
     * - available: number - фактическое значение available
     */
    BalanceErrorReason["NEGATIVE_AVAILABLE"] = "NEGATIVE_AVAILABLE";
    /**
     * Reserved amount отрицательный
     *
     * @remarks
     * Нарушение Core инварианта: reserved >= 0.
     * Бросается из Balance.of() constructor.
     *
     * Контекст обычно содержит:
     * - reserved: number - фактическое значение reserved
     */
    BalanceErrorReason["NEGATIVE_RESERVED"] = "NEGATIVE_RESERVED";
    /**
     * Amount является NaN
     *
     * @remarks
     * Нарушение Core инварианта: amount не может быть NaN.
     * Бросается из Balance.of() constructor при проверке инвариантов.
     *
     * Контекст обычно содержит:
     * - available: string - значение available
     * - reserved: string - значение reserved
     */
    BalanceErrorReason["NAN"] = "NAN";
    /**
     * Amount не является finite (Infinity или -Infinity)
     *
     * @remarks
     * Нарушение Core инварианта: amount должен быть finite.
     * Бросается из Balance.of() constructor при проверке инвариантов.
     *
     * Контекст обычно содержит:
     * - available: string - значение available
     * - reserved: string - значение reserved
     */
    BalanceErrorReason["NON_FINITE"] = "NON_FINITE";
    /**
     * Ошибка парсинга входного значения
     *
     * @remarks
     * Возникает когда не удаётся распарсить входные данные
     * в Decimal или Money через toDecimal() или MoneyService.create().
     *
     * Контекст обычно содержит:
     * - raw: { field: string, value: string } - сырой ввод
     * - cause: { name, message, stack } - исходная ошибка парсинга
     */
    BalanceErrorReason["INVALID_FORMAT"] = "INVALID_FORMAT";
    /**
     * Неподдерживаемая валюта
     *
     * @remarks
     * Возникает когда валюта не входит в список поддерживаемых.
     * В текущей версии поддерживается только USDC.
     *
     * Контекст обычно содержит:
     * - currency: string - неподдерживаемая валюта
     */
    BalanceErrorReason["UNSUPPORTED_CURRENCY"] = "UNSUPPORTED_CURRENCY";
    /**
     * Сумма available + reserved превышает максимально допустимое значение
     *
     * @remarks
     * Нарушение Core инварианта: available + reserved <= Money.MAX_AMOUNT (1e15).
     * Бросается из Balance.of() constructor при проверке инвариантов.
     *
     * Защищает от runtime throw в query-методе total(), который создаёт
     * Money.of(available + reserved) и может упасть при превышении лимита.
     *
     * Контекст обычно содержит:
     * - available: string - значение available
     * - reserved: string - значение reserved
     * - total: string - сумма available + reserved
     * - maxAmount: string - максимально допустимая сумма (Money.MAX_AMOUNT)
     */
    BalanceErrorReason["TOTAL_EXCEEDS_MAX_AMOUNT"] = "TOTAL_EXCEEDS_MAX_AMOUNT";
})(BalanceErrorReason || (BalanceErrorReason = {}));
//# sourceMappingURL=BalanceErrorReason.js.map