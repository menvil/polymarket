/**
 * Вытеснение наблюдений и валидация политик.
 *
 * @remarks
 * `sleep` и реальное время не используются: возраст записи задаётся её
 * временем наблюдения, а `RollingWindow.append()` вытесняет относительно
 * времени ДОБАВЛЯЕМОГО элемента. Поэтому «прошло десять минут» выражается
 * событием с временем на десять минут позже, а не ожиданием.
 */
import { describe, expect, it } from '@jest/globals';
import { EventBus } from '@polymarket/event-bus';
import { PaperClock } from '@polymarket/time';
import { isErr, isOk } from '@polymarket/result';
import { TradingStateProjector } from '../src/index.js';
import {
  EventFactory,
  MARKET_X,
  POLYMARKET,
  YES,
  retention,
  silentLogger,
} from './helpers/fixtures.js';
import type { TradingStateRetentionConfig } from '../src/index.js';

/** Собирает рантайм с заданным хранением. */
function build(config: TradingStateRetentionConfig) {
  const bus = new EventBus(silentLogger);
  const created = TradingStateProjector.create(bus, config, new PaperClock(new Date(0)));
  if (isErr(created)) throw created.error;
  created.value.start();
  return { bus, view: created.value.state(), events: new EventFactory() };
}

describe('L. Вытеснение по количеству', () => {
  it('старейшие наблюдения уходят первыми', async () => {
    const config = retention();
    const { bus, view, events } = build({
      ...config,
      market: { ...config.market, books: { maxCount: 3 } },
    });

    for (let i = 0; i < 5; i += 1) {
      events.observeAt(1_000 + i * 100);
      await bus.publish(
        events.bookDepth({
          venueId: POLYMARKET,
          instrumentId: YES,
          marketId: MARKET_X,
          bid: 0.5,
          sourceTimestampMs: 900 + i * 100,
        }),
      );
    }

    const books = view.getMarket(MARKET_X)?.getInstrument(YES)?.books;
    expect(books?.size()).toBe(3);
    // FIFO: остались три последних наблюдения.
    expect(books?.getAll().map((o) => o.observedAt.toNumber())).toEqual([1_200, 1_300, 1_400]);
    // Версия считает ПРИНЯТЫЕ события, а не выжившие записи.
    expect(view.getVersion()).toBe(5);
  });
});

describe('M. Вытеснение по возрасту', () => {
  it('наблюдения старше окна удаляются при добавлении нового', async () => {
    const config = retention();
    const { bus, view, events } = build({
      ...config,
      market: { ...config.market, trades: { maxAgeMs: 1_000 } },
    });

    const publishAt = async (observedAt: number): Promise<void> => {
      events.observeAt(observedAt);
      await bus.publish(
        events.tradeReceived({
          venueId: POLYMARKET,
          instrumentId: YES,
          marketId: MARKET_X,
          price: 0.5,
          size: 1,
          side: 'BUY',
          sourceTimestampMs: observedAt - 10,
        }),
      );
    };

    await publishAt(10_000);
    await publishAt(10_500);
    // Это наблюдение на 1500 мс новее первого — первое выпадает из окна.
    await publishAt(11_500);

    const trades = view.getMarket(MARKET_X)?.getInstrument(YES)?.publicTrades;
    expect(trades?.getAll().map((o) => o.observedAt.toNumber())).toEqual([10_500, 11_500]);
  });
});

describe('N. Обратный ход времени площадки', () => {
  it('порядок наблюдений и вытеснение не зависят от source timestamp', async () => {
    const config = retention();
    const { bus, view, events } = build({
      ...config,
      market: { ...config.market, trades: { maxAgeMs: 1_000 } },
    });

    // Время наблюдения идёт вперёд, время площадки — НАЗАД.
    const rows: ReadonlyArray<readonly [number, number]> = [
      [10_000, 9_000],
      [10_500, 8_000],
      [11_500, 7_000],
    ];
    for (const [observedAt, sourceTimestampMs] of rows) {
      events.observeAt(observedAt);
      await bus.publish(
        events.tradeReceived({
          venueId: POLYMARKET,
          instrumentId: YES,
          marketId: MARKET_X,
          price: 0.5,
          size: 1,
          side: 'BUY',
          sourceTimestampMs,
        }),
      );
    }

    const trades = view.getMarket(MARKET_X)?.getInstrument(YES)?.publicTrades;
    // Вытеснение считалось по времени наблюдения, а не по времени площадки.
    expect(trades?.getAll().map((o) => o.observedAt.toNumber())).toEqual([10_500, 11_500]);
    // Время площадки сохранено как данные, включая ход назад.
    expect(trades?.getAll().map((o) => o.sourceTimestamp.toNumber())).toEqual([8_000, 7_000]);
  });
});

describe('Валидация политик хранения', () => {
  it('пустая политика отвергается при создании состояния, а не на живом событии', () => {
    const config = retention();
    const created = TradingStateProjector.create(
      new EventBus(silentLogger),
      { ...config, market: { ...config.market, books: {} } },
      new PaperClock(new Date(0)),
    );

    expect(isErr(created)).toBe(true);
    if (isErr(created)) {
      expect(created.error.message).toContain('market.books');
    }
  });

  it('отрицательный maxCount отвергается с указанием пути в конфиге', () => {
    const config = retention();
    const created = TradingStateProjector.create(
      new EventBus(silentLogger),
      { ...config, referencePrices: { maxCount: -1 } },
      new PaperClock(new Date(0)),
    );

    expect(isErr(created)).toBe(true);
    if (isErr(created)) {
      expect(created.error.message).toContain('referencePrices');
    }
  });

  it('корректный конфиг проходит', () => {
    expect(
      isOk(TradingStateProjector.create(new EventBus(silentLogger), retention(), new PaperClock(new Date(0)))),
    ).toBe(true);
  });
});

describe('Владение конфигурацией хранения', () => {
  it('изменение исходного конфига после создания на состояние не влияет', async () => {
    // Вызывающий держит MUTABLE-ссылку на политику. `readonly` — свойство
    // типа, а не объекта, и такое изменение легально.
    const booksPolicy = { maxCount: 3 };
    const config: TradingStateRetentionConfig = {
      market: { books: booksPolicy, trades: { maxCount: 100 } },
      shared: { books: { maxCount: 100 }, trades: { maxCount: 100 } },
      referencePrices: { maxCount: 100 },
    };

    const bus = new EventBus(silentLogger);
    const created = TradingStateProjector.create(bus, config, new PaperClock(new Date(0)));
    if (isErr(created)) throw created.error;
    created.value.start();
    const view = created.value.state();
    const events = new EventFactory();

    // Проверенная конфигурация подменяется ПОСЛЕ создания.
    booksPolicy.maxCount = 1;

    for (const [index, observedAt] of [1_000, 1_100, 1_200].entries()) {
      events.observeAt(observedAt);
      await bus.publish(
        events.bookDepth({
          venueId: POLYMARKET,
          instrumentId: YES,
          marketId: MARKET_X,
          bid: 0.4 + index * 0.05,
          sourceTimestampMs: observedAt - 50,
        }),
      );
    }

    // Осталось три записи, как было настроено при создании, а не одна.
    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.books.size()).toBe(3);
  });
});
