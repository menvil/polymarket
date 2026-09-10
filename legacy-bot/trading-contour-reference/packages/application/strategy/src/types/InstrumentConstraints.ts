/*
 * LEGACY REFERENCE ONLY.
 *
 * Historical implementation of the trading contour, preserved for the
 * new trading runtime.
 *
 * Not built.
 * Not linted.
 * Not runnable against the current repository.
 * Do not import from production code.
 *
 * Source: packages/application/strategy/src/types/InstrumentConstraints.ts
 * Commit: abe9354e07501e87bf8a90fa53cccf6fa1b206a4
 *
 * See README.md for what was preserved and what was extracted to docs/.
 */
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
