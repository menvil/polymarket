/**
 * Конфигурация production-рантайма коллектора и boundary-конверсия из
 * внешней (env/JSON) конфигурации приложения.
 *
 * @remarks
 * Граница «внешняя конфигурация → V2-рантайм» живёт ЗДЕСЬ и только здесь:
 *
 * ```text
 * .env + cex-config.json  →  toDataCollectorConfig()  →  DataCollectorConfig
 *   (CollectorConfig)                                     (V2-компоненты)
 * ```
 *
 * Legacy-типы коллектора (`CexCollectorConfig`/`CexExchangeConfig`) внутрь
 * рантайма НЕ протаскиваются: JSON-файл разбирается здесь и превращается в
 * `CexSourceConfig[]` пакета `@polymarket/cex-v2`.
 */
import type { IMarketFilterConfig } from '@polymarket/ports';
import type { CexMarketType, CexSourceConfig } from '@polymarket/cex-v2';
import type { CollectorConfig } from '../config.js';

/**
 * Параметры записи Polymarket-датасетов (market-session policy рекордера).
 *
 * @remarks
 * Значения передаются в `DataRecorder` как есть; собственной file-логики у
 * рантайма нет (PART 6 — новая третья реализация storage запрещена).
 */
export interface PolymarketRecordingConfig {
  /** Поддиректория источника внутри date-папки (`{out}/{date}/{sourceSubDir}/`). */
  readonly sourceSubDir: string;
  /** Событий в буфере до принудительного сброса. */
  readonly bufferSize: number;
  /** Интервал периодического сброса буфера (мс). */
  readonly flushIntervalMs: number;
  /** Сжатие датасета при финализации. */
  readonly compression: 'none' | 'gzip';
}

/**
 * Параметры CEX-контура: набор source-ов + политика окон записи.
 */
export interface CexCollectionConfig {
  /** Конфигурации V2-source-ов (одна на биржу × тип рынка). */
  readonly sources: readonly CexSourceConfig[];
  /** Размер окна партиции (минуты). Не задан — дефолт `CexWindowRecorder` (5). */
  readonly windowMinutes?: number;
  /** Записей в буфере окна до сброса. */
  readonly bufferSize: number;
  /** Интервал периодического сброса буферов окон (мс). */
  readonly flushIntervalMs: number;
  /** Сжатие завершённой партиции. */
  readonly compression: 'none' | 'gzip';
}

/**
 * Параметры collection-цикла (что и как часто открывать/закрывать).
 */
export interface CollectionRuntimeConfig {
  /** Максимум одновременных collection-сессий. */
  readonly maxMarkets: number;
  /** Минимальный запас до старта события, раньше которого рынок открывается (мс). */
  readonly minTimeToStartMs?: number;
  /** Пауза между обновлениями candidate cache (мс). */
  readonly discoveryRefreshMs: number;
  /** Пауза между тиками runtime-цикла (fillSlots + finalizer) (мс). */
  readonly runtimeTickMs: number;
}

/**
 * Параметры post-expiry финализации (пробрасываются в `MarketFinalizer`).
 *
 * @remarks
 * Значения по умолчанию принадлежат самому финализатору — рантайм их НЕ
 * переопределяет (MR-A: resolution hardening вне scope).
 */
export interface FinalizationRuntimeConfig {
  /** Минимальная пауза между enrichment-попытками одного рынка (мс). */
  readonly enrichmentRetryMs?: number;
  /** Потолок ожидания полного enrichment-а (мс). */
  readonly enrichmentMaxWaitMs?: number;
}

/**
 * Полная конфигурация production-рантайма коллектора.
 */
export interface DataCollectorConfig {
  /**
   * Корень датасетов, общий для обеих storage-политик.
   *
   * @remarks
   * Раскладка (parity с legacy-коллектором):
   * ```text
   * {outputDir}/{YYYY-MM-DD}/{sourceSubDir}/{question}___{marketId}.jsonl[.gz]
   * {outputDir}/{YYYY-MM-DD}/{exchangeId}/{exchange}_{symbol}_..._ET.jsonl[.gz]
   * ```
   */
  readonly outputDir: string;
  /** Политика записи Polymarket-сессий. */
  readonly polymarket: PolymarketRecordingConfig;
  /** Конфигурация Discovery V2 (фильтр кандидатов). */
  readonly discovery: { readonly filter: IMarketFilterConfig };
  /** Параметры collection-цикла. */
  readonly collection: CollectionRuntimeConfig;
  /** Параметры финализации. */
  readonly finalization: FinalizationRuntimeConfig;
  /** Параметры CEX-контура (пустой `sources` — CEX выключен). */
  readonly cex: CexCollectionConfig;
}

/** Дефолтная пауза тика runtime-цикла (мс). */
const DEFAULT_RUNTIME_TICK_MS = 5_000;

/** Legacy-описание одной биржи в `cex-config.json`. */
interface CexConfigFileEntry {
  readonly exchangeId?: unknown;
  readonly type?: unknown;
  readonly symbols?: unknown;
  readonly orderbook?: unknown;
  readonly trades?: unknown;
  readonly obDepth?: unknown;
  readonly restartIntervalMs?: unknown;
  readonly obMethod?: unknown;
}

/**
 * Приводит legacy-тип рынка к canonical `CexMarketType`.
 *
 * @param raw - Значение поля `type` из внешней конфигурации
 * @param exchangeKey - Ключ биржи (для сообщения об ошибке)
 * @returns Тип рынка в терминах `@polymarket/cex-v2`
 * @throws {Error} Если значение не является известным типом рынка
 *
 * @remarks
 * Единственное расхождение словарей — legacy `'futures'` против canonical
 * CCXT `'future'`; остальные значения совпадают.
 */
function toCexMarketType(raw: unknown, exchangeKey: string): CexMarketType {
  if (raw === 'spot' || raw === 'swap') {
    return raw;
  }
  if (raw === 'future' || raw === 'futures') {
    return 'future';
  }
  throw new Error(
    `Invalid CEX config for '${exchangeKey}': type must be 'spot' | 'future' | 'swap', got ${JSON.stringify(raw)}`,
  );
}

/**
 * Читает опциональное положительное число из внешней конфигурации.
 *
 * @param raw - Сырое значение
 * @param field - Имя поля (для сообщения об ошибке)
 * @param exchangeKey - Ключ биржи (для сообщения об ошибке)
 * @returns Число либо `undefined`, если поле не задано
 * @throws {Error} Если значение задано, но не является конечным числом > 0
 */
function optionalPositiveNumber(
  raw: unknown,
  field: string,
  exchangeKey: string,
): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `Invalid CEX config for '${exchangeKey}': ${field} must be a finite number > 0, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Разбирает внешнюю CEX-конфигурацию в набор `CexSourceConfig`.
 *
 * @param json - Содержимое `cex-config.json` (или inline `CEX_CONFIG`)
 * @returns Конфигурации V2-source-ов, по одной на биржу
 * @throws {Error} При невалидном JSON или невалидном описании биржи
 *
 * @remarks
 * Формат файла сохранён от legacy-коллектора (ключ словаря = `exchangeId`),
 * чтобы production-конфигурация не переписывалась вместе с рантаймом;
 * конверсия имён полей выполняется здесь:
 *
 * ```text
 * { type, symbols, orderbook, trades, obDepth, obMethod, restartIntervalMs }
 *                              ↓
 * { marketType, symbols, watchOrderbook, watchTrades, orderbookDepth,
 *   orderbookMethod, restartIntervalMs }
 * ```
 *
 * @example
 * ```typescript
 * const sources = parseCexSourceConfigs('{"binance":{"type":"spot",' +
 *   '"symbols":["BTC/USDT"],"orderbook":true,"trades":true}}');
 * // → [{ exchangeId: 'binance', marketType: 'spot', ... }]
 * ```
 */
export function parseCexSourceConfigs(json: string): readonly CexSourceConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Invalid CEX config JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid CEX config: expected an object keyed by exchange id');
  }

  const sources: CexSourceConfig[] = [];
  for (const [exchangeKey, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      throw new Error(`Invalid CEX config for '${exchangeKey}': expected an object`);
    }
    const entry = rawEntry as CexConfigFileEntry;
    const symbols = entry.symbols;
    if (
      !Array.isArray(symbols) ||
      symbols.length === 0 ||
      symbols.some((symbol) => typeof symbol !== 'string' || symbol.length === 0)
    ) {
      throw new Error(
        `Invalid CEX config for '${exchangeKey}': symbols must be a non-empty array of strings`,
      );
    }
    if (entry.obMethod !== undefined && entry.obMethod !== 'watch' && entry.obMethod !== 'fetch') {
      throw new Error(
        `Invalid CEX config for '${exchangeKey}': obMethod must be 'watch' | 'fetch', got ${JSON.stringify(entry.obMethod)}`,
      );
    }
    const exchangeId =
      typeof entry.exchangeId === 'string' && entry.exchangeId.length > 0
        ? entry.exchangeId
        : exchangeKey;

    const orderbookDepth = optionalPositiveNumber(entry.obDepth, 'obDepth', exchangeKey);
    const restartIntervalMs = optionalPositiveNumber(
      entry.restartIntervalMs,
      'restartIntervalMs',
      exchangeKey,
    );

    sources.push({
      exchangeId,
      marketType: toCexMarketType(entry.type, exchangeKey),
      symbols: symbols as readonly string[],
      watchOrderbook: entry.orderbook === true,
      watchTrades: entry.trades === true,
      ...(orderbookDepth !== undefined ? { orderbookDepth } : {}),
      ...(entry.obMethod !== undefined ? { orderbookMethod: entry.obMethod } : {}),
      ...(restartIntervalMs !== undefined ? { restartIntervalMs } : {}),
    });
  }
  return sources;
}

/**
 * Превращает внешнюю конфигурацию приложения в конфигурацию V2-рантайма.
 *
 * @param config - Загруженная из окружения `CollectorConfig`
 * @returns Конфигурация рантайма, готовая для `createDataCollector`
 * @throws {Error} Если CEX-конфигурация задана, но невалидна
 *
 * @remarks
 * Отказ разбора CEX-конфигурации — fail-fast: legacy-коллектор в этом случае
 * молча продолжал БЕЗ CEX (`logger.error` + `cexService = null`), из-за чего
 * прогон выглядел живым, но половина датасета не писалась. Здесь такая
 * конфигурация не даёт процессу стартовать; чтобы выключить CEX сознательно,
 * достаточно не задавать `CEX_CONFIG_FILE`/`CEX_CONFIG`.
 *
 * @example
 * ```typescript
 * const runtimeConfig = toDataCollectorConfig(loadConfig());
 * const collector = createDataCollector({ config: runtimeConfig, logger, clock });
 * ```
 */
export function toDataCollectorConfig(config: CollectorConfig): DataCollectorConfig {
  return {
    outputDir: config.outputDir,
    polymarket: {
      sourceSubDir: config.sourceSubDir,
      bufferSize: config.bufferSize,
      flushIntervalMs: config.flushIntervalMs,
      compression: config.compression,
    },
    discovery: {
      filter: {
        minTimeToExpiryHours: config.minTimeToExpiryHours,
        minSpread: config.minSpread,
        minLiquidity: config.minLiquidity,
        maxMarketsToReturn: config.maxMarkets,
        requiredKeywords: config.requiredKeywords,
        anyOfKeywords: config.anyOfKeywords,
        excludedKeywords: config.excludedKeywords,
      },
    },
    collection: {
      maxMarkets: config.maxMarkets,
      discoveryRefreshMs: config.marketScanPauseMs,
      runtimeTickMs: DEFAULT_RUNTIME_TICK_MS,
    },
    finalization: {},
    cex: {
      sources: config.cexConfig === null ? [] : parseCexSourceConfigs(config.cexConfig),
      bufferSize: config.cexBufferSize,
      flushIntervalMs: config.cexFlushIntervalMs,
      compression: config.compression,
      ...(config.cexWindowMinutes !== undefined
        ? { windowMinutes: config.cexWindowMinutes }
        : {}),
    },
  };
}
