/**
 * Главный ordering-инвариант N-003 (PART 36): recorder-регистрация существует
 * ДО открытия market-подписки, поэтому даже событие, пришедшее МГНОВЕННО
 * после subscribe, маршрутизируется и записывается.
 *
 * @remarks
 * End-to-end с РЕАЛЬНЫМИ компонентами data plane:
 * настоящий `ExternalMessageBus`, настоящий `ExternalMessageRecorder`
 * (fake — только storage и границы SDK). Fake source публикует первое
 * событие в bus СИНХРОННО ВНУТРИ `subscribeMarket`, до разрешения промиса —
 * жёстче реального транспорта.
 */
import { describe, it, expect } from '@jest/globals';
import { LiveClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import type {
  CryptoPricesBinanceEvent,
  PolymarketExternalMessage,
  StandardMarketEvent,
} from '@polymarket/polymarket-v2';
import type { MarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import { MarketCollectionCoordinator } from '../src/index.js';
import {
  CID_A,
  CID_B,
  CapturingLogger,
  FakeCollectionSource,
  FakeDiscovery,
  FixedClock,
  TOKEN_UP,
  flushAsync,
} from './helpers/fakes.js';

/** Минимальный in-memory storage порта recorder-а (диск не участвует). */
class MemoryStorage {
  public readonly registered: MarketMeta[] = [];
  public readonly writes: Array<{ marketId: string; payload: unknown }> = [];
  public readonly finalized: string[] = [];

  public registerMarket(meta: MarketMeta): boolean {
    this.registered.push(meta);
    return true;
  }

  public recordMarketEvent(marketId: MarketId, rawEvent: unknown): 'recorded' {
    this.writes.push({ marketId: String(marketId), payload: rawEvent });
    return 'recorded';
  }

  public async updateMarketMeta(): Promise<void> {
    // no-op
  }

  public async finalizeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    this.finalized.push(`${String(marketId)}:${reason}`);
  }

  public async flush(): Promise<void> {
    // no-op
  }

  public async cleanup(): Promise<void> {
    // no-op
  }

  public async close(): Promise<void> {
    // no-op
  }
}

/** SDK-событие `book` для рынка (форма output SDK-схемы, один `as`). */
function createBookEvent(conditionId: string): StandardMarketEvent {
  return {
    topic: 'market',
    type: 'book',
    payload: {
      market: conditionId,
      tokenId: TOKEN_UP,
      bids: [{ price: '0.48', size: '30' }],
      asks: [{ price: '0.52', size: '25' }],
      hash: 'first-book-hash',
      timestamp: Date.now(),
    },
  } as unknown as StandardMarketEvent;
}

/** SDK-событие RTDS Binance (форма output SDK-схемы, один `as`). */
function createBinanceEvent(symbol: string): CryptoPricesBinanceEvent {
  return {
    topic: 'prices.crypto.binance',
    type: 'update',
    timestamp: Date.now(),
    payload: { symbol, timestamp: Date.now(), value: '65000.5' },
  } as unknown as CryptoPricesBinanceEvent;
}

describe('первое сообщение не потеряно (PART 36)', () => {
  it('событие, опубликованное ВНУТРИ subscribeMarket, маршрутизируется в storage', async () => {
    const logger = new CapturingLogger();
    const bus = new ExternalMessageBus<PolymarketExternalMessage>();
    const generator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const storage = new MemoryStorage();
    const recorder = new ExternalMessageRecorder({ bus, storage, logger });
    recorder.start();

    const discovery = new FakeDiscovery();
    const source = new FakeCollectionSource();
    const bookEvent = createBookEvent(CID_A);
    // Первое событие рынка прилетает ДО разрешения subscribeMarket.
    // Исход публикации фиксируется во внешней переменной: matcher-исключение
    // внутри hook-а попало бы в error-handling subscribeMarket координатора.
    let firstPublishOk: boolean | undefined;
    source.onSubscribeMarket = async () => {
      const publishResult = await bus.publish({
        type: 'POLYMARKET_MARKET',
        payload: bookEvent,
        metadata: generator.nextRoot(),
      });
      firstPublishOk = publishResult.ok;
    };

    const coordinator = new MarketCollectionCoordinator(
      { discovery, source, recorder, clock: new FixedClock(), logger },
      { maxMarkets: 1 },
    );
    try {
      const candidate = discovery.addMarket({ conditionId: CID_A });

      const outcome = await coordinator.openMarket(candidate);
      expect(outcome).toBe('opened');
      await flushAsync();

      expect(firstPublishOk).toBe(true);
      // Recorder-регистрация уже существовала: событие маршрутизировано, не потеряно
      const stats = recorder.getStats();
      expect(stats.unroutedMarketMessages).toBe(0);
      expect(stats.marketMessagesRouted).toBe(1);
      expect(storage.writes).toEqual([{ marketId: CID_A, payload: bookEvent }]);
      // На диск ушёл САМ payload (без outer envelope) — та же ссылка
      expect(storage.writes[0]!.payload).toBe(bookEvent);
    } finally {
      // Teardown гарантирован и при упавших ассертах — jest не зависает
      await coordinator.close();
      await recorder.close();
      await bus.close();
    }
  });

  it('recorder независимо fan-out-ит один RTDS-фид в файлы обоих рынков (PART 19/39)', async () => {
    const logger = new CapturingLogger();
    const bus = new ExternalMessageBus<PolymarketExternalMessage>();
    const generator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const storage = new MemoryStorage();
    const recorder = new ExternalMessageRecorder({ bus, storage, logger });
    recorder.start();

    const discovery = new FakeDiscovery();
    const source = new FakeCollectionSource();
    const coordinator = new MarketCollectionCoordinator(
      { discovery, source, recorder, clock: new FixedClock(), logger },
      { maxMarkets: 2 },
    );
    try {
      await coordinator.openMarket(discovery.addMarket({ conditionId: CID_A }));
      await coordinator.openMarket(discovery.addMarket({ conditionId: CID_B }));

      // Один нижележащий фид (координатор ref-count-ит source-подписки)
      expect(source.subscribeCryptoCalls.filter((c) => c.includes('btcusdt'))).toHaveLength(1);

      // Одно RTDS-наблюдение → строка в файле КАЖДОГО подписанного рынка
      const rtdsEvent = createBinanceEvent('btcusdt');
      const publishResult = await bus.publish({
        type: 'POLYMARKET_CRYPTO_BINANCE',
        payload: rtdsEvent,
        metadata: generator.nextRoot(),
      });
      expect(publishResult.ok).toBe(true);
      await flushAsync();

      const rtdsWrites = storage.writes.filter((write) => write.payload === rtdsEvent);
      expect(rtdsWrites.map((write) => write.marketId).sort()).toEqual([CID_A, CID_B].sort());

      // Закрытие одного рынка не лишает фида второй (recorder-routing)
      await coordinator.closeSession(discovery.candidates[0]!.marketId, 'SHUTDOWN');
      const secondEvent = createBinanceEvent('btcusdt');
      await bus.publish({
        type: 'POLYMARKET_CRYPTO_BINANCE',
        payload: secondEvent,
        metadata: generator.nextRoot(),
      });
      await flushAsync();
      const secondWrites = storage.writes.filter((write) => write.payload === secondEvent);
      expect(secondWrites.map((write) => write.marketId)).toEqual([CID_B]);
    } finally {
      // Teardown гарантирован и при упавших ассертах — jest не зависает
      await coordinator.close();
      await recorder.close();
      await bus.close();
    }
  });
});
