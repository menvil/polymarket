/**
 * Общие фикстуры тестов коллектора: canonical universe/policy, узкие
 * storage-fakes и билдеры raw-сообщений шины.
 *
 * @remarks
 * Все компоненты границы — НАСТОЯЩИЕ (`ExternalMessageBus`,
 * `ExternalMessageRecorder`, `MarketUniverse`, `PolymarketPolicy`); fake — только
 * storage (диск в этих тестах не участвует). Так тесты доказывают архитектуру
 * контура, а не поведение отдельной функции.
 */
import { LiveClock } from '@polymarket/time';
import type { IClock } from '@polymarket/time';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import {
  KnownVenues,
  unsafeCryptoAssetId,
  unsafeInstrumentId,
  unsafeMarketId,
} from '@polymarket/ids';
import type { MarketId } from '@polymarket/ids';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal нужен как аргумент Money.of при сборке фикстур universe
import Decimal from 'decimal.js';
import { Money } from '@polymarket/value-objects';
import { Market, MarketState, asMarketDuration } from '@polymarket/market';
import type { MarketFamily } from '@polymarket/market';
import { MarketUniverse } from '@polymarket/market-discovery';
import { parsePolicyConfig } from '@polymarket/policy';
import type { PolymarketPolicy } from '@polymarket/policy';
import type {
  MarketDiscoveryEntry,
  MarketDiscoveryDiagnostics,
  MarketMeta,
} from '@polymarket/ports';
import type {
  CexRecordingStorage,
  PolymarketRecordingStorage,
} from '@polymarket/external-message-recorder';
import type { CexWindowRecordOutcome, RecordOutcome } from '@polymarket/data-collection';
import type {
  CexExternalMessage,
  CexMarketType,
  CexOrderbookPayload,
  CexTradePayload,
} from '@polymarket/cex-v2';
import type {
  PolymarketExternalMessage,
  PolymarketRtdsFeed,
  SelectedPolymarketMarket,
  StandardMarketEvent,
} from '@polymarket/polymarket-v2';
import { PolymarketSubscriptionController } from '@polymarket/polymarket-subscription-control';
// Подделки source/discovery берутся из тестовой обвязки САМОГО контроллера
// подписок — единый source of truth (тот же приём, что у market-finalizer):
// иначе появился бы второй, расходящийся набор фикстур того же транспорта.
import {
  FakeDiscovery,
  FakeSource,
  MutableClock,
} from '../../../polymarket-subscription-control/__tests__/helpers/fakes.js';
import { CapturingLogger } from './CapturingLogger.js';

/** Union всех raw-сообщений контура коллектора на одной шине. */
export type ContourMessage = PolymarketExternalMessage | CexExternalMessage;

/** Фиксированное начало торгов по умолчанию (2026-09-01T18:00:00Z). */
export const BASE_START_MS = Date.parse('2026-09-01T18:00:00.000Z');

/** Собирает Timestamp из epoch ms (бросает на невалидном — только в фикстурах). */
export function ts(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`bad timestamp fixture: ${result.error.message}`);
  return result.value;
}

/** Параметры фикстуры canonical рынка. */
export interface MarketFixture {
  readonly id: string;
  readonly asset?: string;
  readonly nominalMs?: number;
  readonly startsAtMs?: number;
  readonly family?: MarketFamily;
  readonly question?: string;
}

/** Собирает запись universe (canonical `Market` + минимальные метрики). */
export function makeEntry(fixture: MarketFixture): MarketDiscoveryEntry {
  const {
    id,
    asset = 'btc',
    nominalMs = 5 * 60_000,
    startsAtMs = BASE_START_MS,
    family = 'CRYPTO_UP_DOWN',
    question = 'Bitcoin Up or Down?',
  } = fixture;
  const duration = asMarketDuration(nominalMs);
  if (duration === undefined) throw new Error(`bad duration fixture: ${nominalMs}`);

  const created = Market.create({
    id: unsafeMarketId(id),
    venueId: KnownVenues.POLYMARKET,
    question,
    startsAt: ts(startsAtMs),
    expiresAt: ts(startsAtMs + nominalMs),
    state: MarketState.active(),
    outcomes: [
      { index: 0, label: 'Up', instrumentId: unsafeInstrumentId(`${id}-up`) },
      { index: 1, label: 'Down', instrumentId: unsafeInstrumentId(`${id}-down`) },
    ],
    family,
    ...(family === 'CRYPTO_UP_DOWN'
      ? { crypto: { asset: unsafeCryptoAssetId(asset), duration } }
      : {}),
  });
  if (!created.ok) throw new Error(`bad market fixture: ${created.error.message}`);

  return { market: created.value, metrics: { liquidity: Money.of(new Decimal(10_000), 'USDC') } };
}

/** Нулевая диагностика снимка (для `universe.replace`). */
const EMPTY_DIAGNOSTICS: MarketDiscoveryDiagnostics = {
  pagesFetched: 0,
  marketsScanned: 0,
  tradeableMarkets: 0,
  unsupportedMarkets: 0,
  supportedCryptoUpDown: 0,
  invalidMarkets: {
    total: 0,
    classification: 0,
    eventUnavailable: 0,
    schedule: 0,
    seriesDuration: 0,
    canonicalMapping: 0,
  },
  duplicateMarkets: 0,
  eventFetches: 0,
  eventFetchFailures: 0,
  eventCacheHits: 0,
};

/** Собирает `MarketUniverse`, наполненный переданными записями. */
export function makeUniverse(entries: readonly MarketDiscoveryEntry[], clock: IClock = new LiveClock()): MarketUniverse {
  const universe = new MarketUniverse(clock);
  universe.replace({ observedAt: ts(BASE_START_MS), entries, diagnostics: EMPTY_DIAGNOSTICS });
  return universe;
}

/** Собирает owner policy площадки Polymarket из plain-конфига. */
export function makePolicy(assets: readonly string[], durations: readonly string[]): PolymarketPolicy {
  const policy = parsePolicyConfig({
    kind: 'POLYMARKET',
    family: 'CRYPTO_UP_DOWN',
    assets: [...assets],
    durations: [...durations],
  });
  if (policy.kind !== 'POLYMARKET') throw new Error('expected a Polymarket policy fixture');
  return policy;
}

/** Минимальное book-событие рынка: recorder читает только `payload.market`. */
export function bookEvent(sourceMarketId: string): StandardMarketEvent {
  return {
    topic: 'market',
    type: 'book',
    payload: {
      market: sourceMarketId,
      tokenId: `${sourceMarketId}-up`,
      bids: [{ price: '0.48', size: '30' }],
      asks: [{ price: '0.52', size: '25' }],
      timestamp: '1',
      hash: 'h',
    },
  } as unknown as StandardMarketEvent;
}

/** Payload CEX-стакана. */
export function orderbookPayload(
  exchangeId = 'binance',
  symbol = 'BTC/USDT',
  marketType: CexMarketType = 'spot',
): CexOrderbookPayload {
  return {
    exchangeId,
    marketType,
    symbol,
    orderBook: { symbol, bids: [[100, 1]], asks: [[101, 1]], timestamp: 1 },
  };
}

/** Payload CEX-сделки. */
export function tradePayload(
  exchangeId = 'binance',
  symbol = 'BTC/USDT',
  marketType: CexMarketType = 'spot',
): CexTradePayload {
  return {
    exchangeId,
    marketType,
    symbol,
    trade: { id: 't-1', price: 100, amount: 0.5, side: 'buy' },
  };
}

/** Захваченная запись Polymarket-payload. */
export interface CapturedPolymarketWrite {
  readonly marketId: MarketId;
  readonly payload: unknown;
}

/** Fake storage market-файлов: фиксирует регистрации и записи, не трогая диск. */
export class FakePolymarketStorage implements PolymarketRecordingStorage {
  public readonly registered: MarketMeta[] = [];
  public readonly writes: CapturedPolymarketWrite[] = [];
  /** `String(marketId)` замороженных датасетов в порядке заморозки. */
  public readonly sealed: string[] = [];
  /** Финализации в порядке вызовов. */
  public readonly finalized: Array<{ marketId: string; reason: 'EXPIRED' | 'SHUTDOWN' }> = [];
  /** Обновления header-а в порядке вызовов. */
  public readonly metaUpdates: Array<{ marketId: string; header: Record<string, unknown> }> = [];
  public closeCalls = 0;

  public registerMarket(meta: MarketMeta): boolean {
    this.registered.push(meta);
    return true;
  }

  public recordMarketEvent(marketId: MarketId, rawEvent: unknown): RecordOutcome {
    this.writes.push({ marketId, payload: rawEvent });
    return 'recorded';
  }

  public async sealMarket(marketId: MarketId): Promise<boolean> {
    this.sealed.push(String(marketId));
    return true;
  }

  public async updateMarketMeta(
    marketId: MarketId,
    header: Record<string, unknown>,
  ): Promise<boolean> {
    this.metaUpdates.push({ marketId: String(marketId), header });
    return true;
  }

  public async readSealedPayloadLines(): Promise<readonly string[] | undefined> {
    return undefined;
  }

  public async finalizeMarket(
    marketId: MarketId,
    reason: 'EXPIRED' | 'SHUTDOWN',
  ): Promise<void> {
    this.finalized.push({ marketId: String(marketId), reason });
  }

  public async flush(): Promise<void> {
    // Буферов нет.
  }

  public async cleanup(): Promise<void> {
    // Диска нет.
  }

  public async close(): Promise<void> {
    this.closeCalls++;
  }
}

/** Захваченная запись CEX-payload. */
export interface CapturedCexWrite {
  readonly exchangeId: string;
  readonly symbol: string;
  readonly marketType: string;
  readonly stream: 'orderbook' | 'trades';
  readonly payload: unknown;
}

/** Fake оконного CEX-storage: фиксирует записи по потоку. */
export class FakeCexStorage implements CexRecordingStorage {
  public readonly writes: CapturedCexWrite[] = [];
  public startCalls = 0;
  public closeCalls = 0;

  public start(): void {
    this.startCalls++;
  }

  public write(
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: 'orderbook' | 'trades',
    payload: unknown,
  ): CexWindowRecordOutcome {
    this.writes.push({ exchangeId, symbol, marketType, stream, payload });
    return 'recorded';
  }

  public async flush(): Promise<void> {
    // Буферов нет.
  }

  public async close(): Promise<void> {
    this.closeCalls++;
  }
}

/** Собирает уникальный conditionId рынка фикстуры. */
export function marketIdOf(id: string): string {
  return id;
}

export { MarketUniverse };

// ─────────────────────── Control-plane подписок (реальный) ───────────────────

export {
  FakeDiscovery,
  FakeSource,
  MutableClock,
  deferred,
  makeSelected,
} from '../../../polymarket-subscription-control/__tests__/helpers/fakes.js';

/** Spot-фид Binance по BTC (та же identity, что у контроллера). */
export const BTC_BINANCE_FEED: PolymarketRtdsFeed = {
  topic: 'prices.crypto.binance',
  symbol: 'btcusdt',
};
/** Spot-фид Chainlink по BTC. */
export const BTC_CHAINLINK_FEED: PolymarketRtdsFeed = {
  topic: 'prices.crypto.chainlink',
  symbol: 'btc/usd',
};
/** Settlement-фид Chainlink TWAP, окно 60 секунд. */
export const BTC_TWAP_60_FEED: PolymarketRtdsFeed = {
  topic: 'prices.crypto.chainlink.twap',
  symbol: 'btc/usd',
  windowSeconds: 60,
};
/** Полный набор фидов крипто-рынка: spot + официальный settlement-поток. */
export const BTC_FULL_FEEDS: readonly PolymarketRtdsFeed[] = [
  BTC_BINANCE_FEED,
  BTC_CHAINLINK_FEED,
  BTC_TWAP_60_FEED,
];

/** Собранный control-plane подписок с НАСТОЯЩИМ контроллером. */
export interface SubscriptionHarness {
  readonly controller: PolymarketSubscriptionController;
  readonly discovery: FakeDiscovery;
  readonly source: FakeSource;
  readonly clock: MutableClock;
}

/**
 * Поднимает НАСТОЯЩИЙ `PolymarketSubscriptionController` на подделках транспорта.
 *
 * @param nowMs - Момент часов контура (по умолчанию — минута до старта рынков)
 * @returns Контроллер и его подделки
 *
 * @remarks
 * Контроллер настоящий намеренно: инварианты владения (claim чужого владельца,
 * retention при shared owners, закрытие последним claim-ом) — это правила
 * ЕГО состояния, и на моке они проверялись бы против выдуманной структуры.
 *
 * @example
 * ```typescript
 * const harness = makeSubscriptionHarness();
 * harness.discovery.register(entry, { rtdsFeeds: BTC_FULL_FEEDS });
 * await harness.controller.acquire(COLLECTOR_RAW_OWNER_KEY, entry);
 * ```
 */
export function makeSubscriptionHarness(nowMs = BASE_START_MS - 60_000): SubscriptionHarness {
  const discovery = new FakeDiscovery();
  const source = new FakeSource();
  const clock = new MutableClock(nowMs);
  const controller = new PolymarketSubscriptionController({
    discovery,
    source,
    clock,
    logger: new CapturingLogger(),
  });
  return { controller, discovery, source, clock };
}

/**
 * Регистрирует vendor-подготовку рынка и приобретает его владельцем.
 *
 * @param harness - Control-plane подписок
 * @param entry - Canonical запись universe
 * @param ownerKey - Владелец claim-а
 * @param rtdsFeeds - Фиды подготовки (по умолчанию spot + settlement TWAP)
 * @returns Зарегистрированная подготовка
 * @throws {Error} Если контроллер отказал в приобретении (дефект фикстуры)
 */
export async function acquireFor(
  harness: SubscriptionHarness,
  entry: MarketDiscoveryEntry,
  ownerKey: string,
  rtdsFeeds: readonly PolymarketRtdsFeed[] = BTC_FULL_FEEDS,
): Promise<SelectedPolymarketMarket> {
  const selected = harness.discovery.register(entry, { rtdsFeeds });
  const result = await harness.controller.acquire(ownerKey, entry);
  if (result.status === 'rejected' || result.status === 'failed') {
    throw new Error(`acquire fixture failed: ${JSON.stringify(result)}`);
  }
  return selected;
}
