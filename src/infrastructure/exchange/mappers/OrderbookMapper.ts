/**
 * OrderbookMapper - маппинг между API и Domain форматами orderbook
 *
 * @remarks
 * Конвертирует ApiOrderbook → Domain Orderbook.
 * Используется клиентами для преобразования REST API ответов.
 *
 * Принципы:
 * - Stateless (pure functions)
 * - Детерминированный (same input → same output)
 * - Валидация входных данных
 * - Error handling для invalid data
 *
 * @module infrastructure/exchange/mappers/OrderbookMapper
 */

import { Orderbook, OrderbookLevel } from '../../../domain/entities/Orderbook.js';
import { Price } from '../../../domain/value-objects/Price.js';
import { Quantity } from '../../../domain/value-objects/Quantity.js';
import type { ApiOrderbook, ApiOrderbookLevel } from '../clients/types.js';

/**
 * OrderbookMapper - маппер для orderbook
 *
 * @remarks
 * Статический класс с pure functions для маппинга.
 */
export class OrderbookMapper {
  /**
   * Конвертирует API orderbook → Domain Orderbook
   *
   * @param api - API orderbook
   * @returns Domain Orderbook entity
   * @throws {Error} При invalid данных (negative price, invalid timestamp)
   *
   * @remarks
   * Алгоритм:
   * 1. Парсит bids/asks → OrderbookLevel[]
   * 2. Парсит timestamp (может быть string, number или undefined)
   * 3. Валидирует timestamp (не NaN)
   * 4. Создаёт Domain Orderbook через Orderbook.create()
   *
   * ВАЖНО: API timestamp в **миллисекундах** (не секундах)!
   * new Date(timestamp) без умножения на 1000.
   *
   * @example
   * ```typescript
   * const apiOrderbook: ApiOrderbook = {
   *   marketId: '0xabc123',
   *   bids: [{ price: '0.55', size: '100' }],
   *   asks: [{ price: '0.56', size: '150' }],
   *   timestamp: 1704067200000 // milliseconds
   * };
   *
   * const orderbook = OrderbookMapper.toDomain(apiOrderbook);
   * console.log(orderbook.getBestBid()?.value); // 0.55
   * ```
   */
  public static toDomain(api: ApiOrderbook): Orderbook {
    // Конвертируем bids
    const bids: OrderbookLevel[] = api.bids.map((level) =>
      this.apiLevelToDomain(level)
    );

    // Конвертируем asks
    const asks: OrderbookLevel[] = api.asks.map((level) =>
      this.apiLevelToDomain(level)
    );

    // Парсим timestamp (может быть number, string или undefined)
    const timestamp = this.parseTimestamp(api.timestamp);

    // Создаём Domain Orderbook
    return Orderbook.create(api.marketId, {
      bids,
      asks,
      timestamp,
    });
  }

  /**
   * Конвертирует API orderbook level → Domain OrderbookLevel
   *
   * @param level - API level
   * @returns Domain OrderbookLevel
   * @throws {Error} При invalid price/size (negative, NaN, non-numeric)
   *
   * @remarks
   * API level содержит strings для точности decimal.
   * Конвертируем в Price и Quantity value objects.
   *
   * @example
   * ```typescript
   * const apiLevel = { price: '0.55', size: '100.5' };
   * const level = OrderbookMapper.apiLevelToDomain(apiLevel);
   * console.log(level.price.value); // 0.55
   * console.log(level.quantity.value); // 100.5
   * ```
   */
  private static apiLevelToDomain(level: ApiOrderbookLevel): OrderbookLevel {
    // Парсим price
    const priceValue = parseFloat(level.price);
    if (isNaN(priceValue) || priceValue < 0) {
      throw new Error(`Invalid price: ${level.price}`);
    }

    // Парсим size
    const sizeValue = parseFloat(level.size);
    if (isNaN(sizeValue) || sizeValue < 0) {
      throw new Error(`Invalid size: ${level.size}`);
    }

    return {
      price: Price.fromNumber(priceValue),
      quantity: Quantity.fromNumber(sizeValue),
    };
  }

  /**
   * Парсит timestamp из API формата
   *
   * @param timestamp - API timestamp (number, string или undefined)
   * @returns Date объект
   *
   * @remarks
   * API timestamp в **миллисекундах**.
   * Если timestamp отсутствует или invalid → использует current time.
   *
   * Алгоритм:
   * 1. Если undefined → current time
   * 2. Если string → parseFloat() → validate
   * 3. Если number → validate
   * 4. Проверка isNaN → current time
   *
   * @example
   * ```typescript
   * // Valid timestamp (ms)
   * const date1 = OrderbookMapper.parseTimestamp(1704067200000);
   * console.log(date1.toISOString()); // 2024-01-01T00:00:00.000Z
   *
   * // String timestamp
   * const date2 = OrderbookMapper.parseTimestamp('1704067200000');
   * console.log(date2.toISOString()); // 2024-01-01T00:00:00.000Z
   *
   * // Missing timestamp → current time
   * const date3 = OrderbookMapper.parseTimestamp(undefined);
   * console.log(date3.getTime()); // current time
   * ```
   */
  private static parseTimestamp(timestamp: number | string | undefined): Date {
    // Если timestamp отсутствует → current time
    if (timestamp === undefined) {
      return new Date();
    }

    // Парсим timestamp
    const ts = typeof timestamp === 'string' ? parseFloat(timestamp) : timestamp;

    // Проверяем валидность
    if (isNaN(ts)) {
      // Invalid timestamp → current time
      return new Date();
    }

    // Создаём Date (timestamp в миллисекундах)
    const date = new Date(ts);

    // Double-check валидности
    if (isNaN(date.getTime())) {
      return new Date();
    }

    return date;
  }

  /**
   * Конвертирует Domain Orderbook → API format
   *
   * @param orderbook - Domain Orderbook
   * @returns API orderbook
   *
   * @remarks
   * Обратная конвертация для serialization/export.
   * Редко используется (обычно нужен только toDomain).
   *
   * @example
   * ```typescript
   * const orderbook = Orderbook.create('0xabc', { bids: [...], asks: [...] });
   * const api = OrderbookMapper.toApi(orderbook);
   * console.log(api.bids[0].price); // '0.55'
   * ```
   */
  public static toApi(orderbook: Orderbook): ApiOrderbook {
    return {
      marketId: orderbook.marketId,
      bids: orderbook.bids.map((level) => ({
        price: level.price.value.toString(),
        size: level.quantity.value.toString(),
      })),
      asks: orderbook.asks.map((level) => ({
        price: level.price.value.toString(),
        size: level.quantity.value.toString(),
      })),
      timestamp: orderbook.timestamp.getTime(), // milliseconds
    };
  }
}
