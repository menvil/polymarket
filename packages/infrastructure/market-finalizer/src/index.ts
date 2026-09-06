/**
 * @polymarket/market-finalizer — post-expiry финализация V2-записей (N-004).
 *
 * @remarks
 * Control-plane пакет: due ACTIVE-сессии collection lifecycle переводятся в
 * FINALIZING (cutoff → settlement grace → seal), обогащаются свежими Gamma
 * Market/Event через официальный SDK и архивируются как EXPIRED `.jsonl.gz`
 * с canonical V2 header-ом, дополненным разделом `finalization`:
 *
 * ```text
 * ACTIVE ──expiresAt──► FINALIZING ──enrich/timeout──► EXPIRED .jsonl.gz
 * ```
 *
 * Data plane (Source → bus → Recorder) пакетом не затрагивается; никаких
 * synthetic Gamma ExternalMessages.
 */
export { MarketFinalizer } from './MarketFinalizer.js';
export { deriveWinnerFromRecordedTwap } from './recordedTwapSettlement.js';
export type {
  RecordedTwapDerivation,
  TwapSettlementObservation,
} from './recordedTwapSettlement.js';
export type {
  FinalizationGammaClient,
  FinalizationLifecycle,
  FinalizingMarketSession,
  FinalizationOutcome,
  FinalizationRecorder,
  MarketFinalizerConfig,
  MarketFinalizerDependencies,
  MarketFinalizerStats,
} from './MarketFinalizer.js';
