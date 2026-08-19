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
import type { ExternalMessage } from '@polymarket/external-messages';
import type { DataRecorder } from '@polymarket/data-collection';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import type {
  PolymarketRecordingBusSubscription,
  PolymarketRecordingStorage,
} from '../src/index.js';

/** Будущее CEX-сообщение (эскиз PART 26) — В N-002 НЕ реализуется. */
type FutureCexExternalMessage = ExternalMessage<
  'CEX_ORDERBOOK',
  { readonly exchange: string; readonly symbol: string; readonly bids: readonly unknown[] }
>;

describe('future contour widening (PART 26)', () => {
  it('bus с расширенным union присваивается порту подписки recorder-а без кастов', () => {
    // ONE ExternalMessageBus на все sources контура:
    const widenedBus = new ExternalMessageBus<
      PolymarketExternalMessage | FutureCexExternalMessage
    >();

    // Recorder подписывается на свои типы через тот же порт — компилируется
    // без as/any: typed subscribe контравариантен по union сообщения.
    const subscription: PolymarketRecordingBusSubscription = widenedBus;

    const dispose = subscription.subscribe('POLYMARKET_MARKET', (message) => {
      // Narrowing сохранён: payload — StandardMarketEvent, доступен vendor topic
      const topic: 'market' = message.payload.topic;
      void topic;
    });
    dispose();
    expect(typeof dispose).toBe('function');
  });
});

describe('storage port (PART 1)', () => {
  it('реальный DataRecorder структурно удовлетворяет PolymarketRecordingStorage', () => {
    // Compile-time: подмножество методов DataRecorder — без адаптера/обёртки
    const accepts = (storage: PolymarketRecordingStorage): PolymarketRecordingStorage => storage;
    const acceptsDataRecorder: (recorder: DataRecorder) => PolymarketRecordingStorage = accepts;
    expect(typeof acceptsDataRecorder).toBe('function');
  });
});
