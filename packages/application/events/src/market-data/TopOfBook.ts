/**
 * Верхушка стакана — immutable snapshot лучших цен.
 *
 * @remarks
 * Несёт immutable snapshot, а НЕ mutable OrderBook — потому что несколько
 * стратегий получают BookUpdatedEvent через fanout: если передать mutable
 * структуру, стратегия А увидит изменения стратегии Б.
 *
 * ### Параметризация ценовым доменом
 *
 * `TPrice` повторяет параметр `Orderbook`: верхушка книги биржи состоит из
 * цен актива (`78468.50`), верхушка книги рынка предсказаний — из долей
 * исхода (`0.52`). Default `OutcomePrice` сохраняет существующие сигнатуры.
 *
 * ### Почему здесь НЕТ поля `spread`
 *
 * Раньше оно было и типизировалось ценой — и это неверно сразу по двум
 * причинам:
 *
 * 1. **Ширина спреда — разность, а не цена.** Она может быть НУЛЕВОЙ
 *    (`bid == ask` — валидный, нормальный рынок), а оба ценовых VO требуют
 *    строго положительного значения. Нулевой спред молча превращался в
 *    `undefined`, то есть «спред 0» становился неотличим от «спреда нет».
 * 2. **Оно избыточно.** Разность вычисляется из тех же `bestBid`/`bestAsk`,
 *    которые уже здесь лежат; для полной книги есть `bookPricing.spread()`,
 *    возвращающий canonical `Spread<TPrice>` — тип, который нулевую ширину
 *    представляет корректно.
 *
 * Production-потребителей у поля не было; механически заменить его тип на
 * `TPrice` значило бы перенести оба дефекта в source-agnostic контракт.
 */
import type { DecimalPrice, OutcomePrice, Quantity } from '@polymarket/value-objects';

export interface TopOfBook<TPrice extends DecimalPrice = OutcomePrice> {
  /** Лучшая цена bid (или `undefined`, если стороны нет) */
  readonly bestBid: TPrice | undefined;
  /** Лучшая цена ask (или `undefined`, если стороны нет) */
  readonly bestAsk: TPrice | undefined;
  /** Размер лучшего bid (или `undefined`) */
  readonly bestBidSize: Quantity | undefined;
  /** Размер лучшего ask (или `undefined`) */
  readonly bestAskSize: Quantity | undefined;
}
