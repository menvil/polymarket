/**
 * Acceptance: биржевое market-data событие проходит через РЕАЛЬНУЮ шину.
 *
 * @remarks
 * Замыкает цепочку, начатую в `@polymarket/application-events`:
 *
 * ```text
 * Orderbook<AssetPrice> → BOOK_DEPTH → ApplicationEvent → IEventBus.publish()
 * ```
 *
 * Здесь проверяется последнее звено — что `EventBusEvent` (union доставки)
 * принимает событие биржевого домена и доставляет его подписчику. Без этого
 * теста «source-agnostic» оставался бы утверждением про типы контрактов, а
 * не про работающий путь публикации.
 */
import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import { AssetPrice, QuantityService } from '@polymarket/value-objects';
import { Orderbook, OrderbookLevel } from '@polymarket/orderbook';
import { TimestampService } from '@polymarket/timestamp';
import { asVenueId, unsafeInstrumentId } from '@polymarket/ids';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { BookDepthEvent } from '@polymarket/application-events';
import { EventBus, type IEventBus } from '../src/index.js';

const BINANCE = asVenueId('BINANCE')!;
const BTC_USDT = unsafeInstrumentId('BTC/USDT');

function silentLogger(): ILogger {
  const sink: ILogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => sink,
  };
  return sink;
}

describe('IEventBus принимает биржевое market-data событие', () => {
  it('Orderbook<AssetPrice> публикуется и доходит до подписчика', async () => {
    const at = TimestampService.create(1_787_751_722_763);
    const size = QuantityService.create('0.5');
    if (!at.ok || !size.ok) throw new Error('fixture');

    const bus: IEventBus = new EventBus(silentLogger());
    const metadata = new MessageMetadataGenerator({ clock: new LiveClock() });

    const received: string[] = [];
    bus.subscribe('BOOK_DEPTH', (event) => {
      received.push(event.payload.snapshot.getBestBid()?.value().toString() ?? '—');
    });

    const event: BookDepthEvent<AssetPrice> = {
      type: 'BOOK_DEPTH',
      payload: {
        venueId: BINANCE,
        instrumentId: BTC_USDT,
        snapshot: Orderbook.fromLevels({
          venueId: BINANCE,
          instrumentId: BTC_USDT,
          bids: [OrderbookLevel.create(AssetPrice.of(new Decimal('78468.50')), size.value)],
          asks: [],
          receivedAt: at.value,
        }),
        timestamp: at.value,
      },
      metadata: metadata.nextRoot(),
    };

    // Ключевая строка: publish принимает событие биржевого домена БЕЗ
    // приведений — union доставки source-agnostic наравне с контрактами
    const result = await bus.publish(event);

    expect(result.ok).toBe(true);
    expect(received).toEqual(['78468.5']);
  });
});
