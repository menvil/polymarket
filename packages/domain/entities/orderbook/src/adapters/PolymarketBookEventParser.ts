/**
 * PolymarketBookEventParser — адаптер для Polymarket WebSocket "book" событий
 *
 * @remarks
 * Конвертирует raw Polymarket CLOB WebSocket событие в доменную Orderbook entity.
 * Делегирует всю валидацию в `OrderbookNormalizer` (PriceService, QuantityService, VO).
 *
 * ### Polymarket "book" событие (полный снапшот стакана):
 * ```json
 * {
 *   "market":    "0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3",
 *   "asset_id":  "62305814799875783974460176688386847666394972778903073967664089920408777315323",
 *   "bids":      [{"price":"0.43","size":"41"}, {"price":"0.42","size":"194"}, ...],
 *   "asks":      [{"price":"0.44","size":"253.92"}, {"price":"0.45","size":"384"}, ...],
 *   "hash":      "b94cbda1d86a59a0a8c15c586039aa811c2a15c6",
 *   "timestamp": "1767463213110",
 *   "event_type":"book"
 * }
 * ```
 *
 * ### Несоответствия формата и их обработка:
 * | Polymarket поле | RawOrderbook поле | Преобразование |
 * |-----------------|-------------------|----------------|
 * | `market`        | `marketId`        | переименование |
 * | `asset_id`      | `tokenId`         | переименование |
 * | `bids[].price`  | `bids[].price`    | переименование (строка передаётся напрямую) |
 * | `bids[].size`   | `bids[].quantity` | переименование (строка передаётся напрямую) |
 * | `timestamp`     | `venueTimestamp`  | переименование (строка передаётся напрямую) |
 *
 * После конвертации в `RawOrderbook` — `OrderbookNormalizer` применяет:
 * - `PriceService.create()` — валидация через Price VO [0.0001, 0.9999]
 * - `QuantityService.create()` — валидация через Quantity VO (>= 0)
 * - Фильтрацию нулевых уровней, агрегацию, сортировку
 * - Crossed book detection
 *
 * @example
 * ```typescript
 * import { PolymarketBookEventParser } from '@polymarket/orderbook';
 *
 * ws.on('message', (rawMsg: string) => {
 *   const raw = JSON.parse(rawMsg);
 *   if (raw.event_type !== 'book') return;
 *
 *   const result = PolymarketBookEventParser.parse(raw as PolymarketBookEvent);
 *   if (!result.ok) {
 *     logger.error('Invalid book event', { error: result.error.message });
 *     return;
 *   }
 *
 *   const orderbook = result.value;
 *   console.log('Best bid:', orderbook.getBestBid()?.price.value().toNumber()); // 0.43
 *   console.log('Best ask:', orderbook.getBestAsk()?.price.value().toNumber()); // 0.44
 *   console.log('Spread:',   orderbook.getSpread()?.toNumber());                // 0.01
 * });
 * ```
 */

import type { Result } from '@polymarket/result';
import { Orderbook } from '../core/Orderbook.js';
import {
  OrderbookNormalizer,
} from '../normalizer/OrderbookNormalizer.js';
import { PERMISSIVE_NORMALIZATION_POLICY } from '../normalizer/NormalizationPolicy.js';
import type { NormalizationPolicy } from '../normalizer/NormalizationPolicy.js';
import type { RawOrderbook } from '../normalizer/types.js';
import { OrderbookValidationError } from '@polymarket/errors/orderbook';
import { OrderbookInvalidError } from '@polymarket/errors/orderbook';

/**
 * Уровень стакана в формате Polymarket WebSocket
 *
 * @remarks
 * `price` и `size` — строки. Это формат Polymarket CLOB API.
 *
 * @example
 * ```json
 * { "price": "0.43", "size": "41" }
 * { "price": "0.08", "size": "3073.25" }
 * ```
 */
export interface PolymarketLevel {
  /** Цена уровня в виде строки (например "0.43") */
  readonly price: string;
  /** Объём на уровне в виде строки (например "3073.25") */
  readonly size: string;
}

/**
 * Polymarket WebSocket "book" событие — полный снапшот стакана
 *
 * @remarks
 * Приходит при подключении к CLOB WebSocket и при принудительном обновлении.
 * Для инкрементальных обновлений используется `event_type: "price_change"`.
 *
 * Особенности формата:
 * - `market` = condition ID (hex, 0x-prefix)
 * - `asset_id` = outcome token ID (большое десятичное число в строке)
 * - `bids` отсортированы по убыванию цены (best bid первый)
 * - `asks` отсортированы по возрастанию цены (best ask первый)
 * - все числовые значения переданы как строки
 * - `timestamp` = epoch ms в виде строки (не ISO, не секунды — именно ms)
 */
export interface PolymarketBookEvent {
  /** Condition ID рынка (hex string с 0x-prefix) */
  readonly market: string;
  /** ID исхода токена (большое десятичное число в виде строки) */
  readonly asset_id: string;
  /** Уровни покупки (строки price/size) */
  readonly bids: readonly PolymarketLevel[];
  /** Уровни продажи (строки price/size) */
  readonly asks: readonly PolymarketLevel[];
  /** Hash снапшота стакана */
  readonly hash: string;
  /** Время генерации на бирже (epoch ms в виде строки) */
  readonly timestamp: string;
  /** Тип события */
  readonly event_type: 'book';
}

/**
 * PolymarketBookEventParser — статический парсер "book" событий
 *
 * @remarks
 * Намеренно реализован как static-only класс.
 * Тонкий адаптер: перекладывает поля + конвертирует строки в числа,
 * затем делегирует всю валидацию в `OrderbookNormalizer`.
 */
export class PolymarketBookEventParser {
  private constructor() {
    throw new Error(
      'PolymarketBookEventParser is a static utility class and cannot be instantiated'
    );
  }

  /**
   * Парсит Polymarket "book" событие в доменную Orderbook entity
   *
   * @param event - Polymarket WebSocket "book" событие
   * @param policy - Политика нормализации (по умолчанию DEFAULT_NORMALIZATION_POLICY)
   * @returns Result<Orderbook, OrderbookValidationError | OrderbookInvalidError>
   *
   * @remarks
   * Алгоритм:
   * 1. Маппинг полей события в RawOrderbook (поля переименовываются, строки передаются as-is)
   * 2. Делегирование в OrderbookNormalizer (VO валидация через PriceService/QuantityService, сортировка, crossed book)
   * 3. Создание Orderbook через Orderbook.fromNormalized()
   *
   * Строки передаются напрямую в RawOrderbook — PriceService/QuantityService/TimestampService
   * принимают string | number и корректно их парсят.
   * Все валидации (диапазон цены, quantity >= 0, crossed book) — в нормализаторе.
   *
   * @example
   * ```typescript
   * const event: PolymarketBookEvent = JSON.parse(wsMessage);
   * const result = PolymarketBookEventParser.parse(event);
   *
   * if (!result.ok) {
   *   console.error(result.error.message);
   *   return;
   * }
   *
   * const ob = result.value;
   * console.log(ob.getBestBid()?.price.value().toNumber()); // 0.43
   * console.log(ob.getBestAsk()?.price.value().toNumber()); // 0.44
   * console.log(ob.getSpread()?.toNumber());                // 0.01
   * console.log(ob.getMidPrice()?.toNumber());              // 0.435
   * console.log(ob.getImbalance().toNumber());              // имбаланс [-1, +1]
   * ```
   */
  public static parse(
    event: PolymarketBookEvent,
    policy: NormalizationPolicy = PERMISSIVE_NORMALIZATION_POLICY
  ): Result<Orderbook, OrderbookValidationError | OrderbookInvalidError> {
    // Строки передаются напрямую — PriceService/QuantityService/TimestampService принимают string
    const raw: RawOrderbook = {
      marketId: event.market,
      tokenId: event.asset_id,
      bids: event.bids.map(l => ({ price: l.price, quantity: l.size })),
      asks: event.asks.map(l => ({ price: l.price, quantity: l.size })),
      venueTimestamp: event.timestamp, // строка "1767463213110" — TimestampService.create() распарсит
    };

    const normalizedResult = OrderbookNormalizer.normalize(raw, policy);
    if (!normalizedResult.ok) {
      return normalizedResult;
    }

    return { ok: true, value: Orderbook.fromNormalized(normalizedResult.value) };
  }
}
