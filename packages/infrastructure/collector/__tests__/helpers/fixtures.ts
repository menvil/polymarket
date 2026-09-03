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
import type { PolymarketExternalMessage, StandardMarketEvent } from '@polymarket/polymarket-v2';

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
  public closeCalls = 0;

  public registerMarket(meta: MarketMeta): boolean {
    this.registered.push(meta);
    return true;
  }

  public recordMarketEvent(marketId: MarketId, rawEvent: unknown): RecordOutcome {
    this.writes.push({ marketId, payload: rawEvent });
    return 'recorded';
  }

  public async sealMarket(): Promise<boolean> {
    return true;
  }

  public async updateMarketMeta(): Promise<boolean> {
    return true;
  }

  public async readSealedPayloadLines(): Promise<readonly string[] | undefined> {
    return undefined;
  }

  public async finalizeMarket(): Promise<void> {
    // Архивация в этих тестах не проверяется.
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
