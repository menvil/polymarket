/**
 * Конфигурация BalanceAllocator.
 *
 * @remarks
 * Определяет параметры распределения баланса по рынкам.
 * Все параметры заданы при создании и не изменяются в рантайме.
 *
 * `tradingBalanceRatio` использует `Ratio` VO — гарантирует значение в [0, 1] на уровне типов.
 * `Ratio.of()` бросает `RatioInvariantViolation` при значении вне [0, 1].
 */
import type { Money, Ratio } from '@polymarket/value-objects';

/**
 * Параметры распределения торгового баланса.
 *
 * @example
 * ```typescript
 * const config: BalanceAllocatorConfig = {
 *   tradingBalanceRatio: Ratio.of(new Decimal('0.8')),  // 80% от баланса идёт в торговлю
 *   minCapitalPerMarket: Money.of(new Decimal(50), 'USDC'),
 *   maxConcurrentMarkets: 10,
 * };
 * ```
 */
export interface BalanceAllocatorConfig {
  /**
   * Доля баланса, используемая для торговли [0, 1].
   *
   * @remarks
   * `Ratio` VO гарантирует значение в [0, 1] — leverage невозможен по определению типа.
   * Например, `Ratio.of(new Decimal('0.8'))` = 80% от totalBalance доступно для аллокации.
   * Остаток (20%) резервируется как подушка безопасности.
   */
  readonly tradingBalanceRatio: Ratio;

  /**
   * Минимальная сумма аллокации на рынок в USDC.
   *
   * @remarks
   * Если свободного баланса не хватает на минимальную аллокацию хотя бы на 1 рынок,
   * аллокация не происходит. Рекомендуется: $50 USDC.
   */
  readonly minCapitalPerMarket: Money;

  /**
   * Максимальное количество одновременно активных рынков.
   *
   * @remarks
   * Ограничивает диверсификацию сверху.
   * Рекомендуется: 10.
   */
  readonly maxConcurrentMarkets: number;
}
