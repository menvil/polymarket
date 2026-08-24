/**
 * Тестовая обвязка finalizer-а: РЕАЛЬНЫЙ MarketCollectionCoordinator поверх
 * journaled-fakes координатора + локальные fakes Gamma/recorder.
 *
 * @remarks
 * Fakes discovery/source/clock/logger переиспользуются из тестовой обвязки
 * `@polymarket/collection-coordinator` относительным импортом СОЗНАТЕЛЬНО:
 * это единый source of truth тестовой инфраструктуры контура (тот же приём,
 * что parity-оракул N-003); публичный API пакета тесты не расширяет.
 * Fresh-Gamma fixtures повторяют live-характеризацию 2026-08-24 (SDK 0.6.0):
 * `outcomes.*.price` — DecimalString (`"1"`/`"0"` у resolved),
 * `event.metadata.priceToBeat/finalPrice` — JSON numbers,
 * `state.closedTime` — не-ISO vendor-строка.
 */
import type { MarketId } from '@polymarket/ids';
import type { PolymarketGammaEvent, PolymarketGammaMarket } from '@polymarket/polymarket-v2';
import { MarketCollectionCoordinator } from '@polymarket/collection-coordinator';
import { MarketFinalizer } from '../../src/index.js';
import type { FinalizationGammaClient, MarketFinalizerConfig } from '../../src/index.js';
import {
  CID_A,
  CallLog,
  CapturingLogger,
  FakeCollectionRecorder,
  FakeCollectionSource,
  FakeDiscovery,
  FixedClock,
  NOW_MS,
  TOKEN_DOWN,
  TOKEN_UP,
} from '../../../collection-coordinator/__tests__/helpers/fakes.js';

export {
  CID_A,
  CID_B,
  NOW_MS,
  TOKEN_DOWN,
  TOKEN_UP,
  mid,
  waitFor,
} from '../../../collection-coordinator/__tests__/helpers/fakes.js';

/** Gamma numeric id рынка фикстур (см. createCandidate координатора). */
export const GAMMA_MARKET_ID = '516789';
/** Gamma event id рынка фикстур. */
export const GAMMA_EVENT_ID = '99001';

/**
 * Recorder-fake finalizer-а: registrations/seal/finalize координатора +
 * наблюдаемый updateMarketMeta.
 */
export class FakeFinalizationRecorder extends FakeCollectionRecorder {
  /** Записанные header-обновления в порядке вызовов. */
  public readonly metaUpdates: Array<{ marketId: string; header: Record<string, unknown> }> = [];
  /** Если задано — sealMarket бросает для этого `String(marketId)`. */
  public sealErrorForMarketId: string | undefined;

  public override readonly sealMarket = async (marketId: MarketId): Promise<boolean> => {
    if (this.sealErrorForMarketId === String(marketId)) {
      throw new Error(`storage seal failed for ${String(marketId)}`);
    }
    this.seals.push(String(marketId));
    return true;
  };
  /** Исход следующих updateMarketMeta (default true = header записан). */
  public metaUpdateResult = true;
  /** Если задано — updateMarketMeta бросает (I/O-ошибка storage). */
  public metaUpdateError: unknown;

  public readonly updateMarketMeta = async (
    marketId: MarketId,
    header: Record<string, unknown>,
  ): Promise<boolean> => {
    if (this.metaUpdateError !== undefined) {
      throw this.metaUpdateError;
    }
    this.metaUpdates.push({ marketId: String(marketId), header });
    return this.metaUpdateResult;
  };

  /** Последний записанный header (для ассертов финального содержимого). */
  public lastHeader(): Record<string, unknown> | undefined {
    return this.metaUpdates[this.metaUpdates.length - 1]?.header;
  }
}

/**
 * Fake официального SDK query plane (fetchMarket/fetchEvent).
 */
export class FakeGamma implements FinalizationGammaClient {
  /** Fresh Markets по gammaMarketId. */
  public readonly markets = new Map<string, PolymarketGammaMarket>();
  /** Fresh Events по event id. */
  public readonly events = new Map<string, PolymarketGammaEvent>();
  public readonly fetchMarketCalls: string[] = [];
  public readonly fetchEventCalls: string[] = [];
  /** Если true — любой fetch бросает (недоступный Gamma). */
  public failFetches = false;

  public fetchMarket = (async (request: { id?: string }): Promise<PolymarketGammaMarket> => {
    const id = String(request.id);
    this.fetchMarketCalls.push(id);
    if (this.failFetches) {
      throw new Error('gamma fetchMarket 500');
    }
    const market = this.markets.get(id);
    if (market === undefined) {
      throw new Error(`FakeGamma has no market ${id}`);
    }
    return market;
  }) as unknown as FinalizationGammaClient['fetchMarket'];

  public fetchEvent = (async (request: { id?: string }): Promise<PolymarketGammaEvent> => {
    const id = String(request.id);
    this.fetchEventCalls.push(id);
    if (this.failFetches) {
      throw new Error('gamma fetchEvent 500');
    }
    const event = this.events.get(id);
    if (event === undefined) {
      throw new Error(`FakeGamma has no event ${id}`);
    }
    return event;
  }) as unknown as FinalizationGammaClient['fetchEvent'];
}

/** Параметры fresh-Market фикстуры (характеризованные значения по умолчанию). */
export interface FreshGammaMarketOptions {
  readonly closed?: boolean;
  readonly umaResolutionStatus?: string | null;
  readonly yesPrice?: string | null;
  readonly noPrice?: string | null;
  /** Байты паддинга (тесты бюджета header). */
  readonly padding?: number;
}

/**
 * Строит СВЕЖИЙ normalized Market resolved-формы (live-характеризация).
 */
export function createFreshGammaMarket(
  options: FreshGammaMarketOptions = {},
): PolymarketGammaMarket {
  const {
    closed = true,
    umaResolutionStatus = 'resolved',
    yesPrice = '1',
    noPrice = '0',
    padding,
  } = options;
  return {
    id: GAMMA_MARKET_ID,
    conditionId: CID_A,
    question: 'Bitcoin Up or Down - fixture',
    state: {
      active: true,
      closed,
      enableOrderBook: true,
      closedTime: closed ? '2026-08-24 11:41:25+00' : null,
    },
    outcomes: {
      yes: { label: 'Up', tokenId: TOKEN_UP, positionId: null, price: yesPrice },
      no: { label: 'Down', tokenId: TOKEN_DOWN, positionId: null, price: noPrice },
    },
    resolution: {
      questionId: null,
      negRiskRequestId: null,
      umaResolutionStatus,
      source: 'https://data.chain.link/streams/btc-usd-twap-60s-streams',
      resolvedBy: null,
    },
    events: [{ id: GAMMA_EVENT_ID, slug: 'fixture-event', title: 'Fixture Event' }],
    ...(padding !== undefined ? { padding: 'x'.repeat(padding) } : {}),
  } as unknown as PolymarketGammaMarket;
}

/** Параметры fresh-Event фикстуры. */
export interface FreshGammaEventOptions {
  /** `eventMetadata.priceToBeat` (JSON number — как в live). */
  readonly priceToBeat?: number;
  /** `eventMetadata.finalPrice` (JSON number — как в live). */
  readonly finalPrice?: number;
  /** Байты паддинга (тесты бюджета header). */
  readonly padding?: number;
}

/**
 * Строит СВЕЖИЙ normalized Event с metadata характеризованной формы.
 */
export function createFreshGammaEvent(options: FreshGammaEventOptions = {}): PolymarketGammaEvent {
  const { priceToBeat, finalPrice, padding } = options;
  const metadata: Record<string, unknown> | null =
    priceToBeat !== undefined || finalPrice !== undefined
      ? {
          ...(priceToBeat !== undefined ? { priceToBeat } : {}),
          ...(finalPrice !== undefined ? { finalPrice } : {}),
        }
      : null;
  return {
    id: GAMMA_EVENT_ID,
    slug: 'fixture-event',
    title: 'Fixture Event',
    state: { active: true, closed: true },
    schedule: { startTime: new Date(NOW_MS + 10 * 60_000).toISOString() },
    metadata,
    markets: [],
    ...(padding !== undefined ? { padding: 'y'.repeat(padding) } : {}),
  } as unknown as PolymarketGammaEvent;
}

/** Полный harness finalizer-а вокруг РЕАЛЬНОГО координатора. */
export interface FinalizerHarness {
  log: CallLog;
  discovery: FakeDiscovery;
  source: FakeCollectionSource;
  recorder: FakeFinalizationRecorder;
  gamma: FakeGamma;
  clock: FixedClock;
  logger: CapturingLogger;
  coordinator: MarketCollectionCoordinator;
  finalizer: MarketFinalizer;
}

/**
 * Собирает harness: реальный координатор + finalizer поверх fakes.
 *
 * @param config - Переопределения retry/timeout finalizer-а
 */
export function createFinalizerHarness(config: MarketFinalizerConfig = {}): FinalizerHarness {
  const log = new CallLog();
  const discovery = new FakeDiscovery(log);
  const source = new FakeCollectionSource(log);
  const recorder = new FakeFinalizationRecorder(log);
  const gamma = new FakeGamma();
  const clock = new FixedClock();
  const logger = new CapturingLogger();
  const coordinator = new MarketCollectionCoordinator(
    { discovery, source, recorder, clock, logger },
    { maxMarkets: 5 },
  );
  const finalizer = new MarketFinalizer(
    { coordinator, recorder, gamma, clock, logger },
    { enrichmentRetryMs: 30_000, enrichmentMaxWaitMs: 15 * 60_000, ...config },
  );
  return { log, discovery, source, recorder, gamma, clock, logger, coordinator, finalizer };
}

/**
 * Заряжает fresh-Gamma ответы фикстурного рынка.
 */
export function armGamma(
  gamma: FakeGamma,
  market: PolymarketGammaMarket,
  event?: PolymarketGammaEvent,
): void {
  gamma.markets.set(GAMMA_MARKET_ID, market);
  if (event !== undefined) {
    gamma.events.set(GAMMA_EVENT_ID, event);
  }
}
