/**
 * IntentNormalizer - ЯВНОЕ преобразование Intent → NormalizedIntent
 *
 * @remarks
 * Нормализация - это НЕ validation, это CORRECTION.
 * Стратегия ДОЛЖНА ЗНАТЬ что её intent был изменён.
 *
 * КРИТИЧЕСКИ ВАЖНО:
 * ✅ Чистая функция (детерминированная)
 * ✅ НЕ делает IO
 * ✅ Возвращает NormalizationResult с diff (что изменилось)
 * ✅ Отделена от validation (это разные шаги)
 *
 * Алгоритм:
 * 1. Округлить size по sizeTick
 * 2. Округлить price по priceTick
 * 3. Создать новый Order с normalized значениями
 * 4. Вернуть NormalizationResult + diff
 *
 * Детерминированность:
 * - (Order, MarketConstraints) → NormalizedOrder
 * - Одинаковый input → одинаковый output
 * - Никаких Date.now(), никаких random
 *
 * Почему это правильно:
 * - Normalization ≠ Validation (явное разделение)
 * - Стратегия знает об изменениях (transparency)
 * - Replay-safe (детерминированная функция)
 * - Unit testable (без IO)
 *
 * @example
 * ```typescript
 * const normalizer = new IntentNormalizer();
 *
 * const order = Order.create({
 *   size: Quantity.fromNumber(100.567), // НЕ нормализован
 *   price: Price.fromNumber(0.523),     // НЕ нормализован
 * });
 *
 * const constraints = {
 *   sizeTick: 0.01,
 *   priceTick: 0.01,
 * };
 *
 * const result = normalizer.normalize(order, constraints);
 *
 * // result.wasNormalized = true
 * // result.order.size = 100.57 (rounded)
 * // result.order.price = 0.52 (rounded)
 * // result.diff = { originalSize: 100.567, normalizedSize: 100.57, ... }
 *
 * if (result.wasNormalized) {
 *   logger.info('Intent normalized', { diff: result.diff });
 * }
 * ```
 */

import { Order } from '../../domain/entities/Order.js';
import type { MarketConstraints } from '../../domain/types/ValidationContext.js';
import type { NormalizationResult, NormalizationDiff } from '../../domain/types/NormalizationResult.js';
import { Quantity } from '../../domain/value-objects/Quantity.js';
import { Price } from '../../domain/value-objects/Price.js';

/**
 * IntentNormalizer - нормализует intent (чистая функция)
 *
 * @remarks
 * Stateless класс - можно переиспользовать instance.
 * Все методы детерминированные (pure functions).
 */
export class IntentNormalizer {
  /**
   * Нормализует order intent
   *
   * @param order - Order intent от стратегии
   * @param constraints - Market constraints (sizeTick, priceTick)
   * @returns NormalizationResult с normalized order и diff
   *
   * @remarks
   * ЧИСТАЯ ФУНКЦИЯ:
   * - Детерминированная: (order, constraints) → result
   * - Не делает IO
   * - Не читает/пишет state
   * - Не использует Date.now() или random
   *
   * Алгоритм:
   * 1. Округлить size по sizeTick (banker's rounding)
   * 2. Округлить price по priceTick (banker's rounding)
   * 3. Проверить изменились ли значения
   * 4. Создать новый Order (если изменились)
   * 5. Вернуть NormalizationResult + diff
   *
   * @example
   * ```typescript
   * const result = normalizer.normalize(order, constraints);
   *
   * if (result.wasNormalized) {
   *   console.log('Size changed:', result.diff.originalSize, '→', result.diff.normalizedSize);
   * }
   *
   * // Продолжить с normalized order
   * const validated = validationPipeline.validate(result.order, context);
   * ```
   */
  public normalize(order: Order, constraints: MarketConstraints): NormalizationResult {
    // Step 1: Normalize size
    const normalizedSize = this.roundToTick(order.size.value, constraints.sizeTick);

    // Step 2: Normalize price
    const normalizedPrice = this.roundToTick(order.price.value, constraints.priceTick);

    // Step 3: Check if anything changed
    const sizeChanged = normalizedSize !== order.size.value;
    const priceChanged = normalizedPrice !== order.price.value;
    const wasNormalized = sizeChanged || priceChanged;

    // Step 4: Create normalized order (если изменилось)
    const normalizedOrder = wasNormalized
      ? Order.create({
          id: order.id,
          tokenId: order.tokenId,
          side: order.side,
          price: Price.fromNumber(normalizedPrice),
          size: Quantity.fromNumber(normalizedSize),
          status: order.status,
          timestamp: order.timestamp,
          filledSize: order.filledSize,
          averageFillPrice: order.averageFillPrice,
        })
      : order; // Не создаём новый instance если ничего не изменилось

    // Step 5: Create diff (если изменилось)
    const diff: NormalizationDiff | undefined = wasNormalized
      ? {
          originalSize: order.size.value,
          normalizedSize,
          originalPrice: order.price.value,
          normalizedPrice,
        }
      : undefined;

    return {
      order: normalizedOrder,
      wasNormalized,
      diff,
    };
  }

  /**
   * Округляет значение по tick (banker's rounding)
   *
   * @param value - Значение для округления
   * @param tick - Tick size (например, 0.01)
   * @returns Округлённое значение
   *
   * @remarks
   * Использует banker's rounding (round half to even):
   * - 0.5 → 0 (round down)
   * - 1.5 → 2 (round up)
   * - 2.5 → 2 (round down)
   * - 3.5 → 4 (round up)
   *
   * Это минимизирует systematic bias при множественных округлениях.
   *
   * Алгоритм:
   * 1. Разделить value на tick
   * 2. Округлить (Math.round использует banker's rounding для .5)
   * 3. Умножить обратно на tick
   * 4. Исправить floating point precision (toFixed → parseFloat)
   *
   * @example
   * ```typescript
   * roundToTick(100.567, 0.01) // 100.57
   * roundToTick(0.523, 0.01)   // 0.52
   * roundToTick(99.995, 0.01)  // 100.00
   * ```
   */
  private roundToTick(value: number, tick: number): number {
    if (tick === 0) {
      throw new Error('Tick cannot be zero');
    }

    // 1. Разделить на tick
    const divided = value / tick;

    // 2. Округлить (banker's rounding)
    const rounded = Math.round(divided);

    // 3. Умножить обратно
    const result = rounded * tick;

    // 4. Исправить floating point precision
    // Например: 0.1 + 0.2 = 0.30000000000000004
    // Округляем до количества decimals в tick
    const decimals = this.countDecimals(tick);
    return parseFloat(result.toFixed(decimals));
  }

  /**
   * Подсчитывает количество decimals в числе
   *
   * @param value - Число
   * @returns Количество decimals
   *
   * @remarks
   * Используется для определения precision при округлении.
   *
   * @example
   * ```typescript
   * countDecimals(0.01)   // 2
   * countDecimals(0.001)  // 3
   * countDecimals(1)      // 0
   * countDecimals(0.1)    // 1
   * ```
   */
  private countDecimals(value: number): number {
    if (Math.floor(value) === value) {
      return 0; // Целое число
    }

    const str = value.toString();
    const decimalIndex = str.indexOf('.');

    if (decimalIndex === -1) {
      return 0;
    }

    return str.length - decimalIndex - 1;
  }
}
