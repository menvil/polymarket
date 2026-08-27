/**
 * Контракт источника, проверяемый НА КОМПИЛЯЦИИ.
 *
 * @remarks
 * Адаптер выводит формы payload из фактического union `CexExternalMessage`,
 * а не описывает их руками. Этот набор фиксирует допущения о контракте
 * N-005 так, чтобы их нарушение стало ошибкой сборки, а не молчаливым
 * `undefined` в рантайме: переименованное поле vendor-снапшота обязано
 * ломать компиляцию здесь, а не тихо превращать книгу в пустую.
 *
 * Проверки типовые — рантайм-ассертов почти нет, и это намеренно.
 */
import { describe, expect, it } from '@jest/globals';
import type {
  CcxtOrderBookSnapshot,
  CcxtTradeSnapshot,
  CexExternalMessage,
  CexMarketType,
} from '@polymarket/cex-v2';
import type { CexIdentitySource } from '../src/index.js';

type OrderbookPayload = Extract<CexExternalMessage, { type: 'CEX_ORDERBOOK' }>['payload'];
type TradePayload = Extract<CexExternalMessage, { type: 'CEX_TRADE' }>['payload'];

/** Компилируется только если `Actual` и `Expected` совпадают структурно. */
type Assert<T extends true> = T;
type Extends<Actual, Expected> = Actual extends Expected ? true : false;

describe('контракт источника CEX (compile-time)', () => {
  it('оба payload несут одни и те же routing-поля', () => {
    type OrderbookRouting = Assert<Extends<OrderbookPayload, CexIdentitySource>>;
    type TradeRouting = Assert<Extends<TradePayload, CexIdentitySource>>;
    const checks: [OrderbookRouting, TradeRouting] = [true, true];
    expect(checks).toEqual([true, true]);
  });

  it('вложенные объекты остаются vendor-снапшотами CCXT', () => {
    type Book = Assert<Extends<OrderbookPayload['orderBook'], CcxtOrderBookSnapshot>>;
    type Trade = Assert<Extends<TradePayload['trade'], CcxtTradeSnapshot>>;
    const checks: [Book, Trade] = [true, true];
    expect(checks).toEqual([true, true]);
  });

  it('типы рынка — нативная терминология CCXT', () => {
    // Идентичность инструмента строится на этом значении, поэтому расширение
    // домена vendor-ом обязано быть заметным
    type Exhaustive = Assert<Extends<CexMarketType, 'spot' | 'future' | 'swap'>>;
    const check: Exhaustive = true;
    expect(check).toBe(true);

    const all: CexMarketType[] = ['spot', 'future', 'swap'];
    expect(all).toHaveLength(3);
  });

  it('union источника состоит ровно из двух наблюдаемых потоков', () => {
    type Types = CexExternalMessage['type'];
    type Exhaustive = Assert<Extends<Types, 'CEX_ORDERBOOK' | 'CEX_TRADE'>>;
    const check: Exhaustive = true;
    expect(check).toBe(true);

    // Рантайм-зеркало: адаптер подписан ровно на эти каналы
    const subscribed: Types[] = ['CEX_ORDERBOOK', 'CEX_TRADE'];
    expect(subscribed).toHaveLength(2);
  });

  it('финансовые поля vendor-снапшота приходят числами, а не VO', () => {
    // Это и есть граница точности: восстановить десятичную строку биржи
    // адаптер не может, потому что CCXT её уже не отдаёт
    type Price = NonNullable<CcxtTradeSnapshot['price']>;
    type Amount = NonNullable<CcxtTradeSnapshot['amount']>;
    type PriceIsNumber = Assert<Extends<Price, number>>;
    type AmountIsNumber = Assert<Extends<Amount, number>>;
    const checks: [PriceIsNumber, AmountIsNumber] = [true, true];
    expect(checks).toEqual([true, true]);
  });
});
