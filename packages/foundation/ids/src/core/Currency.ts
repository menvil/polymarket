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
export const SUPPORTED_CURRENCIES = ['USDC'] as const;

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
 * // Type guard
 * function isSupportedCurrency(value: string): value is SupportedCurrency {
 *   return SUPPORTED_CURRENCIES.includes(value as any);
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
export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return SUPPORTED_CURRENCIES.includes(value as SupportedCurrency);
}

/**
 * Константы для известных валют
 *
 * @remarks
 * Используются для удобного доступа к валютам без magic strings.
 *
 * @example
 * ```typescript
 * const usdc = KnownCurrencies.USDC;  // 'USDC' as SupportedCurrency
 * const money = Money.of(100, KnownCurrencies.USDC);
 * ```
 */
export const KnownCurrencies = {
  USDC: 'USDC' as SupportedCurrency,
} as const;
