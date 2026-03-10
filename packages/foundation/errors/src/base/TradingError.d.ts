/**
 * TradingError - базовый класс для всех ошибок в системе трейдинга
 *
 * @remarks
 * Предоставляет дефолтную реализацию ITradingError.
 * Наследуй этот класс вместо Error + implements ITradingError.
 * Дефолтная реализация toJSON() - можно переопределить если нужно.
 *
 * @example
 * ```typescript
 * import { TradingError, ValidationError } from '@polymarket/errors';
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // СОЗДАНИЕ СВОИХ КЛАССОВ ОШИБОК
 * // ═══════════════════════════════════════════════════════════════════
 *
 * // Вариант 1: Минимальный (1 строка!) ✨
 * // Severity = 'medium' (по умолчанию)
 * export class OrderNotFoundError extends TradingError {}
 *
 * // Вариант 2: С переопределением severity (3 строки)
 * export class ValidationError extends TradingError {
 *   public readonly severity = 'low' as const;
 * }
 *
 * // Вариант 3: С переопределением severity для высокой критичности
 * export class NetworkError extends TradingError {
 *   public readonly severity = 'high' as const;
 * }
 *
 * // ✨ Всё работает автоматически:
 * // - constructor() наследуется
 * // - this.name устанавливается из имени класса
 * // - toJSON() наследуется
 * // - .is() работает автоматически
 * // - instanceof работает
 * // - Динамические сообщения работают
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // СТАТИЧЕСКИЕ СООБЩЕНИЯ
 * // ═══════════════════════════════════════════════════════════════════
 *
 * // Простая ошибка
 * throw new ValidationError('Invalid price');
 *
 * // С контекстом (для логирования)
 * throw new ValidationError('Price must be positive', {
 *   context: { field: 'price', value: -10 }
 * });
 *
 * // С кодом и контекстом
 * throw new ValidationError('Invalid price', {
 *   code: 'PRICE_NEGATIVE',
 *   context: { field: 'price', value: -10 }
 * });
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // ДИНАМИЧЕСКИЕ СООБЩЕНИЯ ИЗ КОНТЕКСТА ✨
 * // ═══════════════════════════════════════════════════════════════════
 *
 * // Базовый шаблон
 * throw new ValidationError(
 *   (ctx) => `${ctx.field} must be positive but current value is ${ctx.value}`,
 *   { context: { field: 'price', value: -10 } }
 * );
 * // Результат: "price must be positive but current value is -10"
 *
 * // С .toUpperCase()
 * throw new ValidationError(
 *   (ctx: any) => `${ctx.field.toUpperCase()} must be positive but got ${ctx.value}`,
 *   { context: { field: 'price', value: -10 } }
 * );
 * // Результат: "PRICE must be positive but got -10"
 *
 * // Диапазон значений
 * throw new ValidationError(
 *   (ctx: any) => `${ctx.field} = ${ctx.value} is out of range (min: ${ctx.min}, max: ${ctx.max})`,
 *   {
 *     code: 'RANGE_ERROR',
 *     context: { field: 'quantity', value: 150, min: 1, max: 100 }
 *   }
 * );
 * // Результат: "quantity = 150 is out of range (min: 1, max: 100)"
 *
 * // Форматирование чисел
 * throw new ValidationError(
 *   (ctx: any) => `Insufficient ${ctx.field}: required ${ctx.required.toFixed(2)}, available ${ctx.available.toFixed(2)}`,
 *   {
 *     code: 'INSUFFICIENT_FUNDS',
 *     context: { field: 'balance', required: 1000, available: 500.5 }
 *   }
 * );
 * // Результат: "Insufficient balance: required 1000.00, available 500.50"
 *
 * // С массивами
 * throw new ValidationError(
 *   (ctx: any) => `${ctx.field} contains invalid items: ${ctx.invalidItems.join(', ')}`,
 *   {
 *     code: 'INVALID_ITEMS',
 *     context: { field: 'tags', invalidItems: ['tag1', 'tag2', 'tag3'] }
 *   }
 * );
 * // Результат: "tags contains invalid items: tag1, tag2, tag3"
 *
 * // Условная логика
 * throw new ValidationError(
 *   (ctx: any) => {
 *     if (ctx.value === undefined) return `${ctx.field} is required`;
 *     if (typeof ctx.value !== ctx.expectedType) {
 *       return `${ctx.field} must be ${ctx.expectedType}, got ${typeof ctx.value}`;
 *     }
 *     return `${ctx.field} is invalid`;
 *   },
 *   {
 *     code: 'TYPE_ERROR',
 *     context: { field: 'price', value: 'abc', expectedType: 'number' }
 *   }
 * );
 * // Результат: "price must be number, got string"
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // ПРОВЕРКА ТИПА ОШИБКИ
 * // ═══════════════════════════════════════════════════════════════════
 *
 * try {
 *   await validateAndExecuteOrder(order);
 * } catch (error) {
 *   // Вариант 1: ValidationError.is() ✨ (короче!)
 *   if (ValidationError.is(error)) {
 *     console.log('Validation failed:', error.context?.field);
 *     return { success: false, error: 'Invalid input' };
 *   }
 *
 *   // Вариант 2: instanceof (стандартно)
 *   if (error instanceof ValidationError) {
 *     console.log('Validation failed:', error.context?.field);
 *     return { success: false, error: 'Invalid input' };
 *   }
 *
 *   // Обработка базового типа TradingError
 *   if (error instanceof TradingError) {
 *     console.error('Trading error:', error.toJSON());
 *     return { success: false, error: error.message };
 *   }
 *
 *   throw error; // Неизвестная ошибка
 * }
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // GRACEFUL ОБРАБОТКА ОШИБОК В TEMPLATE ФУНКЦИЯХ ✨
 * // ═══════════════════════════════════════════════════════════════════
 *
 * // Если template функция выбрасывает ошибку, она обрабатывается gracefully:
 * // 1. Оригинальная ошибка сохраняется в innerError
 * // 2. Используется безопасное сообщение
 * // 3. Context сохраняется для отладки
 *
 * const error = new ValidationError(
 *   (ctx: any) => {
 *     // Ошибка доступа к свойству
 *     return ctx.missingField.toUpperCase();
 *   },
 *   { context: { field: 'price', value: -10 } }
 * );
 *
 * console.log(error.message);
 * // "Message template function failed: Cannot read properties of undefined (reading 'toUpperCase')"
 *
 * console.log(error.innerError);
 * // TypeError: Cannot read properties of undefined (reading 'toUpperCase')
 *
 * console.log(error.context);
 * // { field: 'price', value: -10 } - context сохранён!
 *
 * // innerError включается в toJSON() для отладки
 * console.log(error.toJSON());
 * // {
 * //   name: 'ValidationError',
 * //   message: 'Message template function failed: ...',
 * //   severity: 'low',
 * //   timestamp: '2024-01-20T12:00:00.000Z',
 * //   context: { field: 'price', value: -10 },
 * //   innerError: {
 * //     name: 'TypeError',
 * //     message: "Cannot read properties of undefined (reading 'toUpperCase')",
 * //     stack: '...'
 * //   }
 * // }
 *
 * // ═══════════════════════════════════════════════════════════════════
 * // СЕРИАЛИЗАЦИЯ
 * // ═══════════════════════════════════════════════════════════════════
 *
 * const error = new ValidationError('Invalid price', {
 *   code: 'PRICE_NEGATIVE',
 *   context: { field: 'price', value: -10 }
 * });
 *
 * console.log(error.toJSON());
 * // {
 * //   name: 'ValidationError',
 * //   code: 'PRICE_NEGATIVE',
 * //   message: 'Invalid price',
 * //   severity: 'low',
 * //   timestamp: '2024-01-20T12:00:00.000Z',
 * //   context: { field: 'price', value: -10 }
 * // }
 *
 * // Для API ответов
 * res.status(400).json(error.toJSON());
 * ```
 */
import { ITradingError, ErrorSeverity } from './ITradingError.js';
/**
 * TradingError - базовый класс для всех ошибок
 *
 * @remarks
 * Реализует ITradingError с дефолтной логикой.
 * Дочерние классы могут переопределить severity (дефолт: 'medium').
 */
export declare class TradingError extends Error implements ITradingError {
    /**
     * Уровень серьезности (по умолчанию 'medium')
     */
    readonly severity: ErrorSeverity;
    /**
     * Время возникновения ошибки
     */
    readonly timestamp: Date;
    /**
     * Код ошибки (опционально)
     */
    readonly code?: string;
    /**
     * Дополнительный контекст
     */
    readonly context?: Record<string, unknown>;
    /**
     * Внутренняя ошибка (опционально)
     *
     * @remarks
     * Сохраняет оригинальную ошибку, выброшенную из функции-шаблона сообщения.
     * Полезно для отладки и логирования цепочки ошибок.
     */
    readonly innerError?: Error;
    /**
     * Создаёт TradingError
     *
     * @param message - Человекочитаемое сообщение об ошибке (строка или функция-шаблон)
     * @param options - Опции (опционально)
     * @param options.code - Код ошибки для детальной классификации
     * @param options.context - Дополнительный контекст (обязателен при использовании функции-шаблона)
     *
     * @throws {TypeError} Если message - функция, но context не передан
     * @throws {TypeError} Если message не является строкой или функцией
     *
     * @remarks
     * this.name устанавливается автоматически из имени класса (this.constructor.name),
     * поэтому в дочерних классах не нужно его задавать вручную.
     *
     * **ВАЖНО**: Если message - функция-шаблон, options.context ОБЯЗАТЕЛЕН!
     * Функция будет вызвана с переданным контекстом для генерации динамического сообщения.
     * При отсутствии context выбросится TypeError.
     *
     * @example
     * ```typescript
     * // Статическое сообщение
     * new ValidationError('Invalid value');
     *
     * // Динамическое сообщение из контекста (context обязателен!)
     * new ValidationError(
     *   (ctx) => `${ctx.field.toUpperCase()} must be positive but current value is ${ctx.value}`,
     *   { context: { field: 'price', value: -10 } }
     * );
     * // Результат: "PRICE must be positive but current value is -10"
     *
     * // ❌ ОШИБКА: функция без context
     * // new ValidationError((ctx) => `Field ${ctx.field} is invalid`);
     * // Выбросит TypeError: Message template function provided without context
     * ```
     */
    constructor(message: string | ((context: Record<string, unknown>) => string), options?: {
        code?: string;
        context?: Record<string, unknown>;
    });
    /**
     * Сериализует ошибку в объект
     *
     * @returns Plain object с данными ошибки
     *
     * @remarks
     * Дефолтная реализация - можно переопределить в дочернем классе.
     * Безопасно обрабатывает циклические ссылки в context.
     */
    toJSON(): Record<string, unknown>;
    /**
     * Безопасно сериализует context с защитой от циклических ссылок
     *
     * @param obj - Объект для сериализации
     * @param seen - WeakSet для отслеживания текущего пути рекурсии
     * @returns Сериализованный объект с маркерами "[Circular]" вместо циклических ссылок
     *
     * @remarks
     * Использует WeakSet для детектирования циклов в текущем пути рекурсии.
     * Объекты добавляются в seen перед обработкой детей и удаляются после,
     * чтобы различать настоящие циклы от shared references (один объект в разных местах).
     *
     * @example
     * ```typescript
     * const shared = { value: 1 };
     * const context = {
     *   a: shared,
     *   b: shared  // НЕ цикл - просто shared reference
     * };
     * // Результат: { a: { value: 1 }, b: { value: 1 } }
     *
     * const circular: any = { name: 'root' };
     * circular.self = circular;  // Настоящий цикл
     * // Результат: { name: 'root', self: '[Circular]' }
     * ```
     */
    private safeSerializeContext;
    /**
     * Type guard - проверяет тип ошибки
     *
     * @param error - Объект для проверки
     * @returns True если error является экземпляром этого класса
     *
     * @remarks
     * ✨ Автоматически работает для всех дочерних классов!
     * Альтернатива instanceof для более короткой записи.
     *
     * @example
     * ```typescript
     * import { ValidationError } from '@polymarket/errors';
     *
     * try {
     *   await operation();
     * } catch (error) {
     *   // Способ 1: ValidationError.is() (короче!)
     *   if (ValidationError.is(error)) {
     *     console.log('Validation failed:', error.context?.field);
     *   }
     *
     *   // Способ 2: instanceof (стандартно)
     *   if (error instanceof ValidationError) {
     *     console.log('Validation failed:', error.context?.field);
     *   }
     * }
     * ```
     */
    static is(error: unknown): error is TradingError;
}
//# sourceMappingURL=TradingError.d.ts.map