/**
 * @polymarket/balance-allocator — Распределение торгового баланса по рынкам.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `BalanceAllocator` — реализация IBalanceAllocator (из @polymarket/ports)
 * - `BalanceAllocatorConfig` — параметры конфигурации
 *
 * ### Принцип работы:
 * BalanceAllocator делит `totalBalance * tradingBalanceRatio` поровну между
 * активными рынками с учётом `minCapitalPerMarket` и `maxConcurrentMarkets`.
 * PnL компаундируется в totalBalance при закрытии рынка через `releaseWithPnL()`.
 *
 * @example
 * ```typescript
 * import { BalanceAllocator } from '@polymarket/balance-allocator';
 * import { Money } from '@polymarket/value-objects';
 * import Decimal from 'decimal.js';
 *
 * const allocator = new BalanceAllocator({
 *   tradingBalanceRatio: 0.8,
 *   minCapitalPerMarket: Money.of(new Decimal(50), 'USDC'),
 *   maxConcurrentMarkets: 10,
 * });
 *
 * allocator.updateTotalBalance(Money.of(new Decimal(10000), 'USDC'));
 * const results = allocator.allocateToNewMarkets(['mkt-1', 'mkt-2']);
 * // results[0].allocatedAmount ≈ $4000 USDC
 * ```
 *
 * @packageDocumentation
 */

export { BalanceAllocator } from './BalanceAllocator.js';
export type { BalanceAllocatorConfig } from './BalanceAllocatorConfig.js';
