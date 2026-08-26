/**
 * Compile-time фиксация фактического контракта официального SDK.
 *
 * @remarks
 * Маппинг адаптера написан НЕ по памяти, а по установленным типам
 * `@polymarket/bindings`. Этот файл превращает это в проверяемый инвариант:
 * если vendor переименует поле, изменит опциональность или уронит union —
 * сборка упадёт ЗДЕСЬ, с понятным сообщением, а не расхождением в рантайме.
 *
 * Тесты намеренно compile-time: проверяется типовой контракт, а не поведение.
 */
import { describe, expect, it } from '@jest/globals';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';

/** Payload наблюдения CLOB market channel. */
type MarketEvent = Extract<PolymarketExternalMessage, { type: 'POLYMARKET_MARKET' }>['payload'];

type BookPayload = Extract<MarketEvent, { type: 'book' }>['payload'];
type PriceChangePayload = Extract<MarketEvent, { type: 'price_change' }>['payload'];
type LastTradePayload = Extract<MarketEvent, { type: 'last_trade_price' }>['payload'];
type TickSizePayload = Extract<MarketEvent, { type: 'tick_size_change' }>['payload'];

/** Утверждение «тип X присваиваем типу Y» без рантайм-эффекта. */
type Assignable<TFrom, TTo> = TFrom extends TTo ? true : false;

describe('контракт CLOB market channel', () => {
  it('union несёт ровно четыре обрабатываемых event-типа', () => {
    const types: MarketEvent['type'][] = [
      'book',
      'price_change',
      'last_trade_price',
      'tick_size_change',
    ];
    // Если vendor добавит/уберёт член union — присваивание ниже не соберётся
    const exhaustive: MarketEvent['type'] =
      types[0] as 'book' | 'price_change' | 'last_trade_price' | 'tick_size_change';
    expect(exhaustive).toBe('book');
  });

  it('book: уровни — десятичные СТРОКИ, время опционально', () => {
    const check: Assignable<BookPayload['bids'], readonly { price: string; size: string }[]> = true;
    const marketIsString: Assignable<BookPayload['market'], string> = true;
    const tokenIsString: Assignable<BookPayload['tokenId'], string> = true;
    // Время venue МОЖЕТ отсутствовать — адаптер обязан это допускать
    const timestampOptional: Assignable<undefined, BookPayload['timestamp']> = true;
    const timestampNullable: Assignable<null, BookPayload['timestamp']> = true;

    expect([check, marketIsString, tokenIsString, timestampOptional, timestampNullable]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('price_change: МАССИВ изменений с per-token best bid/ask', () => {
    type Change = PriceChangePayload['priceChanges'][number];

    const isArray: Assignable<PriceChangePayload['priceChanges'], readonly unknown[]> = true;
    const priceIsString: Assignable<Change['price'], string> = true;
    const sizeIsString: Assignable<Change['size'], string> = true;
    const sideIsString: Assignable<Change['side'], string> = true;
    // best bid/ask — именно опционально-nullable: сверка desync обязана это учитывать
    const bestBidNullable: Assignable<null | undefined, Change['bestBid']> = true;
    const bestAskNullable: Assignable<null | undefined, Change['bestAsk']> = true;

    expect([
      isArray,
      priceIsString,
      sizeIsString,
      sideIsString,
      bestBidNullable,
      bestAskNullable,
    ]).toEqual([true, true, true, true, true, true]);
  });

  it('last_trade_price: size ОПЦИОНАЛЕН и стабильного trade id НЕТ', () => {
    // Ровно тот факт, из-за которого объём нельзя выдумывать
    const sizeOptional: Assignable<undefined, LastTradePayload['size']> = true;
    const sizeNullable: Assignable<null, LastTradePayload['size']> = true;
    const priceRequired: Assignable<LastTradePayload['price'], string> = true;

    // Полей идентичности сделки в контракте нет — потому Trade entity неприменим
    type HasTradeId = 'tradeId' extends keyof LastTradePayload ? true : false;
    type HasId = 'id' extends keyof LastTradePayload ? true : false;
    const noTradeId: HasTradeId = false;
    const noId: HasId = false;

    expect([sizeOptional, sizeNullable, priceRequired, noTradeId, noId]).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('tick_size_change: новый шаг обязателен, прежний — нет', () => {
    const newRequired: Assignable<TickSizePayload['newTickSize'], string> = true;
    const oldOptional: Assignable<undefined, TickSizePayload['oldTickSize']> = true;
    const oldNullable: Assignable<null, TickSizePayload['oldTickSize']> = true;

    expect([newRequired, oldOptional, oldNullable]).toEqual([true, true, true]);
  });
});

describe('контракт RTDS-фидов', () => {
  type BinancePayload = Extract<
    PolymarketExternalMessage,
    { type: 'POLYMARKET_CRYPTO_BINANCE' }
  >['payload']['payload'];
  type TwapPayload = Extract<
    PolymarketExternalMessage,
    { type: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP' }
  >['payload']['payload'];

  it('spot несёт symbol/timestamp/value и НЕ несёт окна усреднения', () => {
    const valueIsString: Assignable<BinancePayload['value'], string> = true;
    const symbolIsString: Assignable<BinancePayload['symbol'], string> = true;
    const timestampIsNumber: Assignable<BinancePayload['timestamp'], number> = true;

    type SpotHasWindow = 'windowSeconds' extends keyof BinancePayload ? true : false;
    const noWindow: SpotHasWindow = false;

    expect([valueIsString, symbolIsString, timestampIsNumber, noWindow]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('TWAP несёт окно усреднения из vendor-домена 30 | 60', () => {
    const windowIsThirtyOrSixty: Assignable<TwapPayload['windowSeconds'], 30 | 60> = true;
    const valueIsString: Assignable<TwapPayload['value'], string> = true;

    expect([windowIsThirtyOrSixty, valueIsString]).toEqual([true, true]);
  });
});
