/**
 * @polymarket/coordinator — Автономные компоненты управления жизненным циклом рынков.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `MarketDiscoveryPublisher` — автономный цикл обнаружения рынков и их открытия
 * - `MarketExpiryMonitor` — мониторинг истечения рынков и их закрытия
 *
 * ### Принцип работы:
 * Оба компонента работают автономно, без внешнего тикера:
 * - `MarketDiscoveryPublisher` использует паттерн «пауза после завершения» (setTimeout)
 * - `MarketExpiryMonitor` использует фиксированный интервал проверки (setInterval)
 * - Оба подписываются на `MARKET_OPENED` / `MARKET_CLOSED` для отслеживания состояния
 *
 * ### Интеграция:
 * ```typescript
 * const discovery = new MarketDiscoveryPublisher(deps, { accountId, maxStrategies: 10, scanPauseMs: 30_000 });
 * const monitor = new MarketExpiryMonitor(deps, { accountId, checkIntervalMs: 5_000 });
 *
 * discovery.start();
 * monitor.start();
 *
 * // При остановке:
 * discovery.stop();
 * monitor.stop();
 * ```
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
