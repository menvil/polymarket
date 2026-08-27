/**
 * Отображение наблюдения стакана CEX в canonical `Orderbook<AssetPrice>`.
 *
 * @remarks
 * Проверяются четыре группы свойств:
 * 1. идентичность и структура снапшота;
 * 2. атомарность (битый уровень не даёт частичной книги);
 * 3. семантика публикации `BOOK_DEPTH` / `BOOK_UPDATED`;
 * 4. независимость состояний площадок и типов рынка.
 */
import { describe, expect, it } from '@jest/globals';
import type { BookDepthEvent, BookUpdatedEvent } from '@polymarket/application-events';
import type { AssetPrice } from '@polymarket/value-objects';
import { AssetPriceService, OutcomePriceService, QuantityService } from '@polymarket/value-objects';
import { Orderbook, OrderbookLevel } from '@polymarket/orderbook';
import { TimestampService } from '@polymarket/timestamp';
import type { InstrumentId, VenueId } from '@polymarket/ids';
import { createHarness } from './support/fixtures.js';

/** Достаёт единственное событие глубины (с понятной ошибкой, если их не одно). */
function onlyDepth(events: readonly unknown[]): BookDepthEvent<AssetPrice> {
  expect(events).toHaveLength(1);
  return events[0] as BookDepthEvent<AssetPrice>;
}

describe('CexSemanticAdapter — снапшот стакана', () => {
  it('строит canonical Orderbook<AssetPrice> с верной идентичностью', async () => {
    const h = createHarness();
    await h.publishBook({
      exchangeId: 'binance',
      marketType: 'spot',
      symbol: 'BTC/USDT',
      bids: [
        [79233.99, 0.79752],
        [79233.98, 0.00062],
      ],
      asks: [
        [79234, 4.35384],
        [79234.01, 0.00013],
      ],
      timestamp: 1787668500014,
    });

    const depth = onlyDepth(h.eventsOfType('BOOK_DEPTH'));
    expect(depth.payload.venueId).toBe('BINANCE');
    expect(depth.payload.instrumentId).toBe('spot:BTC/USDT');
    // У биржи рынка нет отдельно от инструмента — поле не заполняется символом
    expect(depth.payload.marketId).toBeUndefined();

    const book = depth.payload.snapshot;
    expect(book).toBeInstanceOf(Orderbook);
    expect(book.bids).toHaveLength(2);
    expect(book.asks).toHaveLength(2);
    expect(book.getBestBid()?.value().toString()).toBe('79233.99');
    expect(book.getBestAsk()?.value().toString()).toBe('79234');
    expect(book.bids[0]!.quantity.value().toString()).toBe('0.79752');
    expect(book.venueTimestamp?.toNumber()).toBe(1787668500014);
    expect(depth.payload.timestamp.toNumber()).toBe(1787668500014);
  });

  it('bids и asks не инвертируются', async () => {
    const h = createHarness();
    await h.publishBook({
      bids: [[100, 1]],
      asks: [[101, 2]],
    });

    const book = onlyDepth(h.eventsOfType('BOOK_DEPTH')).payload.snapshot;
    // Сторона биржевой книги задана явно: bid остаётся bid-ом
    expect(book.getBestBid()?.value().toString()).toBe('100');
    expect(book.getBestAsk()?.value().toString()).toBe('101');
  });

  it('сортирует уровни по доменному правилу, а не по порядку vendor-а', async () => {
    const h = createHarness();
    await h.publishBook({
      bids: [
        [99, 1],
        [100, 2],
      ],
      asks: [
        [102, 1],
        [101, 2],
      ],
    });

    const book = onlyDepth(h.eventsOfType('BOOK_DEPTH')).payload.snapshot;
    expect(book.bids.map((l) => l.price.value().toString())).toEqual(['100', '99']);
    expect(book.asks.map((l) => l.price.value().toString())).toEqual(['101', '102']);
  });

  it('сохраняет уровни с нулевым объёмом, а не выбрасывает их', async () => {
    const h = createHarness();
    await h.publishBook({
      bids: [
        [100, 1],
        [99, 0],
      ],
      asks: [[101, 2]],
    });

    const book = onlyDepth(h.eventsOfType('BOOK_DEPTH')).payload.snapshot;
    // source-контракт нигде не объявляет нулевые строки удаляемым шумом,
    // а молчаливый выброс изменил бы наблюдаемую глубину
    expect(book.bids).toHaveLength(2);
    expect(book.bids[1]!.quantity.value().toString()).toBe('0');
  });

  it('принимает уровни с vendor-extra полями (третий элемент)', async () => {
    const h = createHarness();
    // Часть бирж отдаёт `[price, amount, orderCount]` — замер на архиве
    // нашёл 128 320 таких уровней; лишний элемент не должен ломать маппинг
    await h.publishBook({
      bids: [[100, 1, 7]],
      asks: [[101, 2, 3]],
    });

    const book = onlyDepth(h.eventsOfType('BOOK_DEPTH')).payload.snapshot;
    expect(book.getBestBid()?.value().toString()).toBe('100');
    expect(book.bids[0]!.quantity.value().toString()).toBe('1');
  });

  it('публикует одностороннюю книгу честно, не выдумывая уровней', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[100, 1]], asks: [] });

    const depth = onlyDepth(h.eventsOfType('BOOK_DEPTH'));
    expect(depth.payload.snapshot.asks).toHaveLength(0);

    const updated = h.eventsOfType('BOOK_UPDATED')[0] as BookUpdatedEvent<AssetPrice>;
    expect(updated.payload.topOfBook.bestBid?.value().toString()).toBe('100');
    expect(updated.payload.topOfBook.bestAsk).toBeUndefined();
    expect(updated.payload.topOfBook.bestAskSize).toBeUndefined();
  });

  it('публикует пустую книгу честно', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [], asks: [] });

    const depth = onlyDepth(h.eventsOfType('BOOK_DEPTH'));
    expect(depth.payload.snapshot.isEmpty()).toBe(true);
    const updated = h.eventsOfType('BOOK_UPDATED')[0] as BookUpdatedEvent<AssetPrice>;
    expect(updated.payload.topOfBook.bestBid).toBeUndefined();
    expect(updated.payload.topOfBook.bestAsk).toBeUndefined();
  });

  it('оставляет venueTimestamp пустым, если биржа времени не дала', async () => {
    const h = createHarness();
    await h.publishBook({ timestamp: null });

    const depth = onlyDepth(h.eventsOfType('BOOK_DEPTH'));
    // Vendor-время не выдумывается: пустое поле честнее подставленного Date.now()
    expect(depth.payload.snapshot.venueTimestamp).toBeUndefined();
    // Время события при этом есть — время ПОЛУЧЕНИЯ наблюдения
    expect(depth.payload.timestamp.toNumber()).toBe(
      depth.payload.snapshot.receivedAt.toNumber(),
    );
  });
});

describe('CexSemanticAdapter — точность', () => {
  it('не ухудшает точность значений, пришедших числом', async () => {
    const h = createHarness();
    await h.publishBook({
      bids: [[78468.123456789, 0.00001234]],
      asks: [[78469.987654321, 1234.5678901234]],
    });

    const book = onlyDepth(h.eventsOfType('BOOK_DEPTH')).payload.snapshot;
    // Ровно то же десятичное значение, что несёт JS-число: адаптер не
    // добавляет round-trip через число, а точность CCXT зафиксирована
    // ДО него (см. докблок модуля)
    expect(book.getBestBid()!.value().toString()).toBe('78468.123456789');
    expect(book.bids[0]!.quantity.value().toString()).toBe('0.00001234');
    expect(book.getBestAsk()!.value().toString()).toBe('78469.987654321');
    expect(book.asks[0]!.quantity.value().toString()).toBe('1234.5678901234');
  });

  it('сохраняет десятичную строку дословно, если vendor прислал строку', async () => {
    const h = createHarness();
    await h.publishBook({
      // Строка ТОЧНЕЕ своего числового представления — переводить её в
      // number на границе значило бы потерять цифры
      bids: [['1234.567890123456789', '0.000000000000000001']],
      asks: [['78469.99', '1']],
    });

    const book = onlyDepth(h.eventsOfType('BOOK_DEPTH')).payload.snapshot;
    expect(book.getBestBid()!.value().toString()).toBe('1234.567890123456789');
    expect(book.bids[0]!.quantity.value().toString()).toBe('1e-18');
  });
});

describe('CexSemanticAdapter — атомарность', () => {
  it('не публикует частичную книгу при одном битом уровне', async () => {
    const h = createHarness();
    await h.publishBook({
      bids: [
        [100, 1],
        [99, 2],
        [0, 3], // цена вне домена AssetPrice (строго положителен)
        [97, 4],
      ],
      asks: [[101, 1]],
    });

    // Ни BOOK_DEPTH, ни BOOK_UPDATED: книга «на 3 уровня из 4» выглядела бы
    // исправной и молча искажала бы глубину
    expect(h.published).toHaveLength(0);
    expect(h.adapter.getStats().invalidOrderBooks).toBe(1);
    expect(h.adapter.getStats().orderBooksPublished).toBe(0);
  });

  it('отвергает наблюдение с отрицательным объёмом целиком', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[100, -1]], asks: [[101, 1]] });

    expect(h.published).toHaveLength(0);
    expect(h.adapter.getStats().invalidOrderBooks).toBe(1);
  });

  it('отвергает уровень с нечисловыми полями', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [['not-a-number', 1]], asks: [[101, 1]] });

    expect(h.published).toHaveLength(0);
    expect(h.adapter.getStats().invalidOrderBooks).toBe(1);
  });

  it('отказ одного наблюдения не ломает следующее', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[0, 1]], asks: [[101, 1]] });
    await h.publishBook({ bids: [[100, 1]], asks: [[101, 1]] });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
    expect(h.adapter.getStats().invalidOrderBooks).toBe(1);
    expect(h.adapter.getStats().orderBooksPublished).toBe(1);
  });

  it('отвергает скрещенную книгу, не правя цены', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[101, 1]], asks: [[100, 1]] });

    expect(h.published).toHaveLength(0);
    const stats = h.adapter.getStats();
    expect(stats.crossedOrderBooks).toBe(1);
    expect(stats.invalidOrderBooks).toBe(1);
  });

  it('книга с равными лучшими ценами (нулевой спред) валидна', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[100, 1]], asks: [[100, 1]] });

    // bid == ask — нормальный рынок, а не скрещенная книга
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
    expect(h.adapter.getStats().crossedOrderBooks).toBe(0);
  });
});

describe('CexSemanticAdapter — семантика публикации', () => {
  it('BOOK_DEPTH на каждое наблюдение, BOOK_UPDATED только на смену верхушки', async () => {
    const h = createHarness();

    // A: верхушка 100/101
    await h.publishBook({
      bids: [
        [100, 1],
        [99, 5],
      ],
      asks: [[101, 1]],
    });
    // B: глубина изменилась, верхушка та же
    await h.publishBook({
      bids: [
        [100, 1],
        [99, 9],
      ],
      asks: [[101, 1]],
    });
    // C: верхушка изменилась
    await h.publishBook({
      bids: [
        [100.5, 1],
        [99, 9],
      ],
      asks: [[101, 1]],
    });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(3);
    const updates = h.eventsOfType('BOOK_UPDATED') as BookUpdatedEvent<AssetPrice>[];
    expect(updates).toHaveLength(2);
    expect(updates[0]!.payload.topOfBook.bestBid?.value().toString()).toBe('100');
    expect(updates[1]!.payload.topOfBook.bestBid?.value().toString()).toBe('100.5');
  });

  it('глубинные правки не тратят номера событий верхушки', async () => {
    const h = createHarness();

    // top меняется
    await h.publishBook({ bids: [[100, 1]], asks: [[101, 1]] });
    // только глубина — BOOK_UPDATED не публикуется
    await h.publishBook({
      bids: [
        [100, 1],
        [99, 5],
      ],
      asks: [[101, 1]],
    });
    // снова только глубина
    await h.publishBook({
      bids: [
        [100, 1],
        [99, 7],
      ],
      asks: [[101, 1]],
    });
    // top меняется
    await h.publishBook({ bids: [[100.5, 1]], asks: [[101, 1]] });

    const updates = h.eventsOfType('BOOK_UPDATED') as BookUpdatedEvent<AssetPrice>[];
    // Ряд обязан быть НЕПРЕРЫВНЫМ: контракт заводит sequenceNumber ради gap
    // detection, и `1, 4` подписчик прочитал бы как потерю двух событий
    expect(updates.map((e) => e.payload.sequenceNumber)).toEqual([1, 2]);
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(4);
  });

  it('изменение размера на лучшем уровне — это смена верхушки', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[100, 1]], asks: [[101, 1]] });
    await h.publishBook({ bids: [[100, 2]], asks: [[101, 1]] });

    expect(h.eventsOfType('BOOK_UPDATED')).toHaveLength(2);
  });

  it('одинаковая цена в другой записи не считается сменой верхушки', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[100, 1]], asks: [[101, 1]] });
    // '100.00' и 100 — одна и та же цена; ложного события быть не должно
    await h.publishBook({ bids: [['100.00', '1.0']], asks: [['101', '1']] });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(2);
    expect(h.eventsOfType('BOOK_UPDATED')).toHaveLength(1);
  });

  it('sequenceNumber растёт по инструменту и не берётся из шины', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[100, 1]], asks: [[101, 1]] });
    // Чужие сообщения между наблюдениями инструмента не должны создавать «дыр»
    await h.publishTrade({ exchangeId: 'okx' });
    await h.publishBook({ exchangeId: 'okx', bids: [[1, 1]], asks: [[2, 1]] });
    await h.publishBook({ bids: [[100.5, 1]], asks: [[101, 1]] });

    const binance = (h.eventsOfType('BOOK_UPDATED') as BookUpdatedEvent<AssetPrice>[]).filter(
      (e) => e.payload.venueId === 'BINANCE',
    );
    expect(binance.map((e) => e.payload.sequenceNumber)).toEqual([1, 2]);
  });

  it('sequenceNumber не растёт на отвергнутом наблюдении', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[100, 1]], asks: [[101, 1]] });
    await h.publishBook({ bids: [[0, 1]], asks: [[101, 1]] }); // отвергнуто
    await h.publishBook({ bids: [[100.5, 1]], asks: [[101, 1]] });

    const updates = h.eventsOfType('BOOK_UPDATED') as BookUpdatedEvent<AssetPrice>[];
    expect(updates.map((e) => e.payload.sequenceNumber)).toEqual([1, 2]);
  });
});

describe('CexSemanticAdapter — изоляция состояний', () => {
  it('один символ на разных биржах — независимые книги и нумерация', async () => {
    const h = createHarness();
    await h.publishBook({ exchangeId: 'binance', bids: [[100, 1]], asks: [[101, 1]] });
    await h.publishBook({ exchangeId: 'okx', bids: [[200, 1]], asks: [[201, 1]] });
    await h.publishBook({ exchangeId: 'okx', bids: [[200.5, 1]], asks: [[201, 1]] });

    const updates = h.eventsOfType('BOOK_UPDATED') as BookUpdatedEvent<AssetPrice>[];
    const binance = updates.filter((e) => e.payload.venueId === 'BINANCE');
    const okx = updates.filter((e) => e.payload.venueId === 'OKX');

    expect(binance).toHaveLength(1);
    expect(okx).toHaveLength(2);
    expect(binance[0]!.payload.sequenceNumber).toBe(1);
    expect(okx.map((e) => e.payload.sequenceNumber)).toEqual([1, 2]);
    expect(binance[0]!.payload.topOfBook.bestBid?.value().toString()).toBe('100');
    expect(okx[0]!.payload.topOfBook.bestBid?.value().toString()).toBe('200');
    expect(h.adapter.getStats().activeInstrumentStates).toBe(2);
  });

  it('spot и swap одной биржи не делят состояние', async () => {
    const h = createHarness();
    await h.publishBook({
      exchangeId: 'binance',
      marketType: 'spot',
      symbol: 'BTC/USDT',
      bids: [[100, 1]],
      asks: [[101, 1]],
    });
    // Тот же vendor-символ, другой тип рынка: своп обязан быть отдельным
    // инструментом с собственной нумерацией
    await h.publishBook({
      exchangeId: 'binance',
      marketType: 'swap',
      symbol: 'BTC/USDT',
      bids: [[100, 1]],
      asks: [[101, 1]],
    });

    const updates = h.eventsOfType('BOOK_UPDATED') as BookUpdatedEvent<AssetPrice>[];
    expect(updates).toHaveLength(2);
    expect(updates.map((e) => e.payload.instrumentId)).toEqual([
      'spot:BTC/USDT',
      'swap:BTC/USDT',
    ]);
    // Верхушка та же, но событие вышло — состояния независимы
    expect(updates.map((e) => e.payload.sequenceNumber)).toEqual([1, 1]);
    expect(h.adapter.getStats().activeInstrumentStates).toBe(2);
  });

  it('forgetInstrument освобождает состояние одного инструмента', async () => {
    const h = createHarness();
    await h.publishBook({ exchangeId: 'binance' });
    await h.publishBook({ exchangeId: 'okx' });
    expect(h.adapter.getStats().activeInstrumentStates).toBe(2);

    expect(
      h.adapter.forgetInstrument('BINANCE' as VenueId, 'spot:BTC/USDT' as InstrumentId),
    ).toBe(true);
    expect(h.adapter.getStats().activeInstrumentStates).toBe(1);
  });

  it('forgetVenue освобождает все инструменты площадки', async () => {
    const h = createHarness();
    await h.publishBook({ exchangeId: 'binance', symbol: 'BTC/USDT' });
    await h.publishBook({ exchangeId: 'binance', symbol: 'ETH/USDT' });
    await h.publishBook({ exchangeId: 'okx', symbol: 'BTC/USDT' });

    expect(h.adapter.forgetVenue('BINANCE' as VenueId)).toBe(2);
    expect(h.adapter.getStats().activeInstrumentStates).toBe(1);
  });

  it('наблюдение с непригодной идентичностью не публикуется', async () => {
    const h = createHarness();
    await h.publishBook({ exchangeId: '1btcxe' });

    expect(h.published).toHaveLength(0);
    expect(h.adapter.getStats().invalidIdentities).toBe(1);
  });
});

describe('одна каноническая модель стакана на оба ценовых домена', () => {
  it('Orderbook<OutcomePrice> и Orderbook<AssetPrice> проходят через один контракт события', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[79233.99, 1]], asks: [[79234, 1]] });

    const cexBook = onlyDepth(h.eventsOfType('BOOK_DEPTH')).payload.snapshot;

    // Ручная сборка книги рынка предсказаний той же сущностью
    const outcomePrice = OutcomePriceService.create('0.52');
    const qty = QuantityService.create('100');
    const receivedAt = TimestampService.create(1787668500014);
    expect(outcomePrice.ok && qty.ok && receivedAt.ok).toBe(true);
    if (!outcomePrice.ok || !qty.ok || !receivedAt.ok) throw new Error('fixture');
    const predictionBook = Orderbook.fromLevels({
      venueId: 'POLYMARKET' as VenueId,
      instrumentId: '123' as InstrumentId,
      bids: [OrderbookLevel.create(outcomePrice.value, qty.value)],
      asks: [],
      receivedAt: receivedAt.value,
    });

    // Один и тот же класс, разные параметры ценового домена — второго типа
    // стакана в системе нет
    expect(cexBook).toBeInstanceOf(Orderbook);
    expect(predictionBook).toBeInstanceOf(Orderbook);
    expect(cexBook.constructor).toBe(predictionBook.constructor);

    // Цена биржи вне домена рынка предсказаний — доказательство, что домены
    // действительно разные, а не «одно и то же под другим именем»
    expect(OutcomePriceService.create('79233.99').ok).toBe(false);
    expect(AssetPriceService.create('79233.99').ok).toBe(true);
  });
});
