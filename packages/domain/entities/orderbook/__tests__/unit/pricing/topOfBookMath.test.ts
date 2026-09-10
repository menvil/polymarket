/**
 * Числовые формулы верхушки согласованы с `bookPricing`.
 *
 * @remarks
 * Смысл модуля — не «быстрая версия», а ОДНО определение формулы при двух
 * точностях. Пока согласие не закреплено тестом, второй набор функций
 * является просто четвёртой копией: расходиться они могут молча, и заметить
 * это будет негде.
 *
 * Поэтому здесь сравниваются результаты `Decimal`-пути и `number`-пути на
 * одних и тех же входах, включая асимметричные очереди — на симметричных
 * микроцена совпадает с серединой и перепутанное взвешивание не проявляется.
 */
import { describe, expect, it } from '@jest/globals';
import {
  AssetPrice,
  AssetPriceService,
  OutcomePrice,
  OutcomePriceService,
  QuantityService,
} from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/timestamp';
import { KnownVenues, asVenueId, unsafeInstrumentId, unsafeMarketId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import {
  Orderbook,
  OrderbookLevel,
  bookPricing,
  imbalance,
  microprice,
  midpoint,
  spreadBps,
} from '../../../src/index.js';

const MARKET = unsafeMarketId('market-1');
const BINANCE = asVenueId('BINANCE')!;
const TOKEN = unsafeInstrumentId('token-1');
const AT_RESULT = TimestampService.create(1_787_751_722_763);
if (!AT_RESULT.ok) throw new Error('fixture timestamp');
// Сужение на уровне модуля не проходит внутрь функций — фиксируем значение.
const AT = AT_RESULT.value;

const qty = (raw: string) => {
  const q = QuantityService.create(raw);
  if (!q.ok) throw new Error(`fixture quantity ${raw}`);
  return q.value;
};

const predictionPricing = bookPricing(OutcomePriceService.create);
const assetPricing = bookPricing(AssetPriceService.create);

/** Стакан рынка предсказаний из одной пары уровней. */
function predictionBook(bid: string, ask: string, bidQty: string, askQty: string): Orderbook<OutcomePrice> {
  return Orderbook.fromLevels({
    venueId: KnownVenues.POLYMARKET,
    marketId: MARKET,
    instrumentId: TOKEN,
    bids: [OrderbookLevel.create(OutcomePrice.of(new Decimal(bid)), qty(bidQty))],
    asks: [OrderbookLevel.create(OutcomePrice.of(new Decimal(ask)), qty(askQty))],
    receivedAt: AT,
  });
}

/** Биржевой стакан из одной пары уровней. */
function assetBook(bid: string, ask: string, bidQty: string, askQty: string): Orderbook<AssetPrice> {
  return Orderbook.fromLevels({
    venueId: BINANCE,
    instrumentId: unsafeInstrumentId('BTC/USDT'),
    bids: [OrderbookLevel.create(AssetPrice.of(new Decimal(bid)), qty(bidQty))],
    asks: [OrderbookLevel.create(AssetPrice.of(new Decimal(ask)), qty(askQty))],
    receivedAt: AT,
  });
}

/** Асимметричные очереди: только на них видно перепутанное взвешивание. */
const CASES: ReadonlyArray<[string, string, string, string]> = [
  ['0.50', '0.52', '10', '30'],
  ['0.50', '0.52', '30', '10'],
  ['0.48', '0.52', '900', '100'],
  ['0.01', '0.99', '1', '7'],
  ['0.45', '0.45', '5', '11'],
];

describe('согласие с bookPricing в домене предсказаний', () => {
  it.each(CASES)('bid %s ask %s qty %s/%s — микроцена совпадает', (bid, ask, bq, aq) => {
    const book = predictionBook(bid, ask, bq, aq);
    const viaDecimal = predictionPricing.microprice(book);

    expect(viaDecimal).not.toBeNull();
    expect(microprice(Number(bid), Number(ask), Number(bq), Number(aq))).toBeCloseTo(
      viaDecimal!.value().toNumber(),
      10,
    );
  });

  it.each(CASES)('bid %s ask %s — середина совпадает', (bid, ask, bq, aq) => {
    const viaDecimal = predictionPricing.midPrice(predictionBook(bid, ask, bq, aq));

    expect(viaDecimal).not.toBeNull();
    expect(midpoint(Number(bid), Number(ask))).toBeCloseTo(viaDecimal!.value().toNumber(), 10);
  });
});

describe('согласие с bookPricing в биржевом домене', () => {
  // Тот же контракт при ценах, которых prediction-домен не представляет вовсе.
  const CEX: ReadonlyArray<[string, string, string, string]> = [
    ['78468.50', '78470.50', '0.5', '1.5'],
    ['78468.50', '78470.50', '1.5', '0.5'],
    ['1.00000001', '1.00000009', '3', '17'],
  ];

  it.each(CEX)('bid %s ask %s qty %s/%s — микроцена совпадает', (bid, ask, bq, aq) => {
    const viaDecimal = assetPricing.microprice(assetBook(bid, ask, bq, aq));

    expect(viaDecimal).not.toBeNull();
    expect(microprice(Number(bid), Number(ask), Number(bq), Number(aq))).toBeCloseTo(
      viaDecimal!.value().toNumber(),
      6,
    );
  });
});

describe('микроцена — перекрёстное взвешивание', () => {
  it('толстая покупка тянет цену К ASK, а не от него', () => {
    // Ловушка формулы: «прямое» взвешивание bid×bidQty + ask×askQty дало бы
    // 0.484 и выглядело бы столь же правдоподобно.
    expect(microprice(0.48, 0.52, 900, 100)).toBeCloseTo(0.516, 10);
    expect(microprice(0.48, 0.52, 100, 900)).toBeCloseTo(0.484, 10);
  });

  it('на равных очередях совпадает с серединой', () => {
    expect(microprice(0.48, 0.52, 50, 50)).toBeCloseTo(midpoint(0.48, 0.52), 10);
  });
});

describe('вырожденные входы дают null, а не NaN', () => {
  it('нулевой суммарный объём', () => {
    expect(microprice(0.48, 0.52, 0, 0)).toBeNull();
    expect(imbalance(0, 0)).toBeNull();
  });

  it('нулевая середина', () => {
    expect(spreadBps(0, 0)).toBeNull();
  });
});

describe('перекос и спред', () => {
  it('перекос лежит в [-1, 1] и положителен при перевесе покупателей', () => {
    expect(imbalance(900, 100)).toBeCloseTo(0.8, 10);
    expect(imbalance(100, 900)).toBeCloseTo(-0.8, 10);
    expect(imbalance(50, 50)).toBe(0);
  });

  it('спред в bps считается от середины', () => {
    expect(spreadBps(0.48, 0.52)).toBeCloseTo(800, 10);
  });
});
