/**
 * Паритет «live raw» и «replayed raw» на одном semantic-преобразовании.
 *
 * @remarks
 * Replay Reader в этом MR НЕ реализуется. Но инвариант, от которого он
 * будет зависеть, можно и нужно зафиксировать уже сейчас: если взять
 * ЗАПИСАННЫЙ source-native payload (то, что recorder кладёт в JSONL),
 * пересобрать из него `ExternalMessage` и прогнать через ТОТ ЖЕ адаптер —
 * финансовые и доменные значения обязаны совпасть с live-прогоном.
 *
 * Расхождение здесь означало бы, что бэктест считает не то, что торговля.
 */
import { describe, expect, it } from '@jest/globals';
import type { EventBusEvent } from '@polymarket/event-bus';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import {
  MARKET_ID,
  TOKEN_A,
  TOKEN_B,
  createHarness,
  publishBook,
  publishLastTradePrice,
  publishPriceChange,
  publishReferencePrice,
  type Harness,
} from './support/fixtures.js';

/**
 * Проецирует semantic-события в сравнимый доменный слепок.
 *
 * @param events - Опубликованные события
 * @returns Значения, которые обязаны совпасть между live и replay
 *
 * @remarks
 * В слепок НЕ входят `messageId`/`sequence`/`runId`: они уникальны для
 * каждого прогона by design. Сравнивается ровно то, от чего зависит
 * торговое решение.
 */
function project(events: readonly EventBusEvent[]): unknown[] {
  return events.map((event) => {
    switch (event.type) {
      case 'BOOK_DEPTH':
        return {
          type: event.type,
          instrumentId: String(event.payload.instrumentId),
          bids: event.payload.snapshot.bids.map((level) => [
            level.price.value().toString(),
            level.quantity.value().toString(),
          ]),
          asks: event.payload.snapshot.asks.map((level) => [
            level.price.value().toString(),
            level.quantity.value().toString(),
          ]),
          venueTimestamp: event.payload.snapshot.venueTimestamp?.toNumber(),
          timestamp: event.payload.timestamp.toNumber(),
        };
      case 'BOOK_UPDATED':
        return {
          type: event.type,
          instrumentId: String(event.payload.instrumentId),
          marketId: String(event.payload.marketId),
          bestBid: event.payload.topOfBook.bestBid?.value().toString(),
          bestAsk: event.payload.topOfBook.bestAsk?.value().toString(),
          bestBidSize: event.payload.topOfBook.bestBidSize?.value().toString(),
          bestAskSize: event.payload.topOfBook.bestAskSize?.value().toString(),
          sequenceNumber: event.payload.sequenceNumber,
          timestamp: event.payload.timestamp.toNumber(),
        };
      case 'TRADE_RECEIVED':
        return {
          type: event.type,
          instrumentId: String(event.payload.instrumentId),
          price: event.payload.price.value().toString(),
          size: event.payload.size.value().toString(),
          side: event.payload.side,
          timestamp: event.payload.timestamp.toNumber(),
        };
      case 'TICK_SIZE_CHANGED':
        return {
          type: event.type,
          instrumentId: String(event.payload.instrumentId),
          oldTickSize: event.payload.oldTickSize?.value().toString(),
          newTickSize: event.payload.newTickSize.value().toString(),
        };
      case 'REFERENCE_PRICE_UPDATED':
        return {
          type: event.type,
          sourceId: String(event.payload.sourceId),
          symbol: event.payload.symbol,
          feed: event.payload.feed,
          value: event.payload.value.value().toString(),
          venueTimestamp: event.payload.venueTimestamp.toNumber(),
        };
      default:
        return { type: event.type };
    }
  });
}

/**
 * Прогоняет записанные payload через новый адаптер, как это сделает replay.
 *
 * @param recorded - Payload наблюдений в том виде, в каком они лежат в архиве
 * @returns Доменный слепок semantic-выхода
 *
 * @remarks
 * Сообщение пересобирается из payload и СВЕЖЕЙ metadata — ровно так и
 * поведёт себя Reader: сырой payload он читает из файла, а identity
 * доставки создаёт заново.
 */
async function replay(recorded: readonly unknown[]): Promise<unknown[]> {
  const h = createHarness();
  for (const payload of recorded) {
    await h.bus.publish({
      type: (payload as { __type: string }).__type,
      payload: (payload as { __payload: unknown }).__payload,
      metadata: h.metadataGenerator.nextRoot(),
    } as unknown as PolymarketExternalMessage);
  }
  const projected = project(h.published);
  h.adapter.close();
  return projected;
}

/**
 * Сериализует raw-сообщения так, как их сохраняет recorder (payload-only).
 *
 * @param messages - Live raw-сообщения
 * @returns JSON round-trip записанных payload
 */
function persist(messages: readonly PolymarketExternalMessage[]): unknown[] {
  return messages.map(
    (message) =>
      JSON.parse(
        JSON.stringify({ __type: message.type, __payload: message.payload }),
      ) as unknown,
  );
}

describe('live raw и replayed raw дают одинаковое semantic-преобразование', () => {
  it('стакан, дельты, трейд, тик и референсные цены совпадают значение в значение', async () => {
    const live: Harness = createHarness();
    const rawMessages: PolymarketExternalMessage[] = [];

    rawMessages.push(
      await publishBook(live, {
        tokenId: TOKEN_A,
        bids: [
          { price: '0.123456789', size: '0.000000001' },
          { price: '0.50', size: '10' },
        ],
        asks: [{ price: '0.52', size: '7.5' }],
        timestamp: 1_787_751_722_763,
      }),
    );
    rawMessages.push(
      await publishBook(live, {
        tokenId: TOKEN_B,
        bids: [{ price: '0.30', size: '5' }],
        asks: [{ price: '0.32', size: '6' }],
        timestamp: 1_787_751_722_800,
      }),
    );
    rawMessages.push(
      await publishPriceChange(live, {
        changes: [
          { tokenId: TOKEN_A, price: '0.50', size: '25', side: 'BUY' },
          { tokenId: TOKEN_B, price: '0.32', size: '0', side: 'SELL' },
        ],
        timestamp: 1_787_751_723_000,
      }),
    );
    rawMessages.push(
      await publishLastTradePrice(live, {
        tokenId: TOKEN_A,
        price: '0.5125',
        size: '12.345678',
        side: 'SELL',
        timestamp: 1_787_751_724_000,
      }),
    );
    rawMessages.push(
      await publishReferencePrice(live, {
        channel: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
        symbol: 'btc/usd',
        value: '78376.356031481042173952',
        windowSeconds: 60,
        timestamp: 1_787_751_721_000,
      }),
    );

    const liveProjection = project(live.published);
    live.adapter.close();

    const replayed = await replay(persist(rawMessages));

    expect(replayed).toEqual(liveProjection);
    // Слепок непустой — иначе тест доказывал бы равенство «ничего с ничем»
    expect(liveProjection.length).toBeGreaterThan(5);
  });

  it('desync/resync воспроизводится по записанным данным идентично', async () => {
    const live = createHarness();
    const rawMessages: PolymarketExternalMessage[] = [];

    rawMessages.push(
      await publishBook(live, {
        tokenId: TOKEN_A,
        bids: [{ price: '0.50', size: '10' }],
        asks: [{ price: '0.52', size: '7' }],
      }),
    );
    rawMessages.push(
      await publishPriceChange(live, {
        changes: [
          {
            tokenId: TOKEN_A,
            price: '0.49',
            size: '5',
            side: 'BUY',
            bestBid: '0.51',
            bestAsk: '0.52',
          },
        ],
      }),
    );
    rawMessages.push(
      await publishBook(live, {
        tokenId: TOKEN_A,
        bids: [{ price: '0.51', size: '9' }],
        asks: [{ price: '0.53', size: '4' }],
      }),
    );

    const liveProjection = project(live.published);
    const liveStats = live.adapter.getStats();
    live.adapter.close();

    const replayed = await replay(persist(rawMessages));
    expect(replayed).toEqual(liveProjection);
    expect(liveStats.desyncs).toBe(1);
    expect(liveStats.resyncs).toBe(1);
  });

  it('идентификаторы доставки НЕ совпадают — совпадают именно доменные значения', async () => {
    const live = createHarness();
    const raw = await publishBook(live, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [],
    });
    const liveMessageIds = live.published.map((event) => String(event.metadata.messageId));
    const liveProjection = project(live.published);
    live.adapter.close();

    const h = createHarness();
    const persisted = persist([raw])[0] as { __type: string; __payload: unknown };
    await h.bus.publish({
      type: persisted.__type,
      payload: persisted.__payload,
      metadata: h.metadataGenerator.nextRoot(),
    } as unknown as PolymarketExternalMessage);

    expect(project(h.published)).toEqual(liveProjection);
    expect(h.published.map((event) => String(event.metadata.messageId))).not.toEqual(
      liveMessageIds,
    );
    h.adapter.close();
  });
});

describe('записанный payload остаётся source-native', () => {
  it('в архив уходят исходные строки vendor-а, а не наши VO', async () => {
    const live = createHarness();
    const raw = await publishBook(live, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [],
      market: MARKET_ID,
    });
    live.adapter.close();

    const persisted = persist([raw])[0] as {
      __payload: { payload: { bids: { price: unknown; size: unknown }[] } };
    };
    expect(persisted.__payload.payload.bids[0]!.price).toBe('0.50');
    expect(persisted.__payload.payload.bids[0]!.size).toBe('10');
  });
});
