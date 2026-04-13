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
