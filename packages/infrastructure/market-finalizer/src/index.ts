/**
 * @polymarket/market-finalizer — post-expiry финализация V2-записей (N-004).
 *
 * @remarks
 * Control-plane пакет: due ACTIVE-сессии координатора переводятся в
 * FINALIZING (seal realtime), обогащаются свежими Gamma Market/Event через
 * официальный SDK и архивируются как EXPIRED `.jsonl.gz` с полным финальным
 * V2 header-ом:
 *
 * ```text
 * ACTIVE ──expiresAt──► FINALIZING ──enrich/timeout──► EXPIRED .jsonl.gz
 * ```
 *
 * Data plane (Source → bus → Recorder) пакетом не затрагивается; никаких
 * synthetic Gamma ExternalMessages.
 */
export { MarketFinalizer } from './MarketFinalizer.js';
export type {
  FinalizationCoordinator,
  FinalizationGammaClient,
  FinalizationRecorder,
  MarketFinalizerConfig,
  MarketFinalizerDependencies,
  MarketFinalizerStats,
} from './MarketFinalizer.js';
