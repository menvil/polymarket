/**
 * Semantic-выход сделок и параметров торговли.
 *
 * @remarks
 * Ключевые инварианты этого файла — про то, чего адаптер делать НЕ должен:
 * не выдумывать объём, не выдумывать идентичность сделки и не путать
 * изменение книги со сделкой.
 */
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { asInstrumentId, asMarketId } from '@polymarket/ids';
import {
  MARKET_ID,
  TOKEN_A,
  createHarness,
  publishLastTradePrice,
  publishPriceChange,
  publishTickSizeChange,
  type Harness,
} from './support/fixtures.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.adapter.close();
});

describe('last_trade_price → TRADE_RECEIVED', () => {
  it('переносит цену, объём, сторону, инструмент и время без искажений', async () => {
    await publishLastTradePrice(h, {
      tokenId: TOKEN_A,
      price: '0.5125',
      size: '12.345678',
      side: 'BUY',
      timestamp: 1_787_751_724_000,
    });

    const trades = h.eventsOfType('TRADE_RECEIVED');
    expect(trades).toHaveLength(1);

    const payload = trades[0]!.payload;
    expect(payload.instrumentId).toBe(asInstrumentId(TOKEN_A));
    expect(payload.price.value().toString()).toBe('0.5125');
    expect(payload.size.value().toString()).toBe('12.345678');
    expect(payload.side).toBe('BUY');
    expect(payload.timestamp.toNumber()).toBe(1_787_751_724_000);
  });

  it('СОХРАНЯЕТ сторону источника, а не инвертирует её', async () => {
    await publishLastTradePrice(h, { tokenId: TOKEN_A, price: '0.4', side: 'SELL' });

    expect(h.eventsOfType('TRADE_RECEIVED')[0]!.payload.side).toBe('SELL');
  });

  it('без vendor-времени берёт момент получения наблюдения, а не Date.now()', async () => {
    const raw = await publishLastTradePrice(h, {
      tokenId: TOKEN_A,
      price: '0.4',
      side: 'BUY',
      timestamp: null,
    });

    const trade = h.eventsOfType('TRADE_RECEIVED')[0]!;
    expect(trade.payload.timestamp.toNumber()).toBe(raw.metadata.createdAt.toNumber());
  });
});

describe('трейд без объёма', () => {
  it('НЕ выдумывает Quantity и не публикует фиктивную сделку', async () => {
    await publishLastTradePrice(h, {
      tokenId: TOKEN_A,
      price: '0.5125',
      side: 'BUY',
      size: null,
    });

    expect(h.eventsOfType('TRADE_RECEIVED')).toHaveLength(0);

    const stats = h.adapter.getStats();
    expect(stats.tradesReceived).toBe(1);
    expect(stats.tradesMissingSize).toBe(1);
    expect(stats.tradesPublished).toBe(0);
  });

  it('следующий трейд С объёмом публикуется нормально', async () => {
    await publishLastTradePrice(h, { tokenId: TOKEN_A, price: '0.5', side: 'BUY', size: null });
    await publishLastTradePrice(h, { tokenId: TOKEN_A, price: '0.5', side: 'BUY', size: '3' });

    expect(h.eventsOfType('TRADE_RECEIVED')).toHaveLength(1);
    expect(h.adapter.getStats().tradesMissingSize).toBe(1);
  });
});

describe('идентичность сделки', () => {
  it('не выдумывает id: два одинаковых трейда остаются двумя наблюдениями без id', async () => {
    await publishLastTradePrice(h, {
      tokenId: TOKEN_A,
      price: '0.5',
      side: 'BUY',
      size: '1',
      timestamp: 1_787_751_724_000,
      transactionHash: '0xdeadbeef',
    });
    await publishLastTradePrice(h, {
      tokenId: TOKEN_A,
      price: '0.5',
      side: 'BUY',
      size: '1',
      timestamp: 1_787_751_724_000,
      transactionHash: '0xdeadbeef',
    });

    const trades = h.eventsOfType('TRADE_RECEIVED');
    expect(trades).toHaveLength(2);

    for (const trade of trades) {
      const payload = trade.payload as Record<string, unknown>;
      // Ни одного поля идентичности сделки в payload быть не должно —
      // источник её не даёт, а придумать её значит получить коллизии
      expect(payload['id']).toBeUndefined();
      expect(payload['tradeId']).toBeUndefined();
      expect(payload['venueTradeId']).toBeUndefined();
      expect(payload['txHash']).toBeUndefined();
      expect(payload['transactionHash']).toBeUndefined();
    }
    // Различает наблюдения canonical identity СООБЩЕНИЯ, а не выдуманный trade id
    expect(trades[0]!.metadata.messageId).not.toBe(trades[1]!.metadata.messageId);
  });
});

describe('невалидные трейды', () => {
  it('цена вне домена рынка предсказаний отвергается', async () => {
    await publishLastTradePrice(h, { tokenId: TOKEN_A, price: '1.5', side: 'BUY', size: '1' });

    expect(h.eventsOfType('TRADE_RECEIVED')).toHaveLength(0);
    expect(h.adapter.getStats().invalidPayloads).toBe(1);
  });

  it('отрицательный объём отвергается', async () => {
    await publishLastTradePrice(h, { tokenId: TOKEN_A, price: '0.5', side: 'BUY', size: '-1' });

    expect(h.eventsOfType('TRADE_RECEIVED')).toHaveLength(0);
    expect(h.adapter.getStats().invalidPayloads).toBe(1);
  });
});

describe('price_change никогда не трейд', () => {
  it('поток изменений книги не публикует ни одного TRADE_RECEIVED', async () => {
    await publishPriceChange(h, {
      changes: [
        { tokenId: TOKEN_A, price: '0.50', size: '10', side: 'BUY' },
        { tokenId: TOKEN_A, price: '0.52', size: '5', side: 'SELL' },
      ],
    });

    expect(h.eventsOfType('TRADE_RECEIVED')).toHaveLength(0);
    expect(h.adapter.getStats().tradesReceived).toBe(0);
  });
});

describe('tick_size_change → TICK_SIZE_CHANGED', () => {
  it('публикует canonical-событие с рынком, инструментом и обоими значениями', async () => {
    await publishTickSizeChange(h, {
      tokenId: TOKEN_A,
      oldTickSize: '0.01',
      newTickSize: '0.001',
      timestamp: 1_787_751_725_000,
    });

    const events = h.eventsOfType('TICK_SIZE_CHANGED');
    expect(events).toHaveLength(1);

    const payload = events[0]!.payload;
    expect(payload.marketId).toBe(asMarketId(MARKET_ID));
    expect(payload.instrumentId).toBe(asInstrumentId(TOKEN_A));
    expect(payload.oldTickSize?.value().toString()).toBe('0.01');
    expect(payload.newTickSize.value().toString()).toBe('0.001');
    expect(payload.timestamp.toNumber()).toBe(1_787_751_725_000);
    expect(h.adapter.getStats().tickSizeChanges).toBe(1);
  });

  it('не выдумывает прежний шаг, если источник его не прислал', async () => {
    await publishTickSizeChange(h, {
      tokenId: TOKEN_A,
      oldTickSize: null,
      newTickSize: '0.0001',
    });

    const payload = h.eventsOfType('TICK_SIZE_CHANGED')[0]!.payload;
    expect(payload.oldTickSize).toBeUndefined();
    expect(payload.newTickSize.value().toString()).toBe('0.0001');
  });

  it('непригодный НОВЫЙ шаг отвергается целиком', async () => {
    await publishTickSizeChange(h, { tokenId: TOKEN_A, newTickSize: '0' });

    expect(h.eventsOfType('TICK_SIZE_CHANGED')).toHaveLength(0);
    expect(h.adapter.getStats().invalidPayloads).toBe(1);
  });

  it('смена шага НЕ трогает состояние стакана', async () => {
    await publishTickSizeChange(h, { tokenId: TOKEN_A, newTickSize: '0.001' });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(0);
    expect(h.adapter.getStats().activeBookStates).toBe(0);
  });
});

describe('неизвестные события SDK', () => {
  it('считаются диагностикой и не роняют обработчик шины', async () => {
    await h.bus.publish({
      type: 'POLYMARKET_MARKET',
      payload: { topic: 'market', type: 'best_bid_ask', payload: { tokenId: TOKEN_A } },
      metadata: h.metadataGenerator.nextRoot(),
    } as never);

    expect(h.adapter.getStats().unknownMarketEvents).toBe(1);
    expect(h.published).toHaveLength(0);

    // Шина осталась работоспособной
    await publishLastTradePrice(h, { tokenId: TOKEN_A, price: '0.5', side: 'BUY', size: '1' });
    expect(h.eventsOfType('TRADE_RECEIVED')).toHaveLength(1);
  });
});
