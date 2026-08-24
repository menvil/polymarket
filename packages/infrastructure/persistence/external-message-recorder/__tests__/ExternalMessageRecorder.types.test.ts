/**
 * Type-contract тесты recorder-а (PART 26/37/38 N-002).
 *
 * @remarks
 * Compile-time проверки (typecheck/ts-jest):
 * - порт подписки принимает bus с БОЛЕЕ ШИРОКИМ union-ом sources — будущий
 *   CexSource расширяет union контура БЕЗ второго Recorder service и без
 *   второго bus;
 * - реальный `DataRecorder` удовлетворяет storage-порту без адаптеров;
 * - typed handlers recorder-а получают narrowing payload (без any/unknown).
 */
import { describe, it, expect } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import type { CexWindowRecorder, DataRecorder } from '@polymarket/data-collection';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import type { CexExternalMessage } from '@polymarket/cex-v2';
import type {
  CexRecordingBusSubscription,
  CexRecordingStorage,
  PolymarketRecordingBusSubscription,
  PolymarketRecordingStorage,
} from '../src/index.js';

describe('contour widening (PART 26, реализовано в N-005)', () => {
  it('ОДИН bus с union Polymarket|CEX присваивается обоим портам подписки без кастов', () => {
    // ONE ExternalMessageBus на все sources контура (обещание N-002,
    // materialized N-005: эскиз FutureCexExternalMessage заменён реальным типом):
    const widenedBus = new ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>();

    // Recorder подписывается на свои типы через оба порта — компилируется
    // без as/any: typed subscribe контравариантен по union сообщения.
    const polymarketSubscription: PolymarketRecordingBusSubscription = widenedBus;
    const cexSubscription: CexRecordingBusSubscription = widenedBus;

    const disposeMarket = polymarketSubscription.subscribe('POLYMARKET_MARKET', (message) => {
      // Narrowing сохранён: payload — StandardMarketEvent, доступен vendor topic
      const topic: 'market' = message.payload.topic;
      void topic;
    });
    const disposeCex = cexSubscription.subscribe('CEX_ORDERBOOK', (message) => {
      // Narrowing сохранён: payload — CexOrderbookPayload с vendor-снапшотом
      const exchangeId: string = message.payload.exchangeId;
      const bids = message.payload.orderBook.bids;
      void exchangeId;
      void bids;
    });
    disposeMarket();
    disposeCex();
    expect(typeof disposeMarket).toBe('function');
    expect(typeof disposeCex).toBe('function');
  });
});

describe('storage ports (PART 1 / N-005)', () => {
  it('реальный DataRecorder структурно удовлетворяет PolymarketRecordingStorage', () => {
    // Compile-time: подмножество методов DataRecorder — без адаптера/обёртки
    const accepts = (storage: PolymarketRecordingStorage): PolymarketRecordingStorage => storage;
    const acceptsDataRecorder: (recorder: DataRecorder) => PolymarketRecordingStorage = accepts;
    expect(typeof acceptsDataRecorder).toBe('function');
  });

  it('реальный CexWindowRecorder структурно удовлетворяет CexRecordingStorage', () => {
    const accepts = (storage: CexRecordingStorage): CexRecordingStorage => storage;
    const acceptsWindowRecorder: (recorder: CexWindowRecorder) => CexRecordingStorage = accepts;
    expect(typeof acceptsWindowRecorder).toBe('function');
  });
});
