/**
 * Проекция canonical market-data событий в hot state через настоящую шину.
 *
 * @remarks
 * Тесты идут через реальный `EventBus`, а не вызывают состояние напрямую:
 * проверяется весь путь `IEventBus → projector → state`, включая
 * critical-подписки. Подмена шины заглушкой доказала бы работу заглушки.
 */
import { describe, expect, it } from '@jest/globals';
import { EventBus, type IEventBus } from '@polymarket/event-bus';
import { PaperClock } from '@polymarket/time';
import { isErr } from '@polymarket/result';
import {
  TradingHotState,
  TradingStateProjector,
  InstrumentMarketConflictError,
  type TradingHotStateView,
} from '../src/index.js';
import {
  BINANCE,
  BTC_USD,
  BTC_USDT,
  COINBASE,
  EventFactory,
  MARKET_X,
  MARKET_Y,
  NO,
  POLYMARKET,
  YES,
  retention,
  silentLogger,
} from './helpers/fixtures.js';
import type { TradingStateRetentionConfig } from '../src/index.js';

/** Собирает шину, состояние и запущенный проектор. */
function buildRuntime(config: TradingStateRetentionConfig = retention()): {
  bus: IEventBus;
  view: TradingHotStateView;
  projector: TradingStateProjector;
  events: EventFactory;
} {
  const bus = new EventBus(silentLogger);
  const created = TradingHotState.create(config, new PaperClock(new Date(0)));
  if (isErr(created)) throw created.error;
  const projector = new TradingStateProjector(bus, created.value);
  projector.start();
  return { bus, view: projector.state(), projector, events: new EventFactory() };
}

describe('A. Ленивое создание рынка', () => {
  it('BOOK_DEPTH создаёт рынок, инструмент, индекс и первое наблюдение', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);

    const result = await bus.publish(
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: 900,
      }),
    );

    expect(result.ok).toBe(true);
    const instrument = view.getMarket(MARKET_X)?.getInstrument(YES);
    expect(instrument).toBeDefined();
    expect(instrument?.books.size()).toBe(1);
    expect(instrument?.books.getLatest()?.observedAt.toNumber()).toBe(1_000);
    expect(instrument?.books.getLatest()?.sourceTimestamp.toNumber()).toBe(900);
    expect(view.getVersion()).toBe(1);
    expect(view.getMarketForInstrument(YES)).toBe(MARKET_X);
  });
});

describe('B. Несколько наблюдений одного инструмента', () => {
  it('оба снимка лежат в истории, текущий — последний', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.4, sourceTimestampMs: 900 }),
    );
    events.observeAt(2_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.6, sourceTimestampMs: 1_900 }),
    );

    const books = view.getMarket(MARKET_X)?.getInstrument(YES)?.books;
    expect(books?.size()).toBe(2);
    // Текущее значение — это getLatest(), отдельного currentBook не существует.
    expect(books?.getLatest()?.observedAt.toNumber()).toBe(2_000);
    expect(books?.getAll()[0]?.observedAt.toNumber()).toBe(1_000);
  });
});

describe('C. Изоляция YES и NO', () => {
  it('истории разных инструментов одного рынка не пересекаются', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.4, sourceTimestampMs: 900 }),
    );
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: NO, marketId: MARKET_X, bid: 0.6, sourceTimestampMs: 900 }),
    );
    await bus.publish(
      events.tradeReceived({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, price: 0.4, size: 5, side: 'BUY', sourceTimestampMs: 950 }),
    );

    const market = view.getMarket(MARKET_X);
    expect(market?.getInstrument(YES)?.books.size()).toBe(1);
    expect(market?.getInstrument(NO)?.books.size()).toBe(1);
    expect(market?.getInstrument(YES)?.publicTrades.size()).toBe(1);
    expect(market?.getInstrument(NO)?.publicTrades.size()).toBe(0);
  });
});

describe('D. Верхушка стакана отдельно от полного снимка', () => {
  it('BOOK_UPDATED и BOOK_DEPTH ведут независимые ряды', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);
    await bus.publish(
      events.bookUpdated({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, sequenceNumber: 1, bestBid: 0.4, bestAsk: 0.6, sourceTimestampMs: 900 }),
    );
    events.observeAt(1_100);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.4, sourceTimestampMs: 950 }),
    );

    const instrument = view.getMarket(MARKET_X)?.getInstrument(YES);
    expect(instrument?.topOfBooks.size()).toBe(1);
    expect(instrument?.books.size()).toBe(1);
  });
});

describe('E. Устаревший BOOK_UPDATED', () => {
  it('повторный номер не откатывает состояние и не двигает версию', async () => {
    const { bus, view, events } = buildRuntime();
    const publish = async (sequenceNumber: number, observedAt: number): Promise<void> => {
      events.observeAt(observedAt);
      await bus.publish(
        events.bookUpdated({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, sequenceNumber, bestBid: 0.4, sourceTimestampMs: observedAt - 100 }),
      );
    };

    await publish(10, 1_000);
    await publish(11, 1_100);
    const versionBeforeStale = view.getVersion();
    await publish(10, 1_200);

    const topOfBooks = view.getMarket(MARKET_X)?.getInstrument(YES)?.topOfBooks;
    expect(topOfBooks?.size()).toBe(2);
    expect(topOfBooks?.getAll().map((o) => o.sequenceNumber)).toEqual([10, 11]);
    expect(topOfBooks?.getLatest()?.sequenceNumber).toBe(11);
    expect(view.getVersion()).toBe(versionBeforeStale);
  });
});

describe('F. Разрыв в номерах BOOK_UPDATED', () => {
  it('оба обновления принимаются, восстановление не изобретается', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);
    await bus.publish(
      events.bookUpdated({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, sequenceNumber: 10, bestBid: 0.4, sourceTimestampMs: 900 }),
    );
    events.observeAt(1_100);
    await bus.publish(
      events.bookUpdated({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, sequenceNumber: 15, bestBid: 0.45, sourceTimestampMs: 1_000 }),
    );

    const topOfBooks = view.getMarket(MARKET_X)?.getInstrument(YES)?.topOfBooks;
    expect(topOfBooks?.getAll().map((o) => o.sequenceNumber)).toEqual([10, 15]);
    expect(view.getVersion()).toBe(2);
  });
});

describe('G. Изоляция площадок в shared-состоянии', () => {
  it('события без marketId не создают рынков и не склеиваются между площадками', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);
    await bus.publish(
      events.bookDepth({ venueId: BINANCE, instrumentId: BTC_USDT, bid: 0.5, sourceTimestampMs: 900 }),
    );
    await bus.publish(
      events.bookDepth({ venueId: COINBASE, instrumentId: BTC_USD, bid: 0.51, sourceTimestampMs: 900 }),
    );

    expect(view.marketIds()).toEqual([]);
    expect(view.getSharedInstrument(BINANCE, BTC_USDT)?.books.size()).toBe(1);
    expect(view.getSharedInstrument(COINBASE, BTC_USD)?.books.size()).toBe(1);
    expect(view.sharedVenueIds()).toHaveLength(2);
  });

  it('одинаковый instrumentId на двух площадках остаётся разными рядами', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);
    await bus.publish(events.bookDepth({ venueId: BINANCE, instrumentId: BTC_USDT, bid: 0.5, sourceTimestampMs: 900 }));
    events.observeAt(1_100);
    await bus.publish(events.bookDepth({ venueId: COINBASE, instrumentId: BTC_USDT, bid: 0.6, sourceTimestampMs: 950 }));
    events.observeAt(1_200);
    await bus.publish(events.bookDepth({ venueId: COINBASE, instrumentId: BTC_USDT, bid: 0.7, sourceTimestampMs: 999 }));

    expect(view.getSharedInstrument(BINANCE, BTC_USDT)?.books.size()).toBe(1);
    expect(view.getSharedInstrument(COINBASE, BTC_USDT)?.books.size()).toBe(2);
  });
});

describe('H. Рыночный и площадочный инструмент не конфликтуют', () => {
  it('один текстовый id в рынке и в shared живёт двумя разными состояниями', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: BTC_USDT, marketId: MARKET_X, bid: 0.5, sourceTimestampMs: 900 }),
    );
    events.observeAt(1_100);
    await bus.publish(
      events.bookDepth({ venueId: BINANCE, instrumentId: BTC_USDT, bid: 0.6, sourceTimestampMs: 950 }),
    );

    expect(view.getMarket(MARKET_X)?.getInstrument(BTC_USDT)?.books.size()).toBe(1);
    expect(view.getSharedInstrument(BINANCE, BTC_USDT)?.books.size()).toBe(1);
    // Индекс отражает только market-scoped принадлежность.
    expect(view.getMarketForInstrument(BTC_USDT)).toBe(MARKET_X);
  });
});

describe('I. Публичные сделки', () => {
  it('сохраняются все поля наблюдения', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(2_000);
    await bus.publish(
      events.tradeReceived({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        price: 0.62,
        size: 7,
        side: 'SELL',
        venueTradeId: 'venue-trade-1' as never,
        sourceTimestampMs: 1_900,
      }),
    );

    const trade = view.getMarket(MARKET_X)?.getInstrument(YES)?.publicTrades.getLatest();
    expect(trade?.price.value().toNumber()).toBeCloseTo(0.62, 6);
    expect(trade?.size.toNumber()).toBe(7);
    expect(trade?.side).toBe('SELL');
    expect(trade?.venueTradeId).toBe('venue-trade-1');
    expect(trade?.sourceTimestamp.toNumber()).toBe(1_900);
    expect(trade?.observedAt.toNumber()).toBe(2_000);
  });

  it('отсутствующий venueTradeId остаётся undefined и не синтезируется', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(2_000);
    await bus.publish(
      events.tradeReceived({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, price: 0.5, size: 1, side: 'BUY', sourceTimestampMs: 1_900 }),
    );

    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.publicTrades.getLatest()?.venueTradeId).toBeUndefined();
  });
});

describe('K. Шаг цены', () => {
  it('TICK_SIZE_CHANGED создаёт рынок лениво и обновляет текущее значение', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(3_000);
    await bus.publish(
      events.tickSizeChanged({ marketId: MARKET_X, instrumentId: YES, newTickSize: 0.01, sourceTimestampMs: 2_900 }),
    );

    const instrument = view.getMarket(MARKET_X)?.getInstrument(YES);
    expect(instrument?.tickSize?.tickSize.value().toNumber()).toBeCloseTo(0.01, 6);
    expect(instrument?.tickSize?.observedAt.toNumber()).toBe(3_000);
    expect(view.getVersion()).toBe(1);
  });
});

describe('O. Версия состояния', () => {
  it('стартует с нуля и растёт ровно на единицу за принятое наблюдение', async () => {
    const { bus, view, events } = buildRuntime();
    expect(view.getVersion()).toBe(0);

    // Одно событие создаёт рынок, инструмент, запись индекса и ряд —
    // но это одно принятое наблюдение, значит +1, а не +4.
    events.observeAt(1_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.5, sourceTimestampMs: 900 }),
    );
    expect(view.getVersion()).toBe(1);

    events.observeAt(1_100);
    await bus.publish(
      events.tradeReceived({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, price: 0.5, size: 1, side: 'BUY', sourceTimestampMs: 1_000 }),
    );
    expect(view.getVersion()).toBe(2);
  });
});

describe('P. Жизненный цикл проектора', () => {
  it('повторный start не создаёт вторую подписку', async () => {
    const { bus, view, projector, events } = buildRuntime();
    projector.start();

    events.observeAt(1_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.5, sourceTimestampMs: 900 }),
    );

    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.books.size()).toBe(1);
    expect(view.getVersion()).toBe(1);
  });

  it('после stop события состояние не меняют, повторный stop безопасен', async () => {
    const { bus, view, projector, events } = buildRuntime();
    events.observeAt(1_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.5, sourceTimestampMs: 900 }),
    );
    const versionAtStop = view.getVersion();

    projector.stop();
    projector.stop();
    expect(projector.isRunning()).toBe(false);

    events.observeAt(1_100);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.6, sourceTimestampMs: 1_000 }),
    );

    expect(view.getVersion()).toBe(versionAtStop);
    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.books.size()).toBe(1);
  });
});

describe('Q. Критическая подписка', () => {
  it('нарушение владения инструментом не замалчивается шиной', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.5, sourceTimestampMs: 900 }),
    );

    events.observeAt(1_100);
    const result = await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_Y, bid: 0.5, sourceTimestampMs: 1_000 }),
    );

    // Non-critical подписка проглотила бы ошибку и вернула Ok.
    expect(result.ok).toBe(false);
    // Инструмент не переехал на другой рынок молча.
    expect(view.getMarketForInstrument(YES)).toBe(MARKET_X);
    expect(view.getMarket(MARKET_Y)).toBeUndefined();
  });

  it('ошибка несёт обе стороны конфликта', () => {
    const error = new InstrumentMarketConflictError(YES, MARKET_X, MARKET_Y);
    expect(error.registeredMarketId).toBe(MARKET_X);
    expect(error.incomingMarketId).toBe(MARKET_Y);
    expect(error.severity).toBe('critical');
  });
});
