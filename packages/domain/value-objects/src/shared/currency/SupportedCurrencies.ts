/**
 * Список поддерживаемых валют
 *
 * @remarks
 * ⚠️ ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ для всех валют в системе.
 *
 * При добавлении новой валюты:
 * 1. Добавь валюту в этот массив
 * 2. Money.ZERO автоматически создаст singleton для новой валюты
 * 3. Balance.ZERO автоматически создаст singleton для новой валюты
 * 4. TypeScript автоматически обновит тип SupportedCurrency
 *
 * НЕ НУЖНО больше ничего менять!
 *
 * @example
 * ```typescript
 * // Текущее состояние:
 * export const SUPPORTED_CURRENCIES = ['USDC'] as const;
 *
 * // Добавление новой валюты (пример):
 * export const SUPPORTED_CURRENCIES = ['USDC', 'EUR'] as const;
 *
 * // Всё автоматически заработает:
 * const zeroEur = Money.ZERO.EUR;      // ✅ Singleton создан
 * const balEur = Balance.ZERO.EUR;     // ✅ Singleton создан
 * type Currency = SupportedCurrency;   // ✅ Тип обновлён: 'USDC' | 'EUR'
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
 * - Money.of(value, currency)
 * - Balance.of(available, reserved)
 * - MoneyService.create(value, currency)
 *
 * @example
 * ```typescript
 * // После добавления 'EUR' в SUPPORTED_CURRENCIES:
 * const currency: SupportedCurrency = 'USDC'; // ✅ OK
 * const currency2: SupportedCurrency = 'EUR'; // ✅ OK (автоматически)
 * const currency3: SupportedCurrency = 'BTC'; // ❌ Compile error
 * ```
 */
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];
