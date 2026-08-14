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
 * ### Формат Polymarket lastTradeEvent (реальный пример):
 * ```json
 * {
 *   "market": "0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3",
 *   "asset_id": "62305814799875783974460176688386847666394972778903073967664089920408777315323",
 *   "price": "0.44",
 *   "size": "7.861135",
 *   "fee_rate_bps": "0",
 *   "side": "BUY",
 *   "timestamp": "1767463212903",
 *   "event_type": "last_trade_price",
 *   "transaction_hash": "0x989369fbc370b9384be69c36876e25170f25d87a83ef1413cbf7ca6913533f21"
 * }
 * ```
 *
 * **Формат timestamp:** API может возвращать как секунды (10 цифр), так и миллисекунды (13 цифр).
 * Маппер автоматически определяет формат по порогу 1e12.
 *
 * **Формат asset_id:** API возвращает числовой CTF token ID (большое целое число).
 * Маппер создаёт AssetId типа POLYMARKET_CTF_TOKEN.
 *
 * @example
 * ```typescript
 * // Парсинг события из Polymarket API
 * const result = TradeMapper.fromPolymarketLastTradeEvent({
 *   market: '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3',
 *   asset_id: '62305814799875783974460176688386847666394972778903073967664089920408777315323',
 *   price: '0.44',
 *   size: '7.861135',
 *   side: 'BUY',
 *   timestamp: '1767463212903',
 *   transaction_hash: '0x989369fbc370b9384be69c36876e25170f25d87a83ef1413cbf7ca6913533f21'
 * });
 *
 * if (result.ok) {
 *   const trade = result.value;
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import { asVenueTradeId, asVenueId, parseAssetId, asTxHash, asMarketId } from '@polymarket/ids';
import type { InstrumentId, VenueId, VenueTradeId, TxHash, MarketId } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/timestamp';
import type { Side } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
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
   * - `timestamp` (string | number) — Unix timestamp в секундах или миллисекундах (автоопределение: < 1e12 → секунды, >= 1e12 → миллисекунды)
   * - `transaction_hash` (string, optional) — хэш транзакции
   *
   * @example
   * ```typescript
   * const result = TradeMapper.fromPolymarketLastTradeEvent({
   *   market: '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3',
   *   asset_id: '62305814799875783974460176688386847666394972778903073967664089920408777315323',
   *   price: '0.44',
   *   size: '7.861135',
   *   side: 'BUY',
   *   timestamp: '1767463212903',
   *   transaction_hash: '0x989369fbc370b9384be69c36876e25170f25d87a83ef1413cbf7ca6913533f21'
   * });
   * ```
   */
  public static fromPolymarketLastTradeEvent(
    raw: Record<string, unknown>
  ): Result<Trade, ValidationError> {
    // Защита от не-объектного raw (null, primitives, arrays)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: expected non-null object', {
          context: { value: raw },
        })
      );
    }

    // Извлечь marketId (wire-граница: raw string → branded MarketId; asMarketId сам делает trim)
    const marketIdRaw = raw['market'];
    if (typeof marketIdRaw !== 'string' || marketIdRaw.trim().length === 0) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: missing or invalid market', {
          context: { field: 'market', value: marketIdRaw },
        })
      );
    }
    const marketId = asMarketId(marketIdRaw);
    if (marketId === undefined) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: market failed MarketId validation', {
          context: { field: 'market', value: marketIdRaw },
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

    let price: Price;
    try {
      price = Price.of(priceDecimal);
    } catch {
      return Err(
        new ValidationError('Invalid lastTradeEvent: price must be positive', {
          context: { field: 'price', value: priceRaw },
        })
      );
    }

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

    let size: Quantity;
    try {
      size = Quantity.of(sizeDecimal);
    } catch {
      return Err(
        new ValidationError('Invalid lastTradeEvent: size must be positive', {
          context: { field: 'size', value: sizeRaw },
        })
      );
    }

    // Извлечь timestamp — Polymarket может возвращать секунды (10 цифр) или миллисекунды (13 цифр)
    const timestampRaw = raw['timestamp'];
    if (timestampRaw === undefined || timestampRaw === null) {
      return Err(
        new ValidationError('Invalid lastTradeEvent: missing timestamp', {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    // Создаём Timestamp VO для парсинга и валидации (TimestampService принимает string/number/Decimal)
    const rawTimestampResult = TimestampService.create(String(timestampRaw));
    if (!rawTimestampResult.ok) {
      return Err(
        new ValidationError(`Invalid lastTradeEvent: ${rawTimestampResult.error.message}`, {
          context: { field: 'timestamp', value: timestampRaw },
        })
      );
    }

    // Автоопределение единиц через Timestamp VO:
    // Polymarket возвращает секунды (epoch ~1.7e9, год 2024) или мс (epoch ~1.7e12, год 2024).
    // Порог 1e12 надёжно отделяет: секунды Polymarket << 1e10 << 1e12 << мс Polymarket.
    let timestamp = rawTimestampResult.value;
    if (timestamp.toNumber() < 1e12) {
      const msTimestampResult = TimestampService.create(timestamp.toNumber() * 1000);
      if (!msTimestampResult.ok) {
        return Err(
          new ValidationError(`Invalid lastTradeEvent: ${msTimestampResult.error.message}`, {
            context: { field: 'timestamp', value: timestampRaw },
          })
        );
      }
      timestamp = msTimestampResult.value;
    }

    // Извлечь transaction_hash (опционально)
    const txHashRaw = raw['transaction_hash'];
    const txHash =
      typeof txHashRaw === 'string' && txHashRaw.trim().length > 0
        ? asTxHash(txHashRaw.trim())
        : undefined;

    // Генерировать VenueTradeId из transaction_hash + '_' + timestamp (оригинальное значение из raw)
    // Если txHash недоступен — добавляем price и size для снижения вероятности коллизий
    // (одновременные трейды с разными размерами/ценами на том же рынке/токене будут различаться)
    // Нормализуем числовые поля через Decimal для детерминизма ("0.50" → "0.5")
    let priceNorm = String(priceRaw).trim();
    let sizeNorm = String(sizeRaw).trim();
    try { priceNorm = new Decimal(priceNorm).toFixed(); } catch { /* оставляем raw */ }
    try { sizeNorm = new Decimal(sizeNorm).toFixed(); } catch { /* оставляем raw */ }
    const idResult = TradeMapper._buildVenueTradeId({
      txHash,
      tsStr: String(timestampRaw).trim(),
      marketId,
      assetIdStr: assetIdRaw.trim(),
      priceStr: priceNorm,
      sizeStr: sizeNorm,
    });
    if (!idResult.ok) {
      return Err(idResult.error);
    }

    // Извлечь aggressorSide (опционально)
    const sideRaw = raw['side'];
    const aggressorSide =
      sideRaw === 'BUY' || sideRaw === 'SELL' ? sideRaw : undefined;

    const venueIdResult = TradeMapper._buildPolymarketVenueId();
    if (!venueIdResult.ok) {
      return Err(venueIdResult.error);
    }

    return Trade.create({
      id: idResult.value,
      venueId: venueIdResult.value,
      marketId,
      tokenId,
      price,
      size,
      aggressorSide,
      timestamp,
      txHash,
    });
  }

  /**
   * Создаёт Trade из уже распакованных value objects (application-layer событие)
   *
   * @param params - Уже распарсенные поля трейда
   * @param params.instrumentId - ID токена (branded, из market-data слоя)
   * @param params.marketId - ID рынка
   * @param params.price - Цена трейда (VO)
   * @param params.size - Объём трейда (VO)
   * @param params.side - Сторона агрессора (VO-уровня, всегда известна на этом пути)
   * @param params.timestamp - Время трейда (VO)
   * @returns Result<Trade, ValidationError>
   *
   * @remarks
   * В отличие от {@link fromPolymarketLastTradeEvent} (парсит сырые строки из WS JSON,
   * защищается от произвольного untyped-входа), этот метод принимает уже готовые VO —
   * точка врезки: `MarketDataStore`'s обработчик `TRADE_RECEIVED`
   * (`@polymarket/market-state`) получает `TradeReceivedEvent` из `@polymarket/event-bus`
   * с уже распакованными `instrumentId`/`price`/`size`/`side`/`timestamp`. Сериализовать
   * их обратно в строки ради повторного парсинга было бы архитектурно задом наперёд —
   * `price`/`size` как VO уже гарантированно валидны (VO-конструктор бросает на
   * невалидном входе, см. `docs/architecture/boundary-contract.md`, Решение 2), поэтому
   * повторная проверка положительности здесь не нужна.
   *
   * `transaction_hash` недоступен нигде в цепочке поставки данных для этого события —
   * ни в live WS DTO (`WsTradeDto`), ни в backtest replay (`RawTradeEvent`). VenueTradeId
   * здесь **всегда** строится по composite-формуле (`marketId_assetId_ts_price_size`) —
   * ветка с txHash в общем хелпере {@link _buildVenueTradeId} для этого метода
   * недостижима на практике (в отличие от {@link fromPolymarketLastTradeEvent}, где
   * txHash иногда присутствует).
   *
   * ⚠️ **Известное ограничение**: из-за отсутствия txHash в реальном трафике,
   * `Trade.id` (этот метод) и `Fill.venueTradeId` (`FillMapper.ts`, всегда bare txHash
   * или `undefined`, без composite-фолбэка) для одного и того же реального трейда
   * структурно НИКОГДА не совпадают при точном сравнении ключей — не "иногда не находит,
   * потому что трейд ещё не долетел до public tape" (это ожидаемо и не проблема), а
   * гарантированное несовпадение всегда. `ExecutionLinker` (Этап 7) должен проектировать
   * fuzzy/windowed matching (`tokenId` + price + size + временное окно), а не точный
   * lookup по `venueTradeId` — иначе связка не сработает никогда для реального трафика.
   *
   * @example
   * ```typescript
   * const result = TradeMapper.fromParsedTrade({
   *   instrumentId: event.payload.instrumentId,
   *   marketId: '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3',
   *   price: event.payload.price,
   *   size: event.payload.size,
   *   side: event.payload.side,
   *   timestamp: event.payload.timestamp,
   * });
   * if (result.ok) {
   *   const trade = result.value;
   * }
   * ```
   */
  public static fromParsedTrade(params: {
    readonly instrumentId: InstrumentId;
    readonly marketId: MarketId;
    readonly price: Price;
    readonly size: Quantity;
    readonly side: Side;
    readonly timestamp: Timestamp;
  }): Result<Trade, ValidationError> {
    const { instrumentId, marketId, price, size, side, timestamp } = params;

    if (typeof marketId !== 'string' || marketId.trim().length === 0) {
      return Err(
        new ValidationError('Invalid parsed trade: missing or invalid marketId', {
          context: { field: 'marketId', value: marketId },
        })
      );
    }

    const tokenId = parseAssetId(instrumentId);
    if (!tokenId) {
      return Err(
        new ValidationError('Invalid parsed trade: cannot parse instrumentId as AssetId', {
          context: { field: 'instrumentId', value: instrumentId },
        })
      );
    }

    const idResult = TradeMapper._buildVenueTradeId({
      txHash: undefined,
      tsStr: String(timestamp.toNumber()),
      marketId,
      assetIdStr: String(instrumentId),
      priceStr: price.value().toFixed(),
      sizeStr: size.value().toFixed(),
    });
    if (!idResult.ok) {
      return Err(idResult.error);
    }

    const venueIdResult = TradeMapper._buildPolymarketVenueId();
    if (!venueIdResult.ok) {
      return Err(venueIdResult.error);
    }

    return Trade.create({
      id: idResult.value,
      venueId: venueIdResult.value,
      marketId,
      tokenId,
      price,
      size,
      aggressorSide: side,
      timestamp,
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
    if (snapshot == null || typeof snapshot !== 'object') {
      return Err(
        new ValidationError('Invalid snapshot: expected non-null object', {
          context: { field: 'snapshot', value: snapshot },
        })
      );
    }

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

    if (typeof snapshot.marketId !== 'string' || snapshot.marketId.trim().length === 0) {
      return Err(
        new ValidationError('Invalid snapshot: missing marketId', {
          context: { field: 'marketId' },
        })
      );
    }
    // Persistence-граница: снапшот несёт raw string, домен — branded MarketId
    const marketId = asMarketId(snapshot.marketId);
    if (marketId === undefined) {
      return Err(
        new ValidationError('Invalid snapshot: marketId failed MarketId validation', {
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

    const txHash =
      typeof snapshot.txHash === 'string' && snapshot.txHash.trim().length > 0
        ? asTxHash(snapshot.txHash.trim())
        : undefined;

    return Trade.create({
      id: tradeId,
      venueId,
      marketId,
      tokenId,
      price,
      size,
      aggressorSide: snapshot.aggressorSide === 'BUY' || snapshot.aggressorSide === 'SELL'
        ? snapshot.aggressorSide
        : undefined,
      timestamp: timestampResult.value,
      txHash,
    });
  }

  // ── Приватные хелперы ────────────────────────────────────────────────────
  // Общая логика для fromPolymarketLastTradeEvent() и fromParsedTrade() — не
  // дублируется, оба метода строят Trade.id/venueId через одни и те же функции.

  /**
   * Генерирует VenueTradeId по общей формуле
   *
   * @param parts - Уже нормализованные в строки компоненты (каждый вызывающий метод
   *   нормализует price/size/timestamp по-своему — из raw JSON строк или из VO)
   * @returns Result<VenueTradeId, ValidationError>
   *
   * @remarks
   * Формула: `{txHash}_{ts}` при наличии txHash, иначе composite-ключ
   * `{marketId}_{assetId}_{ts}_{price}_{size}` — снижает вероятность коллизий для
   * одновременных трейдов с разными размерами/ценами на одном рынке/токене.
   *
   * @internal
   */
  private static _buildVenueTradeId(parts: {
    readonly txHash: TxHash | undefined;
    readonly tsStr: string;
    readonly marketId: string;
    readonly assetIdStr: string;
    readonly priceStr: string;
    readonly sizeStr: string;
  }): Result<VenueTradeId, ValidationError> {
    const tradeIdString =
      parts.txHash !== undefined
        ? `${parts.txHash}_${parts.tsStr}`
        : `${parts.marketId}_${parts.assetIdStr}_${parts.tsStr}_${parts.priceStr}_${parts.sizeStr}`;

    const tradeId = asVenueTradeId(tradeIdString);
    if (!tradeId) {
      return Err(
        new ValidationError('Cannot generate VenueTradeId from event data', {
          context: { tradeIdString },
        })
      );
    }
    return Ok(tradeId);
  }

  /**
   * Строит VenueId константу Polymarket
   *
   * @returns Result<VenueId, ValidationError>
   *
   * @internal
   */
  private static _buildPolymarketVenueId(): Result<VenueId, ValidationError> {
    const venueId = asVenueId(POLYMARKET_VENUE_ID);
    if (!venueId) {
      return Err(
        new ValidationError('Cannot create POLYMARKET venue ID', {
          context: { venueId: POLYMARKET_VENUE_ID },
        })
      );
    }
    return Ok(venueId);
  }
}
