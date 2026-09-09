/**
 * Проекция canonical market-data событий в hot state через настоящую шину.
 *
 * @remarks
 * Тесты идут через реальный `EventBus`, а не вызывают состояние напрямую:
 * проверяется весь путь `IEventBus → projector → state`, включая
 * critical-подписки. Подмена шины заглушкой доказала бы работу заглушки.
 *
 * Метки `MD-*` — market-data механика (наполнение рядов, изоляция, домены).
 * Жизненный цикл рынка проверяется отдельной сюитой
 * `marketLifecycle.test.ts` (метки `A`…`AA`).
 *
 * Каждый market-scoped тест начинается с admission: рынок больше не создаётся
 * от первой книги, и наблюдение по непринятому рынку намеренно игнорируется
 * (см. `marketLifecycle.test.ts`, тест G).
 */
import { describe, expect, it } from '@jest/globals';
import { EventBus, type IEventBus } from '@polymarket/event-bus';
import { PaperClock } from '@polymarket/time';
import { isErr } from '@polymarket/result';
import type { Market } from '@polymarket/market';
import {
  TradingStateProjector,
  BookIdentityMismatchError,
  PriceDomainMismatchError,
  UnknownTradingMarketInstrumentError,
  type TradingHotStateView,
} from '../src/index.js';
import {
  BINANCE,
  BTC_USD,
  BTC_USDT,
  assetPrice as assetPriceOf,
  COINBASE,
  EventFactory,
  MARKET_X,
  MARKET_Y,
  NO,
  POLYMARKET,
  YES,
  market,
  retention,
  silentLogger,
} from './helpers/fixtures.js';
import type { TradingStateRetentionConfig } from '../src/index.js';

/** Момент admission: строго до `startsAt` любого тестового рынка. */
const ADMITTED_AT = 1_000;

/** Собирает шину, состояние и запущенный проектор. */
function buildRuntime(config: TradingStateRetentionConfig = retention()): {
  bus: IEventBus;
  view: TradingHotStateView;
  projector: TradingStateProjector;
  events: EventFactory;
} {
  const bus = new EventBus(silentLogger);
  const created = TradingStateProjector.create(bus, config, new PaperClock(new Date(0)));
  if (isErr(created)) throw created.error;
  created.value.start();
  return { bus, view: created.value.state(), projector: created.value, events: new EventFactory() };
}

/**
 * Принимает рынок к торговле — предусловие любого market-scoped теста.
 *
 * @param bus - Шина
 * @param events - Фабрика событий
 * @param admitted - Рынок; по умолчанию тестовый `MARKET_X` с YES/NO
 * @param atMs - Время admission (до `startsAt`)
 * @returns Принятый рынок
 * @throws {Error} Если admission отвергнут — это дефект самого теста
 */
async function admit(
  bus: IEventBus,
  events: EventFactory,
  admitted: Market = market(),
  atMs: number = ADMITTED_AT,
): Promise<Market> {
  events.observeAt(atMs);
  const result = await bus.publish(events.marketAdmitted(admitted));
  if (!result.ok) throw new Error('test setup: admission rejected');
  return admitted;
}

describe('MD-A. Наполнение рядов принятого рынка', () => {
  it('BOOK_DEPTH ложится в ряд инструмента, созданного при admission', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);
    events.observeAt(2_000);

    const result = await bus.publish(
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: 1_900,
      }),
    );

    expect(result.ok).toBe(true);
    const instrument = view.getMarket(MARKET_X)?.getInstrument(YES);
    expect(instrument).toBeDefined();
    expect(instrument?.books.size()).toBe(1);
    expect(instrument?.books.getLatest()?.observedAt.toNumber()).toBe(2_000);
    expect(instrument?.books.getLatest()?.sourceTimestamp.toNumber()).toBe(1_900);
    // Admission + наблюдение — две принятые мутации.
    expect(view.getVersion()).toBe(2);
    expect(view.getMarketForInstrument(YES)).toBe(MARKET_X);
  });
});

describe('MD-B. Несколько наблюдений одного инструмента', () => {
  it('все снимки в истории по порядку, текущий — последний, версия по числу событий', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);

    for (const [index, observedAt] of [2_000, 3_000, 4_000].entries()) {
      events.observeAt(observedAt);
      await bus.publish(
        events.bookDepth({
          venueId: POLYMARKET,
          instrumentId: YES,
          marketId: MARKET_X,
          bid: 0.4 + index * 0.1,
          sourceTimestampMs: observedAt - 100,
        }),
      );
    }

    const books = view.getMarket(MARKET_X)?.getInstrument(YES)?.books;
    expect(books?.size()).toBe(3);
    expect(books?.getAll().map((o) => o.observedAt.toNumber())).toEqual([2_000, 3_000, 4_000]);
    // Текущее значение — это getLatest(), отдельного currentBook не существует.
    expect(books?.getLatest()?.observedAt.toNumber()).toBe(4_000);
    expect(view.getVersion()).toBe(4);
  });
});

describe('MD-C. Изоляция YES и NO', () => {
  it('истории разных инструментов одного рынка не пересекаются', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);
    events.observeAt(2_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.4, sourceTimestampMs: 1_900 }),
    );
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: NO, marketId: MARKET_X, bid: 0.6, sourceTimestampMs: 1_900 }),
    );
    await bus.publish(
      events.tradeReceived({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, price: 0.4, size: 5, side: 'BUY', sourceTimestampMs: 1_950 }),
    );

    const runtimeMarket = view.getMarket(MARKET_X);
    expect(runtimeMarket?.getInstrument(YES)?.books.size()).toBe(1);
    expect(runtimeMarket?.getInstrument(NO)?.books.size()).toBe(1);
    expect(runtimeMarket?.getInstrument(YES)?.publicTrades.size()).toBe(1);
    expect(runtimeMarket?.getInstrument(NO)?.publicTrades.size()).toBe(0);
  });
});

describe('MD-G. Изоляция площадок в shared-состоянии', () => {
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

describe('MD-H. Рыночный и площадочный инструмент не конфликтуют', () => {
  it('один текстовый id в рынке и в shared живёт двумя разными состояниями', async () => {
    const { bus, view, events } = buildRuntime();
    // Инструмент исхода рынка НАЗВАН так же, как инструмент биржи.
    await admit(
      bus,
      events,
      market({
        outcomes: [
          { index: 0, label: 'Up', instrumentId: BTC_USDT },
          { index: 1, label: 'Down', instrumentId: NO },
        ],
      }),
    );

    events.observeAt(2_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: BTC_USDT, marketId: MARKET_X, bid: 0.5, sourceTimestampMs: 1_900 }),
    );
    events.observeAt(2_100);
    await bus.publish(
      events.bookDepth({ venueId: BINANCE, instrumentId: BTC_USDT, bid: 0.6, sourceTimestampMs: 1_950 }),
    );

    expect(view.getMarket(MARKET_X)?.getInstrument(BTC_USDT)?.books.size()).toBe(1);
    expect(view.getSharedInstrument(BINANCE, BTC_USDT)?.books.size()).toBe(1);
    // Индекс отражает только market-scoped принадлежность.
    expect(view.getMarketForInstrument(BTC_USDT)).toBe(MARKET_X);
  });
});

describe('MD-I. Публичные сделки', () => {
  it('сохраняются все поля наблюдения', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);
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
    await admit(bus, events);
    events.observeAt(2_000);
    await bus.publish(
      events.tradeReceived({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, price: 0.5, size: 1, side: 'BUY', sourceTimestampMs: 1_900 }),
    );

    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.publicTrades.getLatest()?.venueTradeId).toBeUndefined();
  });
});

describe('MD-K. Шаг цены', () => {
  it('TICK_SIZE_CHANGED обновляет текущее значение принятого рынка', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);
    events.observeAt(3_000);
    await bus.publish(
      events.tickSizeChanged({ marketId: MARKET_X, instrumentId: YES, newTickSize: 0.01, sourceTimestampMs: 2_900 }),
    );

    const instrument = view.getMarket(MARKET_X)?.getInstrument(YES);
    expect(instrument?.tickSize?.tickSize.value().toNumber()).toBeCloseTo(0.01, 6);
    expect(instrument?.tickSize?.observedAt.toNumber()).toBe(3_000);
    expect(view.getVersion()).toBe(2);
  });
});

describe('MD-O. Версия состояния', () => {
  it('стартует с нуля и растёт ровно на единицу за принятую мутацию', async () => {
    const { bus, view, events } = buildRuntime();
    expect(view.getVersion()).toBe(0);

    // Admission создаёт рынок, ОБА инструмента и две записи индекса —
    // но это одна принятая мутация, значит +1, а не +5.
    await admit(bus, events);
    expect(view.getVersion()).toBe(1);

    events.observeAt(2_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.5, sourceTimestampMs: 1_900 }),
    );
    expect(view.getVersion()).toBe(2);

    events.observeAt(2_100);
    await bus.publish(
      events.tradeReceived({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, price: 0.5, size: 1, side: 'BUY', sourceTimestampMs: 2_000 }),
    );
    expect(view.getVersion()).toBe(3);
  });
});

describe('MD-P. Жизненный цикл проектора', () => {
  it('повторный start не создаёт вторую подписку', async () => {
    const { bus, view, projector, events } = buildRuntime();
    projector.start();
    await admit(bus, events);

    events.observeAt(2_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.5, sourceTimestampMs: 1_900 }),
    );

    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.books.size()).toBe(1);
    expect(view.getVersion()).toBe(2);
  });

  it('после stop события состояние не меняют, повторный stop безопасен', async () => {
    const { bus, view, projector, events } = buildRuntime();
    await admit(bus, events);
    events.observeAt(2_000);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.5, sourceTimestampMs: 1_900 }),
    );
    const versionAtStop = view.getVersion();

    projector.stop();
    projector.stop();
    expect(projector.isRunning()).toBe(false);

    events.observeAt(2_100);
    await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.6, sourceTimestampMs: 2_000 }),
    );

    expect(view.getVersion()).toBe(versionAtStop);
    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.books.size()).toBe(1);
  });
});

describe('MD-R. Идентичность внутри снимка стакана', () => {
  it('снимок чужого инструмента не ложится под ключ события', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);
    events.observeAt(2_000);

    const result = await bus.publish(
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: 1_900,
        // Внутри снимка — ДРУГОЙ инструмент.
        snapshotOverride: { instrumentId: NO },
      }),
    );

    expect(result.ok).toBe(false);
    // Ничего не записано: отказ произошёл ДО мутации.
    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.books.size()).toBe(0);
    expect(view.getMarket(MARKET_X)?.getInstrument(NO)?.books.size()).toBe(0);
    expect(view.getVersion()).toBe(1);
  });

  it('снимок чужого рынка тоже отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);
    events.observeAt(2_000);

    const result = await bus.publish(
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: 1_900,
        snapshotOverride: { marketId: MARKET_Y },
      }),
    );

    expect(result.ok).toBe(false);
    expect(view.getVersion()).toBe(1);
  });

  it('идентичность проверяется даже у непринятого рынка', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);

    // Рынок не принят — данные нам не нужны, но несогласованный снимок
    // остаётся дефектом адаптера, и молчать о нём нельзя.
    const result = await bus.publish(
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: 900,
        snapshotOverride: { instrumentId: NO },
      }),
    );

    expect(result.ok).toBe(false);
    expect(view.getVersion()).toBe(0);
  });

  it('ошибка называет разошедшееся поле и обе стороны', () => {
    const error = new BookIdentityMismatchError('instrumentId', YES, NO);
    expect(error.field).toBe('instrumentId');
    expect(error.inPayload).toBe(YES);
    expect(error.inSnapshot).toBe(NO);
    expect(error.severity).toBe('critical');
  });
});

describe('MD-S. Ценовой домен сужается по владельцу ряда', () => {
  it('сделка рынка хранится с OutcomePrice, сделка площадки — с AssetPrice', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);

    events.observeAt(2_000);
    await bus.publish(
      events.tradeReceived({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        price: 0.62,
        size: 5,
        side: 'BUY',
        sourceTimestampMs: 1_900,
      }),
    );
    events.observeAt(2_100);
    await bus.publish(
      events.cexTradeReceived({
        venueId: BINANCE,
        instrumentId: BTC_USDT,
        price: 78_468.5,
        size: 0.25,
        side: 'SELL',
        sourceTimestampMs: 2_000,
      }),
    );

    const marketTrade = view.getMarket(MARKET_X)?.getInstrument(YES)?.publicTrades.getLatest();
    const sharedTrade = view.getSharedInstrument(BINANCE, BTC_USDT)?.publicTrades.getLatest();

    // Типы сужены: цена рынка сравнима с ценой рынка, цена биржи — с биржевой.
    expect(marketTrade?.price.value().toNumber()).toBeCloseTo(0.62, 6);
    expect(sharedTrade?.price.value().toNumber()).toBeCloseTo(78_468.5, 4);
    expect(marketTrade?.price.constructor.name).toBe('OutcomePrice');
    expect(sharedTrade?.price.constructor.name).toBe('AssetPrice');
  });

  it('биржевая цена в ряду принятого рынка отвергается и ничего не пишет', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);
    events.observeAt(2_000);

    // Цена биржи маршрутизирована в рынок предсказаний — ошибка адаптера.
    const result = await bus.publish(
      events.cexTradeReceived({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        price: 78_468.5,
        size: 1,
        side: 'BUY',
        sourceTimestampMs: 1_900,
      }),
    );

    expect(result.ok).toBe(false);
    // Ряд пуст, версия не выросла: проверка домена идёт ДО записи.
    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.publicTrades.size()).toBe(0);
    expect(view.getVersion()).toBe(1);
  });

  it('после отвергнутой сделки следующее законное наблюдение проходит', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);

    events.observeAt(2_000);
    const rejected = await bus.publish(
      events.cexTradeReceived({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        price: 78_468.5,
        size: 1,
        side: 'BUY',
        sourceTimestampMs: 1_900,
      }),
    );
    expect(rejected.ok).toBe(false);

    events.observeAt(2_100);
    const accepted = await bus.publish(
      events.tradeReceived({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        price: 0.62,
        size: 5,
        side: 'BUY',
        sourceTimestampMs: 2_000,
      }),
    );

    expect(accepted.ok).toBe(true);
    expect(view.getMarket(MARKET_X)?.getInstrument(YES)?.publicTrades.size()).toBe(1);
    expect(view.getMarketForInstrument(YES)).toBe(MARKET_X);
    expect(view.getVersion()).toBe(2);
  });

  it('цена исхода в ленту площадки не попадает и площадку не создаёт', async () => {
    const { bus, view, events } = buildRuntime();
    events.observeAt(1_000);

    // Доля исхода маршрутизирована в биржевую ленту — обратная ошибка.
    const result = await bus.publish(
      events.tradeReceived({
        venueId: BINANCE,
        instrumentId: BTC_USDT,
        price: 0.62,
        size: 1,
        side: 'BUY',
        sourceTimestampMs: 900,
      }),
    );

    expect(result.ok).toBe(false);
    expect(view.getSharedInstrument(BINANCE, BTC_USDT)).toBeUndefined();
    expect(view.sharedVenueIds()).toEqual([]);
    expect(view.getVersion()).toBe(0);
  });

  it('ошибка называет ожидаемый домен и фактическую величину', () => {
    const error = new PriceDomainMismatchError('OutcomePrice', assetPriceOf(78_468.5));
    expect(error.expected).toBe('OutcomePrice');
    expect(error.severity).toBe('critical');
    expect(error.message).toContain('78468.5');
  });
});

describe('MD-Q. Критическая подписка', () => {
  it('нарушение canonical-маршрутизации не замалчивается шиной', async () => {
    const { bus, view, events } = buildRuntime();
    await admit(bus, events);
    // Второй рынок со своими инструментами — YES ему не принадлежит.
    await admit(
      bus,
      events,
      market({
        id: MARKET_Y,
        outcomes: [
          { index: 0, label: 'Up', instrumentId: BTC_USD },
          { index: 1, label: 'Down', instrumentId: BTC_USDT },
        ],
      }),
    );

    events.observeAt(2_000);
    const result = await bus.publish(
      events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_Y, bid: 0.5, sourceTimestampMs: 1_900 }),
    );

    // Non-critical подписка проглотила бы ошибку и вернула Ok.
    expect(result.ok).toBe(false);
    // Инструмент не переехал на другой рынок молча.
    expect(view.getMarketForInstrument(YES)).toBe(MARKET_X);
    expect(view.getMarket(MARKET_Y)?.getInstrument(YES)).toBeUndefined();
    // Мутации не было: две версии — это два admission.
    expect(view.getVersion()).toBe(2);
  });

  it('ошибка несёт рынок, инструмент и состав исходов', () => {
    const error = new UnknownTradingMarketInstrumentError(MARKET_Y, YES, [BTC_USD, BTC_USDT]);
    expect(error.marketId).toBe(MARKET_Y);
    expect(error.instrumentId).toBe(YES);
    expect(error.marketInstrumentIds).toEqual([BTC_USD, BTC_USDT]);
    expect(error.severity).toBe('critical');
  });
});
