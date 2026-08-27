/**
 * Отображение публичных сделок CEX в canonical `TRADE_RECEIVED`.
 *
 * @remarks
 * Главный инвариант набора — НИЧЕГО НЕ ВЫДУМЫВАТЬ: ни идентификатор
 * сделки, ни объём, ни сторону. Отсутствующие данные остаются
 * отсутствующими, а сделка, которую нельзя представить честно, не
 * публикуется вовсе.
 */
import { describe, expect, it } from '@jest/globals';
import type { TradeReceivedEvent } from '@polymarket/application-events';
import type { AssetPrice } from '@polymarket/value-objects';
import { OutcomePriceService } from '@polymarket/value-objects';
import { createHarness } from './support/fixtures.js';

/** Достаёт события ленты в типизированном виде. */
function trades(h: ReturnType<typeof createHarness>): TradeReceivedEvent<AssetPrice>[] {
  return h.eventsOfType('TRADE_RECEIVED') as TradeReceivedEvent<AssetPrice>[];
}

describe('CexSemanticAdapter — валидная сделка', () => {
  it('переносит все поля unified-сделки CCXT в canonical событие', async () => {
    const h = createHarness();
    await h.publishTrade({
      exchangeId: 'binance',
      marketType: 'spot',
      symbol: 'BTC/USDT',
      id: '6617804453',
      side: 'buy',
      price: 79211.89,
      amount: 0.00115,
      cost: 91.0936735,
      timestamp: 1787668200176,
    });

    const [trade] = trades(h);
    expect(trade).toBeDefined();
    expect(trade!.payload.venueId).toBe('BINANCE');
    expect(trade!.payload.instrumentId).toBe('spot:BTC/USDT');
    expect(trade!.payload.marketId).toBeUndefined();
    expect(trade!.payload.venueTradeId).toBe('6617804453');
    expect(trade!.payload.price.value().toString()).toBe('79211.89');
    expect(trade!.payload.size.value().toString()).toBe('0.00115');
    expect(trade!.payload.side).toBe('BUY');
    expect(trade!.payload.timestamp.toNumber()).toBe(1787668200176);
    expect(h.adapter.getStats().tradesPublished).toBe(1);
  });

  it('цена сделки живёт в домене цены актива, а не рынка предсказаний', async () => {
    const h = createHarness();
    await h.publishTrade({ price: 78468.5 });

    const [trade] = trades(h);
    expect(trade!.payload.price.value().toString()).toBe('78468.5');
    // Та же величина в домене рынка предсказаний непредставима — именно
    // поэтому событие параметризовано ценовым доменом
    expect(OutcomePriceService.create('78468.5').ok).toBe(false);
  });

  it('переносит сторону как есть, не инвертируя', async () => {
    const h = createHarness();
    await h.publishTrade({ id: 'a', side: 'buy' });
    await h.publishTrade({ id: 'b', side: 'sell' });
    await h.publishTrade({ id: 'c', side: 'SELL' });

    expect(trades(h).map((t) => t.payload.side)).toEqual(['BUY', 'SELL', 'SELL']);
  });

  it('сохраняет точность значений vendor-а', async () => {
    const h = createHarness();
    await h.publishTrade({ price: 79209.2, amount: 0.00006349 });

    const [trade] = trades(h);
    expect(trade!.payload.price.value().toString()).toBe('79209.2');
    expect(trade!.payload.size.value().toString()).toBe('0.00006349');
  });

  it('принимает числовой venue-идентификатор биржи', async () => {
    const h = createHarness();
    await h.publishTrade({ id: 11801644 });

    expect(trades(h)[0]!.payload.venueTradeId).toBe('11801644');
    expect(h.adapter.getStats().tradesMissingId).toBe(0);
  });
});

describe('CexSemanticAdapter — сделка без идентификатора', () => {
  it('публикуется БЕЗ venueTradeId, а не с выдуманным', async () => {
    const h = createHarness();
    await h.publishTrade({ id: undefined });

    const [trade] = trades(h);
    expect(trade).toBeDefined();
    expect(trade!.payload.venueTradeId).toBeUndefined();
    expect(h.adapter.getStats().tradesMissingId).toBe(1);
    expect(h.adapter.getStats().tradesPublished).toBe(1);
  });

  it('идентификатор не собирается из времени, символа или полей сделки', async () => {
    const h = createHarness();
    await h.publishTrade({
      id: undefined,
      symbol: 'BTC/USDT',
      timestamp: 1787668200176,
      price: 79211.89,
      amount: 0.00115,
    });

    const id = trades(h)[0]!.payload.venueTradeId;
    // Регрессия против известного legacy-дефекта: синтетический ключ вида
    // `{symbol}_{ts}` / hash(price,size,time) молча склеивал бы разные сделки
    expect(id).toBeUndefined();
    const forbidden = [
      '1787668200176',
      'BTC/USDT_1787668200176',
      'spot:BTC/USDT_1787668200176',
      'BINANCE_spot:BTC/USDT_1787668200176',
    ];
    for (const candidate of forbidden) {
      expect(id).not.toBe(candidate);
    }
  });

  it('непригодный идентификатор трактуется как отсутствующий', async () => {
    const h = createHarness();
    await h.publishTrade({ id: '   ' });
    await h.publishTrade({ id: { nested: true } });

    const list = trades(h);
    expect(list).toHaveLength(2);
    expect(list.every((t) => t.payload.venueTradeId === undefined)).toBe(true);
    expect(h.adapter.getStats().tradesMissingId).toBe(2);
  });

  it('сделки без идентификатора НЕ дедуплицируются между собой', async () => {
    const h = createHarness();
    // Две легитимно одинаковые сделки без id — обе обязаны попасть в ленту:
    // без настоящего идентификатора отличить повтор от совпадения нельзя
    await h.publishTrade({ id: undefined, price: 100, amount: 1, timestamp: 1 });
    await h.publishTrade({ id: undefined, price: 100, amount: 1, timestamp: 1 });

    expect(trades(h)).toHaveLength(2);
    expect(h.adapter.getStats().duplicateTrades).toBe(0);
  });
});

describe('CexSemanticAdapter — неполная сделка', () => {
  it('без объёма — пропускается, Quantity(0) не выдумывается', async () => {
    const h = createHarness();
    await h.publishTrade({ amount: undefined });

    expect(trades(h)).toHaveLength(0);
    expect(h.adapter.getStats().tradesMissingAmount).toBe(1);
    expect(h.adapter.getStats().tradesPublished).toBe(0);
  });

  it('объём НЕ выводится из cost / price', async () => {
    const h = createHarness();
    // cost есть и делится на price нацело — соблазн «восстановить» объём
    await h.publishTrade({ amount: undefined, price: 100, cost: 250 });

    expect(trades(h)).toHaveLength(0);
    expect(h.adapter.getStats().tradesMissingAmount).toBe(1);
  });

  it('без стороны — пропускается, сторона не угадывается', async () => {
    const h = createHarness();
    await h.publishTrade({ side: undefined });

    expect(trades(h)).toHaveLength(0);
    expect(h.adapter.getStats().tradesMissingSide).toBe(1);
  });

  it('незнакомое значение стороны — пропускается', async () => {
    const h = createHarness();
    await h.publishTrade({ side: 'unknown' });
    await h.publishTrade({ side: 42 });

    expect(trades(h)).toHaveLength(0);
    expect(h.adapter.getStats().tradesMissingSide).toBe(2);
  });

  it('непригодная цена — сделка отвергается', async () => {
    const h = createHarness();
    await h.publishTrade({ price: 0 });
    await h.publishTrade({ price: -1 });
    await h.publishTrade({ price: undefined });

    expect(trades(h)).toHaveLength(0);
    expect(h.adapter.getStats().invalidTrades).toBe(3);
  });

  it('отрицательный объём — сделка отвергается', async () => {
    const h = createHarness();
    await h.publishTrade({ amount: -1 });

    expect(trades(h)).toHaveLength(0);
    expect(h.adapter.getStats().invalidTrades).toBe(1);
  });

  it('без vendor-времени берётся время получения наблюдения, и это видно', async () => {
    const h = createHarness();
    await h.publishTrade({ timestamp: null });

    const [trade] = trades(h);
    expect(trade).toBeDefined();
    // Локальное время НЕ выдаётся за биржевое молча — расхождение считается
    expect(h.adapter.getStats().tradesMissingVenueTimestamp).toBe(1);
    expect(trade!.payload.timestamp.toNumber()).toBeGreaterThan(0);
  });
});

describe('CexSemanticAdapter — повторные наблюдения сделок', () => {
  it('отсекает повтор той же сделки того же инструмента', async () => {
    const h = createHarness();
    await h.publishTrade({ id: '6617804453' });
    await h.publishTrade({ id: '6617804453' });

    expect(trades(h)).toHaveLength(1);
    expect(h.adapter.getStats().duplicateTrades).toBe(1);
    expect(h.adapter.getStats().tradesPublished).toBe(1);
  });

  it('одинаковый id на разных биржах — разные сделки', async () => {
    const h = createHarness();
    await h.publishTrade({ exchangeId: 'binance', id: '1' });
    await h.publishTrade({ exchangeId: 'okx', id: '1' });

    expect(trades(h)).toHaveLength(2);
    expect(h.adapter.getStats().duplicateTrades).toBe(0);
  });

  it('одинаковый id на разных инструментах одной биржи — разные сделки', async () => {
    const h = createHarness();
    await h.publishTrade({ symbol: 'BTC/USDT', id: '1' });
    await h.publishTrade({ symbol: 'ETH/USDT', id: '1' });
    await h.publishTrade({ marketType: 'swap', symbol: 'BTC/USDT', id: '1' });

    expect(trades(h)).toHaveLength(3);
    expect(h.adapter.getStats().duplicateTrades).toBe(0);
  });

  it('окно дедупа ограничено: давно вытесненный id снова считается новым', async () => {
    const h = createHarness({ recentTradeIdsCapacity: 4 });
    await h.publishTrade({ id: 'first' });
    for (let i = 0; i < 4; i++) {
      await h.publishTrade({ id: `filler-${i}` });
    }
    await h.publishTrade({ id: 'first' });

    // Ограниченность окна важнее полноты дедупа: неограниченный индекс
    // означал бы рост памяти на всё время жизни процесса
    expect(trades(h)).toHaveLength(6);
    expect(h.adapter.getStats().duplicateTrades).toBe(0);
  });
});

describe('CexSemanticAdapter — идентичность сделки', () => {
  it('наблюдение с непригодной идентичностью не публикуется', async () => {
    const h = createHarness();
    await h.publishTrade({ exchangeId: '1btcxe' });

    expect(trades(h)).toHaveLength(0);
    expect(h.adapter.getStats().invalidIdentities).toBe(1);
  });

  it('лента ведётся отдельно по каждой площадке', async () => {
    const h = createHarness();
    await h.publishTrade({ exchangeId: 'binance', id: 'b1', price: 79211.89 });
    await h.publishTrade({ exchangeId: 'okx', id: 'o1', price: 79209.2 });

    const byVenue = trades(h).map((t) => [t.payload.venueId, t.payload.price.value().toString()]);
    expect(byVenue).toEqual([
      ['BINANCE', '79211.89'],
      ['OKX', '79209.2'],
    ]);
  });
});
