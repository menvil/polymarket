/**
 * Адаптер обнаружения рынков Polymarket.
 *
 * @remarks
 * `PolymarketMarketDiscoveryAdapter` реализует `IMarketDiscoveryService`,
 * обращаясь к `PolymarketMarketDataRestClient` для получения данных из Gamma API.
 *
 * ### Алгоритм `refresh()`:
 * 1. Вызвать `_marketDataClient.getActiveMarkets()` — получить все активные рынки
 * 2. Предфильтр: `active && !closed && enableOrderBook && parseable clobTokenIds`
 * 3. Маппинг `GammaMarketDto → DiscoveredMarket` через `_mapToDiscoveredMarket()`
 * 4. Фильтрация через `MarketFilter.filterCandidates()`
 * 5. Скоринг и сортировка через `MarketScorer.scoreAndSort()`
 * 6. Ограничение: `slice(0, maxMarketsToReturn)`
 * 7. Сохранение в `_cachedCandidates`, обновление `_lastFetchMs`
 *
 * ### TTL-кэш:
 * `findCandidates()` проверяет свежесть кэша (60 секунд по умолчанию).
 * При устаревшем кэше автоматически вызывает `refresh()`.
 *
 * ### Маппинг `GammaMarketDto → DiscoveredMarket`:
 * - `conditionId` → `asMarketId()` → `MarketId`
 * - `clobTokenIds[0]` (YES token) → `asInstrumentId()` → `InstrumentId`
 * - `endDate` (ISO строка) → `Date.parse()` → `TimestampService.create()` → `Timestamp`
 * - `orderPriceMinTickSize` → `Price.of(new Decimal(value))` → `Price` (дефолт: 0.01)
 * - `orderMinSize` → `Quantity.of(new Decimal(value))` → `Quantity` (дефолт: 1)
 * - `liquidity` (строка) → `new Decimal()` → `Decimal`
 * - `spread` (number) → `new Decimal()` → `Decimal`
 * - `score = Decimal(0)` (будет установлен `MarketScorer`)
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketMarketDiscoveryAdapter(
 *   marketDataClient,
 *   new MarketFilter(),
 *   new MarketScorer(),
 *   filterConfig,
 *   logger,
 * );
 *
 * const candidates = await adapter.findCandidates();
 * console.log(`Discovered ${candidates.length} tradeable markets`);
 * ```
 */
import Decimal from 'decimal.js';
import type { IMarketDiscoveryService, DiscoveredMarket, IMarketFilterConfig } from '@polymarket/ports';
import { asMarketId, asInstrumentId } from '@polymarket/ids';
import { TimestampService, Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { PolymarketMarketDataRestClient, GammaMarketDto } from '../rest/clients/PolymarketMarketDataRestClient.js';
import type { MarketFilter } from '@polymarket/market-discovery';
import type { MarketScorer } from '@polymarket/market-discovery';

/** TTL кэша в миллисекундах (60 секунд) */
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Адаптер обнаружения рынков Polymarket.
 *
 * @remarks
 * Реализует `IMarketDiscoveryService` для Polymarket Gamma API.
 * Использует TTL-кэш для минимизации запросов к API.
 */
export class PolymarketMarketDiscoveryAdapter implements IMarketDiscoveryService {
  /** Закэшированные кандидаты после последнего refresh() */
  private _cachedCandidates: readonly DiscoveredMarket[] = [];
  /** Время последнего успешного fetch в миллисекундах */
  private _lastFetchMs = 0;
  /** TTL кэша в миллисекундах */
  private readonly _cacheTtlMs: number;
  /** Дочерний логгер с контекстом компонента */
  private readonly _logger: ILogger;

  /**
   * @param _marketDataClient - REST-клиент Gamma API Polymarket
   * @param _filter - Фильтр кандидатов
   * @param _scorer - Скорер и сортировщик кандидатов
   * @param _filterConfig - Конфигурация фильтрации
   * @param logger - Logger для диагностики
   * @param cacheTtlMs - TTL кэша в миллисекундах (по умолчанию 60 секунд)
   *
   * @example
   * ```typescript
   * const adapter = new PolymarketMarketDiscoveryAdapter(
   *   marketDataClient,
   *   new MarketFilter(),
   *   new MarketScorer(),
   *   { minTimeToExpiryHours: 24, minSpread: 0, minDailyVolume: 1000, maxMarketsToReturn: 10 },
   *   logger,
   * );
   * ```
   */
  constructor(
    private readonly _marketDataClient: PolymarketMarketDataRestClient,
    private readonly _filter: MarketFilter,
    private readonly _scorer: MarketScorer,
    private readonly _filterConfig: IMarketFilterConfig,
    logger: ILogger,
    cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
  ) {
    this._cacheTtlMs = cacheTtlMs;
    this._logger = logger.child({ component: 'PolymarketMarketDiscoveryAdapter' });
  }

  /**
   * Возвращает список отфильтрованных и проскоренных кандидатов.
   *
   * @returns Readonly массив DiscoveredMarket, отсортированных по приоритету
   *
   * @remarks
   * При устаревшем TTL автоматически вызывает `refresh()`.
   * Количество возвращаемых рынков ограничено `_filterConfig.maxMarketsToReturn`.
   *
   * @example
   * ```typescript
   * const candidates = await adapter.findCandidates();
   * for (const c of candidates) {
   *   catalog.register({ instrumentId: c.instrumentId, marketId: c.marketId, ... });
   * }
   * ```
   */
  public async findCandidates(): Promise<readonly DiscoveredMarket[]> {
    const nowMs = Date.now();
    const isStale = nowMs - this._lastFetchMs > this._cacheTtlMs;

    if (isStale) {
      this._logger.debug('Market discovery cache is stale, refreshing', {
        lastFetchMs: this._lastFetchMs,
        cacheTtlMs: this._cacheTtlMs,
      });
      await this.refresh();
    }

    return this._cachedCandidates;
  }

  /**
   * Принудительно обновляет кэш кандидатов из Gamma API.
   *
   * @remarks
   * ### Шаги:
   * 1. Запрашивает все активные рынки через `getActiveMarkets()`
   * 2. Предфильтр: `active && !closed && enableOrderBook`
   * 3. Парсинг `clobTokenIds` (JSON строка или массив)
   * 4. Маппинг в `DiscoveredMarket` через `_mapToDiscoveredMarket()`
   * 5. Фильтрация через `MarketFilter`
   * 6. Скоринг через `MarketScorer`
   * 7. Ограничение по `maxMarketsToReturn`
   * 8. Обновление кэша
   *
   * При ошибке API — логируем и оставляем старый кэш.
   *
   * @example
   * ```typescript
   * await adapter.refresh();
   * ```
   */
  public async refresh(): Promise<void> {
    this._logger.info('Refreshing market discovery candidates from Gamma API');

    let rawMarkets: GammaMarketDto[];
    try {
      rawMarkets = await this._marketDataClient.getActiveMarkets();
    } catch (error) {
      this._logger.error('Failed to fetch markets from Gamma API, keeping stale cache', {
        error: error instanceof Error ? error.message : String(error),
        staleCacheSize: this._cachedCandidates.length,
      });
      return;
    }

    this._logger.debug('Fetched raw markets from Gamma API', { total: rawMarkets.length });

    // Предфильтр: только торгуемые рынки с включённым стаканом
    const tradeable = rawMarkets.filter(
      (m) => m.active && !m.closed && m.enableOrderBook,
    );

    this._logger.debug('Pre-filtered tradeable markets', {
      total: rawMarkets.length,
      tradeable: tradeable.length,
    });

    // Маппинг GammaMarketDto → DiscoveredMarket (null при ошибке парсинга)
    const nowMs = Date.now();
    const mapped: DiscoveredMarket[] = [];
    let parseErrors = 0;

    for (const raw of tradeable) {
      const discovered = this._mapToDiscoveredMarket(raw);
      if (discovered !== null) {
        mapped.push(discovered);
      } else {
        parseErrors++;
      }
    }

    if (parseErrors > 0) {
      this._logger.warn('Some markets could not be parsed and were skipped', {
        parseErrors,
        successfullyParsed: mapped.length,
      });
    }

    // Фильтрация по конфигурации
    const filtered = this._filter.filterCandidates(mapped, this._filterConfig, nowMs);

    // Скоринг и сортировка
    const scored = this._scorer.scoreAndSort(filtered);

    // Ограничение по maxMarketsToReturn
    const final = scored.slice(0, this._filterConfig.maxMarketsToReturn);

    // Обновляем кэш
    this._cachedCandidates = final;
    this._lastFetchMs = Date.now();

    this._logger.info('Market discovery refresh complete', {
      raw: rawMarkets.length,
      tradeable: tradeable.length,
      parsed: mapped.length,
      filtered: filtered.length,
      final: final.length,
    });
  }

  /**
   * Маппирует сырые данные Gamma API в `DiscoveredMarket`.
   *
   * @param raw - Сырые данные рынка из Gamma API
   * @returns `DiscoveredMarket` при успехе или `null` при ошибке парсинга
   *
   * @remarks
   * ### Особенности маппинга:
   * - `conditionId` → `asMarketId()` → может вернуть `undefined` (логируем, пропускаем)
   * - `clobTokenIds` — JSON-строка или массив; берём `[0]` (YES token)
   * - `endDate` → `Date.parse()` → `TimestampService.create()` (может быть невалидным)
   * - `orderPriceMinTickSize` — дефолт 0.01 если не задан
   * - `orderMinSize` — дефолт 1 если не задан
   * - `Price.of()` и `Quantity.of()` могут бросать — обёрнуты в try/catch
   * - `liquidity` — строка из API, парсим через `parseFloat()` (0 если NaN)
   *
   * @example
   * ```typescript
   * const discovered = this._mapToDiscoveredMarket(rawMarket);
   * if (!discovered) {
   *   // логируем предупреждение и пропускаем
   * }
   * ```
   */
  private _mapToDiscoveredMarket(raw: GammaMarketDto): DiscoveredMarket | null {
    // 1. Маппинг MarketId из conditionId
    const marketId = asMarketId(raw.conditionId);
    if (!marketId) {
      this._logger.warn('Cannot parse conditionId as MarketId, skipping market', {
        conditionId: raw.conditionId,
        question: raw.question,
      });
      return null;
    }

    // 2. Парсинг clobTokenIds — JSON-строка или массив
    let tokenIds: string[];
    try {
      if (typeof raw.clobTokenIds === 'string') {
        tokenIds = JSON.parse(raw.clobTokenIds) as string[];
      } else if (Array.isArray(raw.clobTokenIds)) {
        tokenIds = raw.clobTokenIds as string[];
      } else {
        this._logger.warn('clobTokenIds is neither string nor array, skipping market', {
          conditionId: raw.conditionId,
          clobTokenIds: raw.clobTokenIds,
        });
        return null;
      }
    } catch (parseError) {
      this._logger.warn('Failed to parse clobTokenIds JSON, skipping market', {
        conditionId: raw.conditionId,
        clobTokenIds: raw.clobTokenIds,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
      return null;
    }

    // 3. Берём YES token (первый элемент)
    const yesTokenIdRaw = tokenIds[0];
    if (!yesTokenIdRaw) {
      this._logger.warn('clobTokenIds is empty, skipping market', {
        conditionId: raw.conditionId,
        question: raw.question,
      });
      return null;
    }

    const instrumentId = asInstrumentId(yesTokenIdRaw);
    if (!instrumentId) {
      this._logger.warn('Cannot parse YES token as InstrumentId, skipping market', {
        conditionId: raw.conditionId,
        yesTokenId: yesTokenIdRaw,
      });
      return null;
    }

    // 4. Парсинг даты истечения
    const endDateMs = Date.parse(raw.endDate);
    if (isNaN(endDateMs)) {
      this._logger.warn('Cannot parse endDate, skipping market', {
        conditionId: raw.conditionId,
        endDate: raw.endDate,
      });
      return null;
    }

    const expiresAtResult = TimestampService.create(endDateMs);
    if (!expiresAtResult.ok) {
      this._logger.warn('Cannot create Timestamp from endDate, skipping market', {
        conditionId: raw.conditionId,
        endDate: raw.endDate,
        error: expiresAtResult.error.message,
      });
      return null;
    }

    // 5. Парсинг Price (tickSize) с дефолтом 0.01
    const tickSizeValue = raw.orderPriceMinTickSize ?? 0.01;
    let tickSize: Price;
    try {
      tickSize = Price.of(new Decimal(tickSizeValue));
    } catch (priceError) {
      this._logger.warn('Cannot create Price from orderPriceMinTickSize, using default 0.01', {
        conditionId: raw.conditionId,
        orderPriceMinTickSize: tickSizeValue,
        error: priceError instanceof Error ? priceError.message : String(priceError),
      });
      try {
        tickSize = Price.of(new Decimal('0.01'));
      } catch {
        this._logger.warn('Even default Price 0.01 failed, skipping market', {
          conditionId: raw.conditionId,
        });
        return null;
      }
    }

    // 6. Парсинг Quantity (minOrderSize) с дефолтом 1
    const minOrderSizeValue = raw.orderMinSize ?? 1;
    let minOrderSize: Quantity;
    try {
      minOrderSize = Quantity.of(new Decimal(minOrderSizeValue));
    } catch (qtyError) {
      this._logger.warn('Cannot create Quantity from orderMinSize, using default 1', {
        conditionId: raw.conditionId,
        orderMinSize: minOrderSizeValue,
        error: qtyError instanceof Error ? qtyError.message : String(qtyError),
      });
      try {
        minOrderSize = Quantity.of(new Decimal('1'));
      } catch {
        this._logger.warn('Even default Quantity 1 failed, skipping market', {
          conditionId: raw.conditionId,
        });
        return null;
      }
    }

    // 7. Ликвидность — строка из API, конвертируем напрямую в Decimal (без потери точности)
    const liquidity = new Decimal(raw.liquidity ?? '0');

    // 8. Спред (number или undefined) — конвертируем в Decimal
    const spread = new Decimal(raw.spread ?? 0);

    return {
      marketId,
      instrumentId,
      question: raw.question,
      expiresAt: expiresAtResult.value,
      tickSize,
      minOrderSize,
      active: true,
      spread,
      liquidity,
      score: new Decimal(0), // Будет установлен MarketScorer в scoreAndSort()
    };
  }
}
