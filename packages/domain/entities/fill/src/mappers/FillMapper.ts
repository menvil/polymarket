/**
 * FillMapper - маппер для Fill entity
 *
 * @remarks
 * Отвечает за преобразование между:
 * - Внешним форматом Polymarket API (order execution event) → Fill entity
 * - Fill entity → FillSnapshot (для хранения)
 * - FillSnapshot → Fill entity (для восстановления)
 *
 * ### Принцип единственной ответственности:
 * Fill entity не знает о внешних форматах API.
 * FillMapper инкапсулирует всю логику парсинга.
 *
 * ### Формат Polymarket orderExecutionEvent:
 * ```json
 * {
 *   "fill_id": "fill-123",
 *   "order_id": "order-456",
 *   "account_id": "wallet:0xabc...",
 *   "market": "0xmarket...",
 *   "asset_id": "0xasset...",
 *   "price": "0.65",
 *   "size": "50",
 *   "side": "BUY",
 *   "timestamp": "1700000000",
 *   "fee_amount": "0.01",
 *   "fee_asset": "USDC",
 *   "liquidity": "MAKER",
 *   "transaction_hash": "0xabcdef..."
 * }
 * ```
 *
 * @example
 * ```typescript
 * const result = FillMapper.fromPolymarketOrderExecutionEvent({
 *   fill_id: 'fill-123',
 *   order_id: 'order-456',
 *   // ...
 * });
 * ```
 */

import { Result, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import {
  asFillId,
  asOrderId,
  parseAccountId,
  asVenueId,
  parseAssetId,
  asVenueTradeId,
  asTxHash,
  AssetIdHelpers,
  accountIdToString,
  assetIdToString,
} from '@polymarket/ids';
import { Price, Quantity, TimestampService, Fee } from '@polymarket/value-objects';
import { AssetQuantity } from '@polymarket/value-objects/asset-quantity';
import Decimal from 'decimal.js';
import { Fill } from '../Fill.js';
import type { FillSnapshot } from '../FillSnapshot.js';
import { isValidLiquidity } from '../value-objects/Liquidity.js';

/**
 * ID торговой площадки Polymarket по умолчанию
 * @internal
 */
const POLYMARKET_VENUE_ID = 'POLYMARKET';

/**
 * FillMapper - статический класс-маппер для Fill
 *
 * @remarks
 * Все методы статические. Не имеет состояния.
 */
export class FillMapper {
  /**
   * Создаёт Fill из события Polymarket orderExecutionEvent
   *
   * @param raw - Сырые данные события (Record<string, unknown>)
   * @returns Result<Fill, ValidationError>
   *
   * @remarks
   * Алгоритм:
   * 1. Извлечь и провалидировать обязательные поля
   * 2. Преобразовать в typed value objects
   * 3. Вызвать Fill.create()
   *
   * ### Формат входных данных:
   * - `fill_id` (string) — ID исполнения
   * - `order_id` (string) — ID ордера
   * - `account_id` (string) — строковый AccountId
   * - `market` (string) — ID рынка
   * - `asset_id` (string) — ID токена
   * - `price` (string | number) — цена
   * - `size` (string | number) — объём
   * - `side` (string) — 'BUY' | 'SELL'
   * - `timestamp` (string | number) — Unix timestamp в секундах
   * - `fee_amount` (string | number, optional) — сумма комиссии
   * - `liquidity` (string, optional) — 'MAKER' | 'TAKER'
   * - `transaction_hash` (string, optional) — хэш транзакции
   *
   * @example
   * ```typescript
   * const result = FillMapper.fromPolymarketOrderExecutionEvent({
   *   fill_id: 'fill-123',
   *   order_id: 'order-456',
   *   account_id: 'wallet:0xabc...',
   *   market: '0xmarket...',
   *   asset_id: '...',
   *   price: '0.65',
   *   size: '50',
   *   side: 'BUY',
   *   timestamp: '1700000000',
   * });
   * ```
   */
  public static fromPolymarketOrderExecutionEvent(
    raw: Record<string, unknown>
  ): Result<Fill, ValidationError> {
    // Извлечь fill_id
    const fillIdRaw = raw['fill_id'];
    if (typeof fillIdRaw !== 'string' || fillIdRaw.trim().length === 0) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: missing or invalid fill_id', {
          context: { field: 'fill_id', value: fillIdRaw },
        })
      );
    }

    const fillId = asFillId(fillIdRaw.trim());
    if (!fillId) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: invalid fill_id format', {
          context: { field: 'fill_id', value: fillIdRaw },
        })
      );
    }

    // Извлечь order_id
    const orderIdRaw = raw['order_id'];
    if (typeof orderIdRaw !== 'string' || orderIdRaw.trim().length === 0) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: missing or invalid order_id', {
          context: { field: 'order_id', value: orderIdRaw },
        })
      );
    }

    const orderId = asOrderId(orderIdRaw.trim());
    if (!orderId) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: invalid order_id format', {
          context: { field: 'order_id', value: orderIdRaw },
        })
      );
    }

    // Извлечь account_id
    const accountIdRaw = raw['account_id'];
    if (typeof accountIdRaw !== 'string' || accountIdRaw.trim().length === 0) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: missing or invalid account_id', {
          context: { field: 'account_id', value: accountIdRaw },
        })
      );
    }

    const accountId = parseAccountId(accountIdRaw.trim());
    if (!accountId) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: invalid account_id format', {
          context: { field: 'account_id', value: accountIdRaw },
        })
      );
    }

    // Извлечь marketId
    const marketId = raw['market'];
    if (typeof marketId !== 'string' || marketId.trim().length === 0) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: missing or invalid market', {
          context: { field: 'market', value: marketId },
        })
      );
    }

    // Извлечь asset_id
    const assetIdRaw = raw['asset_id'];
    if (typeof assetIdRaw !== 'string' || assetIdRaw.trim().length === 0) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: missing or invalid asset_id', {
          context: { field: 'asset_id', value: assetIdRaw },
        })
      );
    }

    const tokenId = parseAssetId(assetIdRaw.trim());
    if (!tokenId) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: cannot parse asset_id', {
          context: { field: 'asset_id', value: assetIdRaw },
        })
      );
    }

    // Извлечь price
    const priceRaw = raw['price'];
    if (priceRaw === undefined || priceRaw === null) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: missing price', {
          context: { field: 'price' },
        })
      );
    }

    let priceDecimal: Decimal;
    try {
      priceDecimal = new Decimal(String(priceRaw));
    } catch {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: price is not a valid number', {
          context: { field: 'price', value: priceRaw },
        })
      );
    }

    if (!priceDecimal.isFinite() || priceDecimal.lte(0)) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: price must be positive', {
          context: { field: 'price', value: priceRaw },
        })
      );
    }

    const price = Price.of(priceDecimal);

    // Извлечь size
    const sizeRaw = raw['size'];
    if (sizeRaw === undefined || sizeRaw === null) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: missing size', {
          context: { field: 'size' },
        })
      );
    }

    let sizeDecimal: Decimal;
    try {
      sizeDecimal = new Decimal(String(sizeRaw));
    } catch {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: size is not a valid number', {
          context: { field: 'size', value: sizeRaw },
        })
      );
    }

    if (!sizeDecimal.isFinite() || sizeDecimal.lte(0)) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: size must be positive', {
          context: { field: 'size', value: sizeRaw },
        })
      );
    }

    const size = Quantity.of(sizeDecimal);

    // Извлечь side
    const sideRaw = raw['side'];
    if (sideRaw !== 'BUY' && sideRaw !== 'SELL') {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: side must be BUY or SELL', {
          context: { field: 'side', value: sideRaw },
        })
      );
    }

    const side = sideRaw;

    // Извлечь timestamp
    const timestampRaw = raw['timestamp'];
    if (timestampRaw === undefined || timestampRaw === null) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: missing timestamp', {
          context: { field: 'timestamp' },
        })
      );
    }

    let timestampSec: number;
    try {
      timestampSec = Number(String(timestampRaw));
    } catch {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: timestamp is not a valid number', {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
      return Err(
        new ValidationError('Invalid orderExecutionEvent: timestamp must be positive', {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    const timestampResult = TimestampService.create(timestampSec * 1000);
    if (!timestampResult.ok) {
      return Err(
        new ValidationError(`Invalid orderExecutionEvent: ${timestampResult.error.message}`, {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    // Извлечь fee_amount (опционально, по умолчанию 0)
    const feeAmountRaw = raw['fee_amount'];
    let feeAmount = new Decimal(0);
    if (feeAmountRaw !== undefined && feeAmountRaw !== null) {
      try {
        feeAmount = new Decimal(String(feeAmountRaw));
        if (!feeAmount.isFinite() || feeAmount.lt(0)) {
          feeAmount = new Decimal(0);
        }
      } catch {
        feeAmount = new Decimal(0);
      }
    }

    // Fee asset — всегда USDC для Polymarket (расчётная валюта)
    const feeQuantity = Quantity.of(feeAmount);
    const feeAssetQuantity = new AssetQuantity(AssetIdHelpers.USDC, feeQuantity);
    const fee = Fee.of(feeAssetQuantity);

    // Извлечь liquidity (опционально)
    const liquidityRaw = raw['liquidity'];
    const liquidity = isValidLiquidity(liquidityRaw) ? liquidityRaw : undefined;

    // Извлечь venueTradeId из transaction_hash (опционально)
    const txHashRaw = raw['transaction_hash'];
    const timestampSecNum = timestampSec;
    let venueTradeId;
    if (typeof txHashRaw === 'string' && txHashRaw.trim().length > 0) {
      const txHash = asTxHash(txHashRaw.trim());
      if (txHash) {
        venueTradeId = asVenueTradeId(`${txHash}_${timestampSecNum}`);
      }
    }

    // venueId — Polymarket
    const venueId = asVenueId(POLYMARKET_VENUE_ID);
    if (!venueId) {
      return Err(
        new ValidationError('Cannot create POLYMARKET venue ID', {
          context: { venueId: POLYMARKET_VENUE_ID },
        })
      );
    }

    return Fill.create({
      id: fillId,
      orderId,
      accountId,
      venueId,
      marketId: marketId.trim(),
      tokenId,
      price,
      size,
      side,
      timestamp: timestampResult.value,
      fee,
      liquidity,
      venueTradeId,
    });
  }

  /**
   * Конвертирует Fill в FillSnapshot (плоское DTO с примитивами)
   *
   * @param fill - Запись исполнения
   * @returns FillSnapshot — сериализованное представление для хранения
   *
   * @remarks
   * Вся логика сериализации живёт здесь (SRP: Fill не знает о persistence).
   * AccountId сериализуется через accountIdToString().
   * AssetId сериализуется через assetIdToString().
   *
   * @example
   * ```typescript
   * const snapshot = FillMapper.toSnapshot(fill);
   * await db.save(snapshot);
   * ```
   */
  public static toSnapshot(fill: Fill): FillSnapshot {
    return {
      id: fill.id,
      orderId: fill.orderId,
      accountId: accountIdToString(fill.accountId),
      venueId: fill.venueId,
      marketId: fill.marketId,
      tokenId: assetIdToString(fill.tokenId),
      price: fill.price.value().toNumber(),
      size: fill.size.value().toNumber(),
      side: fill.side,
      timestampMs: fill.timestamp.toNumber(),
      feeAmount: fill.fee.quantity.amount().value().toNumber(),
      feeAsset: assetIdToString(fill.fee.asset),
      liquidity: fill.liquidity,
      venueTradeId: fill.venueTradeId,
    };
  }

  /**
   * Восстанавливает Fill из FillSnapshot
   *
   * @param snapshot - FillSnapshot с примитивами
   * @returns Result<Fill, ValidationError>
   *
   * @remarks
   * Парсит примитивы обратно в типизированные value objects.
   * AccountId парсится через `parseAccountId()`.
   * AssetId парсится через `parseAssetId()`.
   *
   * @example
   * ```typescript
   * const snapshot = await db.load(id);
   * const result = FillMapper.fromSnapshot(snapshot);
   * if (result.ok) {
   *   const fill = result.value;
   * }
   * ```
   */
  public static fromSnapshot(snapshot: FillSnapshot): Result<Fill, ValidationError> {
    const fillId = asFillId(snapshot.id);
    if (!fillId) {
      return Err(
        new ValidationError('Invalid snapshot: invalid fill ID', {
          context: { field: 'id', value: snapshot.id },
        })
      );
    }

    const orderId = asOrderId(snapshot.orderId);
    if (!orderId) {
      return Err(
        new ValidationError('Invalid snapshot: invalid order ID', {
          context: { field: 'orderId', value: snapshot.orderId },
        })
      );
    }

    const accountIdParsed = parseAccountId(snapshot.accountId);
    if (!accountIdParsed) {
      return Err(
        new ValidationError('Invalid snapshot: invalid account ID format', {
          context: { field: 'accountId', value: snapshot.accountId },
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

    const timestampResult = TimestampService.create(snapshot.timestampMs);
    if (!timestampResult.ok) {
      return Err(
        new ValidationError(`Invalid snapshot: ${timestampResult.error.message}`, {
          context: { field: 'timestampMs', value: snapshot.timestampMs },
        })
      );
    }

    // Восстановить fee
    const feeAssetId = parseAssetId(snapshot.feeAsset);
    if (!feeAssetId) {
      return Err(
        new ValidationError('Invalid snapshot: cannot parse feeAsset', {
          context: { field: 'feeAsset', value: snapshot.feeAsset },
        })
      );
    }

    let feeAmountDecimal: Decimal;
    try {
      feeAmountDecimal = new Decimal(snapshot.feeAmount);
    } catch {
      return Err(
        new ValidationError('Invalid snapshot: feeAmount is not a valid number', {
          context: { field: 'feeAmount', value: snapshot.feeAmount },
        })
      );
    }

    const feeQuantity = Quantity.of(feeAmountDecimal);
    const feeAssetQuantity = new AssetQuantity(feeAssetId, feeQuantity);
    const fee = Fee.of(feeAssetQuantity);

    const venueTradeId =
      snapshot.venueTradeId !== undefined
        ? asVenueTradeId(snapshot.venueTradeId)
        : undefined;

    return Fill.create({
      id: fillId,
      orderId,
      accountId: accountIdParsed,
      venueId,
      marketId: snapshot.marketId,
      tokenId,
      price,
      size,
      side: snapshot.side,
      timestamp: timestampResult.value,
      fee,
      liquidity: snapshot.liquidity,
      venueTradeId,
    });
  }
}

