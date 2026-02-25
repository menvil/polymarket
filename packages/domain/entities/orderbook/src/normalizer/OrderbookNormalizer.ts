/**
 * OrderbookNormalizer - нормализация Raw Orderbook данных
 *
 * @remarks
 * Преобразует сырые данные от exchange в validated OrderbookLevel массивы.
 *
 * Алгоритм нормализации:
 * 1. Парсинг price/quantity (number → VO)
 * 2. Фильтрация нулевых quantity (если policy.dropZeroQty)
 * 3. Агрегация одинаковых price (если policy.aggregateSamePrice)
 * 4. Сортировка (bids descending, asks ascending)
 * 5. Ограничение уровней (если policy.maxLevelsPerSide)
 * 6. Валидация crossed book (если !policy.allowCrossed)
 *
 * Устраняет дублирование парсинга bids/asks через универсальную
 * функцию parseLevels().
 *
 * @example
 * ```typescript
 * import { OrderbookNormalizer, DEFAULT_NORMALIZATION_POLICY } from './OrderbookNormalizer';
 *
 * const rawData: RawOrderbook = {
 *   marketId: 'market-123',
 *   bids: [
 *     { price: 0.52, quantity: 0 },     // будет отфильтрован
 *     { price: 0.51, quantity: 100 },
 *     { price: 0.51, quantity: 50 },    // будет агрегирован
 *   ],
 *   asks: [{ price: 0.53, quantity: 150 }],
 * };
 *
 * const result = OrderbookNormalizer.normalize(rawData, DEFAULT_NORMALIZATION_POLICY);
 * if (result.ok) {
 *   const { bids, asks } = result.value;
 *   console.log(`Normalized: ${bids.length} bids, ${asks.length} asks`);
 * }
 * ```
 */

import { Price, Quantity } from '@polymarket/value-objects';
import { OrderbookValidationError } from '@polymarket/errors';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { OrderbookLevel } from '../core/OrderbookLevel.js';
import { OrderbookInvalidError, OrderbookInvalidReason } from '../errors/OrderbookInvalidError.js';
import type { RawOrderbook, RawLevel } from './types.js';
import type { NormalizationPolicy } from './NormalizationPolicy.js';
import { DEFAULT_NORMALIZATION_POLICY } from './NormalizationPolicy.js';

/**
 * Результат нормализации
 */
export interface NormalizedOrderbook {
  readonly bids: readonly OrderbookLevel[];
  readonly asks: readonly OrderbookLevel[];
  readonly marketId: string;
  readonly tokenId: string;
  readonly venueTimestamp?: number; // unix timestamp ms
  readonly receivedAt: number; // unix timestamp ms
}

/**
 * OrderbookNormalizer - статический класс для нормализации
 */
export class OrderbookNormalizer {
  /**
   * Нормализует raw orderbook данные
   *
   * @param raw - Сырые данные от exchange
   * @param policy - Политика нормализации
   * @returns Result<NormalizedOrderbook, Error>
   *
   * @remarks
   * Главный метод нормализации. Выполняет все шаги:
   * 1. Валидация IDs
   * 2. Парсинг уровней (bids и asks)
   * 3. Валидация crossed book
   * 4. Нормализация timestamps
   */
  public static normalize(
    raw: RawOrderbook,
    policy: NormalizationPolicy = DEFAULT_NORMALIZATION_POLICY
  ): Result<NormalizedOrderbook, OrderbookValidationError | OrderbookInvalidError> {
    // Валидация marketId
    if (!raw.marketId || typeof raw.marketId !== 'string' || raw.marketId.trim().length === 0) {
      return Err(
        new OrderbookValidationError('Missing or invalid marketId', {
          context: { field: 'marketId', value: raw.marketId },
        })
      );
    }

    // Валидация tokenId
    if (!raw.tokenId || typeof raw.tokenId !== 'string' || raw.tokenId.trim().length === 0) {
      return Err(
        new OrderbookValidationError('Missing or invalid tokenId', {
          context: { field: 'tokenId', value: raw.tokenId, marketId: raw.marketId },
        })
      );
    }

    // Парсинг bids
    const bidsResult = this.parseLevels('bids', raw.bids, raw.marketId, policy);
    if (!bidsResult.ok) {
      return bidsResult;
    }

    // Парсинг asks
    const asksResult = this.parseLevels('asks', raw.asks, raw.marketId, policy);
    if (!asksResult.ok) {
      return asksResult;
    }

    const bids = bidsResult.value;
    const asks = asksResult.value;

    // Валидация crossed book (если !allowCrossed)
    if (!policy.allowCrossed && bids.length > 0 && asks.length > 0) {
      const bestBid = bids[0].price.value;
      const bestAsk = asks[0].price.value;

      if (bestBid >= bestAsk) {
        return Err(
          new OrderbookInvalidError('Crossed book detected', {
            context: {
              reason: OrderbookInvalidReason.CROSSED_BOOK,
              marketId: raw.marketId,
              tokenId: raw.tokenId,
              bestBid,
              bestAsk,
            },
          })
        );
      }
    }

    // Нормализация timestamps
    const venueTimestamp = this.parseVenueTimestamp(raw.venueTimestamp);
    const receivedAt = raw.receivedAt ?? Date.now();

    return Ok({
      bids,
      asks,
      marketId: raw.marketId,
      tokenId: raw.tokenId,
      venueTimestamp,
      receivedAt,
    });
  }

  /**
   * Парсит уровни (bids или asks)
   *
   * @param side - 'bids' или 'asks'
   * @param rawLevels - Массив сырых уровней
   * @param marketId - ID market для error context
   * @param policy - Политика нормализации
   * @returns Result<OrderbookLevel[], Error>
   *
   * @remarks
   * Универсальная функция для парсинга обеих сторон.
   * Устраняет дублирование кода из оригинального fromJSON.
   *
   * Алгоритм:
   * 1. Парсинг number → Price/Quantity VO
   * 2. Фильтрация нулевых quantity (если policy.dropZeroQty)
   * 3. Агрегация дубликатов price (если policy.aggregateSamePrice)
   * 4. Сортировка (bids desc, asks asc)
   * 5. Ограничение levels (если policy.maxLevelsPerSide)
   */
  private static parseLevels(
    side: 'bids' | 'asks',
    rawLevels: readonly RawLevel[],
    marketId: string,
    policy: NormalizationPolicy
  ): Result<readonly OrderbookLevel[], OrderbookValidationError> {
    if (!Array.isArray(rawLevels)) {
      return Err(
        new OrderbookValidationError(`${side} must be an array`, {
          context: { field: side, marketId, value: rawLevels },
        })
      );
    }

    const levels: OrderbookLevel[] = [];

    // Шаг 1: Парсинг number → VO
    for (let i = 0; i < rawLevels.length; i++) {
      const rawLevel = rawLevels[i];

      // Валидация price
      if (typeof rawLevel.price !== 'number') {
        return Err(
          new OrderbookValidationError(`Invalid price in ${side}[${i}]`, {
            context: { field: `${side}[${i}].price`, marketId, value: rawLevel.price },
          })
        );
      }

      // Валидация quantity
      if (typeof rawLevel.quantity !== 'number') {
        return Err(
          new OrderbookValidationError(`Invalid quantity in ${side}[${i}]`, {
            context: { field: `${side}[${i}].quantity`, marketId, value: rawLevel.quantity },
          })
        );
      }

      // Создание Price VO
      const priceResult = Price.fromValue(rawLevel.price);
      if (!priceResult.ok) {
        return Err(
          new OrderbookValidationError(`Failed to create Price from ${side}[${i}]: ${priceResult.error.message}`, {
            context: { field: `${side}[${i}].price`, marketId, value: rawLevel.price },
          })
        );
      }

      // Создание Quantity VO
      const quantityResult = Quantity.fromValue(rawLevel.quantity);
      if (!quantityResult.ok) {
        return Err(
          new OrderbookValidationError(`Failed to create Quantity from ${side}[${i}]: ${quantityResult.error.message}`, {
            context: { field: `${side}[${i}].quantity`, marketId, value: rawLevel.quantity },
          })
        );
      }

      const level = OrderbookLevel.create(priceResult.value, quantityResult.value);

      // Шаг 2: Фильтрация нулевых (если policy.dropZeroQty)
      if (policy.dropZeroQty && level.isEmpty()) {
        continue; // skip zero quantity level
      }

      levels.push(level);
    }

    // Шаг 3: Агрегация дубликатов (если policy.aggregateSamePrice)
    let processedLevels: OrderbookLevel[];
    if (policy.aggregateSamePrice) {
      processedLevels = this.aggregateLevels(levels);
    } else {
      processedLevels = levels;
    }

    // Шаг 4: Сортировка
    const sortedLevels = this.sortLevels(processedLevels, side);

    // Шаг 5: Ограничение уровней (если policy.maxLevelsPerSide)
    const limitedLevels = policy.maxLevelsPerSide
      ? sortedLevels.slice(0, policy.maxLevelsPerSide)
      : sortedLevels;

    return Ok(limitedLevels);
  }

  /**
   * Агрегирует уровни с одинаковой ценой
   *
   * @param levels - Массив уровней
   * @returns Массив уровней с агрегированными дубликатами
   *
   * @remarks
   * Суммирует quantity для уровней с одинаковым price.
   *
   * @example
   * ```typescript
   * // Input: [0.51@100, 0.51@50, 0.50@200]
   * // Output: [0.51@150, 0.50@200]
   * ```
   */
  private static aggregateLevels(levels: OrderbookLevel[]): OrderbookLevel[] {
    const priceMap = new Map<number, OrderbookLevel>();

    for (const level of levels) {
      const price = level.price.value;
      const existing = priceMap.get(price);

      if (existing) {
        // Суммируем quantity
        const newQuantity = existing.quantity.value + level.quantity.value;
        const quantityResult = Quantity.fromValue(newQuantity);
        if (quantityResult.ok) {
          priceMap.set(price, existing.withQuantity(quantityResult.value));
        }
      } else {
        priceMap.set(price, level);
      }
    }

    return Array.from(priceMap.values());
  }

  /**
   * Сортирует уровни
   *
   * @param levels - Массив уровней
   * @param side - 'bids' или 'asks'
   * @returns Отсортированный массив
   *
   * @remarks
   * - bids: по убыванию цены (лучший bid первый)
   * - asks: по возрастанию цены (лучший ask первый)
   */
  private static sortLevels(levels: OrderbookLevel[], side: 'bids' | 'asks'): OrderbookLevel[] {
    const sorted = [...levels];

    if (side === 'bids') {
      // Bids: descending price (highest first)
      sorted.sort((a, b) => b.price.value - a.price.value);
    } else {
      // Asks: ascending price (lowest first)
      sorted.sort((a, b) => a.price.value - b.price.value);
    }

    return sorted;
  }

  /**
   * Парсит venue timestamp
   *
   * @param venueTs - Venue timestamp (string ISO, number unix ms, or undefined)
   * @returns Unix timestamp в миллисекундах или undefined
   *
   * @remarks
   * Нормализует разные форматы timestamp в единый: unix ms.
   */
  private static parseVenueTimestamp(venueTs: string | number | undefined): number | undefined {
    if (venueTs === undefined) {
      return undefined;
    }

    if (typeof venueTs === 'number') {
      return venueTs;
    }

    if (typeof venueTs === 'string') {
      const date = new Date(venueTs);
      if (!isNaN(date.getTime())) {
        return date.getTime();
      }
    }

    return undefined;
  }
}
