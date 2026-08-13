import { validateBrandedId } from '../core/utils/validateBrandedId.js';

/**
 * StrategyId - идентификатор стратегии
 *
 * @remarks
 * Branded type для type safety. Идентифицирует экземпляр торговой стратегии
 * (`IStrategy.id`) на протяжении его жизненного цикла — используется как ключ
 * в `StrategyScheduler`, `ExecutionEngine.strategyId` и связанных портах.
 *
 * @example
 * ```typescript
 * const strategyId = asStrategyId('crowd-deviation-1')!;
 * ```
 */
export type StrategyId = string & { readonly __brand: 'StrategyId' };

/**
 * Максимальная длина StrategyId
 * @internal
 */
const MAX_STRATEGY_ID_LENGTH = 256;

/**
 * Валидация и парсинг StrategyId
 *
 * @param raw - Строка для парсинга
 * @returns StrategyId или undefined если формат невалидный
 *
 * @remarks
 * Базовые ограничения:
 * - Не пустая строка
 * - Максимум 256 символов
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 * - Не содержит пробелы по краям (автоматически trim)
 *
 * @example
 * ```typescript
 * asStrategyId('crowd-deviation-1'); // → 'crowd-deviation-1' as StrategyId
 * asStrategyId('  valid  '); // → 'valid' as StrategyId (trimmed)
 * asStrategyId(''); // → undefined (пустая строка)
 * asStrategyId('  '); // → undefined (только пробелы)
 * asStrategyId('a' + String.fromCharCode(0) + 'b'); // → undefined (control character)
 * asStrategyId('x'.repeat(300)); // → undefined (слишком длинная)
 * ```
 */
export function asStrategyId(raw: string): StrategyId | undefined {
  return validateBrandedId(raw, MAX_STRATEGY_ID_LENGTH) as StrategyId | undefined;
}

/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns StrategyId
 *
 * @remarks
 * Используй только если уверен что строка валидна.
 * Для external input всегда используй asStrategyId().
 */
/* c8 ignore next 3 */
export function unsafeStrategyId(raw: string): StrategyId {
  return raw as StrategyId;
}
