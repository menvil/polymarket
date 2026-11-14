/**
 * `@polymarket/polymarket-v2/account` — account plane: authenticated
 * account-state observation.
 *
 * @remarks
 * Отдельная точка входа, а не корень пакета, — сознательно. Account plane
 * в runtime зависит от порта сверки (`@polymarket/account-reconciliation`) и
 * canonical исполнения (`@polymarket/fill`). Если бы корень пакета
 * re-экспортировал его, каждый потребитель data/control-плоскостей
 * (сборщик, recorder, finalizer, control runtime) загружал бы весь стек
 * приватного состояния аккаунта, которому он не нужен.
 *
 * ```text
 * @polymarket/polymarket-v2           data plane + control plane
 * @polymarket/polymarket-v2/account   account plane (этот модуль)
 * ```
 *
 * `PolymarketAccountVenueStateSource` — request/response-адаптер порта
 * `IAccountVenueStateSource`. Он НЕ публикует ни `ExternalMessage`, ни
 * `ApplicationEvent`: обе шины остаются как были, адаптер вызывает сверка.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   PolymarketAccountVenueStateSource,
 *   PolymarketClobRefreshedBalanceReader,
 *   PolymarketStaticTakerFeeRateResolver,
 * } from '@polymarket/polymarket-v2/account';
 * ```
 */
export {
  PolymarketAccountVenueStateSource,
  type PolymarketAccountVenueStateSourceConfig,
  type PolymarketAccountVenueStateSourceDependencies,
  type PolymarketSecureAccountClient,
} from './PolymarketAccountVenueStateSource.js';
export {
  PolymarketClobRefreshedBalanceReader,
  type PolymarketAuthoritativeBalanceReader,
  type PolymarketBalanceAllowanceRefresher,
  type PolymarketBalanceAllowanceRequest,
  type PolymarketBalanceAllowanceSdk,
} from './PolymarketClobRefreshedBalanceReader.js';
export {
  PolymarketStaticTakerFeeRateResolver,
  type PolymarketTakerFeeRateResolver,
} from './PolymarketTakerFeeRateResolver.js';
export { PolymarketAccountStateError } from './polymarketAccountMapping.js';
