/**
 * Type-contract тесты CEX-сообщений (N-005 PART 2/8/25 compile-time часть).
 *
 * @remarks
 * Проверки компилятора:
 * - ОДИН общий bus, параметризованный union-ом обоих sources, присваивается
 *   узким портам publish/subscribe БЕЗ кастов;
 * - typed-подписка сужает payload по discriminator-у (narrowing);
 * - payload несёт source-native снапшот + routing identity.
 */
import { describe, it, expect } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import type { ExternalMessage } from '@polymarket/external-messages';
import type {
  CexExternalMessage,
  CexExternalMessagePublisher,
  CexMarketType,
} from '../src/index.js';

/** Локальный эскиз Polymarket-сообщения — контур другого source. */
type SketchPolymarketMessage = ExternalMessage<
  'POLYMARKET_MARKET',
  { readonly topic: 'market'; readonly market: string }
>;

describe('один bus на все sources (PART 8/25)', () => {
  it('bus с union Polymarket|CEX присваивается CEX-портам без кастов', () => {
    const bus = new ExternalMessageBus<SketchPolymarketMessage | CexExternalMessage>();

    // Порт публикации source (контравариантность publish по union)
    const publisher: CexExternalMessagePublisher = bus;
    expect(typeof publisher.publish).toBe('function');

    // Typed-подписка recorder-а: narrowing по discriminator-у
    const disposeOb = bus.subscribe('CEX_ORDERBOOK', (message) => {
      const marketType: CexMarketType = message.payload.marketType;
      const bids = message.payload.orderBook.bids;
      void marketType;
      void bids;
    });
    const disposeTrade = bus.subscribe('CEX_TRADE', (message) => {
      const price = message.payload.trade.price;
      const exchangeId: string = message.payload.exchangeId;
      void price;
      void exchangeId;
    });
    disposeOb();
    disposeTrade();
    expect(typeof disposeOb).toBe('function');
  });

  it('payload типизирован конкретно: widening до unknown не требуется', () => {
    const message: CexExternalMessage = {
      type: 'CEX_TRADE',
      payload: {
        exchangeId: 'binance',
        marketType: 'swap',
        symbol: 'BTC/USDT:USDT',
        trade: { id: 't', price: 1, amount: 2 },
      },
      metadata: undefined as never, // metadata в compile-time тесте не строится
    };
    if (message.type === 'CEX_TRADE') {
      // Narrowing работает: поле trade доступно без кастов
      expect(message.payload.trade.id).toBe('t');
    }
  });
});
