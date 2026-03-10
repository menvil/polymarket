/**
 * Конфигурация BalanceAllocator.
 *
 * @remarks
 * Определяет параметры распределения баланса по рынкам.
 * Все параметры заданы при создании и не изменяются в рантайме.
 */
import type { Money } from '@polymarket/value-objects';

/**
 * Параметры распределения торгового баланса.
 *
 * @example
 * ```typescript
 * const config: BalanceAllocatorConfig = {
 *   tradingBalanceRatio: 0.8,      // 80% от баланса идёт в торговлю
 *   minCapitalPerMarket: Money.of(new Decimal(50), 'USDC'),  // минимум $50 на рынок
 *   maxConcurrentMarkets: 10,       // не более 10 рынков одновременно
 * };
 * ```
 */
export interface BalanceAllocatorConfig {
  /**
   * Доля баланса, используемая для торговли [0, 1].
   *
   * @remarks
   * Например, 0.8 означает что 80% от `totalBalance` доступно для аллокации.
   * Остаток (20%) резервируется как подушка безопасности.
   * По умолчанию: 0.8
   */
  readonly tradingBalanceRatio: number;

  /**
   * Минимальная сумма аллокации на рынок в USDC.
   *
   * @remarks
   * Если свободного баланса не хватает на минимальную аллокацию хотя бы на 1 рынок,
   * аллокация не происходит. По умолчанию: $50 USDC.
   */
  readonly minCapitalPerMarket: Money;

  /**
   * Максимальное количество одновременно активных рынков.
   *
   * @remarks
   * Ограничивает диверсификацию сверху.
   * По умолчанию: 10.
   */
  readonly maxConcurrentMarkets: number;
}
