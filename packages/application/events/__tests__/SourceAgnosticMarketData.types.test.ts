/**
 * Acceptance: market-data граница Application source-agnostic END-TO-END.
 *
 * @remarks
 * Проверяется НЕ то, что generics называются определённым образом, а то,
 * что путь целиком компилируется:
 *
 * ```text
 * Orderbook<AssetPrice>  →  BOOK_DEPTH  →  ApplicationEvent  →  IEventBus.publish()
 * ```
 *
 * без `as`, без `unknown`, без DTO и без ВТОРОГО набора событий для CEX.
 *
 * Это сильнее, чем `new Orderbook<AssetPrice>(...)` внутри Domain-пакета:
 * до этого изменения Domain-модель уже была generic, а Application-контракт
 * оставался прибит к `OutcomePrice` — типовая стена просто стояла слоем
 * выше и обнаружилась бы на первом же CEX-адаптере.
 */
import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  AssetPrice,
  OutcomePrice,
  QuantityService,
  type DecimalPrice,
} from '@polymarket/value-objects';
import { Orderbook, OrderbookLevel } from '@polymarket/orderbook';
import { TimestampService } from '@polymarket/timestamp';
import {
  KnownVenues,
  asVenueId,
  unsafeInstrumentId,
  unsafeMarketId,
  unsafeVenueTradeId,
} from '@polymarket/ids';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import type {
  ApplicationEvent,
  BookDepthEvent,
  BookUpdatedEvent,
  TopOfBook,
  TradeReceivedEvent,
} from '../src/index.js';

const BINANCE = asVenueId('BINANCE')!;
const BTC_USDT = unsafeInstrumentId('BTC/USDT');
const atResult = TimestampService.create(1_787_751_722_763);
if (!atResult.ok) throw new Error('fixture timestamp');
const AT = atResult.value;

const metadata = new MessageMetadataGenerator({ clock: new LiveClock() });

const qty = (raw: string) => {
  const q = QuantityService.create(raw);
  if (!q.ok) throw new Error(`fixture quantity ${raw}`);
  return q.value;
};

/** Биржевой стакан: цены актива, площадка есть, отдельного рынка нет. */
function cexBook(): Orderbook<AssetPrice> {
  return Orderbook.fromLevels({
    venueId: BINANCE,
    instrumentId: BTC_USDT,
    bids: [OrderbookLevel.create(AssetPrice.of(new Decimal('78468.50')), qty('0.5'))],
    asks: [OrderbookLevel.create(AssetPrice.of(new Decimal('78470.50')), qty('1.5'))],
    receivedAt: AT,
  });
}

describe('BOOK_DEPTH принимает биржевой стакан', () => {
  it('Orderbook<AssetPrice> → BOOK_DEPTH → ApplicationEvent без приведений', () => {
    const event: BookDepthEvent<AssetPrice> = {
      type: 'BOOK_DEPTH',
      payload: {
        venueId: BINANCE,
        // marketId НЕ задан: у биржи рынка отдельно от инструмента нет
        instrumentId: BTC_USDT,
        snapshot: cexBook(),
        timestamp: AT,
      },
      metadata: metadata.nextRoot(),
    };

    // Ключевая строка: биржевое событие — полноправный член canonical union
    const canonical: ApplicationEvent = event;

    expect(canonical.type).toBe('BOOK_DEPTH');
    if (canonical.type !== 'BOOK_DEPTH') return;
    expect(canonical.payload.snapshot.getBestBid()?.value().toString()).toBe('78468.5');
    expect(canonical.payload.marketId).toBeUndefined();
  });

  it('prediction-стакан по-прежнему подходит без параметра', () => {
    const event: BookDepthEvent = {
      type: 'BOOK_DEPTH',
      payload: {
        venueId: KnownVenues.POLYMARKET,
        marketId: unsafeMarketId('0xcondition'),
        instrumentId: unsafeInstrumentId('token-up'),
        snapshot: Orderbook.fromLevels({
          venueId: KnownVenues.POLYMARKET,
          marketId: unsafeMarketId('0xcondition'),
          instrumentId: unsafeInstrumentId('token-up'),
          bids: [OrderbookLevel.create(OutcomePrice.of(new Decimal('0.52')), qty('10'))],
          asks: [],
          receivedAt: AT,
        }),
        timestamp: AT,
      },
      metadata: metadata.nextRoot(),
    };

    const canonical: ApplicationEvent = event;
    expect(canonical.type).toBe('BOOK_DEPTH');
  });
});

describe('BOOK_UPDATED принимает верхушку биржевого стакана', () => {
  it('AssetPrice(78468.50) → TopOfBook → ApplicationEvent', () => {
    const topOfBook: TopOfBook<AssetPrice> = {
      bestBid: AssetPrice.of(new Decimal('78468.50')),
      bestAsk: AssetPrice.of(new Decimal('78470.50')),
      bestBidSize: qty('0.5'),
      bestAskSize: qty('1.5'),
    };

    const event: BookUpdatedEvent<AssetPrice> = {
      type: 'BOOK_UPDATED',
      payload: {
        topOfBook,
        venueId: BINANCE,
        instrumentId: BTC_USDT,
        sequenceNumber: 1,
        timestamp: AT,
      },
      metadata: metadata.nextRoot(),
    };

    const canonical: ApplicationEvent = event;
    expect(canonical.type).toBe('BOOK_UPDATED');
    if (canonical.type !== 'BOOK_UPDATED') return;
    expect(canonical.payload.topOfBook.bestBid?.value().toString()).toBe('78468.5');
    // venueId обязателен и присутствует — книги одного символа на разных
    // биржах различимы
    expect(canonical.payload.venueId).toBe(BINANCE);
  });
});

describe('TRADE_RECEIVED принимает биржевую сделку', () => {
  it('CEX trade @ 78468.50 → TRADE_RECEIVED → ApplicationEvent', () => {
    const event: TradeReceivedEvent<AssetPrice> = {
      type: 'TRADE_RECEIVED',
      payload: {
        venueId: BINANCE,
        instrumentId: BTC_USDT,
        venueTradeId: unsafeVenueTradeId('4308594524'),
        price: AssetPrice.of(new Decimal('78468.50')),
        size: qty('0.3316'),
        side: 'BUY',
        timestamp: AT,
      },
      metadata: metadata.nextRoot(),
    };

    const canonical: ApplicationEvent = event;
    expect(canonical.type).toBe('TRADE_RECEIVED');
    if (canonical.type !== 'TRADE_RECEIVED') return;
    expect(canonical.payload.price.value().toString()).toBe('78468.5');
    expect(canonical.payload.marketId).toBeUndefined();
  });
});

describe('ковариантность union', () => {
  it('оба домена присваиваются самому широкому', () => {
    const asset: BookDepthEvent<AssetPrice> = {
      type: 'BOOK_DEPTH',
      payload: {
        venueId: BINANCE,
        instrumentId: BTC_USDT,
        snapshot: cexBook(),
        timestamp: AT,
      },
      metadata: metadata.nextRoot(),
    };

    // Именно это делает union пригодным для обоих доменов сразу, без
    // второго набора событий под CEX
    const wide: BookDepthEvent<DecimalPrice> = asset;
    expect(wide.payload.snapshot.getBestBid()?.value().greaterThan(78000)).toBe(true);
  });
});
