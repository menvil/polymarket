/**
 * Детерминизм проекции.
 *
 * @remarks
 * Проверяется одно утверждение: состояние — функция ПОСЛЕДОВАТЕЛЬНОСТИ
 * canonical-событий, и ничего больше. Если бы где-то в пути остался
 * `Date.now()`, живой прогон и повтор той же ленты разошлись бы, а значит
 * бэктест перестал бы соответствовать торговле.
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
  POLYMARKET,
  YES,
  asset,
  retention,
  silentLogger,
} from './helpers/fixtures.js';

const SOURCE = 'chainlink' as MarketDataSourceId;

/** Строит одну и ту же ленту событий — порядок и времена зафиксированы. */
function buildTape(): readonly EventBusEvent[] {
  const events = new EventFactory();
  const tape: EventBusEvent[] = [];

  events.observeAt(1_000);
  tape.push(events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.4, sourceTimestampMs: 900 }));
  events.observeAt(1_100);
  tape.push(events.bookDepth({ venueId: POLYMARKET, instrumentId: YES, marketId: MARKET_X, bid: 0.41, sourceTimestampMs: 1_000 }));
  events.observeAt(1_200);
  tape.push(events.bookDepth({ venueId: POLYMARKET, instrumentId: NO, marketId: MARKET_X, bid: 0.59, sourceTimestampMs: 1_100 }));
  events.observeAt(1_300);
  tape.push(events.tradeReceived({ venueId: POLYMARKET, instrumentId: NO, marketId: MARKET_X, price: 0.6, size: 3, side: 'SELL', sourceTimestampMs: 1_250 }));
  events.observeAt(1_400);
  tape.push(events.bookDepth({ venueId: BINANCE, instrumentId: BTC_USDT, bid: 0.5, sourceTimestampMs: 1_350 }));
  events.observeAt(1_500);
  tape.push(events.referencePrice({ sourceId: SOURCE, baseAsset: asset('BTC'), quoteAsset: asset('USD'), nativeSymbol: 'BTCUSD', feed: { kind: 'TWAP', windowSeconds: 30 }, value: 70_000, venueTimestampMs: 1_450, receivedAtMs: 1_480 }));
  events.observeAt(1_600);
  tape.push(events.tickSizeChanged({ marketId: MARKET_X, instrumentId: YES, newTickSize: 0.01, sourceTimestampMs: 1_550 }));

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

/** Снимает читаемый срез состояния для сравнения. */
function snapshot(view: TradingHotStateView): unknown {
  return {
    version: view.getVersion(),
    markets: view.marketIds().map((marketId) => {
      const market = view.getMarket(marketId);
      return {
        marketId,
        instruments: market?.instrumentIds().map((instrumentId) => {
          const instrument = market.getInstrument(instrumentId);
          return {
            instrumentId,
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

describe('Детерминизм проекции', () => {
  it('одна лента даёт одинаковое состояние в двух независимых прогонах', async () => {
    const tape = buildTape();

    const first = snapshot(await project(tape));
    const second = snapshot(await project(tape));

    expect(second).toEqual(first);
  });

  it('версия равна числу принятых наблюдений', async () => {
    const tape = buildTape();
    const view = await project(tape);

    expect(tape).toHaveLength(7);
    expect(view.getVersion()).toBe(7);
  });
});
