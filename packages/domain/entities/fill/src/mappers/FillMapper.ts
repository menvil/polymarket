/**
 * FillMapper - маппер для Fill entity
 *
 * @remarks
 * Отвечает за преобразование между:
 * - Внешним форматом Polymarket WebSocket user-channel trade события → Fill + ExecutionMetadata
 * - Fill + ExecutionMetadata → FillSnapshot (для хранения)
 * - FillSnapshot → Fill + ExecutionMetadata (для восстановления)
 *
 * FUTURE: Этот класс совмещает две разные ответственности и подлежит разделению.
 * Когда архитектура устоится, разбить на:
 *
 * 1. `PolymarketTradeEventParser` (infrastructure layer)
 *    - Содержит: fromPolymarketTradeEvent()
 *    - Знает о формате Polymarket WS user-channel API (специфика одного venue)
 *    - При появлении второго venue — добавить BinanceTradeEventParser и т.д.
 *    - Переехать в: packages/infrastructure/adapters/polymarket/
 *
 * 2. `FillSnapshotMapper` (domain layer, рядом с Fill)
 *    - Содержит: toSnapshot() + fromSnapshot()
 *    - Persistence concern: сериализация для DB/Redis/лога
 *    - Всегда меняется вместе (snapshot schema — единый контракт)
 *    - Остаётся в: packages/domain/entities/fill/
 *
 * ### Принцип единственной ответственности:
 * Fill entity не знает о внешних форматах API.
 * FillMapper инкапсулирует всю логику парсинга.
 *
 * ### Разделение Fill и ExecutionMetadata:
 * Fill содержит доменную экономику (price, size, side, fee, settlementAssetId).
 * ExecutionMetadata содержит инфраструктурный контекст (liquidity, venueTradeId, tradeStatus).
 *
 * ### Формат Polymarket user-channel trade события:
 * ```json
 * {
 *   "event_type": "trade",
 *   "type": "TRADE",
 *   "id": "28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e",
 *   "taker_order_id": "0x06bc63...",
 *   "market": "0xbd31dc8a...",
 *   "asset_id": "52114319501245...",
 *   "side": "BUY",
 *   "size": "10",
 *   "price": "0.57",
 *   "fee_rate_bps": "0",
 *   "status": "MATCHED",
 *   "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
 *   "timestamp": "1672290701",
 *   "trader_side": "TAKER",
 *   "transaction_hash": "0xabcdef...",
 *   "maker_orders": [{ "order_id": "0xff...", "matched_amount": "10", "price": "0.57", "owner": "uuid" }]
 * }
 * ```
 *
 * ### Логика TAKER vs MAKER:
 * - `trader_side = "TAKER"`: orderId = `taker_order_id`, side/size/price из верхнего уровня
 * - `trader_side = "MAKER"`: orderId из `maker_orders` (matched by owner UUID), side инвертирован
 *
 * ### Расчёт комиссии:
 * fee_amount = price × size × fee_rate_bps / 10000
 *
 * @example
 * ```typescript
 * const accountId = parseAccountId('wallet:0xabc...');
 * const result = FillMapper.fromPolymarketTradeEvent(rawEvent, accountId);
 * if (result.ok) {
 *   const { fill, metadata } = result.value;
 *   console.log(fill.getCashFlow()); // экономика
 *   console.log(metadata.liquidity); // инфраструктурный контекст
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { AccountId } from '@polymarket/ids';
import {
  asFillId,
  asOrderId,
  asVenueId,
  asMarketId,
  parseAssetId,
  parseAccountId,
  asVenueTradeId,
  AssetIdHelpers,
  accountIdToString,
  assetIdToString,
} from '@polymarket/ids';
import { Price, Quantity, TimestampService, Fee } from '@polymarket/value-objects';
import { AssetQuantity } from '@polymarket/value-objects/asset-quantity';
import Decimal from 'decimal.js';
import { Fill } from '../Fill.js';
import type { FillSnapshot } from '../FillSnapshot.js';
import type { ExecutionMetadata, TradeStatus } from '../ExecutionMetadata.js';

/**
 * ID торговой площадки Polymarket по умолчанию
 * @internal
 */
const POLYMARKET_VENUE_ID = 'POLYMARKET';

/**
 * Валидные статусы трейда из Polymarket user-channel
 * @internal
 */
const VALID_TRADE_STATUSES: ReadonlySet<string> = new Set([
  'MATCHED',
  'MINED',
  'CONFIRMED',
  'RETRYING',
  'FAILED',
]);

/**
 * FillMapper - статический класс-маппер для Fill
 *
 * @remarks
 * Все методы статические. Не имеет состояния.
 */
export class FillMapper {
  /**
   * Создаёт Fill и ExecutionMetadata из события Polymarket user-channel trade
   *
   * @param raw - Сырые данные события (Record<string, unknown>)
   * @param accountId - AccountId пользователя (из сессионного контекста, не из события)
   * @returns Result<{ fill: Fill; metadata: ExecutionMetadata }, ValidationError>
   *
   * @remarks
   * Алгоритм:
   * 1. Определить тип участника (`trader_side`: TAKER или MAKER)
   * 2. TAKER: orderId = `taker_order_id`, side/size/price из верхнего уровня события
   * 3. MAKER: orderId из `maker_orders[n].order_id` (n = индекс по owner UUID), side инвертирован
   * 4. Вычислить fee: `price × size × fee_rate_bps / 10000`
   * 5. Создать Fill с settlementAssetId = USDC
   * 6. Собрать ExecutionMetadata: liquidity (из trader_side), tradeStatus (из status), venueTradeId (из transaction_hash)
   *
   * ### Формат входных данных (real Polymarket user-channel trade event):
   * - `id` (string) — UUID трейда → FillId
   * - `taker_order_id` (string) — OrderId тейкера (hex)
   * - `market` (string) — ID рынка (hex)
   * - `asset_id` (string) — ID токена (числовой ERC1155 ID или internal строка)
   * - `side` (string, optional) — 'BUY' | 'SELL' (сторона ТЕЙКЕРА; отсутствует в MAKER-событиях)
   * - `size` (string) — объём тейкера
   * - `price` (string) — цена
   * - `fee_rate_bps` (string) — ставка комиссии в базисных пунктах (0 = no fee)
   * - `status` (string) — 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED'
   * - `owner` (string) — UUID пользователя (не используется напрямую)
   * - `timestamp` (string) — Unix timestamp в миллисекундах (13 цифр, не в секундах)
   * - `trader_side` (string) — 'TAKER' | 'MAKER'
   * - `transaction_hash` (string, optional) — хэш транзакции → venueTradeId
   * - `maker_orders` (array, optional) — записи мейкеров [{ order_id, matched_amount, price, owner }]
   *
   * @example
   * ```typescript
   * const accountId = parseAccountId('wallet:0xabc...')!;
   * const result = FillMapper.fromPolymarketTradeEvent({
   *   id: '28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e',
   *   taker_order_id: '0x06bc63...',
   *   market: '0xbd31dc8a...',
   *   asset_id: 'OUTCOME_TOKEN:...',
   *   price: '0.57',
   *   size: '10',
   *   side: 'BUY',
   *   fee_rate_bps: '0',
   *   status: 'MATCHED',
   *   timestamp: '1672290701',
   *   trader_side: 'TAKER',
   *   transaction_hash: '0xabcdef...',
   * }, accountId);
   * if (result.ok) {
   *   const { fill, metadata } = result.value;
   * }
   * ```
   */
  public static fromPolymarketTradeEvent(
    raw: Record<string, unknown>,
    accountId: AccountId
  ): Result<{ fill: Fill; metadata: ExecutionMetadata }, ValidationError> {
    // Защита от null/примитивов на уровне runtime (TypeScript защищает только на уровне компилятора)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return Err(
        new ValidationError('Trade event must be a non-null object', {
          context: { received: typeof raw },
        })
      );
    }

    // Извлечь fill id (UUID трейда)
    const idRaw = raw['id'];
    if (typeof idRaw !== 'string' || idRaw.trim().length === 0) {
      return Err(
        new ValidationError('Invalid trade event: missing or invalid id', {
          context: { field: 'id', value: idRaw },
        })
      );
    }

    const fillId = asFillId(idRaw.trim());
    if (!fillId) {
      return Err(
        new ValidationError('Invalid trade event: invalid id format', {
          context: { field: 'id', value: idRaw },
        })
      );
    }

    // Извлечь trader_side — определяет логику TAKER vs MAKER
    const traderSideRaw = raw['trader_side'];
    if (traderSideRaw !== 'TAKER' && traderSideRaw !== 'MAKER') {
      return Err(
        new ValidationError('Invalid trade event: trader_side must be TAKER or MAKER', {
          context: { field: 'trader_side', value: traderSideRaw },
        })
      );
    }

    const isMaker = traderSideRaw === 'MAKER';

    // Извлечь и распарсить marketId
    const marketIdParsed = asMarketId(typeof raw['market'] === 'string' ? raw['market'] : '');
    if (!marketIdParsed) {
      return Err(
        new ValidationError('Invalid trade event: missing or invalid market', {
          context: { field: 'market', value: raw['market'] },
        })
      );
    }

    // Извлечь asset_id (tokenId)
    const assetIdRaw = raw['asset_id'];
    if (typeof assetIdRaw !== 'string' || assetIdRaw.trim().length === 0) {
      return Err(
        new ValidationError('Invalid trade event: missing or invalid asset_id', {
          context: { field: 'asset_id', value: assetIdRaw },
        })
      );
    }

    const tokenId = parseAssetId(assetIdRaw.trim());
    if (!tokenId) {
      return Err(
        new ValidationError('Invalid trade event: cannot parse asset_id', {
          context: { field: 'asset_id', value: assetIdRaw },
        })
      );
    }

    // Извлечь timestamp
    const timestampRaw = raw['timestamp'];
    if (timestampRaw === undefined || timestampRaw === null) {
      return Err(
        new ValidationError('Invalid trade event: missing timestamp', {
          context: { field: 'timestamp' },
        })
      );
    }

    // Polymarket fill события шлют timestamp в миллисекундах (13 цифр, ~1.7e12).
    // Для обратной совместимости: если значение < 1e12 — считаем секундами и умножаем на 1000.
    const timestampRawNum = Number(String(timestampRaw));
    if (!Number.isFinite(timestampRawNum) || timestampRawNum <= 0) {
      return Err(
        new ValidationError('Invalid trade event: timestamp must be a positive number', {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }
    const timestampMs = timestampRawNum < 1e12 ? timestampRawNum * 1000 : timestampRawNum;

    const timestampResult = TimestampService.create(timestampMs);
    if (!timestampResult.ok) {
      return Err(
        new ValidationError(`Invalid trade event: ${timestampResult.error.message}`, {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    // Логика TAKER vs MAKER: определяем orderId, side, size, price, и effectiveTokenId.
    // В cross-outcome fills (тейкер DOWN, мы мейкер UP) top-level asset_id = DOWN токен (тейкерский).
    // Для MAKER нужно использовать asset_id из нашей записи в maker_orders[], а не top-level.
    let orderId;
    let side: 'BUY' | 'SELL';
    let priceDecimal: Decimal;
    let sizeDecimal: Decimal;
    // По умолчанию — top-level tokenId. MAKER-ветка может переопределить.
    let effectiveTokenId = tokenId;

    if (!isMaker) {
      // TAKER: orderId из taker_order_id, side/size/price из верхнего уровня
      const takerOrderIdRaw = raw['taker_order_id'];
      if (typeof takerOrderIdRaw !== 'string' || takerOrderIdRaw.trim().length === 0) {
        return Err(
          new ValidationError('Invalid trade event: missing or invalid taker_order_id', {
            context: { field: 'taker_order_id', value: takerOrderIdRaw },
          })
        );
      }

      orderId = asOrderId(takerOrderIdRaw.trim());
      if (!orderId) {
        return Err(
          new ValidationError('Invalid trade event: invalid taker_order_id format', {
            context: { field: 'taker_order_id', value: takerOrderIdRaw },
          })
        );
      }

      // side тейкера из верхнего уровня.
      // В cross-outcome fills (тейкер BUY токен A, мейкеры BUY токен B) Polymarket
      // не включает top-level side. Определяем по asset_id:
      // - одинаковые asset_id → обычный fill, side обязателен
      // - разные asset_id → cross-outcome → тейкер всегда BUY (обе стороны покупают за $1 пару)
      const takerSideRaw = raw['side'];
      if (takerSideRaw === 'BUY' || takerSideRaw === 'SELL') {
        side = takerSideRaw;
      } else {
        // Fallback для cross-outcome: проверяем совпадение asset_id с maker_orders
        const makerOrdersRaw = raw['maker_orders'];
        const makerOrders = Array.isArray(makerOrdersRaw) ? makerOrdersRaw : [];
        const isEntry = (o: unknown): o is Record<string, unknown> =>
          o !== null && typeof o === 'object';
        const firstMakerAssetId = makerOrders.length > 0 && isEntry(makerOrders[0])
          ? makerOrders[0]['asset_id']
          : undefined;

        if (typeof firstMakerAssetId === 'string' && firstMakerAssetId !== assetIdRaw.trim()) {
          // Cross-outcome: тейкер всегда BUY своего токена
          side = 'BUY';
        } else {
          // Same-asset fill без top-level side: тейкер — противоположная сторона от мейкера.
          // Например: мейкер BUY → тейкер SELL (продаём в ожидающий BUY-ордер).
          // Это происходит когда наш лимитный ордер исполняется немедленно как taker.
          const firstMakerSideRaw = makerOrders.length > 0 && isEntry(makerOrders[0])
            ? makerOrders[0]['side']
            : undefined;
          if (firstMakerSideRaw === 'BUY') {
            side = 'SELL';
          } else if (firstMakerSideRaw === 'SELL') {
            side = 'BUY';
          } else {
            return Err(
              new ValidationError('Invalid trade event: side must be BUY or SELL', {
                context: { field: 'side', value: takerSideRaw },
              })
            );
          }
        }
      }

      const priceResult = parseDecimalPositive(raw['price'], 'price');
      if (!priceResult.ok) return Err(priceResult.error);
      priceDecimal = priceResult.value;

      const sizeResult = parseDecimalPositive(raw['size'], 'size');
      if (!sizeResult.ok) return Err(sizeResult.error);
      sizeDecimal = sizeResult.value;
    } else {
      // MAKER: orderId из maker_orders.
      // Поиск нашего ордера: сначала по owner UUID, затем по maker_address (ETH wallet).
      // В cross-outcome fills (тейкер продаёт DOWN, мы мейкер UP) top-level owner = UUID тейкера,
      // поэтому fallback на maker_address обязателен.
      const ownerRaw = raw['owner'];
      const makerAddressRaw = raw['maker_address']; // наш ETH-адрес, injected из credentials
      const makerOrdersRaw = raw['maker_orders'];
      const makerOrders = Array.isArray(makerOrdersRaw) ? makerOrdersRaw : [];

      // Поиск по owner UUID (прямые fills) или по maker_address (cross-outcome fills)
      const isEntry = (o: unknown): o is Record<string, unknown> =>
        o !== null && typeof o === 'object';

      let makerOrder = typeof ownerRaw === 'string' && ownerRaw.length > 0
        ? makerOrders.find(
            (o) => isEntry(o) && (o as Record<string, unknown>)['owner'] === ownerRaw
          )
        : undefined;

      if (!makerOrder && typeof makerAddressRaw === 'string' && makerAddressRaw.length > 0) {
        const addrLower = makerAddressRaw.toLowerCase();
        makerOrder = makerOrders.find(
          (o) => isEntry(o) &&
            typeof (o as Record<string, unknown>)['maker_address'] === 'string' &&
            ((o as Record<string, unknown>)['maker_address'] as string).toLowerCase() === addrLower
        );
      }

      if (!makerOrder) {
        return Err(
          new ValidationError(
            'Invalid trade event: cannot identify our maker_order (tried owner UUID and maker_address)',
            {
              context: {
                owner: ownerRaw,
                maker_address: makerAddressRaw,
                makerOrderCount: makerOrders.length,
              },
            }
          )
        );
      }

      const makerOrderRecord = makerOrder as Record<string, unknown>;

      // В cross-outcome fills maker_orders[].asset_id — это наш токен (UP/DOWN),
      // а top-level asset_id — токен тейкера (противоположный исход).
      // Используем asset_id из нашей maker_order записи если он присутствует.
      const makerAssetIdRaw = makerOrderRecord['asset_id'];
      if (typeof makerAssetIdRaw === 'string' && makerAssetIdRaw.trim().length > 0) {
        const parsedMakerAsset = parseAssetId(makerAssetIdRaw.trim());
        if (parsedMakerAsset) {
          effectiveTokenId = parsedMakerAsset;
        }
      }

      const makerOrderIdRaw = makerOrderRecord['order_id'];
      if (typeof makerOrderIdRaw !== 'string' || makerOrderIdRaw.trim().length === 0) {
        return Err(
          new ValidationError('Invalid trade event: missing order_id in maker_orders entry', {
            context: { field: 'maker_orders[].order_id', value: makerOrderIdRaw },
          })
        );
      }

      orderId = asOrderId(makerOrderIdRaw.trim());
      if (!orderId) {
        return Err(
          new ValidationError('Invalid trade event: invalid order_id in maker_orders entry', {
            context: { field: 'maker_orders[].order_id', value: makerOrderIdRaw },
          })
        );
      }

      // Сторона мейкера — берём из maker_orders[].side (реальный формат Polymarket).
      // Если поле отсутствует (старый формат/тесты) — инвертируем тейкерский side.
      const makerSideRaw = makerOrderRecord['side'];
      if (makerSideRaw === 'BUY' || makerSideRaw === 'SELL') {
        side = makerSideRaw;
      } else {
        // Fallback: инвертируем top-level side тейкера (требует его наличия)
        const takerSideRaw = raw['side'];
        if (takerSideRaw !== 'BUY' && takerSideRaw !== 'SELL') {
          return Err(
            new ValidationError(
              'Invalid trade event: cannot determine maker side — no side in maker_orders entry and no valid top-level side',
              { context: { field: 'side / maker_orders[].side', value: takerSideRaw } }
            )
          );
        }
        side = takerSideRaw === 'BUY' ? 'SELL' : 'BUY';
      }

      // Цена мейкера из maker_orders (может отличаться для limit ордеров)
      // Не используем fallback на taker-данные: отсутствие поля = ошибка парсинга
      const makerPriceRaw = makerOrderRecord['price'];
      const priceResult = parseDecimalPositive(makerPriceRaw, 'maker_orders[].price');
      if (!priceResult.ok) return Err(priceResult.error);
      priceDecimal = priceResult.value;

      // Объём мейкера из matched_amount (только его часть трейда)
      // Не используем fallback на taker-данные: отсутствие поля = ошибка парсинга
      const matchedAmountRaw = makerOrderRecord['matched_amount'];
      const sizeResult = parseDecimalPositive(matchedAmountRaw, 'maker_orders[].matched_amount');
      if (!sizeResult.ok) return Err(sizeResult.error);
      sizeDecimal = sizeResult.value;
    }

    const price = Price.of(priceDecimal);
    const size = Quantity.of(sizeDecimal);

    // Вычислить fee из fee_rate_bps: fee_amount = price × size × fee_rate_bps / 10000
    const feeRateBpsRaw = raw['fee_rate_bps'];
    let feeAmount = new Decimal(0);
    if (feeRateBpsRaw !== undefined && feeRateBpsRaw !== null) {
      try {
        const feeRateBps = new Decimal(String(feeRateBpsRaw));
        if (feeRateBps.isFinite() && feeRateBps.gt(0)) {
          feeAmount = priceDecimal.mul(sizeDecimal).mul(feeRateBps).div(10000);
        }
      } catch {
        // Невалидный fee_rate_bps → комиссия = 0
      }
    }

    const feeQuantity = Quantity.of(feeAmount);
    const feeAssetQuantity = new AssetQuantity(AssetIdHelpers.USDC, feeQuantity);
    const fee = Fee.of(feeAssetQuantity);

    // venueId — Polymarket
    const venueId = asVenueId(POLYMARKET_VENUE_ID);
    if (!venueId) {
      return Err(
        new ValidationError('Cannot create POLYMARKET venue ID', {
          context: { venueId: POLYMARKET_VENUE_ID },
        })
      );
    }

    // Создать Fill с settlementAssetId = USDC
    // effectiveTokenId: для MAKER = asset_id из maker_orders[] (наш токен, а не тейкерский)
    const fillResult = Fill.create({
      id: fillId,
      orderId,
      accountId,
      venueId,
      marketId: marketIdParsed,
      tokenId: effectiveTokenId,
      settlementAssetId: AssetIdHelpers.USDC,
      price,
      size,
      side,
      timestamp: timestampResult.value,
      fee,
    });

    if (!fillResult.ok) {
      return Err(fillResult.error);
    }

    // Собрать ExecutionMetadata
    const liquidity = traderSideRaw === 'MAKER' ? 'MAKER' : 'TAKER';

    const statusRaw = raw['status'];
    const tradeStatus =
      typeof statusRaw === 'string' && VALID_TRADE_STATUSES.has(statusRaw)
        ? (statusRaw as TradeStatus)
        : undefined;

    const txHashRaw = raw['transaction_hash'];
    let venueTradeId;
    if (typeof txHashRaw === 'string' && txHashRaw.trim().length > 0) {
      venueTradeId = asVenueTradeId(txHashRaw.trim()) ?? undefined;
    }

    const metadata: ExecutionMetadata = { liquidity, tradeStatus, venueTradeId };

    return Ok({ fill: fillResult.value, metadata });
  }

  /**
   * Конвертирует Fill в FillSnapshot (плоское DTO с примитивами)
   *
   * @param fill - Запись исполнения
   * @param metadata - Опциональные инфраструктурные метаданные
   * @returns FillSnapshot — сериализованное представление для хранения
   *
   * @remarks
   * Вся логика сериализации живёт здесь (SRP: Fill не знает о persistence).
   * AccountId сериализуется через accountIdToString().
   * AssetId сериализуется через assetIdToString().
   * metadata.liquidity, metadata.venueTradeId и metadata.tradeStatus включаются если metadata передан.
   *
   * @example
   * ```typescript
   * const snapshot = FillMapper.toSnapshot(fill, metadata);
   * await db.save(snapshot);
   * ```
   */
  public static toSnapshot(fill: Fill, metadata?: ExecutionMetadata): FillSnapshot {
    return {
      id: fill.id,
      orderId: fill.orderId,
      accountId: accountIdToString(fill.accountId),
      venueId: fill.venueId,
      marketId: fill.marketId,
      tokenId: assetIdToString(fill.tokenId),
      settlementAssetId: assetIdToString(fill.settlementAssetId),
      price: fill.price.value().toNumber(),
      size: fill.size.value().toNumber(),
      side: fill.side,
      timestampMs: fill.timestamp.toNumber(),
      feeAmount: fill.fee.quantity.amount().value().toNumber(),
      feeAsset: assetIdToString(fill.fee.asset),
      liquidity: metadata?.liquidity,
      venueTradeId: metadata?.venueTradeId,
      tradeStatus: metadata?.tradeStatus,
    };
  }

  /**
   * Восстанавливает Fill и ExecutionMetadata из FillSnapshot
   *
   * @param snapshot - FillSnapshot с примитивами
   * @returns Result<{ fill: Fill; metadata: ExecutionMetadata }, ValidationError>
   *
   * @remarks
   * Парсит примитивы обратно в типизированные value objects.
   * AccountId парсится через `parseAccountId()`.
   * AssetId парсится через `parseAssetId()`.
   * settlementAssetId обязателен в снапшоте.
   *
   * @example
   * ```typescript
   * const snapshot = await db.load(id);
   * const result = FillMapper.fromSnapshot(snapshot);
   * if (result.ok) {
   *   const { fill, metadata } = result.value;
   * }
   * ```
   */
  public static fromSnapshot(
    snapshot: FillSnapshot
  ): Result<{ fill: Fill; metadata: ExecutionMetadata }, ValidationError> {
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

    const marketId = asMarketId(snapshot.marketId);
    if (!marketId) {
      return Err(
        new ValidationError('Invalid snapshot: invalid marketId', {
          context: { field: 'marketId', value: snapshot.marketId },
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

    const settlementAssetId = parseAssetId(snapshot.settlementAssetId);
    if (!settlementAssetId) {
      return Err(
        new ValidationError('Invalid snapshot: cannot parse settlementAssetId', {
          context: { field: 'settlementAssetId', value: snapshot.settlementAssetId },
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

    let price: Price;
    try {
      price = Price.of(priceDecimal);
    } catch {
      return Err(
        new ValidationError('Invalid snapshot: price must be positive', {
          context: { field: 'price', value: snapshot.price },
        })
      );
    }

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

    let size: Quantity;
    try {
      size = Quantity.of(sizeDecimal);
    } catch {
      return Err(
        new ValidationError('Invalid snapshot: size must be positive', {
          context: { field: 'size', value: snapshot.size },
        })
      );
    }

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

    let feeQuantity: Quantity;
    try {
      feeQuantity = Quantity.of(feeAmountDecimal);
    } catch {
      return Err(
        new ValidationError('Invalid snapshot: feeAmount must be non-negative', {
          context: { field: 'feeAmount', value: snapshot.feeAmount },
        })
      );
    }
    const feeAssetQuantity = new AssetQuantity(feeAssetId, feeQuantity);
    const fee = Fee.of(feeAssetQuantity);

    if (snapshot.side !== 'BUY' && snapshot.side !== 'SELL') {
      return Err(
        new ValidationError('Invalid snapshot: side must be BUY or SELL', {
          context: { field: 'side', value: snapshot.side },
        })
      );
    }

    const fillResult = Fill.create({
      id: fillId,
      orderId,
      accountId: accountIdParsed,
      venueId,
      marketId,
      tokenId,
      settlementAssetId,
      price,
      size,
      side: snapshot.side,
      timestamp: timestampResult.value,
      fee,
    });

    if (!fillResult.ok) {
      return Err(fillResult.error);
    }

    // Восстановить ExecutionMetadata из снапшота
    const venueTradeId =
      snapshot.venueTradeId !== undefined
        ? asVenueTradeId(snapshot.venueTradeId)
        : undefined;

    const tradeStatus =
      snapshot.tradeStatus !== undefined && VALID_TRADE_STATUSES.has(snapshot.tradeStatus)
        ? (snapshot.tradeStatus as TradeStatus)
        : undefined;

    const metadata: ExecutionMetadata = {
      liquidity: snapshot.liquidity,
      venueTradeId: venueTradeId ?? undefined,
      tradeStatus,
    };

    return Ok({ fill: fillResult.value, metadata });
  }
}

/**
 * Парсит Decimal из произвольного значения, проверяет что положительное
 *
 * @param value - Входное значение (string | number | unknown)
 * @param fieldName - Название поля для сообщения об ошибке
 * @returns Result<Decimal, ValidationError>
 *
 * @internal
 */
function parseDecimalPositive(
  value: unknown,
  fieldName: string
): Result<Decimal, ValidationError> {
  if (value === undefined || value === null) {
    return Err(
      new ValidationError(`Invalid trade event: missing ${fieldName}`, {
        context: { field: fieldName },
      })
    );
  }

  let d: Decimal;
  try {
    d = new Decimal(String(value));
  } catch {
    return Err(
      new ValidationError(`Invalid trade event: ${fieldName} is not a valid number`, {
        context: { field: fieldName, value },
      })
    );
  }

  if (!d.isFinite() || d.lte(0)) {
    return Err(
      new ValidationError(`Invalid trade event: ${fieldName} must be a positive number`, {
        context: { field: fieldName, value },
      })
    );
  }

  return Ok(d);
}
