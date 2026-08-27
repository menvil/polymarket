/**
 * Тесты для PolymarketBookEventParser
 *
 * @remarks
 * Проверяет парсинг реальных Polymarket WebSocket "book" событий.
 * Использует реальный JSON с биржи.
 */

import { describe, it, expect } from '@jest/globals';
import {
  PolymarketBookEventParser,
  type PolymarketBookEvent,
} from '../../../src/adapters/PolymarketBookEventParser.js';
import { DEFAULT_NORMALIZATION_POLICY } from '../../../src/normalizer/NormalizationPolicy.js';
import { bookPricing } from '../../../src/index.js';
import { OutcomePriceService } from '@polymarket/value-objects';

/** Метрики prediction-домена: фабрика связывается один раз. */
const pricing = bookPricing(OutcomePriceService.create);

// ==================== Реальное событие с Polymarket ====================

/**
 * Реальный пример "book" события из Polymarket CLOB WebSocket.
 *
 * market  = condition ID рынка
 * asset_id = outcome token ID (YES токен)
 * bids    = уровни покупки (best bid = 0.43)
 * asks    = уровни продажи (best ask = 0.44)
 * timestamp = epoch ms (строка!)
 */
const REAL_BOOK_EVENT: PolymarketBookEvent = {
  market: '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3',
  asset_id: '62305814799875783974460176688386847666394972778903073967664089920408777315323',
  bids: [
    { price: '0.43', size: '41' },
    { price: '0.42', size: '194' },
    { price: '0.41', size: '209.6' },
    { price: '0.40', size: '476' },
    { price: '0.39', size: '452.61' },
    { price: '0.38', size: '886' },
    { price: '0.37', size: '824' },
    { price: '0.36', size: '774' },
    { price: '0.35', size: '769' },
    { price: '0.34', size: '882.29' },
    { price: '0.33', size: '1636' },
    { price: '0.32', size: '571' },
    { price: '0.31', size: '576' },
    { price: '0.30', size: '646.99' },
    { price: '0.01', size: '6252' },
  ],
  asks: [
    { price: '0.44', size: '253.92' },
    { price: '0.45', size: '384' },
    { price: '0.46', size: '383' },
    { price: '0.47', size: '788.74' },
    { price: '0.48', size: '781' },
    { price: '0.49', size: '862' },
    { price: '0.50', size: '862' },
    { price: '0.51', size: '866' },
    { price: '0.52', size: '784' },
    { price: '0.53', size: '752.12' },
    { price: '0.99', size: '6469' },
  ],
  hash: 'b94cbda1d86a59a0a8c15c586039aa811c2a15c6',
  timestamp: '1767463213110',
  event_type: 'book',
};

// ==================== Тесты ====================

describe('PolymarketBookEventParser.parse() — реальный "book" ивент', () => {
  it('успешно парсит реальное событие в Orderbook', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
  });

  it('корректно маппит market → instrumentId', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.marketId).toBe(REAL_BOOK_EVENT.market);
  });

  it('корректно маппит asset_id → asset', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instrumentId).toBe(REAL_BOOK_EVENT.asset_id);
  });

  it('best bid = 0.43 (строка "0.43" → OutcomePrice VO)', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bestBid = result.value.getBestBid(); // возвращает OutcomePrice | null
    expect(bestBid).not.toBeNull();
    expect(bestBid!.value().toNumber()).toBe(0.43);
  });

  it('best ask = 0.44 (строка "0.44" → OutcomePrice VO)', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bestAsk = result.value.getBestAsk(); // возвращает OutcomePrice | null
    expect(bestAsk).not.toBeNull();
    expect(bestAsk!.value().toNumber()).toBe(0.44);
  });

  it('spread = 0.01', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const spreadResult = pricing.spread(result.value);
    expect(spreadResult.ok).toBe(true);
    if (!spreadResult.ok) return;
    expect(spreadResult.value.width().toNumber()).toBeCloseTo(0.01, 10);
  });

  it('mid price = 0.435', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mid = pricing.midPrice(result.value);
    expect(mid).not.toBeNull();
    expect(mid!.value().toNumber()).toBeCloseTo(0.435, 10);
  });

  it('venueTimestamp корректно парсится из строки "1767463213110"', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.venueTimestamp?.toNumber()).toBe(1767463213110);
  });

  it('дробные size корректно конвертируются ("3073.25" → 3073.25)', () => {
    const event: PolymarketBookEvent = {
      ...REAL_BOOK_EVENT,
      bids: [{ price: '0.43', size: '3073.25' }],
      asks: [{ price: '0.44', size: '100' }],
    };
    const result = PolymarketBookEventParser.parse(event);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // bids[0] — это OrderbookLevel с полями price (OutcomePrice) и quantity (Quantity)
    const bestBidLevel = result.value.bids[0];
    expect(bestBidLevel.quantity.value().toNumber()).toBeCloseTo(3073.25, 2);
  });

  it('bids отсортированы по убыванию цены', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bids = result.value.bids;
    for (let i = 1; i < bids.length; i++) {
      expect(bids[i - 1].price.value().toNumber()).toBeGreaterThan(
        bids[i].price.value().toNumber()
      );
    }
  });

  it('asks отсортированы по возрастанию цены', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asks = result.value.asks;
    for (let i = 1; i < asks.length; i++) {
      expect(asks[i - 1].price.value().toNumber()).toBeLessThan(
        asks[i].price.value().toNumber()
      );
    }
  });

  it('стакан не пустой', () => {
    const result = PolymarketBookEventParser.parse(REAL_BOOK_EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isEmpty()).toBe(false);
    expect(result.value.hasLiquidity()).toBe(true);
  });
});

describe('PolymarketBookEventParser.parse() — невалидные данные', () => {
  it('возвращает Err для пустого market (marketId)', () => {
    const result = PolymarketBookEventParser.parse({ ...REAL_BOOK_EVENT, market: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('marketid');
    }
  });

  it('возвращает Err для пустого asset_id (tokenId)', () => {
    const result = PolymarketBookEventParser.parse({ ...REAL_BOOK_EVENT, asset_id: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('tokenid');
    }
  });

  it('возвращает Err для некорректного price (строка "not-a-number")', () => {
    const result = PolymarketBookEventParser.parse({
      ...REAL_BOOK_EVENT,
      bids: [{ price: 'not-a-number', size: '100' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toMatch(/price|invalid/i);
    }
  });

  it('возвращает Err для crossed book если allowCrossed=false', () => {
    // bid 0.60 >= ask 0.50 — crossed book, явно передаём strict policy
    const result = PolymarketBookEventParser.parse(
      {
        ...REAL_BOOK_EVENT,
        bids: [{ price: '0.60', size: '100' }],
        asks: [{ price: '0.50', size: '100' }],
      },
      DEFAULT_NORMALIZATION_POLICY
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('crossed');
    }
  });

  it('дефолтная политика (PERMISSIVE) принимает crossed book', () => {
    // По умолчанию crossed book разрешён — доверяем данным exchange
    const result = PolymarketBookEventParser.parse({
      ...REAL_BOOK_EVENT,
      bids: [{ price: '0.60', size: '100' }],
      asks: [{ price: '0.50', size: '100' }],
    });
    expect(result.ok).toBe(true);
  });
});

describe('PolymarketBookEventParser — нельзя создать экземпляр', () => {
  it('бросает Error при вызове конструктора', () => {
    // @ts-expect-error - testing private constructor
    expect(() => new PolymarketBookEventParser()).toThrow(Error);
  });
});

describe('PolymarketBookEventParser.parse() — малформированные bids/asks', () => {
  it('возвращает Err (не TypeError) если bids не массив', () => {
    const event = { ...REAL_BOOK_EVENT, bids: null } as unknown as PolymarketBookEvent;
    const result = PolymarketBookEventParser.parse(event);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('array');
    }
  });

  it('возвращает Err (не TypeError) если asks не массив', () => {
    const event = { ...REAL_BOOK_EVENT, asks: undefined } as unknown as PolymarketBookEvent;
    const result = PolymarketBookEventParser.parse(event);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('array');
    }
  });
});
