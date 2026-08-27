/**
 * Стакан и его метрики работают в ЛЮБОМ ценовом домене.
 *
 * @remarks
 * Это и есть цель foundation-изменения: одна структура данных и одна
 * арифметика для рынка предсказаний и для биржевого стакана. До него
 * `Orderbook` был жёстко типизирован `OutcomePrice [0.0001, 0.9999]`, и стакан
 * BTC/USDT на 78 468 был непредставим В ПРИНЦИПЕ.
 */
import { describe, expect, it } from '@jest/globals';
import {
  OutcomePrice,
  OutcomePriceService,
  AssetPrice,
  AssetPriceService,
  QuantityService,
} from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/timestamp';
import { KnownVenues, asVenueId, unsafeInstrumentId, unsafeMarketId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { Orderbook, OrderbookLevel, bookPricing } from '../../../src/index.js';

const MARKET = unsafeMarketId('market-1');
// Биржи появятся в KnownVenues вместе с CEX-адаптером; foundation их не заводит
const BINANCE = asVenueId('BINANCE')!;
const TOKEN = unsafeInstrumentId('token-1');
const AT = TimestampService.create(1_787_751_722_763);
if (!AT.ok) throw new Error('fixture timestamp');

const qty = (raw: string) => {
  const q = QuantityService.create(raw);
  if (!q.ok) throw new Error(`fixture quantity ${raw}`);
  return q.value;
};

const predictionPricing = bookPricing(OutcomePriceService.create);
const assetPricing = bookPricing(AssetPriceService.create);

describe('рынок предсказаний (домен [0.0001, 0.9999])', () => {
  const book = Orderbook.fromLevels({
    venueId: KnownVenues.POLYMARKET,
    marketId: MARKET,
    instrumentId: TOKEN,
    bids: [OrderbookLevel.create(OutcomePrice.of(new Decimal('0.50')), qty('10'))],
    asks: [OrderbookLevel.create(OutcomePrice.of(new Decimal('0.52')), qty('30'))],
    receivedAt: AT.value,
  });

  it('mid и спред считаются в prediction-домене', () => {
    expect(predictionPricing.midPrice(book)?.value().toString()).toBe('0.51');
    const spread = predictionPricing.spread(book);
    expect(spread.ok).toBe(true);
    if (!spread.ok) return;
    expect(spread.value.width().toString()).toBe('0.02');
  });

  it('микроцена взвешивается объёмами', () => {
    // (0.52*10 + 0.50*30) / 40 = 0.505
    expect(predictionPricing.microprice(book)?.value().toString()).toBe('0.505');
  });
});

describe('биржевой стакан (домен (0, ∞))', () => {
  // У биржи рынка отдельно от инструмента НЕТ — marketId не задаётся
  const book = Orderbook.fromLevels({
    venueId: BINANCE,
    instrumentId: unsafeInstrumentId('BTC/USDT'),
    bids: [OrderbookLevel.create(AssetPrice.of(new Decimal('78468.50')), qty('0.5'))],
    asks: [OrderbookLevel.create(AssetPrice.of(new Decimal('78470.50')), qty('1.5'))],
    receivedAt: AT.value,
  });

  it('стакан на 78 468 вообще СУЩЕСТВУЕТ — раньше был непредставим', () => {
    // Доказательство «в лоб»: prediction-цена такое значение принять не может
    expect(OutcomePriceService.create('78468.50').ok).toBe(false);
    expect(book.getBestBid()?.value().toString()).toBe('78468.5');
  });

  it('та же арифметика даёт метрики в домене актива', () => {
    expect(assetPricing.midPrice(book)?.value().toString()).toBe('78469.5');
    const spread = assetPricing.spread(book);
    expect(spread.ok).toBe(true);
    if (!spread.ok) return;
    // 2 USDT ширины вместо долей вероятности
    expect(spread.value.width().toString()).toBe('2');
  });

  it('микроцена работает и на биржевых объёмах', () => {
    // (78470.50*0.5 + 78468.50*1.5) / 2 = 78469.0
    expect(assetPricing.microprice(book)?.value().toString()).toBe('78469');
  });

  it('скрещенная книга ловится в любом домене', () => {
    const crossed = Orderbook.fromLevels({
      venueId: BINANCE,
      instrumentId: unsafeInstrumentId('BTC/USDT'),
      bids: [OrderbookLevel.create(AssetPrice.of(new Decimal('78475')), qty('1'))],
      asks: [OrderbookLevel.create(AssetPrice.of(new Decimal('78470')), qty('1'))],
      receivedAt: AT.value,
    });
    const spread = assetPricing.spread(crossed);
    expect(spread.ok).toBe(false);
    if (spread.ok) return;
    expect(spread.error.isCrossedBook()).toBe(true);
  });
});

describe('структурные операции домена не знают', () => {
  it('глубина и объёмы считаются одинаково в обоих доменах', () => {
    const prediction = Orderbook.fromLevels({
      venueId: KnownVenues.POLYMARKET,
      marketId: MARKET,
      instrumentId: TOKEN,
      bids: [
        OrderbookLevel.create(OutcomePrice.of(new Decimal('0.50')), qty('10')),
        OrderbookLevel.create(OutcomePrice.of(new Decimal('0.49')), qty('20')),
      ],
      asks: [],
      receivedAt: AT.value,
    });
    const asset = Orderbook.fromLevels({
      venueId: BINANCE,
      instrumentId: unsafeInstrumentId('BTC/USDT'),
      bids: [
        OrderbookLevel.create(AssetPrice.of(new Decimal('78468')), qty('10')),
        OrderbookLevel.create(AssetPrice.of(new Decimal('78467')), qty('20')),
      ],
      asks: [],
      receivedAt: AT.value,
    });

    expect(prediction.getBidDepth()).toBe(asset.getBidDepth());
    expect(prediction.getTotalBidVolume().value().toString()).toBe(
      asset.getTotalBidVolume().value().toString(),
    );
    expect(prediction.getImbalance()).toBe(asset.getImbalance());
  });

  it('сортировка уровней одинакова в обоих доменах', () => {
    const asset = Orderbook.fromLevels({
      venueId: BINANCE,
      instrumentId: unsafeInstrumentId('BTC/USDT'),
      bids: [
        OrderbookLevel.create(AssetPrice.of(new Decimal('78460')), qty('1')),
        OrderbookLevel.create(AssetPrice.of(new Decimal('78468')), qty('1')),
      ],
      asks: [
        OrderbookLevel.create(AssetPrice.of(new Decimal('78480')), qty('1')),
        OrderbookLevel.create(AssetPrice.of(new Decimal('78470')), qty('1')),
      ],
      receivedAt: AT.value,
    });

    expect(asset.bids.map((l) => l.price.value().toString())).toEqual(['78468', '78460']);
    expect(asset.asks.map((l) => l.price.value().toString())).toEqual(['78470', '78480']);
  });
});
