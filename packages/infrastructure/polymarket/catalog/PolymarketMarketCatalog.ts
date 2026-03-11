/**
 * Реализация каталога инструментов Polymarket.
 *
 * @remarks
 * `PolymarketMarketCatalog` реализует `IMarketCatalog` с поддержкой
 * как read (get, getAll, getByMarketId), так и write (register, remove, clear) операций.
 *
 * ### Назначение:
 * Хранит in-memory состояние известных торговых инструментов.
 * Наполняется из `PolymarketMarketDiscoveryAdapter` через `MarketDiscoveryPublisher._discover()`.
 * Очищается при закрытии рынков через `CloseMarketUseCase`.
 *
 * ### Структура хранилища:
 * - Основная карта: `InstrumentId → InstrumentInfo` (O(1) lookup по tokenId)
 * - Вспомогательная карта: `MarketId → InstrumentId` (O(1) lookup по conditionId)
 *
 * ### Thread safety:
 * Не thread-safe (Node.js однопоточный, поэтому не требуется).
 *
 * @example
 * ```typescript
 * const catalog = new PolymarketMarketCatalog(logger);
 *
 * catalog.register({
 *   instrumentId,
 *   marketId,
 *   tickSize: Price.of(new Decimal('0.01')),
 *   minOrderSize: Quantity.of(new Decimal('1')),
 *   active: true,
 * });
 *
 * const info = catalog.get(instrumentId);     // InstrumentInfo | undefined
 * const byMarket = catalog.getByMarketId(marketId); // InstrumentInfo | undefined
 * catalog.remove(instrumentId);
 * catalog.clear();
 * ```
 */
import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';

/**
 * In-memory реализация каталога торговых инструментов Polymarket.
 *
 * @remarks
 * Реализует `IMarketCatalog` с поддержкой write-операций.
 * Используется как центральный реестр для MarketDiscoveryPublisher,
 * MarketExpiryMonitor и application-layer хэндлеров.
 */
export class PolymarketMarketCatalog implements IMarketCatalog {
  /** Основная карта: InstrumentId → InstrumentInfo */
  private readonly _instruments = new Map<InstrumentId, InstrumentInfo>();
  /** Вспомогательная карта для lookup по MarketId: MarketId → InstrumentId */
  private readonly _marketIdIndex = new Map<MarketId, InstrumentId>();
  /** Дочерний логгер с контекстом компонента */
  private readonly _logger: ILogger;

  /**
   * @param logger - Logger для диагностики операций каталога
   */
  constructor(logger: ILogger) {
    this._logger = logger.child({ component: 'PolymarketMarketCatalog' });
  }

  /**
   * Возвращает метаданные инструмента по InstrumentId.
   *
   * @param instrumentId - ID токена (UP/DOWN outcome token)
   * @returns InstrumentInfo или undefined если инструмент неизвестен
   *
   * @example
   * ```typescript
   * const info = catalog.get(tokenId);
   * if (!info) {
   *   logger.warn('Unknown instrument', { instrumentId: tokenId });
   *   return;
   * }
   * ```
   */
  public get(instrumentId: InstrumentId): InstrumentInfo | undefined {
    return this._instruments.get(instrumentId);
  }

  /**
   * Возвращает метаданные инструмента по MarketId (condition_id).
   *
   * @param marketId - ID рынка (condition_id в Polymarket API)
   * @returns InstrumentInfo или undefined если рынок неизвестен
   *
   * @remarks
   * Использует вспомогательный индекс для O(1) поиска.
   * Применяется в `StrategyCoordinator._checkPolicy()` для получения
   * `instrumentId` перед вызовом `remove()`.
   *
   * @example
   * ```typescript
   * const info = catalog.getByMarketId(marketId);
   * if (info) catalog.remove(info.instrumentId);
   * ```
   */
  public getByMarketId(marketId: MarketId): InstrumentInfo | undefined {
    const instrumentId = this._marketIdIndex.get(marketId);
    if (!instrumentId) return undefined;
    return this._instruments.get(instrumentId);
  }

  /**
   * Возвращает все загруженные инструменты.
   *
   * @returns Readonly массив всех InstrumentInfo
   *
   * @remarks
   * Возвращает новый массив при каждом вызове (snapshot текущего состояния).
   * Размер каталога обычно небольшой (10–100 инструментов), поэтому аллокация некритична.
   *
   * @example
   * ```typescript
   * const all = catalog.getAll();
   * const active = all.filter(i => i.active);
   * ```
   */
  public getAll(): readonly InstrumentInfo[] {
    return [...this._instruments.values()];
  }

  /**
   * Регистрирует (или обновляет) инструмент в каталоге.
   *
   * @param instrument - Метаданные инструмента для регистрации
   *
   * @remarks
   * Если инструмент с таким instrumentId уже существует:
   * 1. Удаляем старую запись в `_marketIdIndex` (по старому marketId)
   * 2. Обновляем `_instruments`
   * 3. Обновляем `_marketIdIndex` по новому marketId
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
  public register(instrument: InstrumentInfo): void {
    const existing = this._instruments.get(instrument.instrumentId);

    if (existing) {
      // Удаляем старый marketId из индекса (может измениться при обновлении)
      this._marketIdIndex.delete(existing.marketId);
      this._logger.debug('Updating instrument in catalog', {
        instrumentId: String(instrument.instrumentId),
        marketId: String(instrument.marketId),
      });
    } else {
      this._logger.debug('Registering new instrument in catalog', {
        instrumentId: String(instrument.instrumentId),
        marketId: String(instrument.marketId),
        question: instrument.marketId,
      });
    }

    this._instruments.set(instrument.instrumentId, instrument);
    this._marketIdIndex.set(instrument.marketId, instrument.instrumentId);
  }

  /**
   * Удаляет инструмент из каталога по InstrumentId.
   *
   * @param instrumentId - ID токена для удаления
   *
   * @remarks
   * Если инструмент не найден — no-op (не бросает ошибку, логируем warn).
   * При удалении также очищается запись в `_marketIdIndex`.
   *
   * @example
   * ```typescript
   * const found = catalog.getByMarketId(marketId);
   * if (found) catalog.remove(found.instrumentId);
   * ```
   */
  public remove(instrumentId: InstrumentId): void {
    const existing = this._instruments.get(instrumentId);

    if (!existing) {
      this._logger.warn('Attempted to remove unknown instrument from catalog', {
        instrumentId: String(instrumentId),
      });
      return;
    }

    this._instruments.delete(instrumentId);
    this._marketIdIndex.delete(existing.marketId);

    this._logger.debug('Removed instrument from catalog', {
      instrumentId: String(instrumentId),
      marketId: String(existing.marketId),
    });
  }

  /**
   * Удаляет все инструменты из каталога.
   *
   * @remarks
   * Используется при полном сбросе состояния системы.
   * После вызова `getAll()` возвращает пустой массив.
   *
   * @example
   * ```typescript
   * catalog.clear();
   * console.log(catalog.getAll().length); // 0
   * ```
   */
  public clear(): void {
    const count = this._instruments.size;
    this._instruments.clear();
    this._marketIdIndex.clear();
    this._logger.info('Market catalog cleared', { removedCount: count });
  }
}
