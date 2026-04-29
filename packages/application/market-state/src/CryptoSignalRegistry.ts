import type {
  CexVenue,
  CryptoPriceHistoryView,
  CryptoPriceSource,
  CryptoVenueHistoryView,
  CryptoVenueStateView,
} from './CryptoMarketDataStore.js';

/**
 * Направление торгового сигнала относительно базового актива.
 *
 * - `up` — цена актива растёт относительно опорного значения.
 * - `down` — цена актива падает.
 * - `flat` — нет значимого движения (ниже порога `thresholdBps`).
 */
export type CryptoSignalDirection = 'up' | 'down' | 'flat';

/**
 * Результат вычисления торгового сигнала.
 *
 * @remarks
 * Возвращается методами `CryptoSignalRegistry.evaluate()` и
 * `CryptoSignalRegistryView.evaluate()`.
 */
export interface CryptoSignalResult {
  /** Идентификатор сигнала (напр. "cex_chainlink_lead_lag"). */
  readonly id: string;
  /** Символ базового актива (напр. "BTC"). */
  readonly asset: string;
  /** Timestamp вычисления сигнала (Unix ms). */
  readonly tsMs: number;
  /** Числовое значение сигнала в единицах `unit`. */
  readonly value: number;
  /** Единица измерения значения. */
  readonly unit: 'bps' | 'price' | 'score';
  /** Направление: up, down или flat. */
  readonly direction: CryptoSignalDirection;
  /**
   * Нормированная сила сигнала [0..10]:
   * 0 — нет сигнала, 10 — максимальная сила.
   */
  readonly strength: number;
  /**
   * Уверенность в направлении [0..1].
   * 0 — данные устаревшие или нет согласия бирж,
   * 1 — максимальная уверенность.
   */
  readonly confidence: number;
  /**
   * Флаг: данные устарели (возраст > `staleMs`).
   * При `stale = true` `confidence = 0`.
   */
  readonly stale: boolean;
  /** Диагностические компоненты для отладки (venue prices, age и т.д.). */
  readonly components: Readonly<Record<string, number | string | boolean>>;
}

/**
 * Контекст для вычисления сигнала — рыночные данные на момент вызова.
 */
export interface CryptoSignalContext {
  /** Символ базового актива. */
  readonly asset: string;
  /** Текущее время (Unix ms). */
  readonly nowMs: number;
  /** История цен по источникам (Chainlink, CEX). */
  readonly priceHistory?: CryptoPriceHistoryView;
  /** Текущее состояние стаканов по биржам. */
  readonly venueState?: CryptoVenueStateView;
  /** История microprice по биржам. */
  readonly venueHistory?: CryptoVenueHistoryView;
}

/**
 * Параметры запроса сигнала — фильтры и настройки агрегации.
 */
export interface CryptoSignalRequest {
  /** Список CEX-бирж для агрегации. Default: ['binance', 'coinbase', 'okx']. */
  readonly venues?: readonly CexVenue[];
  /** Источники цен (напр. 'polymarket_chainlink'). */
  readonly sources?: readonly CryptoPriceSource[];
  /** Веса бирж для взвешенной агрегации. */
  readonly weights?: Readonly<Record<string, number>>;
  /** Intercept in USD for offline linear CEX→Chainlink models. */
  readonly linearInterceptUsd?: number;
  /**
   * Per-venue статический базис в USD, обычно вычисляется офлайн как
   * `median(venueMicroprice - chainlinkPrice)`.
   */
  readonly basisByVenue?: Readonly<Record<string, number>>;
  /** Minimum number of fresh venues required to emit a signal. */
  readonly minVenueCount?: number;
  /** Ignore venue books wider than this spread. */
  readonly maxSpreadBps?: number;
  /** Optional offline-calibrated direction hit rate by score bucket `1..10`. */
  readonly confidenceByScore?: Readonly<Record<string, number>>;
  /** Окно истории для momentum компоненты (ms). Default: 1000. */
  readonly lookbackMs?: number;
  /** Максимальный возраст данных биржи (ms). Default: 2000. */
  readonly staleMs?: number;
  /** Минимальный порог значения для direction != flat (bps). Default: 0.5. */
  readonly thresholdBps?: number;
  /** Минимум исторических samples на venue для rolling-basis сигналов. Default: 3. */
  readonly minBasisSamples?: number;
}

/**
 * Неизменяемый view реестра сигналов, привязанный к конкретному контексту.
 *
 * @remarks
 * Создаётся через `CryptoSignalRegistry.createView(context)`.
 * Передаётся в стратегии через `StrategySnapshot.cryptoSignals`.
 */
export interface CryptoSignalRegistryView {
  /** Возвращает список зарегистрированных идентификаторов сигналов. */
  list(): readonly string[];
  /**
   * Вычисляет сигнал по ID с заданными параметрами.
   *
   * @param signalId - Идентификатор сигнала
   * @param request - Параметры запроса
   * @returns Результат сигнала или `undefined` если данных недостаточно
   */
  evaluate(signalId: string, request?: CryptoSignalRequest): CryptoSignalResult | undefined;
}

/**
 * Функция вычисления одного сигнала.
 *
 * @param context - Рыночные данные на момент вычисления
 * @param request - Параметры запроса (фильтры, веса, пороги)
 * @returns Результат сигнала или `undefined` если данных недостаточно
 */
export type CryptoSignalCalculator = (
  context: CryptoSignalContext,
  request: CryptoSignalRequest,
) => CryptoSignalResult | undefined;

/**
 * Реестр торговых сигналов на основе крипто-рыночных данных.
 *
 * @remarks
 * Хранит словарь `id → CryptoSignalCalculator`.
 * Каждый calculator получает рыночный контекст и параметры запроса,
 * возвращает типизированный результат с направлением, силой и уверенностью.
 *
 * ### Встроенные сигналы (через `createDefaultCryptoSignalRegistry()`):
 * - **`cex_weighted_microprice_momentum`** — взвешенный momentum microprice
 *   CEX-бирж за период `lookbackMs`.
 * - **`cex_vs_chainlink_basis`** — отклонение CEX microprice от Chainlink (bps).
 * - **`cex_chainlink_lead_lag`** — комбинированный lead-lag сигнал:
 *   residual (CEX vs Chainlink) + momentum + trade pressure,
 *   взвешенные по quality (возраст, спред).
 * - **`cex_chainlink_rolling_divergence`** — CEX-vs-Chainlink residual
 *   после вычитания rolling median basis за `lookbackMs`.
 *
 * @example
 * ```typescript
 * const registry = createDefaultCryptoSignalRegistry();
 * const view = registry.createView({ asset: 'BTC', nowMs: Date.now(), venueState, priceHistory });
 * const signal = view.evaluate('cex_chainlink_lead_lag', { venues: ['binance', 'coinbase'] });
 * ```
 */
export class CryptoSignalRegistry {
  private readonly _calculators = new Map<string, CryptoSignalCalculator>();

  /**
   * Регистрирует новый сигнал.
   *
   * @param id - Уникальный идентификатор сигнала
   * @param calculator - Функция вычисления
   */
  register(id: string, calculator: CryptoSignalCalculator): void {
    this._calculators.set(id, calculator);
  }

  /**
   * Возвращает список зарегистрированных идентификаторов.
   *
   * @returns Массив строк — IDs всех сигналов
   */
  list(): readonly string[] {
    return [...this._calculators.keys()];
  }

  /**
   * Создаёт view реестра, привязанный к конкретному рыночному контексту.
   *
   * @remarks
   * View передаётся в стратегии: `snapshot.cryptoSignals = registry.createView(ctx)`.
   * Позволяет вызывать `evaluate()` без явной передачи контекста.
   *
   * @param context - Рыночные данные на момент создания view
   * @returns Неизменяемый `CryptoSignalRegistryView`
   */
  createView(context: CryptoSignalContext): CryptoSignalRegistryView {
    return {
      list: () => this.list(),
      evaluate: (signalId, request = {}) => this.evaluate(signalId, context, request),
    };
  }

  /**
   * Вычисляет сигнал по ID с явным контекстом и параметрами.
   *
   * @param signalId - Идентификатор сигнала
   * @param context - Рыночные данные
   * @param request - Параметры запроса
   * @returns Результат сигнала или `undefined` если calculator не найден
   *   или данных недостаточно
   */
  evaluate(
    signalId: string,
    context: CryptoSignalContext,
    request: CryptoSignalRequest = {},
  ): CryptoSignalResult | undefined {
    return this._calculators.get(signalId)?.(context, request);
  }
}

/**
 * Создаёт реестр с тремя встроенными сигналами.
 *
 * @remarks
 * Регистрирует:
 * - `cex_weighted_microprice_momentum`
 * - `cex_vs_chainlink_basis`
 * - `cex_chainlink_lead_lag`
 *
 * @returns Готовый к использованию `CryptoSignalRegistry`
 */
export function createDefaultCryptoSignalRegistry(): CryptoSignalRegistry {
  const registry = new CryptoSignalRegistry();
  registry.register('cex_weighted_microprice_momentum', weightedMicropriceMomentum);
  registry.register('cex_vs_chainlink_basis', cexVsChainlinkBasis);
  registry.register('cex_chainlink_lead_lag', cexChainlinkLeadLag);
  registry.register('cex_chainlink_rolling_divergence', cexChainlinkRollingDivergence);
  registry.register('cex_chainlink_linear_lead_lag', cexChainlinkLinearLeadLag);
  return registry;
}

/**
 * Сигнал: взвешенный momentum microprice CEX-бирж.
 *
 * @remarks
 * Вычисляет изменение взвешенного microprice за период `lookbackMs`:
 * `value = (current - previous) / previous × 10000` (bps).
 *
 * @param context - Рыночный контекст
 * @param request - Параметры запроса
 * @returns Результат сигнала или `undefined` при недостатке данных
 */
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

/**
 * Сигнал: отклонение CEX microprice от Chainlink (basis bps).
 *
 * @remarks
 * `value = (cex - chainlink) / chainlink × 10000` (bps).
 * Положительное значение — CEX торгуется выше Chainlink (bullish).
 *
 * @param context - Рыночный контекст
 * @param request - Параметры запроса
 * @returns Результат сигнала или `undefined` при недостатке данных
 */
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

  const cexAgeMs = context.nowMs - current.lastTsMs;
  const chainlinkAgeMs = context.nowMs - chainlink.exchangeTsMs;
  const tsMs = Math.min(current.lastTsMs, chainlink.exchangeTsMs);
  const ageMs = Math.max(cexAgeMs, chainlinkAgeMs);
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
      cexAgeMs,
      chainlinkAgeMs,
      ageMs,
    },
  });
}

/**
 * Сигнал: комбинированный CEX lead-lag относительно Chainlink.
 *
 * @remarks
 * Агрегирует три компоненты с quality-взвешиванием (возраст + спред):
 * - **residualBps** — отклонение microprice от Chainlink за вычетом basis.
 * - **momentumBps** — изменение microprice за `lookbackMs`.
 * - **tradePressure** — агрегированное давление сделок.
 *
 * Итоговое значение:
 * `valueBps = residual + momentum × 0.25 + tradePressure × threshold × 0.5`
 *
 * **Уверенность** (`confidence`):
 * - Если задан `confidenceByScore` — использует калиброванное значение по bucket.
 * - Иначе — `(strength / 10) × (0.5 + agreement / 2)`, где agreement —
 *   доля бирж, согласных с направлением.
 *
 * @param context - Рыночный контекст
 * @param request - Параметры запроса
 * @returns Результат сигнала или `undefined` при недостатке данных
 */
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
  const chainlinkAgeMs = context.nowMs - chainlink.exchangeTsMs;
  if (chainlinkAgeMs < 0 || chainlinkAgeMs > staleMs) return undefined;

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
  const stale = maxAgeMs > staleMs || chainlinkAgeMs > staleMs;
  const confidence = stale
    ? 0
    : calibratedConfidence ?? Math.max(0, Math.min(1, (strength / 10) * (0.5 + agreement / 2)));

  return {
    id: 'cex_chainlink_lead_lag',
    asset: context.asset,
    tsMs: Math.min(lastTsMs, chainlink.exchangeTsMs),
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
      chainlinkAgeMs,
      avgSpreadBps: avgSpreadBps / venueCount,
      calibrated: calibratedConfidence !== undefined,
    },
  };
}

/**
 * Rolling CEX-vs-Chainlink divergence without offline coefficients.
 *
 * @remarks
 * For each venue:
 * 1. Builds `basis = median(venueMicroprice - chainlinkPrice)` over `lookbackMs`.
 * 2. Computes current residual after subtracting that basis.
 * 3. Aggregates venue residuals by median and requires venue agreement.
 *
 * This is intended for "CEX оторвался от Chainlink" experiments where the
 * absolute venue basis changes day to day and should adapt online.
 */
function cexChainlinkRollingDivergence(
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
  const lookbackMs = request.lookbackMs ?? 60_000;
  const thresholdBps = request.thresholdBps ?? 0.5;
  const minVenueCount = request.minVenueCount ?? Math.min(2, venues.length);
  const minBasisSamples = request.minBasisSamples ?? 3;
  const maxSpreadBps = request.maxSpreadBps ?? 10;
  const chainlinkAgeMs = context.nowMs - chainlink.exchangeTsMs;
  if (chainlinkAgeMs < 0 || chainlinkAgeMs > staleMs) return undefined;

  const chainlinkHistory = priceHistory.getRecent('polymarket_chainlink', lookbackMs + staleMs);
  const residualsBps: number[] = [];
  let lastTsMs = 0;
  let maxAgeMs = chainlinkAgeMs;
  let spreadSumBps = 0;
  let venueCount = 0;
  let positiveVenues = 0;
  let negativeVenues = 0;
  const components: Record<string, number | string | boolean> = {
    thresholdBps,
    lookbackMs,
    minBasisSamples,
    chainlinkPrice: chainlink.price,
  };

  for (const venue of venues) {
    const state = venueState.get(venue);
    if (!state) continue;

    const ageMs = context.nowMs - state.lastBookTsMs;
    if (ageMs < 0 || ageMs > staleMs) continue;
    if (state.spreadBps > maxSpreadBps) continue;

    const venueHistory = priceHistory
      .getRecent(cexVenueToPriceSource(venue), lookbackMs)
      .filter((point) => point.exchangeTsMs < state.lastBookTsMs);
    const basisSamples: number[] = [];
    for (const point of venueHistory) {
      const chainlinkAtPoint = nearestPrice(point.exchangeTsMs, chainlinkHistory, staleMs);
      if (!chainlinkAtPoint) continue;
      basisSamples.push(point.price - chainlinkAtPoint.price);
    }
    if (basisSamples.length < minBasisSamples) continue;

    const basisUsd = medianNumber(basisSamples);
    const residualUsd = state.microprice - chainlink.price - basisUsd;
    const residualBps = residualUsd / chainlink.price * 10_000;
    residualsBps.push(residualBps);
    if (residualBps >= thresholdBps) positiveVenues++;
    if (residualBps <= -thresholdBps) negativeVenues++;

    venueCount++;
    lastTsMs = Math.max(lastTsMs, state.lastBookTsMs);
    maxAgeMs = Math.max(maxAgeMs, ageMs);
    spreadSumBps += state.spreadBps;
    components[`${venue}BasisUsd`] = basisUsd;
    components[`${venue}ResidualBps`] = residualBps;
    components[`${venue}BasisSamples`] = basisSamples.length;
  }

  if (venueCount < minVenueCount || residualsBps.length < minVenueCount) return undefined;

  const valueBpsRaw = medianNumber(residualsBps);
  const rawDirection: CryptoSignalDirection = Math.abs(valueBpsRaw) < thresholdBps
    ? 'flat'
    : valueBpsRaw > 0
      ? 'up'
      : 'down';
  const agreeingVenues = rawDirection === 'up'
    ? positiveVenues
    : rawDirection === 'down'
      ? negativeVenues
      : 0;
  const valueBps = rawDirection === 'flat' || agreeingVenues < minVenueCount ? 0 : valueBpsRaw;

  return makeSignalResult({
    id: 'cex_chainlink_rolling_divergence',
    asset: context.asset,
    tsMs: Math.min(lastTsMs, chainlink.exchangeTsMs),
    value: valueBps,
    unit: 'bps',
    thresholdBps,
    stale: maxAgeMs > staleMs,
    components: {
      ...components,
      venues: venues.join(','),
      venueCount,
      minVenueCount,
      positiveVenues,
      negativeVenues,
      agreeingVenues,
      rawValueBps: valueBpsRaw,
      maxAgeMs,
      chainlinkAgeMs,
      avgSpreadBps: spreadSumBps / venueCount,
      maxSpreadBps,
    },
  });
}

/**
 * Offline linear CEX→Chainlink lead-lag model.
 *
 * @remarks
 * Mirrors `scripts/backtest-cex-crowd.ts`: each venue feature is
 * `venueMicroprice - venueBasis - chainlinkPrice`, then
 * `predDeltaUsd = intercept + Σ(weight_venue × feature_venue)`.
 */
function cexChainlinkLinearLeadLag(
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
  const chainlinkAgeMs = context.nowMs - chainlink.exchangeTsMs;
  if (chainlinkAgeMs < 0 || chainlinkAgeMs > staleMs) return undefined;

  const thresholdBps = request.thresholdBps ?? 0.5;
  const minVenueCount = request.minVenueCount ?? venues.length;
  const maxSpreadBps = request.maxSpreadBps ?? 10;

  let predDeltaUsd = request.linearInterceptUsd ?? 0;
  let venueCount = 0;
  let lastTsMs = 0;
  let maxAgeMs = 0;
  let spreadSumBps = 0;
  const components: Record<string, number | string | boolean> = {
    interceptUsd: predDeltaUsd,
    thresholdBps,
  };

  for (const venue of venues) {
    const state = venueState.get(venue);
    if (!state) continue;

    const ageMs = context.nowMs - state.lastBookTsMs;
    if (ageMs < 0 || ageMs > staleMs) continue;
    if (state.spreadBps > maxSpreadBps) continue;

    const coefficient = request.weights?.[venue] ?? 0;
    if (!Number.isFinite(coefficient)) continue;

    const basisUsd = request.basisByVenue?.[venue] ?? 0;
    const residualUsd = state.microprice - basisUsd - chainlink.price;
    predDeltaUsd += coefficient * residualUsd;

    components[`${venue}ResidualUsd`] = residualUsd;
    components[`${venue}Weight`] = coefficient;
    components[`${venue}BasisUsd`] = basisUsd;

    venueCount++;
    lastTsMs = Math.max(lastTsMs, state.lastBookTsMs);
    maxAgeMs = Math.max(maxAgeMs, ageMs);
    spreadSumBps += state.spreadBps;
  }

  if (venueCount < minVenueCount) return undefined;

  const predBps = predDeltaUsd / chainlink.price * 10_000;
  return makeSignalResult({
    id: 'cex_chainlink_linear_lead_lag',
    asset: context.asset,
    tsMs: Math.min(lastTsMs, chainlink.exchangeTsMs),
    value: predBps,
    unit: 'bps',
    thresholdBps,
    stale: maxAgeMs > staleMs || chainlinkAgeMs > staleMs,
    components: {
      ...components,
      venues: venues.join(','),
      venueCount,
      minVenueCount,
      chainlinkPrice: chainlink.price,
      predDeltaUsd,
      predBps,
      maxAgeMs,
      chainlinkAgeMs,
      avgSpreadBps: spreadSumBps / venueCount,
      maxSpreadBps,
    },
  });
}

/**
 * Вычисляет взвешенный microprice по набору CEX-бирж.
 *
 * @param venueState - Текущее состояние стаканов
 * @param venues - Список бирж
 * @param weights - Веса бирж (optional)
 * @returns Взвешенная цена, timestamp и количество бирж, или `undefined`
 */
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

/**
 * Строит `CryptoSignalResult` из сырых компонент.
 *
 * @remarks
 * Вычисляет direction, strength и confidence по стандартной формуле:
 * - `direction = flat / up / down` по `|value| vs threshold`.
 * - `strength = min(10, |value| / threshold)`.
 * - `confidence = stale ? 0 : min(1, strength / 10)`.
 *
 * @param input - Параметры для построения результата
 * @returns Готовый `CryptoSignalResult`
 */
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

function nearestPrice(
  tsMs: number,
  points: readonly { readonly price: number; readonly exchangeTsMs: number }[],
  maxDistanceMs: number,
): { readonly price: number; readonly exchangeTsMs: number } | undefined {
  let best: { readonly price: number; readonly exchangeTsMs: number } | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.abs(point.exchangeTsMs - tsMs);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best && bestDistance <= maxDistanceMs ? best : undefined;
}

function medianNumber(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Конвертирует CexVenue в CryptoPriceSource для обращения к истории цен.
 *
 * @param venue - Идентификатор биржи (напр. "binance")
 * @returns Строка вида "cex_binance"
 */
function cexVenueToPriceSource(venue: CexVenue): CryptoPriceSource {
  return `cex_${venue}` as CryptoPriceSource;
}
