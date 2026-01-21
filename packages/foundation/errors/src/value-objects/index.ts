/**
 * Value Objects Errors - ошибки валидации value objects
 *
 * @remarks
 * Этот модуль содержит специализированные классы ошибок для валидации
 * value objects в доменной модели торговой системы.
 *
 * Все ошибки:
 * - Наследуются от TradingError
 * - Имеют severity = 'low' (проблемы валидации не критичны)
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
 * - CurrencyMismatchError - несоответствие валют при операциях
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
 *   throw new InvalidPriceError(value);
 * }
 *
 * // Валидация денег
 * if (amount < 0) {
 *   throw new InvalidMoneyError(amount, 'USDC');
 * }
 *
 * // Проверка валюты при операциях
 * if (money1.currency !== money2.currency) {
 *   throw new CurrencyMismatchError('addition', money1.currency, money2.currency);
 * }
 *
 * // Защита от деления на ноль
 * if (divisor === 0) {
 *   throw new DivisionByZeroError(dividend, divisor, 'average price calculation');
 * }
 * ```
 *
 * @packageDocumentation
 */

// Валидация диапазонов
export * from './InvalidPriceError.js';
export * from './InvalidQuantityError.js';
export * from './InvalidPercentageError.js';
export * from './InvalidAmountError.js';

// Валидация денежных значений
export * from './InvalidMoneyError.js';
export * from './CurrencyMismatchError.js';

// Математические ошибки
export * from './DivisionByZeroError.js';
export * from './ArithmeticOverflowError.js';