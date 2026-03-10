/**
 * Список поддерживаемых валют в системе
 *
 * @remarks
 * ⚠️ ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ для всех валют в системе.
 *
 * При добавлении новой валюты:
 * 1. Добавь валюту в этот массив
 * 2. TypeScript автоматически обновит тип SupportedCurrency
 * 3. Все value objects (Money, Balance) автоматически поддержат новую валюту
 *
 * @example
 * ```typescript
 * // Текущее состояние:
 * export const SUPPORTED_CURRENCIES = ['USDC'] as const;
 *
 * // Добавление новой валюты (пример):
 * export const SUPPORTED_CURRENCIES = ['USDC', 'USDT', 'EUR'] as const;
 *
 * // Всё автоматически заработает:
 * const currency: SupportedCurrency = 'EUR';  // ✅ Тип обновлён
 * const asset = AssetIdHelpers.fromCurrency('EUR'); // ✅ OK
 * ```
 */
export declare const SUPPORTED_CURRENCIES: readonly ["USDC"];
/**
 * Тип для поддерживаемых валют
 *
 * @remarks
 * Автоматически выводится из SUPPORTED_CURRENCIES.
 * При добавлении валюты в массив, тип обновляется автоматически.
 *
 * Используется в:
 * - AssetId (для currency assets)
 * - Money.of(value, currency)
 * - Balance.of(available, reserved, currency)
 * - MoneyService.create(value, currency)
 *
 * @example
 * ```typescript
 * const currency: SupportedCurrency = 'USDC'; // ✅ OK
 * const currency2: SupportedCurrency = 'BTC'; // ❌ Compile error (не в списке)
 *
 * // Используй экспортируемый type guard (принимает unknown, O(1) через Set):
 * if (isSupportedCurrency(input)) {
 *   // TypeScript знает: input is SupportedCurrency
 * }
 * ```
 */
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
/**
 * Type guard для проверки что строка является поддерживаемой валютой
 *
 * @param value - Строка для проверки
 * @returns true если value является SupportedCurrency
 *
 * @remarks
 * Использует Set для O(1) lookup вместо array.includes() O(n).
 *
 * @example
 * ```typescript
 * const input = getUserInput(); // string
 *
 * if (isSupportedCurrency(input)) {
 *   // TypeScript знает: input is SupportedCurrency
 *   const money = Money.of(100, input);
 * } else {
 *   throw new Error(`Unsupported currency: ${input}`);
 * }
 * ```
 */
export declare function isSupportedCurrency(value: unknown): value is SupportedCurrency;
/**
 * Константы для известных валют
 *
 * @remarks
 * Автоматически генерируется из SUPPORTED_CURRENCIES.
 * При добавлении валюты в SUPPORTED_CURRENCIES, эта константа обновляется автоматически.
 *
 * Это предотвращает рассинхронизацию между списком валют и константами.
 *
 * @example
 * ```typescript
 * const usdc = KnownCurrencies.USDC;  // 'USDC' as SupportedCurrency
 * const money = Money.of(100, KnownCurrencies.USDC);
 *
 * // При добавлении USDT в SUPPORTED_CURRENCIES:
 * // KnownCurrencies.USDT автоматически появится и будет типизирован
 * ```
 */
export declare const KnownCurrencies: { readonly [K in SupportedCurrency]: K; };
/**
 * Нормализация currency code (uppercase, trimmed)
 *
 * @param code - Currency code для нормализации
 * @returns Нормализованный currency code, или undefined если входное значение не строка или пустое
 *
 * @remarks
 * Приводит currency code к каноническому формату:
 * - Убирает пробелы в начале и конце
 * - Переводит в uppercase
 * - Возвращает undefined для не-строк и пустых/пробельных строк
 *
 * Поведение согласовано с asSupportedCurrency и currencyEquals:
 * все три функции возвращают «нет результата» для невалидного ввода
 * вместо выброса исключения.
 *
 * @example
 * ```typescript
 * normalizeCurrency('usdc'); // → 'USDC'
 * normalizeCurrency(' USDC '); // → 'USDC'
 * normalizeCurrency('UsD c'); // → 'USD C'
 * normalizeCurrency(''); // → undefined
 * normalizeCurrency(42); // → undefined
 * ```
 */
export declare function normalizeCurrency(code: unknown): string | undefined;
/**
 * Проверка и приведение строки к SupportedCurrency
 *
 * @param code - Currency code для проверки
 * @returns SupportedCurrency или undefined если currency не поддерживается
 *
 * @remarks
 * Выполняет нормализацию и проверку что currency поддерживается системой.
 * Используй для валидации user input перед созданием Money/Balance.
 *
 * @example
 * ```typescript
 * const userInput = 'usdc'; // lowercase from user
 *
 * const currency = asSupportedCurrency(userInput);
 * if (currency) {
 *   // TypeScript знает: currency is SupportedCurrency
 *   const money = Money.of(100, currency);
 * } else {
 *   throw new Error(`Unsupported currency: ${userInput}`);
 * }
 * ```
 */
export declare function asSupportedCurrency(code: unknown): SupportedCurrency | undefined;
/**
 * Case-insensitive сравнение currency codes
 *
 * @param a - Первый currency code
 * @param b - Второй currency code
 * @returns true если currency codes идентичны (игнорируя регистр)
 *
 * @remarks
 * Использует нормализацию для case-insensitive сравнения.
 * Полезно для сравнения user input с системными currency codes.
 *
 * @example
 * ```typescript
 * currencyEquals('USDC', 'usdc'); // → true
 * currencyEquals('USDC', 'USDT'); // → false
 * currencyEquals(' USDC ', 'USDC'); // → true
 * ```
 */
export declare function currencyEquals(a: unknown, b: unknown): boolean;
//# sourceMappingURL=Currency.d.ts.map