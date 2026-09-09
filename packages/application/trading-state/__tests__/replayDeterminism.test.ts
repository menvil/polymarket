/**
 * Детерминизм проекции (тест `AA` плана MR).
 *
 * @remarks
 * Проверяется одно утверждение: состояние — функция ПОСЛЕДОВАТЕЛЬНОСТИ
 * canonical-событий, и ничего больше. Если бы где-то в пути остался
 * `Date.now()`, живой прогон и повтор той же ленты разошлись бы, а значит
 * бэктест перестал бы соответствовать торговле.
 *
 * Лента проходит полный жизненный цикл рынка — admission, warm history,
 * активация, торговля, закрытие, резолюция, финализация, — потому что
 * недетерминированным может оказаться именно переход: время перехода берётся
 * из `metadata.createdAt`, и подмена его на показания часов сломала бы ровно
 * это сравнение.
 *
 * Отдельного replay-движка здесь нет и не нужно: достаточно применить одну
 * ленту к двум свежим состояниям и сравнить читаемые проекции.
 */
import { describe, expect, it } from '@jest/globals';
import { EventBus } from '@polymarket/event-bus';
import { PaperClock } from '@polymarket/time';
import { isErr } from '@polymarket/result';
import type { EventBusEvent } from '@polymarket/event-bus';
import type { MarketDataSourceId } from '@polymarket/ids';
import { TradingStateProjector, type TradingHotStateView } from '../src/index.js';
import {
  BINANCE,
  BTC_USDT,
  EventFactory,
  MARKET_X,
  NO,
  OPENS_AT_MS,
  POLYMARKET,
  YES,
  asset,
  market,
  resolvedMarket,
  retention,
  silentLogger,
} from './helpers/fixtures.js';

const SOURCE = 'chainlink' as MarketDataSourceId;

/**
 * Строит одну и ту же ленту событий — порядок и времена зафиксированы.
 *
 * @returns Полный жизненный цикл рынка плюс shared-наблюдения
 */
function buildTape(): readonly EventBusEvent[] {
  const events = new EventFactory();
  const admitted = market();
  const tape: EventBusEvent[] = [];

  // Admission — единственный способ создать состояние рынка.
  events.observeAt(1_000);
  tape.push(events.marketAdmitted(admitted));

  // Warm history: рынок ещё не активирован, но данные уже собираются.
  events.observeAt(2_000);
  tape.push(events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.4, sourceTimestampMs: 1_900 }));
  events.observeAt(3_000);
  tape.push(events.bookDepth({ venueId: POLYMARKET, instrumentId: NO, marketId: MARKET_X, bid: 0.59, sourceTimestampMs: 2_900 }));

  // Активация ровно на startsAt.
  events.observeAt(OPENS_AT_MS);
  tape.push(events.marketActivated(MARKET_X));

  // Торговля.
  events.observeAt(OPENS_AT_MS + 100);
  tape.push(events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.41, sourceTimestampMs: OPENS_AT_MS + 50 }));
  events.observeAt(OPENS_AT_MS + 200);
  tape.push(events.tradeReceived({ venueId: POLYMARKET, instrumentId: NO, marketId: MARKET_X, price: 0.6, size: 3, side: 'SELL', sourceTimestampMs: OPENS_AT_MS + 150 }));
  events.observeAt(OPENS_AT_MS + 300);
  tape.push(events.tickSizeChanged({ marketId: MARKET_X, instrumentId: YES, newTickSize: 0.01, sourceTimestampMs: OPENS_AT_MS + 250 }));

  // Shared-наблюдения: от admission не зависят.
  events.observeAt(OPENS_AT_MS + 400);
  tape.push(events.bookDepth({ venueId: BINANCE, instrumentId: BTC_USDT, bid: 0.5, sourceTimestampMs: OPENS_AT_MS + 350 }));
  events.observeAt(OPENS_AT_MS + 500);
  tape.push(events.referencePrice({ sourceId: SOURCE, baseAsset: asset('BTC'), quoteAsset: asset('USD'), nativeSymbol: 'BTCUSD', feed: { kind: 'TWAP', windowSeconds: 30 }, value: 70_000, venueTimestampMs: OPENS_AT_MS + 450, receivedAtMs: OPENS_AT_MS + 480 }));

  // Остановка торговли: тяжёлые ряды освобождаются.
  events.observeAt(OPENS_AT_MS + 1_000);
  tape.push(events.marketTradingClosed(MARKET_X));

  // Поздние наблюдения — игнорируются, версию не двигают.
  events.observeAt(OPENS_AT_MS + 1_100);
  tape.push(events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.42, sourceTimestampMs: OPENS_AT_MS + 1_050 }));

  // Резолюция и финализация.
  events.observeAt(OPENS_AT_MS + 2_000);
  tape.push(events.marketResolved(resolvedMarket(admitted, 1)));
  events.observeAt(OPENS_AT_MS + 3_000);
  tape.push(events.marketFinalized(MARKET_X));

  return tape;
}

/** Применяет ленту к свежему состоянию. */
async function project(tape: readonly EventBusEvent[]): Promise<TradingHotStateView> {
  const bus = new EventBus(silentLogger);
  const created = TradingStateProjector.create(bus, retention(), new PaperClock(new Date(0)));
  if (isErr(created)) throw created.error;
  created.value.start();
  for (const event of tape) await bus.publish(event);
  return created.value.state();
}

/**
 * Снимает читаемый срез состояния для сравнения.
 *
 * @remarks
 * Включает и retained-часть (рынок, жизненный цикл, структурный состав
 * инструментов), и активные ряды: расхождение возможно в любой из них.
 */
function snapshot(view: TradingHotStateView): unknown {
  return {
    version: view.getVersion(),
    markets: view.marketIds().map((marketId) => {
      const runtimeMarket = view.getMarket(marketId);
      return {
        marketId,
        market: {
          id: runtimeMarket?.market.id,
          venueId: runtimeMarket?.market.venueId,
          question: runtimeMarket?.market.question,
          startsAt: runtimeMarket?.market.startsAt.toNumber(),
          expiresAt: runtimeMarket?.market.expiresAt.toNumber(),
          venueStatus: runtimeMarket?.market.state.status,
          winner: runtimeMarket?.market.resolvedOutcome?.instrumentId,
        },
        lifecycle: {
          status: runtimeMarket?.lifecycle.status,
          admittedAt: runtimeMarket?.lifecycle.admittedAt.toNumber(),
          activatedAt: runtimeMarket?.lifecycle.activatedAt?.toNumber(),
          tradingClosedAt: runtimeMarket?.lifecycle.tradingClosedAt?.toNumber(),
          resolvedAt: runtimeMarket?.lifecycle.resolvedAt?.toNumber(),
          finalizedAt: runtimeMarket?.lifecycle.finalizedAt?.toNumber(),
        },
        // Структурный состав инструментов не зависит от освобождения рядов.
        structuralInstruments: runtimeMarket?.instrumentIds(),
        owners: runtimeMarket?.instrumentIds().map((instrumentId) => [
          instrumentId,
          view.getMarketForInstrument(instrumentId),
        ]),
        retainedInstruments: runtimeMarket?.instrumentIds().map((instrumentId) => {
          const instrument = runtimeMarket.getInstrument(instrumentId);
          return {
            instrumentId,
            retained: instrument !== undefined,
            books: instrument?.books.getAll().map((o) => o.observedAt.toNumber()),
            trades: instrument?.publicTrades.getAll().map((o) => [o.side, o.size.toNumber(), o.observedAt.toNumber()]),
            tickSize: instrument?.tickSize?.tickSize.value().toString(),
          };
        }),
      };
    }),
    shared: view.sharedVenueIds().map((venueId) => ({
      venueId,
      books: view.getSharedInstrument(venueId, BTC_USDT)?.books.getAll().map((o) => o.observedAt.toNumber()),
    })),
    referencePrices: view.referencePriceSeriesKeys().map((key) => ({
      key,
      values: view.getReferencePriceSeries(key)?.getAll().map((o) => [o.value.value().toString(), o.observedAt.toNumber()]),
    })),
  };
}

describe('AA. Детерминизм проекции', () => {
  it('одна лента даёт одинаковое состояние в двух независимых прогонах', async () => {
    const tape = buildTape();

    const first = snapshot(await project(tape));
    const second = snapshot(await project(tape));

    expect(second).toEqual(first);
  });

  it('версия равна числу ПРИНЯТЫХ мутаций, а не длине ленты', async () => {
    const tape = buildTape();
    const view = await project(tape);

    // 13 событий: одно из них — поздний BOOK_DEPTH после остановки торгов,
    // и он намеренно проигнорирован.
    expect(tape).toHaveLength(13);
    expect(view.getVersion()).toBe(12);
  });

  it('после полного цикла остаётся retained compact market', async () => {
    const view = await project(buildTape());
    const state = view.getMarket(MARKET_X);

    expect(state?.lifecycle.status).toBe('FINALIZED');
    expect(state?.market.resolvedOutcome?.instrumentId).toBe(NO);
    // Структура на месте, тяжёлые ряды освобождены.
    expect(state?.instrumentIds()).toEqual([YES, NO]);
    expect(state?.getInstrument(YES)).toBeUndefined();
    expect(state?.getInstrument(NO)).toBeUndefined();
    expect(view.getMarketForInstrument(YES)).toBe(MARKET_X);
    // Shared-данные жизненным циклом рынка не затронуты.
    expect(view.getSharedInstrument(BINANCE, BTC_USDT)?.books.size()).toBe(1);
    expect(view.referencePriceSeriesKeys()).toHaveLength(1);
  });
});
