import type {
  CexVenue,
  CryptoPriceHistoryView,
  CryptoPriceSource,
  CryptoVenueHistoryView,
  CryptoVenueStateView,
} from './CryptoMarketDataStore.js';

export type CryptoSignalDirection = 'up' | 'down' | 'flat';

export interface CryptoSignalResult {
  readonly id: string;
  readonly asset: string;
  readonly tsMs: number;
  readonly value: number;
  readonly unit: 'bps' | 'price' | 'score';
  readonly direction: CryptoSignalDirection;
  readonly strength: number;
  readonly confidence: number;
  readonly stale: boolean;
  readonly components: Readonly<Record<string, number | string | boolean>>;
}

export interface CryptoSignalContext {
  readonly asset: string;
  readonly nowMs: number;
  readonly priceHistory?: CryptoPriceHistoryView;
  readonly venueState?: CryptoVenueStateView;
  readonly venueHistory?: CryptoVenueHistoryView;
}

export interface CryptoSignalRequest {
  readonly venues?: readonly CexVenue[];
  readonly sources?: readonly CryptoPriceSource[];
  readonly weights?: Readonly<Record<string, number>>;
  /**
   * Per-venue static basis in USD, usually estimated offline as
   * `median(venueMicroprice - chainlinkPrice)`.
   */
  readonly basisByVenue?: Readonly<Record<string, number>>;
  /** Minimum number of fresh venues required to emit a signal. */
  readonly minVenueCount?: number;
  /** Ignore venue books wider than this spread. */
  readonly maxSpreadBps?: number;
  /** Optional offline-calibrated direction hit rate by score bucket `1..10`. */
  readonly confidenceByScore?: Readonly<Record<string, number>>;
  readonly lookbackMs?: number;
  readonly staleMs?: number;
  readonly thresholdBps?: number;
}

export interface CryptoSignalRegistryView {
  list(): readonly string[];
  evaluate(signalId: string, request?: CryptoSignalRequest): CryptoSignalResult | undefined;
}

export type CryptoSignalCalculator = (
  context: CryptoSignalContext,
  request: CryptoSignalRequest,
) => CryptoSignalResult | undefined;

export class CryptoSignalRegistry {
  private readonly _calculators = new Map<string, CryptoSignalCalculator>();

  register(id: string, calculator: CryptoSignalCalculator): void {
    this._calculators.set(id, calculator);
  }

  list(): readonly string[] {
    return [...this._calculators.keys()];
  }

  createView(context: CryptoSignalContext): CryptoSignalRegistryView {
    return {
      list: () => this.list(),
      evaluate: (signalId, request = {}) => this.evaluate(signalId, context, request),
    };
  }

  evaluate(
    signalId: string,
    context: CryptoSignalContext,
    request: CryptoSignalRequest = {},
  ): CryptoSignalResult | undefined {
    return this._calculators.get(signalId)?.(context, request);
  }
}

export function createDefaultCryptoSignalRegistry(): CryptoSignalRegistry {
  const registry = new CryptoSignalRegistry();
  registry.register('cex_weighted_microprice_momentum', weightedMicropriceMomentum);
  registry.register('cex_vs_chainlink_basis', cexVsChainlinkBasis);
  registry.register('cex_chainlink_lead_lag', cexChainlinkLeadLag);
  return registry;
}

function weightedMicropriceMomentum(
  context: CryptoSignalContext,
  request: CryptoSignalRequest,
): CryptoSignalResult | undefined {
  const priceHistory = context.priceHistory;
  const venueState = context.venueState;
  if (!priceHistory || !venueState) return undefined;

  const venues = request.venues ?? ['binance', 'coinbase', 'okx'];
  const lookbackMs = request.lookbackMs ?? 1_000;
  const staleMs = request.staleMs ?? 2_000;
  const thresholdBps = request.thresholdBps ?? 0.5;

  const current = weightedVenuePrice(venueState, venues, request.weights);
  if (!current) return undefined;

  let previousNumerator = 0;
  let previousDenominator = 0;
  for (const venue of venues) {
    const history = priceHistory.getRecent(cexVenueToPriceSource(venue), lookbackMs);
    const point = history[0];
    if (!point) continue;
    const weight = request.weights?.[venue] ?? 1;
    previousNumerator += point.price * weight;
    previousDenominator += weight;
  }

  if (previousDenominator <= 0) return undefined;

  const previous = previousNumerator / previousDenominator;
  const valueBps = ((current.price - previous) / previous) * 10_000;
  const ageMs = context.nowMs - current.lastTsMs;

  return makeSignalResult({
    id: 'cex_weighted_microprice_momentum',
    asset: context.asset,
    tsMs: current.lastTsMs,
    value: valueBps,
    unit: 'bps',
    thresholdBps,
    stale: ageMs > staleMs,
    components: {
      venues: venues.join(','),
      currentPrice: current.price,
      previousPrice: previous,
      lookbackMs,
      ageMs,
      venueCount: current.venueCount,
    },
  });
}

function cexVsChainlinkBasis(
  context: CryptoSignalContext,
  request: CryptoSignalRequest,
): CryptoSignalResult | undefined {
  const priceHistory = context.priceHistory;
  const venueState = context.venueState;
  if (!priceHistory || !venueState) return undefined;

  const venues = request.venues ?? ['binance', 'coinbase', 'okx'];
  const staleMs = request.staleMs ?? 2_000;
  const thresholdBps = request.thresholdBps ?? 0.5;
  const current = weightedVenuePrice(venueState, venues, request.weights);
  const chainlink = priceHistory.getLatest('polymarket_chainlink');
  if (!current || !chainlink) return undefined;

  const tsMs = Math.max(current.lastTsMs, chainlink.exchangeTsMs);
  const ageMs = context.nowMs - tsMs;
  const valueBps = ((current.price - chainlink.price) / chainlink.price) * 10_000;

  return makeSignalResult({
    id: 'cex_vs_chainlink_basis',
    asset: context.asset,
    tsMs,
    value: valueBps,
    unit: 'bps',
    thresholdBps,
    stale: ageMs > staleMs,
    components: {
      venues: venues.join(','),
      cexPrice: current.price,
      chainlinkPrice: chainlink.price,
      venueCount: current.venueCount,
      ageMs,
    },
  });
}

function cexChainlinkLeadLag(
  context: CryptoSignalContext,
  request: CryptoSignalRequest,
): CryptoSignalResult | undefined {
  const priceHistory = context.priceHistory;
  const venueState = context.venueState;
  if (!priceHistory || !venueState) return undefined;

  const chainlink = priceHistory.getLatest('polymarket_chainlink');
  if (!chainlink || !Number.isFinite(chainlink.price) || chainlink.price <= 0) return undefined;

  const venues = request.venues ?? ['binance', 'coinbase', 'okx'];
  const staleMs = request.staleMs ?? 2_000;
  const lookbackMs = request.lookbackMs ?? 1_000;
  const thresholdBps = request.thresholdBps ?? 0.5;
  const minVenueCount = request.minVenueCount ?? Math.min(2, venues.length);
  const maxSpreadBps = request.maxSpreadBps ?? 10;

  let residualNumerator = 0;
  let momentumNumerator = 0;
  let tradePressureNumerator = 0;
  let denominator = 0;
  let lastTsMs = 0;
  let venueCount = 0;
  let agreeingVenues = 0;
  let positiveVenues = 0;
  let negativeVenues = 0;
  let maxAgeMs = 0;
  let avgSpreadBps = 0;

  for (const venue of venues) {
    const state = venueState.get(venue);
    if (!state) continue;

    const ageMs = context.nowMs - state.lastBookTsMs;
    if (ageMs < 0 || ageMs > staleMs) continue;
    if (state.spreadBps > maxSpreadBps) continue;

    const configuredWeight = request.weights?.[venue] ?? 1;
    if (!Number.isFinite(configuredWeight) || configuredWeight <= 0) continue;

    const basisUsd = request.basisByVenue?.[venue] ?? 0;
    const residualUsd = state.microprice - basisUsd - chainlink.price;
    const residualBps = residualUsd / chainlink.price * 10_000;

    const previous = priceHistory.getRecent(cexVenueToPriceSource(venue), lookbackMs)[0];
    const momentumBps = previous && previous.price > 0
      ? (state.microprice - previous.price) / previous.price * 10_000
      : 0;

    const qualityWeight =
      configuredWeight
      / (1 + ageMs / Math.max(staleMs, 1))
      / (1 + state.spreadBps / Math.max(maxSpreadBps, 0.01));

    residualNumerator += residualBps * qualityWeight;
    momentumNumerator += momentumBps * qualityWeight;
    tradePressureNumerator += state.recentTradePressure * qualityWeight;
    denominator += qualityWeight;
    lastTsMs = Math.max(lastTsMs, state.lastBookTsMs);
    maxAgeMs = Math.max(maxAgeMs, ageMs);
    avgSpreadBps += state.spreadBps;
    venueCount++;

    if (Math.abs(residualBps) >= thresholdBps) {
      if (residualBps > 0) positiveVenues++;
      if (residualBps < 0) negativeVenues++;
    }
  }

  if (denominator <= 0 || venueCount < minVenueCount) return undefined;

  const residualBps = residualNumerator / denominator;
  const momentumBps = momentumNumerator / denominator;
  const tradePressure = tradePressureNumerator / denominator;
  const valueBps = residualBps + momentumBps * 0.25 + tradePressure * thresholdBps * 0.5;
  const direction: CryptoSignalDirection = Math.abs(valueBps) < thresholdBps
    ? 'flat'
    : valueBps > 0
      ? 'up'
      : 'down';

  if (direction === 'up') agreeingVenues = positiveVenues;
  if (direction === 'down') agreeingVenues = negativeVenues;
  const agreement = direction === 'flat' ? 0 : agreeingVenues / venueCount;
  const strength = Math.max(0, Math.min(10, Math.abs(valueBps) / Math.max(thresholdBps, 0.0001)));
  const scoreBucket = Math.max(0, Math.min(10, Math.ceil(strength)));
  const calibratedConfidence = request.confidenceByScore?.[String(scoreBucket)];
  const stale = maxAgeMs > staleMs;
  const confidence = stale
    ? 0
    : calibratedConfidence ?? Math.max(0, Math.min(1, (strength / 10) * (0.5 + agreement / 2)));

  return {
    id: 'cex_chainlink_lead_lag',
    asset: context.asset,
    tsMs: Math.max(lastTsMs, chainlink.exchangeTsMs),
    value: valueBps,
    unit: 'bps',
    direction,
    strength,
    confidence,
    stale,
    components: {
      venues: venues.join(','),
      venueCount,
      minVenueCount,
      chainlinkPrice: chainlink.price,
      residualBps,
      momentumBps,
      tradePressure,
      agreement,
      positiveVenues,
      negativeVenues,
      scoreBucket,
      thresholdBps,
      maxAgeMs,
      avgSpreadBps: avgSpreadBps / venueCount,
      calibrated: calibratedConfidence !== undefined,
    },
  };
}

function weightedVenuePrice(
  venueState: CryptoVenueStateView,
  venues: readonly CexVenue[],
  weights: Readonly<Record<string, number>> | undefined,
): { readonly price: number; readonly lastTsMs: number; readonly venueCount: number } | undefined {
  let numerator = 0;
  let denominator = 0;
  let lastTsMs = 0;
  let venueCount = 0;

  for (const venue of venues) {
    const state = venueState.get(venue);
    if (!state) continue;
    const weight = weights?.[venue] ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    numerator += state.microprice * weight;
    denominator += weight;
    lastTsMs = Math.max(lastTsMs, state.lastBookTsMs);
    venueCount++;
  }

  if (denominator <= 0 || venueCount === 0) return undefined;
  return { price: numerator / denominator, lastTsMs, venueCount };
}

function makeSignalResult(input: {
  readonly id: string;
  readonly asset: string;
  readonly tsMs: number;
  readonly value: number;
  readonly unit: 'bps' | 'price' | 'score';
  readonly thresholdBps: number;
  readonly stale: boolean;
  readonly components: Readonly<Record<string, number | string | boolean>>;
}): CryptoSignalResult {
  const absValue = Math.abs(input.value);
  const direction: CryptoSignalDirection = absValue < input.thresholdBps
    ? 'flat'
    : input.value > 0
      ? 'up'
      : 'down';
  const strength = Math.max(0, Math.min(10, absValue / input.thresholdBps));
  const confidence = input.stale ? 0 : Math.max(0, Math.min(1, strength / 10));

  return {
    id: input.id,
    asset: input.asset,
    tsMs: input.tsMs,
    value: input.value,
    unit: input.unit,
    direction,
    strength,
    confidence,
    stale: input.stale,
    components: input.components,
  };
}

function cexVenueToPriceSource(venue: CexVenue): CryptoPriceSource {
  return `cex_${venue}` as CryptoPriceSource;
}
