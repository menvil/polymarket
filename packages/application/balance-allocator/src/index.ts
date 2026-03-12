/**
 * @polymarket/balance-allocator — Распределение торгового баланса по рынкам.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `BalanceAllocator` — реализация IBalanceAllocator (из @polymarket/ports)
 * - `BalanceAllocatorConfig` — параметры конфигурации
 *
 * ### Принцип работы:
 * BalanceAllocator вычисляет `tradingBalance = totalBalance × tradingBalanceRatio`,
 * затем делит `freeBalance` на `max(newSlots, availableSlots)` — резервируя капитал
 * под будущие слоты, а не только под текущие новые рынки.
 * Это означает, что каждый рынок получает `freeBalance / availableSlots`, а не
 * `freeBalance / newMarkets`. PnL компаундируется в totalBalance при закрытии
 * рынка через `releaseWithPnL()`.
 *
 * @example
 * ```typescript
 * import { BalanceAllocator } from '@polymarket/balance-allocator';
 * import { Money, Ratio } from '@polymarket/value-objects';
 * import Decimal from 'decimal.js';
 *
 * const allocator = new BalanceAllocator({
 *   tradingBalanceRatio: Ratio.of(new Decimal('0.8')),
 *   minCapitalPerMarket: Money.of(new Decimal(50), 'USDC'),
 *   maxConcurrentMarkets: 10,
 * });
 *
 * allocator.updateTotalBalance(Money.of(new Decimal(10000), 'USDC'));
 * const results = allocator.allocateToNewMarkets(['mkt-1', 'mkt-2']);
 * // results[0].allocatedAmount = $800 USDC (8000 trading balance / 10 available slots)
 * ```
 *
 * @packageDocumentation
 */

export { BalanceAllocator } from './BalanceAllocator.js';
export type { BalanceAllocatorConfig } from './BalanceAllocatorConfig.js';
