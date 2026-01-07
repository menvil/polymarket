/**
 * NormalizationResult - результат нормализации intent
 *
 * @remarks
 * Нормализация - это ЯВНОЕ преобразование Intent → NormalizedIntent.
 * Это НЕ validation, это CORRECTION.
 *
 * КРИТИЧЕСКИ ВАЖНО:
 * ✅ Стратегия ДОЛЖНА ЗНАТЬ что её intent был изменён
 * ✅ Normalization ≠ Validation (отдельные шаги)
 * ✅ Normalization результат содержит diff (что изменилось)
 *
 * Почему это важно:
 * - Стратегия может решить НЕ размещать ордер если diff слишком большой
 * - Debugging: видно как normalization изменил intent
 * - Transparency: нет скрытых mutations
 *
 * Pipeline:
 * 1. Intent → Normalize → NormalizedIntent (с diff)
 * 2. NormalizedIntent → Validate → Ok / Err
 * 3. ValidatedIntent → Execute → Result
 *
 * @example
 * ```typescript
 * // Normalize intent
 * const result = intentNormalizer.normalize(order, constraints);
 *
 * if (result.wasNormalized) {
 *   // ✅ Стратегия ЗНАЕТ что intent изменён
 *   logger.info('Intent normalized', {
 *     originalSize: result.diff.originalSize,
 *     normalizedSize: result.diff.normalizedSize,
 *   });
 *
 *   // Опционально: отклонить если diff слишком большой
 *   if (Math.abs(result.diff.normalizedSize - result.diff.originalSize) > 10) {
 *     return Err({ type: 'NORMALIZATION_TOO_LARGE' });
 *   }
 * }
 *
 * // Продолжить с normalized order
 * const validated = validationPipeline.validate(result.order, context);
 * ```
 */

import type { Order } from '../entities/Order.js';

/**
 * NormalizationDiff - что изменилось при нормализации
 *
 * @remarks
 * Показывает разницу между оригинальным и нормализованным order.
 * Используется для:
 * - Logging (видно что изменилось)
 * - Debugging (почему стратегия получила не тот размер)
 * - Decision making (стратегия может отклонить если diff слишком большой)
 */
export interface NormalizationDiff {
  /** Оригинальный размер (до нормализации) */
  originalSize: number;

  /** Нормализованный размер (после округления по sizeTick) */
  normalizedSize: number;

  /** Оригинальная цена (до нормализации) */
  originalPrice: number;

  /** Нормализованная цена (после округления по priceTick) */
  normalizedPrice: number;
}

/**
 * NormalizationResult - результат нормализации intent
 *
 * @remarks
 * Содержит:
 * - order: нормализованный Order
 * - wasNormalized: был ли order изменён
 * - diff: разница (если был изменён)
 *
 * Стратегия получает ЯВНУЮ информацию об изменениях.
 */
export interface NormalizationResult {
  /**
   * Нормализованный Order
   *
   * @remarks
   * Готов для передачи в ValidationPipeline.
   * Размер и цена округлены по sizeTick/priceTick.
   */
  order: Order;

  /**
   * Был ли order изменён при нормализации
   *
   * @remarks
   * - true: size или price были изменены
   * - false: order остался без изменений (уже был нормализован)
   *
   * Если true → смотрим diff для деталей.
   */
  wasNormalized: boolean;

  /**
   * Разница между оригиналом и нормализованным (если wasNormalized = true)
   *
   * @remarks
   * undefined если wasNormalized = false (не было изменений).
   *
   * Стратегия может использовать diff для:
   * - Проверки что изменения приемлемы
   * - Логирования
   * - Debugging
   */
  diff?: NormalizationDiff;
}
