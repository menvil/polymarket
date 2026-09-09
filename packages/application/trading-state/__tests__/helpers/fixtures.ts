/**
 * Фикстуры canonical-событий для тестов hot state.
 *
 * @remarks
 * Время наблюдения задаётся ЯВНО через управляемые часы: в состоянии не
 * должно остаться ни одной зависимости от `Date.now()`, и тест обязан это
 * доказывать, а не полагаться на удачу. `sleep` не используется нигде —
 * возраст записей задаётся временем наблюдения, а не ожиданием.
 */
import Decimal from 'decimal.js';
import { PaperClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { TimestampService } from '@polymarket/timestamp';
import {
  AssetPrice,
  OutcomePriceService,
  QuantityService,
  type DecimalPrice,
  type OutcomePrice,
  type Quantity,
  type Side,
} from '@polymarket/value-objects';
import { Orderbook, OrderbookLevel } from '@polymarket/orderbook';
import {
  asAssetSymbolId,
  asVenueId,
  unsafeInstrumentId,
  type AssetSymbolId,
  type InstrumentId,
  type MarketDataSourceId,
  type MarketId,
  type VenueId,
  type VenueTradeId,
} from '@polymarket/ids';
import type {
  BookDepthEvent,
  ReferencePriceFeed,
  ReferencePriceUpdatedEvent,
  TickSizeChangedEvent,
  TradeReceivedEvent,
} from '@polymarket/application-events';
import type { TradingStateRetentionConfig } from '../../src/index.js';

/** Разворачивает `Result` фикстуры: отказ здесь — дефект самого теста. */
function must<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`fixture failed: ${String(result.error)}`);
  return result.value as T;
}

/** Момент времени из миллисекунд. */
export function ts(ms: number) {
  return must(TimestampService.create(ms));
}

/** Количество из числа. */
export function qty(value: number): Quantity {
  return must(QuantityService.create(value));
}

/** Цена исхода из числа. */
export function outcomePrice(value: number): OutcomePrice {
  return must(OutcomePriceService.create(value));
}

/** Цена актива из числа. */
export function assetPrice(value: number): AssetPrice {
  return AssetPrice.of(new Decimal(value));
}

/** Управляемые часы, с которых снимается время наблюдения. */
export class TestClock extends PaperClock {}

/**
 * Генератор событий с управляемым временем наблюдения.
 *
 * @remarks
 * `observedAt` каждого события задаётся вызывающим, поэтому одна и та же
 * последовательность воспроизводима: retention и порядок не зависят от
 * того, когда тест запущен.
 */
export class EventFactory {
  private readonly _clock = new PaperClock(new Date(0));
  private readonly _metadata = new MessageMetadataGenerator({ clock: this._clock });

  /** Устанавливает время наблюдения для следующих событий. */
  public observeAt(ms: number): void {
    this._clock.setTime(new Date(ms));
  }

  /** Конверт с текущим временем наблюдения. */
  private _envelope() {
    return this._metadata.nextRoot();
  }

  /** `BOOK_DEPTH` для рынка либо для площадки, если `marketId` не задан. */
  public bookDepth(args: {
    readonly venueId: VenueId;
    readonly instrumentId: InstrumentId;
    readonly marketId?: MarketId;
    readonly bid: number;
    readonly sourceTimestampMs: number;
    /** Подменить identity ВНУТРИ снимка — только для теста расхождения */
    readonly snapshotOverride?: {
      readonly venueId?: VenueId;
      readonly marketId?: MarketId;
      readonly instrumentId?: InstrumentId;
    };
  }): BookDepthEvent<DecimalPrice> {
    const { marketId, snapshotOverride, ...rest } = args;
    const receivedAt = ts(rest.sourceTimestampMs);
    // Identity снимка повторяет identity события — так требует контракт
    // `BOOK_DEPTH`. Переопределяется только там, где тест проверяет отказ
    // при расхождении.
    const snapshotMarketId = snapshotOverride?.marketId ?? marketId;
    const snapshot = Orderbook.fromLevels({
      venueId: snapshotOverride?.venueId ?? rest.venueId,
      ...(snapshotMarketId === undefined ? {} : { marketId: snapshotMarketId }),
      instrumentId: snapshotOverride?.instrumentId ?? rest.instrumentId,
      bids: [OrderbookLevel.create(outcomePrice(rest.bid), qty(1))],
      asks: [],
      receivedAt,
    });
    const payload = {
      venueId: rest.venueId,
      ...(marketId === undefined ? {} : { marketId }),
      instrumentId: rest.instrumentId,
      snapshot,
      timestamp: receivedAt,
    };
    return { type: 'BOOK_DEPTH', payload, metadata: this._envelope() };
  }

  /** `TRADE_RECEIVED` для рынка либо для площадки. */
  public tradeReceived(args: {
    readonly venueId: VenueId;
    readonly instrumentId: InstrumentId;
    readonly marketId?: MarketId;
    readonly price: number;
    readonly size: number;
    readonly side: Side;
    readonly venueTradeId?: VenueTradeId;
    readonly sourceTimestampMs: number;
  }): TradeReceivedEvent<DecimalPrice> {
    const { marketId, venueTradeId, ...rest } = args;
    return {
      type: 'TRADE_RECEIVED',
      payload: {
        venueId: rest.venueId,
        instrumentId: rest.instrumentId,
        ...(marketId === undefined ? {} : { marketId }),
        ...(venueTradeId === undefined ? {} : { venueTradeId }),
        price: outcomePrice(rest.price),
        size: qty(rest.size),
        side: rest.side,
        timestamp: ts(rest.sourceTimestampMs),
      },
      metadata: this._envelope(),
    };
  }

  /**
   * `TRADE_RECEIVED` с ценой БИРЖЕВОГО домена (`AssetPrice`).
   *
   * @remarks
   * Отдельно от {@link EventFactory.tradeReceived}, который строит цену
   * исхода: у биржи цена не помещается в (0, 1), и это ровно то различие,
   * ради которого canonical-событие параметризовано общим доменом.
   */
  public cexTradeReceived(args: {
    readonly venueId: VenueId;
    readonly instrumentId: InstrumentId;
    readonly marketId?: MarketId;
    readonly price: number;
    readonly size: number;
    readonly side: Side;
    readonly sourceTimestampMs: number;
  }): TradeReceivedEvent<DecimalPrice> {
    const { marketId, ...rest } = args;
    return {
      type: 'TRADE_RECEIVED',
      payload: {
        venueId: rest.venueId,
        instrumentId: rest.instrumentId,
        ...(marketId === undefined ? {} : { marketId }),
        price: assetPrice(rest.price),
        size: qty(rest.size),
        side: rest.side,
        timestamp: ts(rest.sourceTimestampMs),
      },
      metadata: this._envelope(),
    };
  }

  /** `REFERENCE_PRICE_UPDATED` с полной идентичностью фида. */
  public referencePrice(args: {
    readonly sourceId: MarketDataSourceId;
    readonly baseAsset: AssetSymbolId;
    readonly quoteAsset: AssetSymbolId;
    readonly nativeSymbol: string;
    readonly feed: ReferencePriceFeed;
    readonly value: number;
    readonly venueTimestampMs: number;
    readonly receivedAtMs: number;
  }): ReferencePriceUpdatedEvent {
    return {
      type: 'REFERENCE_PRICE_UPDATED',
      payload: {
        sourceId: args.sourceId,
        baseAsset: args.baseAsset,
        quoteAsset: args.quoteAsset,
        nativeSymbol: args.nativeSymbol,
        feed: args.feed,
        value: assetPrice(args.value),
        venueTimestamp: ts(args.venueTimestampMs),
        receivedAt: ts(args.receivedAtMs),
      },
      metadata: this._envelope(),
    };
  }

  /** `TICK_SIZE_CHANGED` — по контракту всегда market-scoped. */
  public tickSizeChanged(args: {
    readonly marketId: MarketId;
    readonly instrumentId: InstrumentId;
    readonly newTickSize: number;
    readonly sourceTimestampMs: number;
  }): TickSizeChangedEvent {
    return {
      type: 'TICK_SIZE_CHANGED',
      payload: {
        marketId: args.marketId,
        instrumentId: args.instrumentId,
        oldTickSize: undefined,
        newTickSize: outcomePrice(args.newTickSize),
        timestamp: ts(args.sourceTimestampMs),
      },
      metadata: this._envelope(),
    };
  }
}

/** Идентичности для тестов. */
/** Площадка для теста: `asVenueId` — валидирующий парсер, отказ здесь дефект теста. */
function venue(raw: string): VenueId {
  const parsed = asVenueId(raw);
  if (parsed === undefined) throw new Error(`fixture: invalid venue id ${raw}`);
  return parsed;
}

export const POLYMARKET = venue('POLYMARKET');
export const BINANCE = venue('BINANCE');
export const COINBASE = venue('COINBASE');
export const MARKET_X = 'market-x' as MarketId;
export const MARKET_Y = 'market-y' as MarketId;
export const YES = unsafeInstrumentId('yes-token');
export const NO = unsafeInstrumentId('no-token');
export const BTC_USDT = unsafeInstrumentId('BTCUSDT');

/** Символ актива для тестов: `asAssetSymbolId` — валидирующий парсер. */
export function asset(raw: string): AssetSymbolId {
  const parsed = asAssetSymbolId(raw);
  if (parsed === undefined) throw new Error(`fixture: invalid asset symbol ${raw}`);
  return parsed;
}
export const BTC_USD = unsafeInstrumentId('BTCUSD');

/** Щедрая конфигурация хранения — тесты retention задают свою. */
export function retention(overrides: Partial<TradingStateRetentionConfig> = {}): TradingStateRetentionConfig {
  return {
    market: { books: { maxCount: 100 }, trades: { maxCount: 100 } },
    shared: { books: { maxCount: 100 }, trades: { maxCount: 100 } },
    referencePrices: { maxCount: 100 },
    ...overrides,
  };
}

/**
 * Логгер-заглушка: тесты проверяют состояние, а не вывод.
 *
 * @remarks
 * `child()` обязателен — `EventBus` создаёт дочерний логгер в конструкторе.
 */
export const silentLogger = (() => {
  const logger: Record<string, unknown> = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  };
  logger['child'] = () => logger;
  return logger as never;
})();
