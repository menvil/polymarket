/**
 * Semantic-выход книги: `book`/`price_change` → `BOOK_DEPTH`/`BOOK_UPDATED`.
 *
 * @remarks
 * Проверяется именно то, что определяет корректность торговых решений:
 * какие события выходят, в каком количестве, что в них лежит и в какой
 * момент публикация ПРЕКРАЩАЕТСЯ.
 */
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { asInstrumentId, asMarketId } from '@polymarket/ids';
import {
  MARKET_ID,
  TOKEN_A,
  TOKEN_B,
  createHarness,
  publishBook,
  publishPriceChange,
  type Harness,
} from './support/fixtures.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.adapter.close();
});

describe('book → canonical Orderbook', () => {
  it('публикует BOOK_DEPTH с настоящей сущностью Orderbook, а не DTO', async () => {
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [
        { price: '0.48', size: '30' },
        { price: '0.50', size: '10' },
      ],
      asks: [{ price: '0.52', size: '7' }],
      timestamp: 1_787_751_722_763,
    });

    const depth = h.eventsOfType('BOOK_DEPTH');
    expect(depth).toHaveLength(1);

    const snapshot = depth[0]!.payload.snapshot;
    expect(snapshot.asset).toBe(asInstrumentId(TOKEN_A));
    expect(String(snapshot.instrumentId)).toBe(MARKET_ID);
    expect(snapshot.bids.map((level) => level.price.value().toString())).toEqual(['0.5', '0.48']);
    expect(snapshot.asks.map((level) => level.price.value().toString())).toEqual(['0.52']);
    // Сущность, а не сериализованная копия — у DTO не было бы методов домена
    expect(snapshot.getSpread().ok).toBe(true);
    expect(snapshot.venueTimestamp?.toNumber()).toBe(1_787_751_722_763);
  });

  it('BOOK_UPDATED несёт верхушку, marketId и per-instrument версию', async () => {
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [{ price: '0.52', size: '7' }],
    });

    const updated = h.eventsOfType('BOOK_UPDATED');
    expect(updated).toHaveLength(1);

    const payload = updated[0]!.payload;
    expect(payload.instrumentId).toBe(asInstrumentId(TOKEN_A));
    expect(payload.marketId).toBe(asMarketId(MARKET_ID));
    expect(payload.topOfBook.bestBid?.value().toString()).toBe('0.5');
    expect(payload.topOfBook.bestAsk?.value().toString()).toBe('0.52');
    expect(payload.topOfBook.bestBidSize?.value().toString()).toBe('10');
    expect(payload.topOfBook.spread?.value().toString()).toBe('0.02');
    expect(payload.sequenceNumber).toBe(1);
  });

  it('второй снапшот полностью замещает состояние (уровни не накапливаются)', async () => {
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: Array.from({ length: 10 }, (_, i) => ({
        price: `0.${String(40 + i).padStart(2, '0')}`,
        size: '5',
      })),
      asks: [],
    });
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [
        { price: '0.49', size: '2' },
        { price: '0.48', size: '3' },
      ],
      asks: [],
    });

    const depth = h.eventsOfType('BOOK_DEPTH');
    expect(depth).toHaveLength(2);
    expect(depth[1]!.payload.snapshot.bids).toHaveLength(2);
  });

  it('версия книги растёт монотонно по инструменту', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '1' }], asks: [] });
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.51', size: '2', side: 'BUY' }],
    });
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.52', size: '3', side: 'BUY' }],
    });

    expect(h.eventsOfType('BOOK_UPDATED').map((e) => e.payload.sequenceNumber)).toEqual([1, 2, 3]);
  });
});

describe('price_change → реконструкция', () => {
  beforeEach(async () => {
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [{ price: '0.52', size: '7' }],
    });
    h.published.length = 0;
  });

  it('задаёт абсолютный размер уровня (25, а не 35)', async () => {
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '25', side: 'BUY' }],
    });

    const depth = h.eventsOfType('BOOK_DEPTH');
    expect(depth).toHaveLength(1);
    expect(depth[0]!.payload.snapshot.bids[0]!.quantity.value().toString()).toBe('25');
  });

  it('размер 0 удаляет уровень', async () => {
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '0', side: 'BUY' }],
    });

    const snapshot = h.eventsOfType('BOOK_DEPTH')[0]!.payload.snapshot;
    expect(snapshot.bids).toHaveLength(0);
    expect(snapshot.getBestBid()).toBeNull();
  });

  it('SELL идёт в asks, а не в bids', async () => {
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.53', size: '4', side: 'SELL' }],
    });

    const snapshot = h.eventsOfType('BOOK_DEPTH')[0]!.payload.snapshot;
    expect(snapshot.asks.map((l) => l.price.value().toString())).toEqual(['0.52', '0.53']);
    expect(snapshot.bids.map((l) => l.price.value().toString())).toEqual(['0.5']);
  });

  it('НИКОГДА не превращается в трейд', async () => {
    await publishPriceChange(h, {
      changes: [
        { tokenId: TOKEN_A, price: '0.50', size: '25', side: 'BUY' },
        { tokenId: TOKEN_A, price: '0.52', size: '9', side: 'SELL' },
      ],
    });

    expect(h.eventsOfType('TRADE_RECEIVED')).toHaveLength(0);
    expect(h.adapter.getStats().tradesPublished).toBe(0);
  });

  it('BOOK_UPDATED не публикуется, если верхушка не изменилась', async () => {
    // Правка ГЛУБИНЫ: новый уровень хуже текущего лучшего бида
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.45', size: '100', side: 'BUY' }],
    });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
    expect(h.eventsOfType('BOOK_UPDATED')).toHaveLength(0);
  });

  it('BOOK_UPDATED публикуется при изменении РАЗМЕРА лучшего уровня', async () => {
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '11', side: 'BUY' }],
    });

    const updated = h.eventsOfType('BOOK_UPDATED');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.payload.topOfBook.bestBidSize?.value().toString()).toBe('11');
  });
});

describe('мульти-токен внутри одного price_change', () => {
  beforeEach(async () => {
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [{ price: '0.52', size: '7' }],
    });
    await publishBook(h, {
      tokenId: TOKEN_B,
      bids: [{ price: '0.30', size: '5' }],
      asks: [{ price: '0.32', size: '6' }],
    });
    h.published.length = 0;
  });

  it('оба токена получают ОДИН итоговый снапшот, без промежуточных публикаций', async () => {
    await publishPriceChange(h, {
      changes: [
        { tokenId: TOKEN_A, price: '0.50', size: '1', side: 'BUY' },
        { tokenId: TOKEN_B, price: '0.30', size: '2', side: 'BUY' },
        // Второе изменение того же токена A внутри одного события
        { tokenId: TOKEN_A, price: '0.49', size: '3', side: 'BUY' },
      ],
    });

    const depth = h.eventsOfType('BOOK_DEPTH');
    // Ровно по одному снапшоту на затронутый инструмент, а не по одному на изменение
    expect(depth).toHaveLength(2);

    const byToken = new Map(depth.map((e) => [String(e.payload.instrumentId), e.payload.snapshot]));
    const bookA = byToken.get(TOKEN_A)!;
    const bookB = byToken.get(TOKEN_B)!;

    // Обе правки токена A применены в ЕДИНСТВЕННОМ опубликованном снапшоте
    expect(bookA.bids.map((l) => [l.price.value().toString(), l.quantity.value().toString()])).toEqual([
      ['0.5', '1'],
      ['0.49', '3'],
    ]);
    expect(bookB.bids.map((l) => [l.price.value().toString(), l.quantity.value().toString()])).toEqual([
      ['0.3', '2'],
    ]);
  });

  it('состояние токенов независимо', async () => {
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '0', side: 'BUY' }],
    });

    const depth = h.eventsOfType('BOOK_DEPTH');
    expect(depth).toHaveLength(1);
    expect(String(depth[0]!.payload.instrumentId)).toBe(TOKEN_A);
    expect(h.adapter.getStats().activeBookStates).toBe(2);
  });
});

describe('дельта до снапшота', () => {
  it('не публикует частичную книгу и считает deltaBeforeSnapshot', async () => {
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '10', side: 'BUY' }],
    });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(0);
    expect(h.eventsOfType('BOOK_UPDATED')).toHaveLength(0);
    expect(h.adapter.getStats().deltaBeforeSnapshot).toBe(1);
    expect(h.adapter.getStats().activeBookStates).toBe(0);
  });

  it('после authoritative book публикация начинается', async () => {
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '10', side: 'BUY' }],
    });
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [],
    });
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.51', size: '4', side: 'BUY' }],
    });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(2);
  });
});

describe('desync', () => {
  beforeEach(async () => {
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [{ price: '0.52', size: '7' }],
    });
    h.published.length = 0;
  });

  it('расхождение с объявленной источником верхушкой останавливает публикацию', async () => {
    await publishPriceChange(h, {
      changes: [
        {
          tokenId: TOKEN_A,
          price: '0.49',
          size: '5',
          side: 'BUY',
          bestBid: '0.51', // источник видит другую верхушку
          bestAsk: '0.52',
        },
      ],
    });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(0);
    expect(h.adapter.getStats().desyncs).toBe(1);
    expect(h.adapter.getStats().desyncedBookStates).toBe(1);
  });

  it('пока инструмент в DESYNC, дельты не публикуются', async () => {
    await publishPriceChange(h, {
      changes: [
        { tokenId: TOKEN_A, price: '0.49', size: '5', side: 'BUY', bestBid: '0.51', bestAsk: '0.52' },
      ],
    });
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.45', size: '1', side: 'BUY' }],
    });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(0);
    // Второй пропуск НЕ считается новым desync
    expect(h.adapter.getStats().desyncs).toBe(1);
  });

  it('полный book восстанавливает состояние и возобновляет публикацию', async () => {
    await publishPriceChange(h, {
      changes: [
        { tokenId: TOKEN_A, price: '0.49', size: '5', side: 'BUY', bestBid: '0.51', bestAsk: '0.52' },
      ],
    });
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.51', size: '9' }],
      asks: [{ price: '0.53', size: '4' }],
    });

    const stats = h.adapter.getStats();
    expect(stats.resyncs).toBe(1);
    expect(stats.desyncedBookStates).toBe(0);
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);

    h.published.length = 0;
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '2', side: 'BUY' }],
    });
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
  });

  it('совпадающие best bid/ask desync НЕ вызывают', async () => {
    await publishPriceChange(h, {
      changes: [
        { tokenId: TOKEN_A, price: '0.51', size: '5', side: 'BUY', bestBid: '0.51', bestAsk: '0.52' },
      ],
    });

    expect(h.adapter.getStats().desyncs).toBe(0);
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
  });
});

describe('односторонняя и пустая книга', () => {
  it('BOOK_DEPTH публикуется для односторонней книги, уровни не выдумываются', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '10' }], asks: [] });

    const depth = h.eventsOfType('BOOK_DEPTH');
    expect(depth).toHaveLength(1);
    expect(depth[0]!.payload.snapshot.asks).toHaveLength(0);

    const top = h.eventsOfType('BOOK_UPDATED')[0]!.payload.topOfBook;
    expect(top.bestBid?.value().toString()).toBe('0.5');
    expect(top.bestAsk).toBeUndefined();
    expect(top.bestAskSize).toBeUndefined();
    // Спред без второй стороны не существует и не подделывается
    expect(top.spread).toBeUndefined();
  });

  it('пустая книга допустима и не порождает фиктивных уровней', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [], asks: [] });

    const depth = h.eventsOfType('BOOK_DEPTH');
    expect(depth).toHaveLength(1);
    expect(depth[0]!.payload.snapshot.isEmpty()).toBe(true);

    const top = h.eventsOfType('BOOK_UPDATED')[0]!.payload.topOfBook;
    expect(top.bestBid).toBeUndefined();
    expect(top.bestAsk).toBeUndefined();
  });

  it('опустошение книги публикуется как изменение верхушки', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '10' }], asks: [] });
    h.published.length = 0;

    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '0', side: 'BUY' }],
    });

    const updated = h.eventsOfType('BOOK_UPDATED');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.payload.topOfBook.bestBid).toBeUndefined();
  });
});

describe('точность', () => {
  it('неудобные десятичные значения не проходят через float', async () => {
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.123456789', size: '0.000000001' }],
      asks: [{ price: '0.9999', size: '123456789.123456789' }],
    });

    const snapshot = h.eventsOfType('BOOK_DEPTH')[0]!.payload.snapshot;
    expect(snapshot.bids[0]!.price.value().toString()).toBe('0.123456789');
    expect(snapshot.asks[0]!.quantity.value().toString()).toBe('123456789.123456789');
  });
});

describe('невалидные payload', () => {
  it('уровень с отрицательным размером не портит состояние и не роняет обработку', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '10' }], asks: [] });
    h.published.length = 0;

    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '-5', side: 'BUY' }],
    });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(0);
    expect(h.adapter.getStats().invalidPayloads).toBe(1);

    // Состояние осталось прежним — следующая корректная дельта видит size 10
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.49', size: '1', side: 'BUY' }],
    });
    const snapshot = h.eventsOfType('BOOK_DEPTH')[0]!.payload.snapshot;
    expect(snapshot.bids.map((l) => l.quantity.value().toString())).toEqual(['10', '1']);
  });

  it('цена вне домена рынка предсказаний отвергается без падения', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '1.5', size: '10' }], asks: [] });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(0);
    expect(h.adapter.getStats().invalidPayloads).toBe(1);
  });
});
