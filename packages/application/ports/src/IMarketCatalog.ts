/**
 * Порт: каталог инструментов для application layer.
 *
 * @remarks
 * `IMarketCatalog` — application-layer порт (Dependency Inversion).
 * Инфраструктурная реализация `PolymarketMarketCatalog` (@polymarket/exchange)
 * имплементирует этот интерфейс и заполняет каталог из REST API при старте.
 *
 * Строки из REST API (tick size, min order size) парсятся в domain VOs
 * на границе инфраструктуры — application layer уже работает с типизированными объектами.
 *
 * Используется:
 * - BookUpdateHandler — `catalog.get(tokenId)` → `InstrumentInfo.instrumentId`
 * - OrderRiskChecker — `catalog.get(tokenId)?.tickSize` (уже Price, не string)
 * - PolymarketExchangeClientAdapter — маппинг параметров ордера
 */
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { Price, Quantity } from '@polymarket/value-objects';

/**
 * Метаданные торгового инструмента.
 *
 * @remarks
 * Заполняется из @polymarket/exchange при старте системы.
 * Все поля уже типизированы — не нужно парсить строки в application layer.
 */
export interface InstrumentInfo {
  /** ID токена (YES/NO outcome token) — типизированный branded type */
  readonly instrumentId: InstrumentId;
  /** ID рынка (condition_id в Polymarket API) */
  readonly marketId: MarketId;
  /** Минимальный шаг цены */
  readonly tickSize: Price;
  /** Минимальный размер ордера */
  readonly minOrderSize: Quantity;
  /** Активен ли рынок */
  readonly active: boolean;
}

/**
 * Порт: каталог инструментов.
 *
 * @example
 * ```typescript
 * const info = catalog.get(tokenId);
 * if (!info) {
 *   throw new Error(`Unknown instrument: ${tokenId}`);
 * }
 * // info.tickSize уже Price — не нужно парсить строку
 * riskChecker.validatePrice(price, info.tickSize);
 * ```
 */
export interface IMarketCatalog {
  /**
   * Возвращает метаданные инструмента по InstrumentId.
   *
   * @param instrumentId - ID токена (YES/NO outcome token)
   * @returns InstrumentInfo или undefined если инструмент неизвестен
   */
  get(instrumentId: InstrumentId): InstrumentInfo | undefined;

  /**
   * Возвращает все загруженные инструменты.
   *
   * @returns Readonly массив всех InstrumentInfo
   */
  getAll(): readonly InstrumentInfo[];
}
