/**
 * @polymarket/market-lifecycle — Управление жизненным циклом торговых рынков.
 *
 * @remarks
 * ### Содержимое пакета:
 *
 * **Интерфейсы:**
 * - `IRemovalPolicy` / `MarketContext` — политика удаления рынков
 *
 * **Реализации:**
 * - `ExpirationRemovalPolicy` — закрывает рынки за N мин до истечения
 *
 * **Use Cases:**
 * - `OpenMarketUseCase` — открытие рынка с аллокацией баланса
 * - `CloseMarketUseCase` — закрытие рынка с отменой ордеров и PnL
 *
 * @example
 * ```typescript
 * import { OpenMarketUseCase, CloseMarketUseCase, ExpirationRemovalPolicy } from '@polymarket/market-lifecycle';
 *
 * const policy = new ExpirationRemovalPolicy(clock, 30 * 60 * 1000);
 * const marketsToClose = policy.evaluate(activeMarkets);
 *
 * for (const marketId of marketsToClose) {
 *   await closeMarketUseCase.execute({ marketId, accountId, reason: 'EXPIRED' });
 * }
 * ```
 *
 * @packageDocumentation
 */

// Интерфейсы
export type { IRemovalPolicy, MarketContext } from './IRemovalPolicy.js';

// Реализации
export { ExpirationRemovalPolicy } from './ExpirationRemovalPolicy.js';

// Use Cases
export { OpenMarketUseCase } from './OpenMarketUseCase.js';
export type { OpenMarketDeps, OpenMarketInput } from './OpenMarketUseCase.js';

export { CloseMarketUseCase } from './CloseMarketUseCase.js';
export type { CloseMarketDeps, CloseMarketInput } from './CloseMarketUseCase.js';
