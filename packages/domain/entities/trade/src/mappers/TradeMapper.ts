/**
 * TradeMapper - маппер для Trade entity
 *
 * @remarks
 * Отвечает за преобразование между:
 * - Внешним форматом Polymarket API → Trade entity
 * - Trade entity → TradeSnapshot (для хранения)
 * - TradeSnapshot → Trade entity (для восстановления)
 *
 * ### Принцип единственной ответственности:
 * Trade entity не знает о внешних форматах API.
 * TradeMapper инкапсулирует всю логику парсинга.
 *
 * ### Формат Polymarket lastTradeEvent:
 * ```json
 * {
 *   "market": "0xmarket...",
 *   "asset_id": "0xasset...",
 *   "price": "0.65",
 *   "size": "100",
 *   "side": "BUY",
 *   "timestamp": "1700000000",
 *   "transaction_hash": "0xabcdef..."
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Парсинг события из Polymarket API
 * const result = TradeMapper.fromPolymarketLastTradeEvent({
 *   market: '0xmarket...',
 *   asset_id: '0xasset...',
 *   price: '0.65',
 *   size: '100',
 *   side: 'BUY',
 *   timestamp: '1700000000',
 *   transaction_hash: '0xabcdef...'
 * });
 *
 * if (result.ok) {
 *   const trade = result.value;
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import { asVenueTradeId, asVenueId, parseAssetId, asTxHash } from '@polymarket/ids';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import { Trade } from '../Trade.js';
import type { TradeSnapshot } from '../TradeSnapshot.js';

/**
 * ID торговой площадки Polymarket по умолчанию
 * @internal
 */
const POLYMARKET_VENUE_ID = 'POLYMARKET';

/**
 * TradeMapper - статический класс-маппер для Trade
 *
 * @remarks
 * Все методы статические. Не имеет состояния.
 */
export class TradeMapper {
  /**
   * Создаёт Trade из события Polymarket lastTradeEvent
   *
   * @param raw - Сырые данные события (Record<string, unknown>)
   * @returns Result<Trade, ValidationError>
   *
   * @remarks
   * Алгоритм:
   * 1. Извлечь и провалидировать поля из raw объекта
   * 2. Преобразовать в typed value objects
   * 3. Сгенерировать VenueTradeId = transaction_hash + '_' + timestamp
   * 4. Вызвать Trade.create()
   *
   * ### Формат входных данных:
   * - `market` (string) — ID рынка
   * - `asset_id` (string) — ID токена
   * - `price` (string | number) — цена как строка
   * - `size` (string | number) — объём как строка
   * - `side` (string) — 'BUY' | 'SELL' (агрессор)
   * - `timestamp` (string | number) — Unix timestamp в секундах
   * - `transaction_hash` (string, optional) — хэш транзакции
   *
   * @example
   * ```typescript
   * const result = TradeMapper.fromPolymarketLastTradeEvent({
   *   market: '0x1234...',
   *   asset_id: '0xasset...',
   *   price: '0.65',
   *   size: '100',
   *   side: 'BUY',
   *   timestamp: '1700000000',
   *   transaction_hash: '0xabcdef...'
   * });
   * ```
   */
  public static fromPolymarketLastTradeEvent(
    raw: Record<string, unknown>
  ): Result<Trade, ValidationError> {
    // Извлечь marketId
    const marketId = raw['market'];
    if (typeof marketId !== 'string' || marketId.trim().length === 0) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: missing or invalid market', {
          context: { field: 'market', value: marketId },
        })
      );
    }

    // Извлечь assetId
    const assetIdRaw = raw['asset_id'];
    if (typeof assetIdRaw !== 'string' || assetIdRaw.trim().length === 0) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: missing or invalid asset_id', {
          context: { field: 'asset_id', value: assetIdRaw },
        })
      );
    }

    const tokenId = parseAssetId(assetIdRaw.trim());
    if (!tokenId) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: cannot parse asset_id', {
          context: { field: 'asset_id', value: assetIdRaw },
        })
      );
    }

    // Извлечь price
    const priceRaw = raw['price'];
    if (priceRaw === undefined || priceRaw === null) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: missing price', {
          context: { field: 'price', value: priceRaw },
        })
      );
    }

    let priceDecimal: Decimal;
    try {
      priceDecimal = new Decimal(String(priceRaw));
    } catch {
      return Err(
        new ValidationError('Invalid lastTradeEvent: price is not a valid number', {
          context: { field: 'price', value: priceRaw },
        })
      );
    }

    if (!priceDecimal.isFinite() || priceDecimal.lte(0)) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: price must be positive', {
          context: { field: 'price', value: priceRaw },
        })
      );
    }

    const price = Price.of(priceDecimal);

    // Извлечь size
    const sizeRaw = raw['size'];
    if (sizeRaw === undefined || sizeRaw === null) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: missing size', {
          context: { field: 'size', value: sizeRaw },
        })
      );
    }

    let sizeDecimal: Decimal;
    try {
      sizeDecimal = new Decimal(String(sizeRaw));
    } catch {
      return Err(
        new ValidationError('Invalid lastTradeEvent: size is not a valid number', {
          context: { field: 'size', value: sizeRaw },
        })
      );
    }

    if (!sizeDecimal.isFinite() || sizeDecimal.lte(0)) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: size must be positive', {
          context: { field: 'size', value: sizeRaw },
        })
      );
    }

    const size = Quantity.of(sizeDecimal);

    // Извлечь timestamp (в секундах от Polymarket, конвертируем в ms)
    const timestampRaw = raw['timestamp'];
    if (timestampRaw === undefined || timestampRaw === null) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: missing timestamp', {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    let timestampSec: number;
    try {
      timestampSec = Number(String(timestampRaw));
    } catch {
      return Err(
        new ValidationError('Invalid lastTradeEvent: timestamp is not a valid number', {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: timestamp must be positive', {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    const timestampResult = Timestamp.fromEpochMs(timestampSec * 1000);
    if (!timestampResult.ok) {
      return Err(
        new ValidationError(`Invalid lastTradeEvent: ${timestampResult.error.message}`, {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    const timestamp = timestampResult.value;

    // Извлечь transaction_hash (опционально)
    const txHashRaw = raw['transaction_hash'];
    const txHash =
      typeof txHashRaw === 'string' && txHashRaw.trim().length > 0
        ? asTxHash(txHashRaw.trim())
        : undefined;

    // Генерировать VenueTradeId из transaction_hash + '_' + timestamp
    const tradeIdString =
      txHash !== undefined
        ? `${txHash}_${timestampSec}`
        : `${marketId.trim()}_${assetIdRaw.trim()}_${timestampSec}`;

    const tradeId = asVenueTradeId(tradeIdString);
    if (!tradeId) {
      return Err(
        new ValidationError('Cannot generate VenueTradeId from event data', {
          context: { tradeIdString },
        })
      );
    }

    // Извлечь aggressorSide (опционально)
    const sideRaw = raw['side'];
    const aggressorSide =
      sideRaw === 'BUY' || sideRaw === 'SELL' ? sideRaw : undefined;

    // venueId — Polymarket
    const venueId = asVenueId(POLYMARKET_VENUE_ID);
    if (!venueId) {
      return Err(
        new ValidationError('Cannot create POLYMARKET venue ID', {
          context: { venueId: POLYMARKET_VENUE_ID },
        })
      );
    }

    return Trade.create({
      id: tradeId,
      venueId,
      marketId: marketId.trim(),
      tokenId,
      price,
      size,
      aggressorSide,
      timestamp,
      txHash,
    });
  }

  /**
   * Конвертирует Trade в TradeSnapshot
   *
   * @param trade - Trade entity
   * @returns TradeSnapshot — плоское DTO с примитивами
   *
   * @remarks
   * Делегирует в trade.toSnapshot().
   *
   * @example
   * ```typescript
   * const snapshot = TradeMapper.toSnapshot(trade);
   * await db.save(snapshot);
   * ```
   */
  public static toSnapshot(trade: Trade): TradeSnapshot {
    return trade.toSnapshot();
  }

  /**
   * Восстанавливает Trade из TradeSnapshot
   *
   * @param snapshot - TradeSnapshot с примитивами
   * @returns Result<Trade, ValidationError>
   *
   * @remarks
   * Алгоритм:
   * 1. Парсим примитивы в typed types
   * 2. Создаём value objects
   * 3. Вызываем Trade.create()
   *
   * @example
   * ```typescript
   * const snapshot = await db.load(id);
   * const result = TradeMapper.fromSnapshot(snapshot);
   * if (result.ok) {
   *   const trade = result.value;
   * }
   * ```
   */
  public static fromSnapshot(snapshot: TradeSnapshot): Result<Trade, ValidationError> {
    const tradeId = asVenueTradeId(snapshot.id);
    if (!tradeId) {
      return Err(
        new ValidationError('Invalid snapshot: invalid trade ID', {
          context: { field: 'id', value: snapshot.id },
        })
      );
    }

    const venueId = asVenueId(snapshot.venueId);
    if (!venueId) {
      return Err(
        new ValidationError('Invalid snapshot: invalid venue ID', {
          context: { field: 'venueId', value: snapshot.venueId },
        })
      );
    }

    if (!snapshot.marketId || snapshot.marketId.trim().length === 0) {
      return Err(
        new ValidationError('Invalid snapshot: missing marketId', {
          context: { field: 'marketId' },
        })
      );
    }

    const tokenId = parseAssetId(snapshot.tokenId);
    if (!tokenId) {
      return Err(
        new ValidationError('Invalid snapshot: cannot parse tokenId', {
          context: { field: 'tokenId', value: snapshot.tokenId },
        })
      );
    }

    let priceDecimal: Decimal;
    try {
      priceDecimal = new Decimal(snapshot.price);
    } catch {
      return Err(
        new ValidationError('Invalid snapshot: price is not a valid number', {
          context: { field: 'price', value: snapshot.price },
        })
      );
    }

    const price = Price.of(priceDecimal);

    let sizeDecimal: Decimal;
    try {
      sizeDecimal = new Decimal(snapshot.size);
    } catch {
      return Err(
        new ValidationError('Invalid snapshot: size is not a valid number', {
          context: { field: 'size', value: snapshot.size },
        })
      );
    }

    const size = Quantity.of(sizeDecimal);

    const timestampResult = Timestamp.fromEpochMs(snapshot.timestampMs);
    if (!timestampResult.ok) {
      return Err(
        new ValidationError(`Invalid snapshot: ${timestampResult.error.message}`, {
          context: { field: 'timestampMs', value: snapshot.timestampMs },
        })
      );
    }

    const txHash =
      snapshot.txHash !== undefined ? asTxHash(snapshot.txHash) : undefined;

    return Trade.create({
      id: tradeId,
      venueId,
      marketId: snapshot.marketId,
      tokenId,
      price,
      size,
      aggressorSide: snapshot.aggressorSide,
      timestamp: timestampResult.value,
      txHash,
    });
  }
}
