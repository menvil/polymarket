/**
 * Ограничения инструмента для стратегии.
 *
 * @remarks
 * Подмножество InstrumentInfo из каталога. Передаётся стратегии в StrategySnapshot,
 * чтобы стратегия САМА принимала решения с учётом минимальных размеров.
 *
 * ### Зачем:
 * Без constraints стратегия говорит "SELL 5", а ExecutionEngine молча меняет на 9
 * (minOrderValue clamping) или скипает (positionQty < minOrderSize).
 * Стратегия теряет контроль, логи расходятся с реальностью.
 *
 * С constraints стратегия видит ограничения и сама адаптирует size:
 * - "остаток 4 < minOrderSize 5 → продаю всё 9"
 * - "orderValue $0.58 < minOrderValue $1 → покупаю 9 или не покупаю"
 *
 * @example
 * ```typescript
 * // В gather():
 * const { constraints } = snapshot;
 * if (constraints) {
 *   const adjustedSize = this.adjustSellSize(desired, positionQty, constraints.minOrderSize);
 * }
 * ```
 */
import type { Money, OutcomePrice, Quantity } from '@polymarket/value-objects';

/**
 * Ограничения инструмента, передаваемые стратегии в `StrategySnapshot`.
 *
 * @remarks
 * Подробное обоснование ("зачем") — см. TSDoc модуля в начале файла.
 */
export interface InstrumentConstraints {
  /** Минимальный размер ордера в токенах */
  readonly minOrderSize: Quantity;
  /**
   * Минимальная стоимость ордера в USDC (price × size >= minOrderValue).
   * Polymarket требует >= $1 для BUY-ордеров.
   *
   * @remarks
   * Money, а НЕ Quantity: это денежный notional (USDC), а не количество
   * токенов. Стратегии читают числовое значение через `.value()` (Decimal).
   */
  readonly minOrderValue: Money;
  /** Минимальный шаг цены */
  readonly tickSize: OutcomePrice;
}
