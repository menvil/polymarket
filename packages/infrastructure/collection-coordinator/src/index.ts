/**
 * @polymarket/collection-coordinator — LEGACY координатор collection sessions.
 *
 * @deprecated
 * LEGACY BEHAVIOR ORACLE.
 * Not part of canonical collector runtime.
 * Keep until real collector qualification is complete.
 * Delete during Legacy Infrastructure Cleanup.
 *
 * @remarks
 * ### Почему пакет больше не canonical
 *
 * Координатор сам владел физическими ресурсами рынка:
 *
 * ```text
 * discovery.prepareSelected()          ← собственная vendor-подготовка
 * source.subscribeMarket()             ← собственная подписка CLOB
 * source.subscribeCryptoPrices()       ← собственные spot-фиды
 * source.subscribeChainlinkTwap()      ← собственный settlement-поток
 * собственный ref-count RTDS           ← второй счётчик тех же фидов
 * ```
 *
 * После Collector-cutover физическим ресурсом владеет ОДИН компонент —
 * `PolymarketSubscriptionController`, а жизненный цикл уже начатой записи
 * ведёт `PolymarketCollectionLifecycle` (`@polymarket/collector`). Два
 * владельца одних и тех же подписок — не стиль, а источник расхождений:
 * второй ref-count закрывал бы фид, ещё нужный первому.
 *
 * ### Что от него оставлено
 *
 * Проверенная ПОВЕДЕНЧЕСКАЯ политика (ACTIVE/FINALIZING, cutoff на истечении,
 * сужение RTDS до settlement-потока, boundary grace, seal, порядок shutdown)
 * перенесена в canonical lifecycle. DTO финализации header-а живут в
 * `@polymarket/collector` и реэкспортируются отсюда — второго набора
 * одинаковых типов быть не должно.
 *
 * ### Правила обращения до удаления
 *
 * Новых runtime-зависимостей на этот пакет не создавать (проверяется
 * structural-тестом границы в `@polymarket/collector`). Использовать только
 * как оракул поведения при верификации нового контура.
 */
export { MarketCollectionCoordinator } from './MarketCollectionCoordinator.js';
export type {
  CollectionCoordinatorStats,
  CollectionDiscovery,
  CollectionOpenOutcome,
  CollectionRecorder,
  CollectionRtdsFeedStat,
  CollectionSessionSnapshot,
  CollectionSettlementObserver,
  CollectionSource,
  FinalizingMarketSession,
  MarketCollectionCoordinatorConfig,
  MarketCollectionCoordinatorDependencies,
} from './MarketCollectionCoordinator.js';
export { buildCollectionHeader } from './collectionHeader.js';
export type { CollectionHeaderInput } from './collectionHeader.js';
// Canonical DTO финализации живут в `@polymarket/collector`; здесь только
// реэкспорт ради существующих импортов до удаления пакета.
export type {
  CollectionFallbackEvidence,
  CollectionFallbackTrigger,
  CollectionFinalOutcome,
  CollectionHeaderFinalization,
  CollectionPriceProvenance,
  CollectionResolutionProvenance,
  CollectionSettlementDescriptor,
} from './collectionHeader.js';
