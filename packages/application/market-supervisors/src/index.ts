/**
 * @polymarket/market-supervisors — Автономные компоненты управления жизненным циклом рынков.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `MarketDiscoveryPublisher` — автономный цикл обнаружения рынков и их открытия
 * - `MarketExpiryMonitor` — мониторинг истечения рынков и их закрытия
 * - `IRemovalPolicy` / `ExpirationRemovalPolicy` — политики закрытия рынков
 *
 * @packageDocumentation
 */

export { MarketDiscoveryPublisher } from './MarketDiscoveryPublisher.js';
export type {
  MarketDiscoveryPublisherDeps,
  MarketDiscoveryPublisherConfig,
} from './MarketDiscoveryPublisher.js';

export { MarketExpiryMonitor } from './MarketExpiryMonitor.js';
export type {
  MarketExpiryMonitorDeps,
  MarketExpiryMonitorConfig,
} from './MarketExpiryMonitor.js';

export { ExpirationRemovalPolicy } from './ExpirationRemovalPolicy.js';
export type { IRemovalPolicy, MarketContext } from './IRemovalPolicy.js';
