/**
 * OrderbookSerializer - адаптер для JSON serialization/deserialization
 *
 * @remarks
 * Отделяет логику сериализации от entity.
 * Использует OrderbookNormalizer для парсинга raw JSON.
 *
 * Поток данных:
 * 1. JSON → RawOrderbook
 * 2. RawOrderbook → OrderbookNormalizer → NormalizedOrderbook
 * 3. NormalizedOrderbook → Orderbook.fromNormalized() → Orderbook
 * 4. Orderbook → toJSON() → JSON
 *
 * @example
 * ```typescript
 * import { OrderbookSerializer } from './OrderbookSerializer';
 *
 * // Deserialization
 * const json = { / * ... * / };
 * const result = OrderbookSerializer.fromJSON(json);
 * if (result.ok) {
 *   const orderbook = result.value;
 * }
 *
 * // Serialization
 * const json = OrderbookSerializer.toJSON(orderbook);
 * ```
 */

import type { Result } from '@polymarket/result';
import { OrderbookValidationError } from '@polymarket/errors';
import { Orderbook } from '../core/Orderbook.js';
import { OrderbookNormalizer } from '../normalizer/OrderbookNormalizer.js';
import { OrderbookInvalidError } from '../errors/OrderbookInvalidError.js';
import type { RawOrderbook } from '../normalizer/types.js';
import type { NormalizationPolicy } from '../normalizer/NormalizationPolicy.js';
import { DEFAULT_NORMALIZATION_POLICY } from '../normalizer/NormalizationPolicy.js';

/**
 * JSON представление Orderbook
 *
 * @remarks
 * Full view с всеми уровнями для полной сериализации.
 */
export interface OrderbookJSON {
  readonly marketId: string;
  readonly tokenId: string;
  readonly venueTimestamp?: number;
  readonly receivedAt: number;
  readonly bids: readonly { price: number; quantity: number }[];
  readonly asks: readonly { price: number; quantity: number }[];
}

/**
 * OrderbookSerializer - статический класс для сериализации
 */
export class OrderbookSerializer {
  /**
   * Deserializes JSON to Orderbook
   *
   * @param json - JSON объект
   * @param policy - Политика нормализации
   * @returns Result<Orderbook, Error>
   *
   * @remarks
   * Использует OrderbookNormalizer для валидации и нормализации.
   *
   * Алгоритм:
   * 1. Преобразование JSON → RawOrderbook
   * 2. Нормализация через OrderbookNormalizer
   * 3. Создание Orderbook через Orderbook.fromNormalized()
   *
   * @example
   * ```typescript
   * const json = {
   *   marketId: 'market-123',
   *   tokenId: 'token-yes',
   *   bids: [{ price: 0.52, quantity: 100 }],
   *   asks: [{ price: 0.53, quantity: 150 }],
   * };
   *
   * const result = OrderbookSerializer.fromJSON(json);
   * if (result.ok) {
   *   console.log('Orderbook loaded:', result.value.toString());
   * } else {
   *   console.error('Failed to load:', result.error.message);
   * }
   * ```
   */
  public static fromJSON(
    json: Record<string, unknown>,
    policy: NormalizationPolicy = DEFAULT_NORMALIZATION_POLICY
  ): Result<Orderbook, OrderbookValidationError | OrderbookInvalidError> {
    // Преобразование JSON → RawOrderbook
    const rawOrderbook: RawOrderbook = {
      marketId: json.marketId as string | undefined,
      tokenId: json.tokenId as string | undefined,
      bids: (json.bids as Array<{ price: number; quantity: number }>) || [],
      asks: (json.asks as Array<{ price: number; quantity: number }>) || [],
      venueTimestamp: json.venueTimestamp as number | string | undefined,
      receivedAt: json.receivedAt as number | undefined,
    };

    // Нормализация через OrderbookNormalizer
    const normalizedResult = OrderbookNormalizer.normalize(rawOrderbook, policy);
    if (!normalizedResult.ok) {
      return normalizedResult;
    }

    // Создание Orderbook
    const orderbook = Orderbook.fromNormalized(normalizedResult.value);
    return { ok: true, value: orderbook };
  }

  /**
   * Serializes Orderbook to JSON
   *
   * @param orderbook - Orderbook entity
   * @returns JSON представление
   *
   * @remarks
   * Возвращает full view с всеми уровнями для полной сериализации.
   *
   * @example
   * ```typescript
   * const json = OrderbookSerializer.toJSON(orderbook);
   * const serialized = JSON.stringify(json);
   *
   * // Восстановление
   * const restored = OrderbookSerializer.fromJSON(JSON.parse(serialized));
   * ```
   */
  public static toJSON(orderbook: Orderbook): OrderbookJSON {
    return {
      marketId: orderbook.instrumentId,
      tokenId: orderbook.asset,
      venueTimestamp: orderbook.venueTimestamp,
      receivedAt: orderbook.receivedAt,
      bids: orderbook.bids.map(level => level.toObject()),
      asks: orderbook.asks.map(level => level.toObject()),
    };
  }

  /**
   * Serializes Orderbook to JSON string
   *
   * @param orderbook - Orderbook entity
   * @param pretty - Format with indentation
   * @returns JSON string
   *
   * @example
   * ```typescript
   * const jsonString = OrderbookSerializer.stringify(orderbook, true);
   * console.log(jsonString);
   * ```
   */
  public static stringify(orderbook: Orderbook, pretty: boolean = false): string {
    const json = this.toJSON(orderbook);
    return pretty ? JSON.stringify(json, null, 2) : JSON.stringify(json);
  }

  /**
   * Deserializes JSON string to Orderbook
   *
   * @param jsonString - JSON string
   * @param policy - Политика нормализации
   * @returns Result<Orderbook, Error>
   *
   * @example
   * ```typescript
   * const jsonString = '{"marketId":"market-123",...}';
   * const result = OrderbookSerializer.parse(jsonString);
   * ```
   */
  public static parse(
    jsonString: string,
    policy: NormalizationPolicy = DEFAULT_NORMALIZATION_POLICY
  ): Result<Orderbook, OrderbookValidationError | OrderbookInvalidError> {
    try {
      const json = JSON.parse(jsonString);
      return this.fromJSON(json, policy);
    } catch (error) {
      return {
        ok: false,
        error: new OrderbookValidationError(
          `Failed to parse JSON: ${(error as Error).message}`,
          { context: { jsonString } }
        ),
      };
    }
  }
}
