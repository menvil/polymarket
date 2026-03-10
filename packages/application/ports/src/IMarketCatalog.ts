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
import type { Price, Quantity, Timestamp } from '@polymarket/value-objects';

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
  /** Время истечения рынка (используется ExpirationRemovalPolicy) */
  readonly expiresAt: Timestamp;
}

/**
 * Порт: каталог инструментов.
 *
 * @remarks
 * Расширенный интерфейс поддерживает как чтение (get/getAll/getByMarketId),
 * так и запись (register/remove/clear). Это позволяет StrategyCoordinator
 * динамически наполнять и очищать каталог при обнаружении рынков.
 *
 * @example
 * ```typescript
 * const info = catalog.get(tokenId);
 * if (!info) {
 *   throw new Error(`Unknown instrument: ${tokenId}`);
 * }
 * // info.tickSize уже Price — не нужно парсить строку
 * riskChecker.validatePrice(price, info.tickSize);
 *
 * // Добавление нового инструмента:
 * catalog.register({ instrumentId, marketId, tickSize, minOrderSize, active: true, expiresAt });
 *
 * // Удаление по marketId:
 * const found = catalog.getByMarketId(marketId);
 * if (found) catalog.remove(found.instrumentId);
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
   * Возвращает метаданные инструмента по MarketId (condition_id).
   *
   * @param marketId - ID рынка (condition_id в Polymarket API)
   * @returns InstrumentInfo или undefined если рынок неизвестен
   *
   * @remarks
   * Используется в _checkPolicy() для поиска instrumentId по marketId
   * перед вызовом remove().
   */
  getByMarketId(marketId: MarketId): InstrumentInfo | undefined;

  /**
   * Возвращает все загруженные инструменты.
   *
   * @returns Readonly массив всех InstrumentInfo
   */
  getAll(): readonly InstrumentInfo[];

  /**
   * Регистрирует (или обновляет) инструмент в каталоге.
   *
   * @param instrument - Метаданные инструмента для регистрации
   *
   * @remarks
   * Если инструмент с таким instrumentId уже существует — перезаписывает его.
   * Вызывается StrategyCoordinator._discover() для наполнения каталога
   * из результатов IMarketDiscoveryService.findCandidates().
   *
   * @example
   * ```typescript
   * catalog.register({
   *   instrumentId,
   *   marketId,
   *   tickSize: Price.of(new Decimal('0.01')),
   *   minOrderSize: Quantity.of(new Decimal('1')),
   *   active: true,
   * });
   * ```
   */
  register(instrument: InstrumentInfo): void;

  /**
   * Удаляет инструмент из каталога по InstrumentId.
   *
   * @param instrumentId - ID токена для удаления
   *
   * @remarks
   * Если инструмент не найден — no-op (не бросает ошибку).
   * Вызывается StrategyCoordinator._checkPolicy() при закрытии рынка.
   *
   * @example
   * ```typescript
   * const found = catalog.getByMarketId(marketId);
   * if (found) catalog.remove(found.instrumentId);
   * ```
   */
  remove(instrumentId: InstrumentId): void;

  /**
   * Удаляет все инструменты из каталога.
   *
   * @remarks
   * Используется при полном сбросе состояния системы
   * (например, перед перезагрузкой конфигурации рынков).
   *
   * @example
   * ```typescript
   * catalog.clear();
   * // После clear() catalog.getAll() возвращает []
   * ```
   */
  clear(): void;
}
