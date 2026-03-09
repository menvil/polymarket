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
 * import { OrderbookNormalizer } from './OrderbookNormalizer.js';
 * import { DEFAULT_NORMALIZATION_POLICY } from './NormalizationPolicy.js';
 *
 * const rawData: RawOrderbook = {
 *   marketId: 'market-123',
 *   tokenId: '62305814799875783974460176688386847666394972778903073967664089920408777315323',
 *   bids: [
 *     { price: '0.52', quantity: '0' },     // будет отфильтрован
 *     { price: '0.51', quantity: '100' },
 *     { price: '0.51', quantity: '50' },    // будет агрегирован
 *   ],
 *   asks: [{ price: '0.53', quantity: '150' }],
 * };
 *
 * const result = OrderbookNormalizer.normalize(rawData, DEFAULT_NORMALIZATION_POLICY);
 * if (result.ok) {
 *   const { bids, asks } = result.value;
 *   console.log(`Normalized: ${bids.length} bids, ${asks.length} asks`);
 * }
 * ```
 */

import { PriceService, QuantityService, TimestampService } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/value-objects';
import { OrderbookValidationError } from '@polymarket/errors/orderbook';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { OrderbookLevel } from '../core/OrderbookLevel.js';
import { OrderbookInvalidError, OrderbookInvalidReason } from '@polymarket/errors/orderbook';
import type { RawOrderbook, RawLevel } from './types.js';
import type { NormalizationPolicy } from './NormalizationPolicy.js';
import { PERMISSIVE_NORMALIZATION_POLICY } from './NormalizationPolicy.js';

/**
 * Результат нормализации
 *
 * @remarks
 * Используются Timestamp VO вместо raw number для type safety.
 */
export interface NormalizedOrderbook {
  readonly bids: readonly OrderbookLevel[];
  readonly asks: readonly OrderbookLevel[];
  readonly marketId: string;
  readonly tokenId: string;
  readonly venueTimestamp?: Timestamp;
  readonly receivedAt: Timestamp;
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
    policy: NormalizationPolicy = PERMISSIVE_NORMALIZATION_POLICY
  ): Result<NormalizedOrderbook, OrderbookValidationError | OrderbookInvalidError> {
    // Валидация marketId
    if (!raw.marketId || raw.marketId.trim().length === 0) {
      return Err(
        new OrderbookValidationError('Missing or invalid marketId', {
          context: { field: 'marketId', value: raw.marketId },
        })
      );
    }

    // Валидация tokenId
    if (!raw.tokenId || raw.tokenId.trim().length === 0) {
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
      const bestBidPrice = bids[0].price.value();
      const bestAskPrice = asks[0].price.value();

      // Используем Decimal-сравнение для точности (избегаем float precision issues)
      if (bestBidPrice.gte(bestAskPrice)) {
        return Err(
          new OrderbookInvalidError('Crossed book detected', {
            context: {
              reason: OrderbookInvalidReason.CROSSED_BOOK,
              marketId: raw.marketId,
              tokenId: raw.tokenId,
              bestBid: bestBidPrice.toString(),
              bestAsk: bestAskPrice.toString(),
            },
          })
        );
      }
    }

    // Нормализация timestamps
    const venueTimestamp = this.parseVenueTimestamp(raw.venueTimestamp);
    let receivedAt: Timestamp;
    if (raw.receivedAt === undefined) {
      receivedAt = TimestampService.now();
    } else {
      const receivedResult = TimestampService.create(raw.receivedAt);
      receivedAt = receivedResult.ok ? receivedResult.value : TimestampService.now();
    }

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
   * 1. Парсинг string|number → Price/Quantity VO через safe factory методы
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

    // Шаг 1: Парсинг string|number → VO через safe factory
    for (let i = 0; i < rawLevels.length; i++) {
      const rawLevel = rawLevels[i];

      // Создание Price VO через PriceService.create (принимает string | number | Decimal)
      const priceResult = PriceService.create(rawLevel.price);
      if (!priceResult.ok) {
        return Err(
          new OrderbookValidationError(`Invalid price in ${side}[${i}]: ${priceResult.error.message}`, {
            context: { field: `${side}[${i}].price`, marketId, value: rawLevel.price },
          })
        );
      }

      // Создание Quantity VO через QuantityService.create (принимает string | number | Decimal)
      const quantityResult = QuantityService.create(rawLevel.quantity);
      if (!quantityResult.ok) {
        return Err(
          new OrderbookValidationError(`Invalid quantity in ${side}[${i}]: ${quantityResult.error.message}`, {
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
    const limitedLevels = policy.maxLevelsPerSide !== undefined
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
   * Использует Decimal-арифметику для точного суммирования.
   *
   * @example
   * ```typescript
   * // Input: [0.51@100, 0.51@50, 0.50@200]
   * // Output: [0.51@150, 0.50@200]
   * ```
   */
  private static aggregateLevels(levels: OrderbookLevel[]): OrderbookLevel[] {
    // Используем string key для точного Decimal-сравнения (избегаем float precision issues)
    const priceMap = new Map<string, OrderbookLevel>();

    for (const level of levels) {
      const priceKey = level.price.value().toString();
      const existing = priceMap.get(priceKey);

      if (existing) {
        // Суммируем quantity через Decimal-арифметику
        const newQuantityDecimal = existing.quantity.value().plus(level.quantity.value());
        const quantityResult = QuantityService.create(newQuantityDecimal);
        if (quantityResult.ok) {
          priceMap.set(priceKey, existing.withQuantity(quantityResult.value));
        } else {
          // Теоретически недостижимая ветка: сумма двух валидных Quantity всегда >= 0.
          // При ошибке сохраняем существующий уровень без обновления (quantity нового уровня теряется).
          // eslint-disable-next-line no-console
          console.error('[OrderbookNormalizer] aggregateLevels: quantity sum failed', {
            priceKey,
            newQuantityDecimal: newQuantityDecimal.toString(),
            error: quantityResult.error.message,
          });
        }
      } else {
        priceMap.set(priceKey, level);
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
      // Bids: descending price (highest first) — лучший bid первым
      sorted.sort((a, b) => b.price.value().comparedTo(a.price.value()));
    } else {
      // Asks: ascending price (lowest first) — лучший ask первым
      sorted.sort((a, b) => a.price.value().comparedTo(b.price.value()));
    }

    return sorted;
  }

  /**
   * Парсит venue timestamp в Timestamp VO
   *
   * @param venueTs - Venue timestamp (ISO строка, unix ms number, или undefined)
   * @returns Timestamp VO или undefined если нет/невалиден
   *
   * @remarks
   * Нормализует разные форматы:
   * - number (unix ms): передаётся в TimestampService.create() напрямую
   * - ISO string (например "2024-01-15T10:30:00.000Z"): парсится через Date
   * - numeric string (например "1767463213110"): передаётся в TimestampService.create()
   */
  private static parseVenueTimestamp(venueTs: string | number | undefined): Timestamp | undefined {
    if (venueTs === undefined) {
      return undefined;
    }

    if (typeof venueTs === 'number') {
      const result = TimestampService.create(venueTs);
      return result.ok ? result.value : undefined;
    }

    // Строка: сначала пробуем как число (epoch ms), потом как ISO date
    const asNumber = Number(venueTs);
    if (!Number.isNaN(asNumber)) {
      const result = TimestampService.create(asNumber);
      return result.ok ? result.value : undefined;
    }

    const date = new Date(venueTs);
    if (!Number.isNaN(date.getTime())) {
      const result = TimestampService.create(date.getTime());
      return result.ok ? result.value : undefined;
    }

    return undefined;
  }
}
