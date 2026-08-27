/**
 * Ценовые метрики стакана: mid price, микроцена, спред.
 *
 * @remarks
 * ## Почему это НЕ методы `Orderbook`
 *
 * У сущности стакана два разных вида операций, и ведут они себя
 * противоположно:
 *
 * ```text
 * getBestBid()   ВЫБИРАЕТ уже существующий уровень   → домен знать не нужно
 * midPrice()     СОЗДАЁТ новое значение из Decimal   → без домена невозможно
 * ```
 *
 * Чтобы собрать `(bid + ask) / 2` обратно в цену, нужно знать, какой
 * фабрикой это делать — `PriceService.create` для рынка предсказаний или
 * `ReferencePriceService.create` для внешнего актива. Пока такие методы
 * жили внутри `Orderbook`, сущность была обязана знать ровно один домен, и
 * именно это делало её непригодной для стакана биржи.
 *
 * Решение: фабрика нужна, но её место — **не в структуре**. Домен знает
 * вызывающий, он же и связывает фабрику один раз:
 *
 * ```typescript
 * const pricing = bookPricing(PriceService.create);
 * pricing.midPrice(book);
 * ```
 *
 * Связывание один раз, а не параметром на каждый вызов, выбрано намеренно:
 * при передаче фабрики в каждый вызов можно подсунуть чужую (`T` выведется
 * ИЗ ФАБРИКИ, а не из книги), и компилятор это пропустит. Связанный
 * экземпляр делает такую ошибку непредставимой.
 *
 * ## Арифметика одна на все домены
 *
 * Формулы `mid`/`microprice`/`spread` не зависят от того, вероятность это
 * или цена актива. Поэтому реализация ОДНА, а не по классу на домен —
 * иначе мы бы размножили одну формулу под разными именами.
 */
import type { Price, Spread, DecimalPrice } from '@polymarket/value-objects';
import { Spread as SpreadCore } from '@polymarket/value-objects';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { OrderbookInvalidError, OrderbookInvalidReason } from '@polymarket/errors/orderbook';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { Orderbook } from '../core/Orderbook.js';

/**
 * Фабрика цены конкретного домена.
 *
 * @remarks
 * Совместима с `PriceService.create` / `ReferencePriceService.create` как
 * есть — специально писать адаптер не нужно.
 */
export type PriceFactory<TPrice extends DecimalPrice> = (
  value: Decimal,
) => Result<TPrice, unknown>;

/** Ценовые метрики стакана, связанные с конкретным ценовым доменом. */
export interface BookPricing<TPrice extends DecimalPrice> {
  /**
   * Средняя цена между лучшими bid и ask.
   *
   * @param book - Стакан
   * @returns Mid price либо `null`, если стакан пуст, односторонний или
   *   скрещен, а также если результат не принадлежит домену цены
   *
   * @remarks
   * Объёмы НЕ учитываются — для этого есть {@link BookPricing.microprice}.
   */
  midPrice(book: Orderbook<TPrice>): TPrice | null;

  /**
   * Цена, взвешенная по объёмам на лучших уровнях.
   *
   * @param book - Стакан
   * @returns Микроцена либо `null`, если одной из сторон нет либо суммарный
   *   объём нулевой
   *
   * @remarks
   * `microprice = (ask·bidQty + bid·askQty) / (bidQty + askQty)` — точнее
   * отражает давление, чем mid, потому что учитывает дисбаланс ликвидности.
   */
  microprice(book: Orderbook<TPrice>): TPrice | null;

  /**
   * Спред между лучшими bid и ask.
   *
   * @param book - Стакан
   * @returns `Ok(Spread)` либо `Err(OrderbookInvalidError)` с причиной
   *   `EMPTY_BOOK` / `ONE_SIDED` / `CROSSED_BOOK`
   *
   * @remarks
   * Возвращает `Result`, а не `null`: «нет ликвидности» и «скрещенная
   * книга» — принципиально разные состояния, и для торговой системы второе
   * является сигналом тревоги, который нельзя терять в `null`.
   */
  spread(book: Orderbook<TPrice>): Result<Spread<TPrice>, OrderbookInvalidError>;
}

/**
 * Связывает ценовые метрики стакана с фабрикой конкретного домена.
 *
 * @param create - Фабрика цены (`PriceService.create` и подобные)
 * @returns Набор метрик, работающий в этом домене
 *
 * @example
 * ```typescript
 * import { PriceService } from '@polymarket/value-objects';
 * import { bookPricing } from '@polymarket/orderbook';
 *
 * const pricing = bookPricing(PriceService.create);
 *
 * const mid = pricing.midPrice(book);
 * const spread = pricing.spread(book);
 * if (!spread.ok && spread.error.isCrossedBook()) {
 *   // критично: книга скрещена
 * }
 * ```
 */
export function bookPricing<TPrice extends DecimalPrice = Price>(
  create: PriceFactory<TPrice>,
): BookPricing<TPrice> {
  const spread = (book: Orderbook<TPrice>): Result<Spread<TPrice>, OrderbookInvalidError> => {
    const bid = book.getBestBid();
    const ask = book.getBestAsk();

    if (bid === null && ask === null) {
      return Err(
        new OrderbookInvalidError('Empty orderbook', {
          context: {
            reason: OrderbookInvalidReason.EMPTY_BOOK,
            marketId: book.instrumentId,
            tokenId: book.asset,
          },
        }),
      );
    }
    if (bid === null || ask === null) {
      return Err(
        new OrderbookInvalidError('One-sided orderbook', {
          context: {
            reason: OrderbookInvalidReason.ONE_SIDED,
            marketId: book.instrumentId,
            tokenId: book.asset,
            bestBid: bid?.value().toNumber(),
            bestAsk: ask?.value().toNumber(),
          },
        }),
      );
    }

    // Core-фабрика, а не `SpreadService`: фасад типизирован prediction-ценой
    // и generic-книгу не принял бы. Core бросает ровно один инвариант —
    // `bid > ask`, — который здесь и означает скрещенную книгу.
    try {
      return Ok(SpreadCore.of(bid, ask));
    } catch {
      return Err(
        new OrderbookInvalidError('Crossed book detected', {
          context: {
            reason: OrderbookInvalidReason.CROSSED_BOOK,
            marketId: book.instrumentId,
            tokenId: book.asset,
            bestBid: bid.value().toNumber(),
            bestAsk: ask.value().toNumber(),
          },
        }),
      );
    }
  };

  return {
    spread,

    midPrice(book: Orderbook<TPrice>): TPrice | null {
      const spreadResult = spread(book);
      if (!spreadResult.ok) return null;
      const result = create(spreadResult.value.midpoint());
      return result.ok ? result.value : null;
    },

    microprice(book: Orderbook<TPrice>): TPrice | null {
      if (book.bids.length === 0 || book.asks.length === 0) {
        return null;
      }
      const bestBid = book.bids[0]!;
      const bestAsk = book.asks[0]!;

      const bidQty = bestBid.quantity.value();
      const askQty = bestAsk.quantity.value();
      const totalQty = bidQty.plus(askQty);
      if (totalQty.isZero()) {
        return null;
      }

      const value = bestAsk.price
        .value()
        .times(bidQty)
        .plus(bestBid.price.value().times(askQty))
        .dividedBy(totalQty);

      const result = create(value);
      return result.ok ? result.value : null;
    },
  };
}
