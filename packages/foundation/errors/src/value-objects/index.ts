/**
 * Value Objects Errors - ошибки валидации value objects
 *
 * @remarks
 * Этот модуль содержит специализированные классы ошибок для валидации
 * value objects в доменной модели торговой системы.
 *
 * Все ошибки:
 * - Наследуются от TradingError
 * - Имеют severity = 'low' (ошибки валидации, пользователь может исправить)
 * - Поддерживают статические и динамические сообщения
 * - Содержат структурированный context для отладки
 *
 * Категории ошибок:
 *
 * **Валидация диапазонов:**
 * - InvalidPriceError - цена вне диапазона [0.0001, 0.9999]
 * - InvalidQuantityError - некорректное количество акций
 * - InvalidPercentageError - процент вне допустимого диапазона
 * - InvalidAmountError - универсальная ошибка валидации числовых значений
 *
 * **Валидация денежных значений:**
 * - InvalidMoneyError - некорректная денежная сумма (отрицательная, NaN, etc.)
 * - InvalidBalanceError - некорректный баланс (available/reserved validation)
 * - CurrencyMismatchError - несоответствие валют при операциях
 *
 * **Валидация торговых объектов:**
 * - InvalidSpreadError - невалидный спред (bid > ask)
 * - InvalidQuoteError - невалидная котировка маркет-мейкера
 *
 * **Математические ошибки:**
 * - DivisionByZeroError - деление на ноль
 * - ArithmeticOverflowError - переполнение при арифметических операциях
 *
 * @example
 * ```typescript
 * import {
 *   InvalidPriceError,
 *   InvalidMoneyError,
 *   CurrencyMismatchError,
 *   DivisionByZeroError
 * } from '@polymarket/errors';
 *
 * // Валидация цены
 * if (!Price.isValid(value)) {
 *   throw new InvalidPriceError(
 *     `Invalid price: ${value}`,
 *     {
 *       code: InvalidPriceError.code,
 *       context: { value }
 *     }
 *   );
 * }
 *
 * // Валидация денег
 * if (amount < 0) {
 *   throw new InvalidMoneyError(
 *     `Invalid money amount: ${amount}`,
 *     {
 *       code: InvalidMoneyError.code,
 *       context: { amount, currency: 'USDC' }
 *     }
 *   );
 * }
 *
 * // Проверка валюты при операциях
 * if (money1.currency !== money2.currency) {
 *   throw new CurrencyMismatchError(
 *     `Currency mismatch: ${money1.currency} vs ${money2.currency}`,
 *     {
 *       code: CurrencyMismatchError.code,
 *       context: {
 *         operation: 'addition',
 *         expected: money1.currency,
 *         actual: money2.currency
 *       }
 *     }
 *   );
 * }
 *
 * // Защита от деления на ноль
 * if (divisor === 0) {
 *   throw new DivisionByZeroError(
 *     'Cannot divide by zero',
 *     {
 *       code: DivisionByZeroError.code,
 *       context: { dividend, divisor, operation: 'average price calculation' }
 *     }
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// Валидация диапазонов
export * from './InvalidPriceError.js';
export * from './InvalidQuantityError.js';
export * from './InvalidPercentageError.js';
export * from './InvalidRatioError.js';
export * from './InvalidAmountError.js';

// Валидация денежных значений
export * from './InvalidMoneyError.js';
export * from './InvalidBalanceError.js';
export * from './CurrencyMismatchError.js';

// Валидация торговых объектов
export * from './InvalidAssetQuantityError.js';
export * from './InvalidSpreadError.js';
export * from './InvalidQuoteError.js';
export * from './InvalidOutcomeTokenError.js';

// Математические ошибки
export * from './DivisionByZeroError.js';
export * from './ArithmeticOverflowError.js';
