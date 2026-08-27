/**
 * Эквивалентность live-формы и replay-формы наблюдения.
 *
 * @remarks
 * ### Что именно доказывается
 *
 * Адаптер обязан давать ОДНИ И ТЕ ЖЕ semantic-значения независимо от того,
 * пришло наблюдение прямо из `CexSource` или было прочитано из записанного
 * архива. Иначе backtest считал бы не то, что торговля.
 *
 * Replay-engine здесь НЕ строится (это не задача MR): берётся настоящая
 * строка записанного JSONL и из неё собирается `ExternalMessage` той же
 * формы, что даёт live-путь. Recorder пишет ИМЕННО payload (formatVersion 2),
 * поэтому реконструкция сводится к `JSON.parse(line)` + свежая metadata —
 * ровно то, что будет делать будущий reader.
 *
 * ### Откуда фикстура
 *
 * `support/recorded-cex-payloads.jsonl` — дословные строки из архива
 * прогона checkpoint-а `2026-08-25T14-26-41-194Z-full` (6 бирж, spot). Это
 * не сочинённые данные: там ровно те JS-числа, которые отдал CCXT и
 * записал recorder.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { EventBus } from '@polymarket/event-bus';
import type { EventBusEvent } from '@polymarket/event-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import type { CexExternalMessage } from '@polymarket/cex-v2';
import type { BookDepthEvent, TradeReceivedEvent } from '@polymarket/application-events';
import type { AssetPrice } from '@polymarket/value-objects';
import { CexSemanticAdapter } from '../src/index.js';
import { silentLogger } from './support/fixtures.js';

/** Одна записанная строка архива: payload наблюдения как его пишет recorder. */
type RecordedPayload = Record<string, unknown>;

/** Читает фикстуру записанных payload-ов. */
function readRecordedPayloads(): RecordedPayload[] {
  const path = join(__dirname, 'support', 'recorded-cex-payloads.jsonl');
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedPayload);
}

/** Прогоняет payload через адаптер и возвращает все полученные события. */
async function runThroughAdapter(
  payloads: readonly RecordedPayload[],
): Promise<EventBusEvent[]> {
  const bus = new ExternalMessageBus<CexExternalMessage>();
  const eventBus = new EventBus(silentLogger());
  const metadataGenerator = new MessageMetadataGenerator({ clock: new LiveClock() });
  const published: EventBusEvent[] = [];
  for (const type of ['BOOK_DEPTH', 'BOOK_UPDATED', 'TRADE_RECEIVED'] as const) {
    eventBus.subscribe(type, (event) => {
      published.push(event);
    });
  }

  const adapter = new CexSemanticAdapter({
    bus,
    eventBus,
    metadataGenerator,
    logger: silentLogger(),
  });
  adapter.start();

  for (const payload of payloads) {
    await bus.publish({
      type: ('orderBook' in payload ? 'CEX_ORDERBOOK' : 'CEX_TRADE') as 'CEX_ORDERBOOK',
      payload: payload as never,
      metadata: metadataGenerator.nextRoot(),
    });
  }

  adapter.close();
  return published;
}

/** Сводка финансовых значений события — то, что обязано совпасть. */
function financialFingerprint(event: EventBusEvent): unknown {
  if (event.type === 'BOOK_DEPTH') {
    const depth = event as BookDepthEvent<AssetPrice>;
    const book = depth.payload.snapshot;
    return {
      type: depth.type,
      venueId: depth.payload.venueId,
      instrumentId: depth.payload.instrumentId,
      marketId: depth.payload.marketId,
      timestamp: depth.payload.timestamp.toNumber(),
      venueTimestamp: book.venueTimestamp?.toNumber(),
      bids: book.bids.map((l) => [l.price.value().toString(), l.quantity.value().toString()]),
      asks: book.asks.map((l) => [l.price.value().toString(), l.quantity.value().toString()]),
    };
  }
  if (event.type === 'TRADE_RECEIVED') {
    const trade = event as TradeReceivedEvent<AssetPrice>;
    return {
      type: trade.type,
      venueId: trade.payload.venueId,
      instrumentId: trade.payload.instrumentId,
      marketId: trade.payload.marketId,
      venueTradeId: trade.payload.venueTradeId,
      price: trade.payload.price.value().toString(),
      size: trade.payload.size.value().toString(),
      side: trade.payload.side,
      timestamp: trade.payload.timestamp.toNumber(),
    };
  }
  return { type: event.type };
}

describe('эквивалентность live- и replay-формы наблюдения', () => {
  it('записанные payload-ы дают semantic-события со всех бирж фикстуры', async () => {
    const payloads = readRecordedPayloads();
    expect(payloads.length).toBeGreaterThanOrEqual(7);

    const events = await runThroughAdapter(payloads);
    const venues = new Set(
      events.map((event) => String((event.payload as { venueId?: unknown }).venueId)),
    );
    expect(venues).toEqual(new Set(['BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'COINBASE']));
  });

  it('одинаковые значения независимо от формы сообщения', async () => {
    const payloads = readRecordedPayloads();

    // «Live-форма»: тот же payload, который source публикует напрямую
    const live = await runThroughAdapter(payloads);
    // «Replay-форма»: payload, прошедший сериализацию архива и обратно
    const replayed = payloads.map(
      (payload) => JSON.parse(JSON.stringify(payload)) as RecordedPayload,
    );
    const replay = await runThroughAdapter(replayed);

    expect(replay.map(financialFingerprint)).toEqual(live.map(financialFingerprint));
  });

  it('цены записанного стакана переносятся в canonical книгу дословно', async () => {
    const [binanceBook] = readRecordedPayloads();
    expect(binanceBook).toBeDefined();
    const events = await runThroughAdapter([binanceBook!]);

    const depth = events.find((e) => e.type === 'BOOK_DEPTH') as
      | BookDepthEvent<AssetPrice>
      | undefined;
    expect(depth).toBeDefined();

    const raw = binanceBook as unknown as {
      orderBook: { bids: [number, number][]; asks: [number, number][]; timestamp: number };
    };
    const book = depth!.payload.snapshot;

    // Лучшие уровни архива и canonical-книги — одно значение
    expect(book.getBestBid()!.value().toNumber()).toBe(raw.orderBook.bids[0]![0]);
    expect(book.getBestAsk()!.value().toNumber()).toBe(raw.orderBook.asks[0]![0]);
    expect(book.bids[0]!.quantity.value().toNumber()).toBe(raw.orderBook.bids[0]![1]);
    expect(book.venueTimestamp!.toNumber()).toBe(raw.orderBook.timestamp);
    // Глубина сохранена целиком, ни один уровень не потерян
    expect(book.bids).toHaveLength(raw.orderBook.bids.length);
    expect(book.asks).toHaveLength(raw.orderBook.asks.length);
  });

  it('поля записанной сделки переносятся в canonical событие дословно', async () => {
    const payloads = readRecordedPayloads();
    const recordedTrades = payloads.filter((p) => 'trade' in p);
    expect(recordedTrades.length).toBeGreaterThanOrEqual(4);

    const events = await runThroughAdapter(recordedTrades);
    const published = events.filter(
      (e): e is TradeReceivedEvent<AssetPrice> => e.type === 'TRADE_RECEIVED',
    );
    expect(published).toHaveLength(recordedTrades.length);

    recordedTrades.forEach((payload, index) => {
      const raw = (payload as { trade: Record<string, unknown> }).trade;
      const event = published[index]!;
      expect(event.payload.venueTradeId).toBe(String(raw['id']));
      expect(event.payload.price.value().toNumber()).toBe(raw['price']);
      expect(event.payload.size.value().toNumber()).toBe(raw['amount']);
      expect(event.payload.side).toBe(String(raw['side']).toUpperCase());
      expect(event.payload.timestamp.toNumber()).toBe(raw['timestamp']);
      // `cost` архива объёмом не становится ни при каких условиях
      expect(event.payload.size.value().toNumber()).not.toBe(raw['cost']);
    });
  });

  it('сверхмалый объём из архива не схлопывается в ноль', async () => {
    const payloads = readRecordedPayloads();
    // Реальная сделка coinbase: amount = 1e-8
    const tiny = payloads.find(
      (p) => 'trade' in p && (p as { trade: { amount?: unknown } }).trade.amount === 1e-8,
    );
    expect(tiny).toBeDefined();

    const events = await runThroughAdapter([tiny!]);
    const trade = events[0] as TradeReceivedEvent<AssetPrice>;
    expect(trade.payload.size.value().toString()).toBe('1e-8');
    expect(trade.payload.size.value().isZero()).toBe(false);
  });

  it('replay не мутирует прочитанный payload', async () => {
    const payloads = readRecordedPayloads();
    const before = JSON.stringify(payloads);
    await runThroughAdapter(payloads);
    expect(JSON.stringify(payloads)).toBe(before);
  });
});
