/**
 * Жизненный цикл рынка в торговом рантайме — через настоящую шину.
 *
 * @remarks
 * Метки `A`…`Z` соответствуют плану MR. Market-data механика (наполнение
 * рядов, изоляция инструментов, ценовые домены) проверяется отдельной сюитой
 * `TradingStateProjector.test.ts` (метки `MD-*`), детерминизм полной ленты —
 * `replayDeterminism.test.ts` (тест `AA`).
 *
 * Все переходы идут через реальный `EventBus`: проверяется путь
 * `IEventBus → projector → state`, включая critical-подписки. Времена
 * переходов задаются `metadata.createdAt` управляемых фикстур — ни
 * `Date.now()`, ни живых часов в тестах нет.
 */
import { describe, expect, it } from '@jest/globals';
import { EventBus, type IEventBus } from '@polymarket/event-bus';
import { PaperClock } from '@polymarket/time';
import { isErr } from '@polymarket/result';
import { MarketState, type Market } from '@polymarket/market';
import {
  TradingStateProjector,
  InstrumentMarketConflictError,
  TradingMarketAdmissionStateError,
  TradingMarketAdmissionTimingError,
  TradingMarketAlreadyAdmittedError,
  TradingMarketLifecycleTransitionError,
  TradingMarketStructureConflictError,
  findTradingMarketStructureDifference,
  sameTradingMarketStructure,
  type TradingHotStateView,
} from '../src/index.js';
import {
  BINANCE,
  BTC_USD,
  BTC_USDT,
  EXPIRES_AT_MS,
  EventFactory,
  KALSHI,
  KALSHI_NO,
  KALSHI_YES,
  MARKET_X,
  MARKET_Y,
  NO,
  OPENS_AT_MS,
  POLYMARKET,
  YES,
  asset,
  cryptoSpec,
  market,
  money,
  resolvedMarket,
  retention,
  silentLogger,
} from './helpers/fixtures.js';
import type { MarketDataSourceId, StrategyId } from '@polymarket/ids';

/** Время admission — строго до `OPENS_AT_MS`. */
const ADMITTED_AT = 1_000;
/** Время активации — ровно на открытии рынка. */
const ACTIVATED_AT = OPENS_AT_MS;

const SOURCE = 'chainlink' as MarketDataSourceId;

/** Собирает шину, состояние и запущенный проектор. */
function buildRuntime(): {
  bus: IEventBus;
  view: TradingHotStateView;
  events: EventFactory;
} {
  const bus = new EventBus(silentLogger);
  const created = TradingStateProjector.create(bus, retention(), new PaperClock(new Date(0)));
  if (isErr(created)) throw created.error;
  created.value.start();
  return { bus, view: created.value.state(), events: new EventFactory() };
}

/** Публикует событие в заданный момент наблюдения. */
async function publishAt(
  bus: IEventBus,
  events: EventFactory,
  atMs: number,
  build: () => Parameters<IEventBus['publish']>[0],
): Promise<{ ok: boolean }> {
  events.observeAt(atMs);
  return bus.publish(build());
}

/** Наполняет ряды обоих исходов, чтобы очистку было чем проверить. */
async function fillActiveData(
  bus: IEventBus,
  events: EventFactory,
  atMs: number,
): Promise<void> {
  for (const instrumentId of [YES, NO]) {
    await publishAt(bus, events, atMs, () =>
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: atMs - 50,
      }),
    );
    await publishAt(bus, events, atMs, () =>
      events.tradeReceived({
        venueId: POLYMARKET,
        instrumentId,
        marketId: MARKET_X,
        price: 0.5,
        size: 1,
        side: 'BUY',
        sourceTimestampMs: atMs - 50,
      }),
    );
    await publishAt(bus, events, atMs, () =>
      events.tickSizeChanged({
        venueId: POLYMARKET,
        marketId: MARKET_X,
        instrumentId,
        newTickSize: 0.01,
        sourceTimestampMs: atMs - 50,
      }),
    );
  }
}

/** Приводит рынок к статусу ACTIVE. */
async function toActive(
  bus: IEventBus,
  events: EventFactory,
  admitted: Market = market(),
): Promise<Market> {
  await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(admitted));
  await publishAt(bus, events, ACTIVATED_AT, () => events.marketActivated(admitted.venueId, admitted.id));
  return admitted;
}

describe('A. Admission', () => {
  it('создаёт состояние рынка, оба инструмента и обе записи индекса', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = market();

    const result = await publishAt(bus, events, ADMITTED_AT, () =>
      events.marketAdmitted(admitted),
    );

    expect(result.ok).toBe(true);
    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state).toBeDefined();
    // Хранится РОВНО тот canonical Market, что пришёл в payload.
    expect(state?.market).toBe(admitted);
    expect(state?.lifecycle.status).toBe('ADMITTED');
    expect(state?.lifecycle.admittedAt.toNumber()).toBe(ADMITTED_AT);
    expect(state?.lifecycle.activatedAt).toBeUndefined();
    expect(state?.instrumentIds()).toEqual([YES, NO]);
    expect(state?.getInstrument(YES)).toBeDefined();
    expect(state?.getInstrument(NO)).toBeDefined();
    expect(view.getMarketForInstrument(POLYMARKET, YES)).toBe(MARKET_X);
    expect(view.getMarketForInstrument(POLYMARKET, NO)).toBe(MARKET_X);
    expect(view.marketIdentities()).toEqual([{ venueId: POLYMARKET, marketId: MARKET_X }]);
    expect(view.getVersion()).toBe(1);
  });

  it('структура рынка читается из canonical Market, а не из копий полей', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = market({ question: 'Bitcoin Up or Down — 12:00 to 12:05?' });
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(admitted));

    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state?.market.question).toBe('Bitcoin Up or Down — 12:00 to 12:05?');
    expect(state?.market.startsAt.toNumber()).toBe(OPENS_AT_MS);
    expect(state?.market.expiresAt.toNumber()).toBe(EXPIRES_AT_MS);
    expect(state?.market.family).toBe('CRYPTO_UP_DOWN');
    expect(state?.market.crypto?.asset).toBe('btc');
    // Внешнее состояние площадки — отдельно от нашего lifecycle.
    expect(state?.market.state.status).toBe('ACTIVE');
    expect(state?.lifecycle.status).toBe('ADMITTED');
  });
});

describe('B. Оба инструмента существуют до первой книги', () => {
  it('ряды созданы и пусты сразу после admission', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state?.instrumentIds()).toEqual([YES, NO]);
    for (const instrumentId of [YES, NO]) {
      const instrument = state?.getInstrument(instrumentId);
      expect(instrument).toBeDefined();
      expect(instrument?.books.size()).toBe(0);
      expect(instrument?.publicTrades.size()).toBe(0);
      expect(instrument?.tickSize).toBeUndefined();
    }
  });
});

describe('C. Admission после startsAt отвергается', () => {
  it('ровно в startsAt уже поздно', async () => {
    const { bus, view, events } = buildRuntime();

    const result = await publishAt(bus, events, OPENS_AT_MS, () =>
      events.marketAdmitted(market()),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)).toBeUndefined();
    expect(view.getMarketForInstrument(POLYMARKET, YES)).toBeUndefined();
    expect(view.getMarketForInstrument(POLYMARKET, NO)).toBeUndefined();
    expect(view.marketIdentities()).toEqual([]);
    expect(view.getVersion()).toBe(0);
  });

  it('после startsAt тоже поздно', async () => {
    const { bus, view, events } = buildRuntime();

    const result = await publishAt(bus, events, OPENS_AT_MS + 1, () =>
      events.marketAdmitted(market()),
    );

    expect(result.ok).toBe(false);
    expect(view.getVersion()).toBe(0);
  });

  it('ошибка несёт оба времени', () => {
    const admitted = market();
    const error = new TradingMarketAdmissionTimingError(
      POLYMARKET,
      MARKET_X,
      admitted.startsAt,
      admitted.startsAt,
    );
    expect(error.marketId).toBe(MARKET_X);
    expect(error.severity).toBe('critical');
    expect(error.message).toContain('strictly before startsAt');
  });
});

describe('D. Терминальный рынок не принимается', () => {
  it('CLOSED на площадке отвергается', async () => {
    const { bus, view, events } = buildRuntime();

    const result = await publishAt(bus, events, ADMITTED_AT, () =>
      events.marketAdmitted(market({ state: MarketState.closed() })),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)).toBeUndefined();
    expect(view.getVersion()).toBe(0);
  });

  it('RESOLVED на площадке отвергается', async () => {
    const { bus, view, events } = buildRuntime();

    const result = await publishAt(bus, events, ADMITTED_AT, () =>
      events.marketAdmitted(resolvedMarket(market())),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)).toBeUndefined();
    expect(view.getMarketForInstrument(POLYMARKET, YES)).toBeUndefined();
    expect(view.getVersion()).toBe(0);
  });

  it('ошибка называет внешнее состояние', () => {
    const error = new TradingMarketAdmissionStateError(POLYMARKET, MARKET_X, 'RESOLVED');
    expect(error.venueStatus).toBe('RESOLVED');
    expect(error.severity).toBe('critical');
  });
});

describe('E. Повторный admission отвергается', () => {
  it('второе событие того же рынка — ошибка, а не обновление', async () => {
    const { bus, view, events } = buildRuntime();
    const first = market();
    const accepted = await publishAt(bus, events, ADMITTED_AT, () =>
      events.marketAdmitted(first),
    );
    expect(accepted.ok).toBe(true);
    expect(view.getVersion()).toBe(1);

    // Второе admission приносит ДРУГОЙ объект того же рынка.
    const second = market({ question: 'Другая формулировка?' });
    const duplicate = await publishAt(bus, events, ADMITTED_AT + 100, () =>
      events.marketAdmitted(second),
    );

    expect(duplicate.ok).toBe(false);
    // Ни версия, ни сохранённый рынок, ни состав инструментов не изменились.
    expect(view.getVersion()).toBe(1);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.market).toBe(first);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.admittedAt.toNumber()).toBe(ADMITTED_AT);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.instrumentIds()).toEqual([YES, NO]);
    expect(view.marketIdentities()).toEqual([{ venueId: POLYMARKET, marketId: MARKET_X }]);
  });

  it('ошибка называет текущий статус', () => {
    const error = new TradingMarketAlreadyAdmittedError(POLYMARKET, MARKET_X, 'ACTIVE');
    expect(error.currentStatus).toBe('ACTIVE');
    expect(error.severity).toBe('critical');
    expect(error.message).toContain('already admitted');
  });
});

describe('F. Атомарность: конфликт второго исхода', () => {
  it('занятый ВТОРОЙ инструмент не оставляет частично созданный рынок', async () => {
    const { bus, view, events } = buildRuntime();
    // Рынок A владеет YES и NO.
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));
    expect(view.getVersion()).toBe(1);

    // Рынок B: первый исход свободен (BTC_USD), второй занят рынком A (NO).
    const result = await publishAt(bus, events, ADMITTED_AT + 100, () =>
      events.marketAdmitted(
        market({
          id: MARKET_Y,
          outcomes: [
            { index: 0, label: 'Up', instrumentId: BTC_USD },
            { index: 1, label: 'Down', instrumentId: NO },
          ],
        }),
      ),
    );

    expect(result.ok).toBe(false);
    // Рынок B не создан вовсе.
    expect(view.getMarket(POLYMARKET, MARKET_Y)).toBeUndefined();
    expect(view.marketIdentities()).toEqual([{ venueId: POLYMARKET, marketId: MARKET_X }]);
    // Свободный первый исход НЕ зарегистрирован за отвергнутым рынком.
    expect(view.getMarketForInstrument(POLYMARKET, BTC_USD)).toBeUndefined();
    // Занятый исход остался за рынком A.
    expect(view.getMarketForInstrument(POLYMARKET, NO)).toBe(MARKET_X);
    expect(view.getVersion()).toBe(1);
  });

  it('конфликт первого исхода тоже отвергается целиком', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, ADMITTED_AT + 100, () =>
      events.marketAdmitted(
        market({
          id: MARKET_Y,
          outcomes: [
            { index: 0, label: 'Up', instrumentId: YES },
            { index: 1, label: 'Down', instrumentId: BTC_USDT },
          ],
        }),
      ),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_Y)).toBeUndefined();
    expect(view.getMarketForInstrument(POLYMARKET, BTC_USDT)).toBeUndefined();
    expect(view.getMarketForInstrument(POLYMARKET, YES)).toBe(MARKET_X);
    expect(view.getVersion()).toBe(1);
  });

  it('ошибка несёт обе стороны конфликта', () => {
    const error = new InstrumentMarketConflictError(POLYMARKET, YES, MARKET_X, MARKET_Y);
    expect(error.registeredMarketId).toBe(MARKET_X);
    expect(error.incomingMarketId).toBe(MARKET_Y);
    expect(error.severity).toBe('critical');
  });
});

describe('G. Market-data непринятого рынка игнорируется', () => {
  it('ни рынка, ни инструмента, ни версии — и это НЕ ошибка', async () => {
    const { bus, view, events } = buildRuntime();

    const book = await publishAt(bus, events, 1_000, () =>
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: 900,
      }),
    );
    const trade = await publishAt(bus, events, 1_100, () =>
      events.tradeReceived({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        price: 0.5,
        size: 1,
        side: 'BUY',
        sourceTimestampMs: 1_000,
      }),
    );
    const tick = await publishAt(bus, events, 1_200, () =>
      events.tickSizeChanged({
        venueId: POLYMARKET,
        marketId: MARKET_X,
        instrumentId: YES,
        newTickSize: 0.01,
        sourceTimestampMs: 1_100,
      }),
    );

    // Событие намеренно нерелевантно — publish остаётся Ok.
    expect(book.ok).toBe(true);
    expect(trade.ok).toBe(true);
    expect(tick.ok).toBe(true);
    expect(view.getMarket(POLYMARKET, MARKET_X)).toBeUndefined();
    expect(view.marketIdentities()).toEqual([]);
    expect(view.getMarketForInstrument(POLYMARKET, YES)).toBeUndefined();
    expect(view.getVersion()).toBe(0);
  });

  it('данные ЧУЖОГО рынка не мешают принятому', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    // MARKET_Y не принят: его книга проходит мимо состояния.
    const foreign = await publishAt(bus, events, 2_000, () =>
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: BTC_USDT,
        marketId: MARKET_Y,
        bid: 0.5,
        sourceTimestampMs: 1_900,
      }),
    );

    expect(foreign.ok).toBe(true);
    expect(view.getMarket(POLYMARKET, MARKET_Y)).toBeUndefined();
    expect(view.getMarketForInstrument(POLYMARKET, BTC_USDT)).toBeUndefined();
    expect(view.getVersion()).toBe(1);
  });
});

describe('H. Warm history до активации', () => {
  it('принятый, но ещё не активированный рынок накапливает историю', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    await publishAt(bus, events, 2_000, () =>
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.48,
        sourceTimestampMs: 1_900,
      }),
    );
    await publishAt(bus, events, 3_000, () =>
      events.tradeReceived({
        venueId: POLYMARKET,
        instrumentId: NO,
        marketId: MARKET_X,
        price: 0.52,
        size: 2,
        side: 'SELL',
        sourceTimestampMs: 2_900,
      }),
    );

    const state = view.getMarket(POLYMARKET, MARKET_X);
    // Статус ещё ADMITTED — но данные уже собираются.
    expect(state?.lifecycle.status).toBe('ADMITTED');
    expect(state?.getInstrument(YES)?.books.size()).toBe(1);
    expect(state?.getInstrument(YES)?.books.getLatest()?.observedAt.toNumber()).toBe(2_000);
    expect(state?.getInstrument(NO)?.publicTrades.size()).toBe(1);
    expect(view.getVersion()).toBe(3);
  });

  it('после активации накопленная история сохраняется', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));
    await publishAt(bus, events, 2_000, () =>
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.48,
        sourceTimestampMs: 1_900,
      }),
    );
    await publishAt(bus, events, ACTIVATED_AT, () => events.marketActivated(POLYMARKET, MARKET_X));
    await publishAt(bus, events, ACTIVATED_AT + 100, () =>
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.49,
        sourceTimestampMs: ACTIVATED_AT + 50,
      }),
    );

    const books = view.getMarket(POLYMARKET, MARKET_X)?.getInstrument(YES)?.books;
    expect(books?.getAll().map((o) => o.observedAt.toNumber())).toEqual([
      2_000,
      ACTIVATED_AT + 100,
    ]);
  });
});

describe('I. Неизвестный инструмент принятого рынка', () => {
  it('BOOK_DEPTH с чужим инструментом отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, 2_000, () =>
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: BTC_USDT,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: 1_900,
      }),
    );

    expect(result.ok).toBe(false);
    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state?.instrumentIds()).toEqual([YES, NO]);
    expect(state?.getInstrument(BTC_USDT)).toBeUndefined();
    expect(view.getMarketForInstrument(POLYMARKET, BTC_USDT)).toBeUndefined();
    expect(view.getVersion()).toBe(1);
  });

  it('TRADE_RECEIVED с чужим инструментом отвергается так же', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, 2_000, () =>
      events.tradeReceived({
        venueId: POLYMARKET,
        instrumentId: BTC_USDT,
        marketId: MARKET_X,
        price: 0.5,
        size: 1,
        side: 'BUY',
        sourceTimestampMs: 1_900,
      }),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.getInstrument(BTC_USDT)).toBeUndefined();
    expect(view.getVersion()).toBe(1);
  });

  it('TICK_SIZE_CHANGED с чужим инструментом отвергается так же', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, 2_000, () =>
      events.tickSizeChanged({
        venueId: POLYMARKET,
        marketId: MARKET_X,
        instrumentId: BTC_USDT,
        newTickSize: 0.01,
        sourceTimestampMs: 1_900,
      }),
    );

    expect(result.ok).toBe(false);
    expect(view.getVersion()).toBe(1);
  });
});

describe('J. Активация', () => {
  it('ровно на startsAt переводит ADMITTED → ACTIVE', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, OPENS_AT_MS, () =>
      events.marketActivated(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(true);
    const lifecycle = view.getMarket(POLYMARKET, MARKET_X)?.lifecycle;
    expect(lifecycle?.status).toBe('ACTIVE');
    expect(lifecycle?.activatedAt?.toNumber()).toBe(OPENS_AT_MS);
    expect(lifecycle?.admittedAt.toNumber()).toBe(ADMITTED_AT);
    expect(lifecycle?.tradingClosedAt).toBeUndefined();
    expect(view.getVersion()).toBe(2);
  });

  it('позже startsAt, но до expiresAt тоже допустима', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, EXPIRES_AT_MS - 1, () =>
      events.marketActivated(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(true);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ACTIVE');
  });

  it('повторная активация отвергается и состояние не меняет', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);
    expect(view.getVersion()).toBe(2);

    const again = await publishAt(bus, events, ACTIVATED_AT + 100, () =>
      events.marketActivated(POLYMARKET, MARKET_X),
    );

    expect(again.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.activatedAt?.toNumber()).toBe(ACTIVATED_AT);
    expect(view.getVersion()).toBe(2);
  });

  it('активация непринятого рынка отвергается', async () => {
    const { bus, view, events } = buildRuntime();

    const result = await publishAt(bus, events, ACTIVATED_AT, () =>
      events.marketActivated(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)).toBeUndefined();
    expect(view.getVersion()).toBe(0);
  });
});

describe('K. Ранняя активация отвергается', () => {
  it('до startsAt торговать нечем', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, OPENS_AT_MS - 1, () =>
      events.marketActivated(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(false);
    const lifecycle = view.getMarket(POLYMARKET, MARKET_X)?.lifecycle;
    expect(lifecycle?.status).toBe('ADMITTED');
    expect(lifecycle?.activatedAt).toBeUndefined();
    expect(view.getVersion()).toBe(1);
  });
});

describe('L. Активация после истечения отвергается', () => {
  it('ровно в expiresAt уже поздно', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, EXPIRES_AT_MS, () =>
      events.marketActivated(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ADMITTED');
    expect(view.getVersion()).toBe(1);
  });

  it('после expiresAt тоже поздно', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, EXPIRES_AT_MS + 1_000, () =>
      events.marketActivated(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(false);
    expect(view.getVersion()).toBe(1);
  });
});

describe('M. Недопустимые переходы', () => {
  it('ADMITTED → FINALIZED отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, ACTIVATED_AT, () =>
      events.marketFinalized(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ADMITTED');
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.finalizedAt).toBeUndefined();
    expect(view.getVersion()).toBe(1);
  });

  it('ADMITTED → TRADING_CLOSED отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, ACTIVATED_AT, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ADMITTED');
    expect(view.getVersion()).toBe(1);
  });

  it('ADMITTED → RESOLVED отвергается: catch-up мы не поддерживаем', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = market();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(admitted));

    const result = await publishAt(bus, events, ACTIVATED_AT, () =>
      events.marketResolved(resolvedMarket(admitted)),
    );

    expect(result.ok).toBe(false);
    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state?.lifecycle.status).toBe('ADMITTED');
    // Сохранённый рынок остался прежним, а не разрешённым.
    expect(state?.market).toBe(admitted);
    expect(state?.market.isActive()).toBe(true);
    expect(view.getVersion()).toBe(1);
  });

  it('ACTIVE → FINALIZED отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);

    const result = await publishAt(bus, events, ACTIVATED_AT + 100, () =>
      events.marketFinalized(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ACTIVE');
    expect(view.getVersion()).toBe(2);
  });

  it('ошибка называет исходный и целевой статус', () => {
    const error = new TradingMarketLifecycleTransitionError(
      POLYMARKET,
      MARKET_X,
      'FINALIZED',
      'ACTIVE',
      'PHASE',
    );
    expect(error.current).toBe('ACTIVE');
    expect(error.target).toBe('FINALIZED');
    expect(error.violation).toBe('PHASE');
    expect(error.severity).toBe('critical');
  });

  it('ошибка непринятого рынка отличима от ошибки фазы', () => {
    const error = new TradingMarketLifecycleTransitionError(
      POLYMARKET,
      MARKET_X,
      'ACTIVE',
      undefined,
      'NOT_ADMITTED',
    );
    expect(error.current).toBeUndefined();
    expect(error.violation).toBe('NOT_ADMITTED');
    expect(error.message).toContain('NOT_ADMITTED → ACTIVE');
  });
});

describe('N. Остановка торговли', () => {
  it('ACTIVE → TRADING_CLOSED записывает время и растит версию на единицу', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);
    const closedAt = ACTIVATED_AT + 5_000;

    const result = await publishAt(bus, events, closedAt, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(true);
    const lifecycle = view.getMarket(POLYMARKET, MARKET_X)?.lifecycle;
    expect(lifecycle?.status).toBe('TRADING_CLOSED');
    expect(lifecycle?.tradingClosedAt?.toNumber()).toBe(closedAt);
    expect(lifecycle?.activatedAt?.toNumber()).toBe(ACTIVATED_AT);
    expect(lifecycle?.resolvedAt).toBeUndefined();
    expect(view.getVersion()).toBe(3);
  });

  it('закрытие раньше expiresAt разрешено', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);

    const result = await publishAt(bus, events, ACTIVATED_AT + 1, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(true);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('TRADING_CLOSED');
  });

  it('повторное закрытие отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);
    await publishAt(bus, events, ACTIVATED_AT + 100, () => events.marketTradingClosed(POLYMARKET, MARKET_X));

    const again = await publishAt(bus, events, ACTIVATED_AT + 200, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );

    expect(again.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.tradingClosedAt?.toNumber()).toBe(
      ACTIVATED_AT + 100,
    );
    expect(view.getVersion()).toBe(3);
  });
});

describe('O. Очистка активных данных на закрытии', () => {
  it('тяжёлые ряды освобождаются, compact-состояние остаётся', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);
    await fillActiveData(bus, events, ACTIVATED_AT + 1_000);

    // Данные действительно были.
    const before = view.getMarket(POLYMARKET, MARKET_X);
    expect(before?.getInstrument(YES)?.books.size()).toBe(1);
    expect(before?.getInstrument(NO)?.publicTrades.size()).toBe(1);
    expect(before?.getInstrument(YES)?.tickSize).toBeDefined();

    await publishAt(bus, events, ACTIVATED_AT + 2_000, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );

    const after = view.getMarket(POLYMARKET, MARKET_X);
    // Тяжёлое активное состояние удалено.
    expect(after?.getInstrument(YES)).toBeUndefined();
    expect(after?.getInstrument(NO)).toBeUndefined();
    // Compact-часть цела.
    expect(after).toBeDefined();
    expect(after?.market).toBe(admitted);
    expect(after?.market.question).toBe('Bitcoin Up or Down?');
    expect(after?.instrumentIds()).toEqual([YES, NO]);
    expect(view.getMarketForInstrument(POLYMARKET, YES)).toBe(MARKET_X);
    expect(view.getMarketForInstrument(POLYMARKET, NO)).toBe(MARKET_X);
    expect(after?.lifecycle.status).toBe('TRADING_CLOSED');
    expect(after?.lifecycle.admittedAt.toNumber()).toBe(ADMITTED_AT);
    expect(after?.lifecycle.activatedAt?.toNumber()).toBe(ACTIVATED_AT);
    expect(view.marketIdentities()).toEqual([{ venueId: POLYMARKET, marketId: MARKET_X }]);
  });
});

describe('P. Поздние market-data игнорируются', () => {
  it('после TRADING_CLOSED наблюдения не меняют ни версию, ни состояние', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);
    await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );
    const versionAtClose = view.getVersion();

    const book = await publishAt(bus, events, ACTIVATED_AT + 2_000, () =>
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: ACTIVATED_AT + 1_900,
      }),
    );
    const trade = await publishAt(bus, events, ACTIVATED_AT + 2_100, () =>
      events.tradeReceived({
        venueId: POLYMARKET,
        instrumentId: NO,
        marketId: MARKET_X,
        price: 0.5,
        size: 1,
        side: 'BUY',
        sourceTimestampMs: ACTIVATED_AT + 2_000,
      }),
    );
    const tick = await publishAt(bus, events, ACTIVATED_AT + 2_200, () =>
      events.tickSizeChanged({
        venueId: POLYMARKET,
        marketId: MARKET_X,
        instrumentId: YES,
        newTickSize: 0.001,
        sourceTimestampMs: ACTIVATED_AT + 2_100,
      }),
    );

    // Игнор, а не ошибка: инструмент законный, просто торги остановлены.
    expect(book.ok).toBe(true);
    expect(trade.ok).toBe(true);
    expect(tick.ok).toBe(true);
    expect(view.getVersion()).toBe(versionAtClose);
    // Ряды не воссозданы.
    expect(view.getMarket(POLYMARKET, MARKET_X)?.getInstrument(YES)).toBeUndefined();
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('TRADING_CLOSED');
  });

  it('чужой инструмент остаётся ошибкой и после закрытия', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);
    await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );
    const versionAtClose = view.getVersion();

    const result = await publishAt(bus, events, ACTIVATED_AT + 2_000, () =>
      events.bookDepth({
        venueId: POLYMARKET,
        instrumentId: BTC_USDT,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: ACTIVATED_AT + 1_900,
      }),
    );

    expect(result.ok).toBe(false);
    expect(view.getVersion()).toBe(versionAtClose);
  });
});

describe('Q. Штатная резолюция', () => {
  it('TRADING_CLOSED → RESOLVED обновляет Market и даёт победителя', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);
    await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );
    const resolved = resolvedMarket(admitted, 1);
    const resolvedAt = ACTIVATED_AT + 2_000;

    const result = await publishAt(bus, events, resolvedAt, () =>
      events.marketResolved(resolved),
    );

    expect(result.ok).toBe(true);
    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state?.lifecycle.status).toBe('RESOLVED');
    expect(state?.lifecycle.resolvedAt?.toNumber()).toBe(resolvedAt);
    // Сохранённый Market заменён РАЗРЕШЁННЫМ.
    expect(state?.market).toBe(resolved);
    expect(state?.market.isResolved()).toBe(true);
    expect(state?.market.state.status).toBe('RESOLVED');
    expect(state?.market.resolvedOutcome?.instrumentId).toBe(NO);
    expect(state?.market.resolvedOutcome?.label).toBe('Down');
    // Закрытие мы видели раньше — его время не переписано.
    expect(state?.lifecycle.tradingClosedAt?.toNumber()).toBe(ACTIVATED_AT + 1_000);
    expect(view.getVersion()).toBe(4);
  });
});

describe('R. Резолюция прямо из ACTIVE', () => {
  it('закрывает торговлю тем же переходом и растит версию один раз', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);
    await fillActiveData(bus, events, ACTIVATED_AT + 500);
    const versionBefore = view.getVersion();
    const resolvedAt = ACTIVATED_AT + 1_000;

    const result = await publishAt(bus, events, resolvedAt, () =>
      events.marketResolved(resolvedMarket(admitted, 0)),
    );

    expect(result.ok).toBe(true);
    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state?.lifecycle.status).toBe('RESOLVED');
    expect(state?.lifecycle.resolvedAt?.toNumber()).toBe(resolvedAt);
    // Разрешённый рынок не остаётся торгово активным.
    expect(state?.lifecycle.tradingClosedAt?.toNumber()).toBe(resolvedAt);
    // Тяжёлые данные освобождены тем же переходом.
    expect(state?.getInstrument(YES)).toBeUndefined();
    expect(state?.getInstrument(NO)).toBeUndefined();
    expect(state?.instrumentIds()).toEqual([YES, NO]);
    expect(state?.market.resolvedOutcome?.instrumentId).toBe(YES);
    // Ровно +1, хотя переход сделал три вещи.
    expect(view.getVersion()).toBe(versionBefore + 1);
  });
});

describe('S. Неразрешённый payload отвергается', () => {
  it('ACTIVE-рынок в TRADING_MARKET_RESOLVED — ошибка', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);

    const result = await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketResolved(admitted),
    );

    expect(result.ok).toBe(false);
    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state?.lifecycle.status).toBe('ACTIVE');
    expect(state?.lifecycle.resolvedAt).toBeUndefined();
    expect(state?.lifecycle.tradingClosedAt).toBeUndefined();
    expect(state?.getInstrument(YES)).toBeDefined();
    expect(view.getVersion()).toBe(2);
  });

  it('CLOSED-рынок площадки тоже не является резолюцией', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);
    const closed = admitted.markClosed();
    if (!closed.ok) throw closed.error;

    const result = await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketResolved(closed.value),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.market).toBe(admitted);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ACTIVE');
    expect(view.getVersion()).toBe(2);
  });
});

describe('T. Резолюция чужого рынка отвергается', () => {
  it('рынок, которого рантайм не принимал, не резолвится', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);
    const other = market({
      id: MARKET_Y,
      outcomes: [
        { index: 0, label: 'Up', instrumentId: BTC_USD },
        { index: 1, label: 'Down', instrumentId: BTC_USDT },
      ],
    });

    const result = await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketResolved(resolvedMarket(other)),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_Y)).toBeUndefined();
    expect(view.getMarket(POLYMARKET, MARKET_X)?.market).toBe(admitted);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ACTIVE');
    expect(view.getVersion()).toBe(2);
  });

  it('тот же id на другой площадке — НЕ наш рынок, а не конфликт структуры', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);
    // KALSHI:X — другая СУЩНОСТЬ рынка, а не изменённая структура POLYMARKET:X.
    const otherVenue = market({ venueId: KALSHI, state: MarketState.resolved(0) });

    const result = await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketResolved(otherVenue),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.market).toBe(admitted);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ACTIVE');
    // Рынок ищется по паре, поэтому KALSHI:X не найден вовсе.
    expect(view.getMarket(KALSHI, MARKET_X)).toBeUndefined();
    expect(view.getVersion()).toBe(2);
  });
});

describe('U. Конфликт структуры при резолюции', () => {
  const cases: ReadonlyArray<readonly [string, () => Market]> = [
    ['startsAt', () => resolvedMarket(market({ startsAtMs: OPENS_AT_MS + 1 }))],
    ['expiresAt', () => resolvedMarket(market({ expiresAtMs: EXPIRES_AT_MS + 1 }))],
    [
      'outcome instrumentId',
      () =>
        resolvedMarket(
          market({
            outcomes: [
              { index: 0, label: 'Up', instrumentId: YES },
              { index: 1, label: 'Down', instrumentId: BTC_USDT },
            ],
          }),
        ),
    ],
    ['family', () => resolvedMarket(market({ family: 'BINARY_OUTCOME' }))],
    ['crypto.asset', () => resolvedMarket(market({ crypto: cryptoSpec('eth') }))],
    ['crypto.duration', () => resolvedMarket(market({ crypto: cryptoSpec('btc', 60_000) }))],
  ];

  for (const [field, build] of cases) {
    it(`расхождение по ${field} отвергается без мутации`, async () => {
      const { bus, view, events } = buildRuntime();
      const admitted = await toActive(bus, events);
      await fillActiveData(bus, events, ACTIVATED_AT + 100);
      const versionBefore = view.getVersion();

      const result = await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
        events.marketResolved(build()),
      );

      expect(result.ok).toBe(false);
      const state = view.getMarket(POLYMARKET, MARKET_X);
      // Состояние осталось полностью прежним.
      expect(state?.market).toBe(admitted);
      expect(state?.lifecycle.status).toBe('ACTIVE');
      expect(state?.lifecycle.resolvedAt).toBeUndefined();
      expect(state?.lifecycle.tradingClosedAt).toBeUndefined();
      expect(state?.getInstrument(YES)?.books.size()).toBe(1);
      expect(state?.getInstrument(NO)?.publicTrades.size()).toBe(1);
      expect(view.getVersion()).toBe(versionBefore);
    });
  }

  it('ошибка называет разошедшееся поле и обе стороны', () => {
    const error = new TradingMarketStructureConflictError(POLYMARKET, MARKET_X, {
      field: 'startsAt',
      left: '1970-01-01T00:00:10.000Z',
      right: '1970-01-01T00:00:11.000Z',
    });
    expect(error.difference.field).toBe('startsAt');
    expect(error.severity).toBe('critical');
    expect(error.message).toContain('startsAt');
  });

  it('helper сравнения не считает structural ни question, ни slug, ни state', () => {
    const base = market({ question: 'A?', slug: 'market-a' });
    const renamed = market({ question: 'B?', slug: 'market-b' });
    expect(sameTradingMarketStructure(base, renamed)).toBe(true);
    expect(sameTradingMarketStructure(base, resolvedMarket(base))).toBe(true);
    expect(sameTradingMarketStructure(base, market({ startsAtMs: OPENS_AT_MS - 1 }))).toBe(false);
  });
});

describe('V. Уточнение question и slug принимается', () => {
  it('display metadata не является торговой идентичностью', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events, market({ question: 'Bitcoin Up?', slug: 'btc-up-1200' }));
    await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );
    const clarified = resolvedMarket(
      market({ question: 'Bitcoin Up or Down — 12:00 to 12:05?', slug: 'btc-up-down-1200' }),
      1,
    );

    const result = await publishAt(bus, events, ACTIVATED_AT + 2_000, () =>
      events.marketResolved(clarified),
    );

    expect(result.ok).toBe(true);
    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state?.market).toBe(clarified);
    expect(state?.market.question).toBe('Bitcoin Up or Down — 12:00 to 12:05?');
    expect(state?.market.slug).toBe('btc-up-down-1200');
    expect(state?.lifecycle.status).toBe('RESOLVED');
    expect(view.getVersion()).toBe(4);
  });
});

describe('W. Финализация', () => {
  it('RESOLVED → FINALIZED удерживает рынок в состоянии', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);
    await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );
    const resolved = resolvedMarket(admitted, 0);
    await publishAt(bus, events, ACTIVATED_AT + 2_000, () => events.marketResolved(resolved));
    const finalizedAt = ACTIVATED_AT + 3_000;

    const result = await publishAt(bus, events, finalizedAt, () =>
      events.marketFinalized(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(true);
    const state = view.getMarket(POLYMARKET, MARKET_X);
    expect(state?.lifecycle.status).toBe('FINALIZED');
    expect(state?.lifecycle.finalizedAt?.toNumber()).toBe(finalizedAt);
    // Retained compact market: рынок и структура на месте.
    expect(state?.market).toBe(resolved);
    expect(state?.market.resolvedOutcome?.instrumentId).toBe(YES);
    expect(state?.instrumentIds()).toEqual([YES, NO]);
    expect(view.getMarketForInstrument(POLYMARKET, YES)).toBe(MARKET_X);
    expect(view.marketIdentities()).toEqual([{ venueId: POLYMARKET, marketId: MARKET_X }]);
    expect(view.getVersion()).toBe(5);
  });

  it('повторная финализация отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);
    await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketResolved(resolvedMarket(admitted)),
    );
    await publishAt(bus, events, ACTIVATED_AT + 2_000, () => events.marketFinalized(POLYMARKET, MARKET_X));
    const versionAfterFinalize = view.getVersion();

    const again = await publishAt(bus, events, ACTIVATED_AT + 3_000, () =>
      events.marketFinalized(POLYMARKET, MARKET_X),
    );

    expect(again.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.finalizedAt?.toNumber()).toBe(
      ACTIVATED_AT + 2_000,
    );
    expect(view.getVersion()).toBe(versionAfterFinalize);
  });
});

describe('X. Финализация до резолюции отвергается', () => {
  it('из TRADING_CLOSED финализировать нельзя', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);
    await publishAt(bus, events, ACTIVATED_AT + 1_000, () =>
      events.marketTradingClosed(POLYMARKET, MARKET_X),
    );
    const versionBefore = view.getVersion();

    const result = await publishAt(bus, events, ACTIVATED_AT + 2_000, () =>
      events.marketFinalized(POLYMARKET, MARKET_X),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('TRADING_CLOSED');
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.finalizedAt).toBeUndefined();
    expect(view.getVersion()).toBe(versionBefore);
  });
});

describe('Y. Shared-данные не зависят от принятых рынков', () => {
  it('CEX и референсные цены живут без единого admission', async () => {
    const { bus, view, events } = buildRuntime();

    await publishAt(bus, events, 1_000, () =>
      events.bookDepth({
        venueId: BINANCE,
        instrumentId: BTC_USDT,
        bid: 0.5,
        sourceTimestampMs: 900,
      }),
    );
    await publishAt(bus, events, 1_100, () =>
      events.cexTradeReceived({
        venueId: BINANCE,
        instrumentId: BTC_USDT,
        price: 78_468.5,
        size: 0.25,
        side: 'SELL',
        sourceTimestampMs: 1_000,
      }),
    );
    await publishAt(bus, events, 1_200, () =>
      events.referencePrice({
        sourceId: SOURCE,
        baseAsset: asset('BTC'),
        quoteAsset: asset('USD'),
        nativeSymbol: 'BTCUSD',
        feed: { kind: 'SPOT' },
        value: 78_470,
        venueTimestampMs: 1_150,
        receivedAtMs: 1_180,
      }),
    );

    expect(view.marketIdentities()).toEqual([]);
    expect(view.getSharedInstrument(BINANCE, BTC_USDT)?.books.size()).toBe(1);
    expect(view.getSharedInstrument(BINANCE, BTC_USDT)?.publicTrades.size()).toBe(1);
    expect(view.referencePriceSeriesKeys()).toHaveLength(1);
    expect(view.getVersion()).toBe(3);
  });
});

describe('Z. Legacy lifecycle не влияет на новое состояние', () => {
  it('MARKET_OPENED и MARKET_CLOSED проектор не слушает', async () => {
    const { bus, view, events } = buildRuntime();
    const admitted = await toActive(bus, events);
    const versionBefore = view.getVersion();

    // Legacy-события строятся вручную: их payload несёт аллокацию и PnL, к
    // новому lifecycle отношения не имеющие, и фабрики для них здесь нет.
    events.observeAt(ACTIVATED_AT + 100);
    const opened = await bus.publish({
      type: 'MARKET_OPENED',
      payload: {
        marketId: MARKET_X,
        strategyId: 'legacy-strategy' as StrategyId,
        allocatedBalance: money(100),
        timestamp: admitted.startsAt,
      },
      metadata: events.metadata(),
    });
    events.observeAt(ACTIVATED_AT + 200);
    const closed = await bus.publish({
      type: 'MARKET_CLOSED',
      payload: {
        marketId: MARKET_X,
        reason: 'EXPIRED',
        realizedPnL: money(0),
        timestamp: admitted.expiresAt,
      },
      metadata: events.metadata(),
    });

    // Подписчиков нет — шина не жалуется, состояние не меняется.
    expect(opened.ok).toBe(true);
    expect(closed.ok).toBe(true);
    expect(view.getVersion()).toBe(versionBefore);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ACTIVE');
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.tradingClosedAt).toBeUndefined();
  });

  it('в списке проецируемых типов только новый lifecycle', () => {
    const types = TradingStateProjector.projectedEventTypes();
    expect(types).toContain('TRADING_MARKET_ADMITTED');
    expect(types).toContain('TRADING_MARKET_ACTIVATED');
    expect(types).toContain('TRADING_MARKET_CLOSED');
    expect(types).toContain('TRADING_MARKET_RESOLVED');
    expect(types).toContain('TRADING_MARKET_FINALIZED');
    expect(types).not.toContain('MARKET_OPENED');
    expect(types).not.toContain('MARKET_CLOSED');
    expect(types).not.toContain('BOOK_UPDATED');
  });
});

describe('AB. Идентичность рынка = площадка + рынок', () => {
  it('POLYMARKET:X и KALSHI:X принимаются одновременно', async () => {
    const { bus, view, events } = buildRuntime();

    const polymarket = await toActive(bus, events);
    const kalshi = market({
      venueId: KALSHI,
      outcomes: [
        { index: 0, label: 'Up', instrumentId: KALSHI_YES },
        { index: 1, label: 'Down', instrumentId: KALSHI_NO },
      ],
    });
    const admitted = await publishAt(bus, events, ADMITTED_AT + 100, () =>
      events.marketAdmitted(kalshi),
    );

    expect(admitted.ok).toBe(true);
    // Один и тот же MarketId — два РАЗНЫХ рынка.
    expect(view.getMarket(POLYMARKET, MARKET_X)?.market).toBe(polymarket);
    expect(view.getMarket(KALSHI, MARKET_X)?.market).toBe(kalshi);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ACTIVE');
    expect(view.getMarket(KALSHI, MARKET_X)?.lifecycle.status).toBe('ADMITTED');
    expect(view.marketIdentities()).toEqual([
      { venueId: POLYMARKET, marketId: MARKET_X },
      { venueId: KALSHI, marketId: MARKET_X },
    ]);
    expect(view.getVersion()).toBe(3);
  });

  it('одинаковый InstrumentId на разных площадках не блокирует admission', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    // ТЕ ЖЕ YES/NO, но у другой площадки — другие инструменты.
    const kalshi = market({ venueId: KALSHI });
    const admitted = await publishAt(bus, events, ADMITTED_AT + 100, () =>
      events.marketAdmitted(kalshi),
    );

    expect(admitted.ok).toBe(true);
    expect(view.getMarketForInstrument(POLYMARKET, YES)).toBe(MARKET_X);
    expect(view.getMarketForInstrument(KALSHI, YES)).toBe(MARKET_X);
    // Индексы независимы: запись одной площадки не отвечает за другую.
    expect(view.getMarketForInstrument(BINANCE, YES)).toBeUndefined();
    expect(view.getVersion()).toBe(2);
  });

  it('market-data чужой площадки не попадает в наш рынок', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);
    // KALSHI:X с ТЕМИ ЖЕ идентификаторами рынка и инструмента, но не принят.
    const book = await publishAt(bus, events, ACTIVATED_AT + 100, () =>
      events.bookDepth({
        venueId: KALSHI,
        instrumentId: YES,
        marketId: MARKET_X,
        bid: 0.9,
        sourceTimestampMs: ACTIVATED_AT + 50,
      }),
    );
    const trade = await publishAt(bus, events, ACTIVATED_AT + 200, () =>
      events.tradeReceived({
        venueId: KALSHI,
        instrumentId: YES,
        marketId: MARKET_X,
        price: 0.9,
        size: 1,
        side: 'BUY',
        sourceTimestampMs: ACTIVATED_AT + 150,
      }),
    );
    const tick = await publishAt(bus, events, ACTIVATED_AT + 300, () =>
      events.tickSizeChanged({
        venueId: KALSHI,
        marketId: MARKET_X,
        instrumentId: YES,
        newTickSize: 0.001,
        sourceTimestampMs: ACTIVATED_AT + 250,
      }),
    );

    // Чужой рынок — игнор, а не запись и не ошибка.
    expect(book.ok).toBe(true);
    expect(trade.ok).toBe(true);
    expect(tick.ok).toBe(true);
    const ours = view.getMarket(POLYMARKET, MARKET_X);
    expect(ours?.getInstrument(YES)?.books.size()).toBe(0);
    expect(ours?.getInstrument(YES)?.publicTrades.size()).toBe(0);
    expect(ours?.getInstrument(YES)?.tickSize).toBeUndefined();
    expect(view.getMarket(KALSHI, MARKET_X)).toBeUndefined();
    expect(view.getVersion()).toBe(2);
  });

  it('чужой инструмент чужой площадки не даёт ложного аварийного отказа', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);

    // Инструмента KALSHI_YES нет ни у одного принятого рынка. Но и рынок
    // KALSHI:X не принят — значит это чужие данные, а не нарушение routing.
    const result = await publishAt(bus, events, ACTIVATED_AT + 100, () =>
      events.bookDepth({
        venueId: KALSHI,
        instrumentId: KALSHI_YES,
        marketId: MARKET_X,
        bid: 0.5,
        sourceTimestampMs: ACTIVATED_AT + 50,
      }),
    );

    expect(result.ok).toBe(true);
    expect(view.getVersion()).toBe(2);
  });

  it('lifecycle-событие чужой площадки не двигает наш рынок', async () => {
    const { bus, view, events } = buildRuntime();
    await toActive(bus, events);
    const versionBefore = view.getVersion();

    const closed = await publishAt(bus, events, ACTIVATED_AT + 100, () =>
      events.marketTradingClosed(KALSHI, MARKET_X),
    );
    const finalized = await publishAt(bus, events, ACTIVATED_AT + 200, () =>
      events.marketFinalized(KALSHI, MARKET_X),
    );

    // Оба отвергнуты как NOT_ADMITTED: рынок ищется по паре.
    expect(closed.ok).toBe(false);
    expect(finalized.ok).toBe(false);
    const ours = view.getMarket(POLYMARKET, MARKET_X)?.lifecycle;
    expect(ours?.status).toBe('ACTIVE');
    expect(ours?.tradingClosedAt).toBeUndefined();
    expect(ours?.finalizedAt).toBeUndefined();
    expect(view.getVersion()).toBe(versionBefore);
  });

  it('активация чужой площадки не активирует наш рынок', async () => {
    const { bus, view, events } = buildRuntime();
    await publishAt(bus, events, ADMITTED_AT, () => events.marketAdmitted(market()));

    const result = await publishAt(bus, events, ACTIVATED_AT, () =>
      events.marketActivated(KALSHI, MARKET_X),
    );

    expect(result.ok).toBe(false);
    expect(view.getMarket(POLYMARKET, MARKET_X)?.lifecycle.status).toBe('ADMITTED');
    expect(view.getVersion()).toBe(1);
  });

  it('helper сравнения площадку всё же различает — просто состояние до него не доходит', () => {
    // Сам helper обязан быть честным для любого вызывающего.
    const difference = findTradingMarketStructureDifference(
      market(),
      market({ venueId: KALSHI }),
    );
    expect(difference?.field).toBe('venueId');
    // Форма нейтральна: `left` — первый аргумент сравнения, `right` — второй.
    // Ролями их называет ошибка, и в её тексте они остаются admitted/incoming.
    expect(difference?.left).toBe(POLYMARKET);
    expect(difference?.right).toBe(KALSHI);
    // А состояние ищет рынок по паре, поэтому отвечает NOT_ADMITTED (см. тест T).
    expect(sameTradingMarketStructure(market(), market({ venueId: KALSHI }))).toBe(false);
  });
});
