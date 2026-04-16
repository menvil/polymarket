import { readFileSync } from 'node:fs';

/**
 * Конфигурация скрипта сбора данных.
 *
 * @remarks
 * Все параметры загружаются из переменных окружения.
 * При отсутствии обязательной переменной — выбрасывается Error при старте.
 *
 * ### Пример .env:
 * ```env
 * GAMMA_API_BASE_URL=https://gamma-api.polymarket.com
 * POLYMARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
 * DATA_COLLECTION_OUTPUT_DIR=./snapshots
 * MARKET_DISCOVERY_MIN_SPREAD=0.02
 * ```
 */

/** Конфигурация скрипта сбора данных */
export interface CollectorConfig {
  /**
   * Включить DNS override через DoH (Cloudflare 1.1.1.1).
   * Использовать на машинах с заблокированным DNS провайдера.
   * По умолчанию: false.
   */
  readonly dnsOverrideEnabled: boolean;

  /** URL Gamma API для дискавери рынков */
  readonly gammaApiBaseUrl: string;

  /** URL Polymarket WebSocket */
  readonly wsUrl: string;

  /** Задержка перереподключения WS (мс) */
  readonly wsReconnectDelayMs: number;

  /** Минимальное время до истечения рынка (часы) */
  readonly minTimeToExpiryHours: number;

  /** Минимальный спред */
  readonly minSpread: number;

  /** Минимальная ликвидность рынка (глубина стакана, не дневной объём) */
  readonly minLiquidity: number;

  /** Максимальное количество одновременно отслеживаемых рынков */
  readonly maxMarkets: number;

  /** Обязательные ключевые слова (ALL должны присутствовать в question) */
  readonly requiredKeywords: readonly string[];

  /** Ключевые слова «хотя бы одно» */
  readonly anyOfKeywords: readonly string[];

  /** Запрещённые ключевые слова */
  readonly excludedKeywords: readonly string[];

  /** Интервал пересканирования рынков (мс) */
  readonly marketScanPauseMs: number;

  /** Директория для записи снапшотов (например `./data/snapshots`) */
  readonly outputDir: string;

  /**
   * Поддиректория источника внутри date-папки.
   * @example `'polymarket'` → `data/snapshots/YYYY-MM-DD/polymarket/`
   */
  readonly sourceSubDir: string;

  /** Сжатие файла при финализации */
  readonly compression: 'none' | 'gzip';

  /** Размер буфера событий */
  readonly bufferSize: number;

  /** Интервал периодического сброса буфера (мс) */
  readonly flushIntervalMs: number;

  /**
   * JSON-конфигурация CEX бирж (опционально).
   * Если не задан — CEX коллектор не запускается.
   * @example `'{"binance":{"type":"spot","symbols":["BTC/USDT"],"orderbook":true,"trades":true}}'`
   */
  readonly cexConfig: string | null;
}

/**
 * Загружает и валидирует конфигурацию из переменных окружения.
 *
 * @returns Типизированный объект конфигурации
 * @throws {Error} Если обязательная переменная окружения не задана
 *
 * @example
 * ```typescript
 * const config = loadConfig();
 * console.log(`Writing to: ${config.outputDir}`);
 * ```
 */
export function loadConfig(): CollectorConfig {
  function optional(name: string, fallback: string): string {
    return process.env[name] ?? fallback;
  }

  function optionalNumber(name: string, fallback: number): number {
    const val = process.env[name];
    if (!val) return fallback;
    const n = Number(val);
    if (isNaN(n)) throw new Error(`Env var ${name} must be a number, got: ${val}`);
    return n;
  }

  function parseKeywords(name: string): readonly string[] {
    const val = process.env[name];
    if (!val || val.trim() === '') return [];
    return val.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  /**
   * Читает CEX конфиг: сначала ищет CEX_CONFIG_FILE (JSON файл),
   * затем CEX_CONFIG (inline JSON строка). Возвращает null если не задан.
   */
  function parseCexConfig(): string | null {
    const filePath = process.env['CEX_CONFIG_FILE'];
    if (filePath) {
      try {
        return readFileSync(filePath, 'utf-8').trim();
      } catch (err) {
        throw new Error(`Cannot read CEX_CONFIG_FILE="${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return process.env['CEX_CONFIG'] ?? null;
  }

  function parseCompression(name: string): 'none' | 'gzip' {
    const val = optional(name, 'none');
    if (val !== 'none' && val !== 'gzip') {
      throw new Error(`Env var ${name} must be 'none' or 'gzip', got: ${val}`);
    }
    return val;
  }

  return {
    dnsOverrideEnabled:   optional('DNS_OVERRIDE_ENABLED', 'false') === 'true',
    gammaApiBaseUrl:      optional('GAMMA_API_BASE_URL', 'https://gamma-api.polymarket.com'),
    wsUrl:                optional('POLYMARKET_WS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),
    wsReconnectDelayMs:   optionalNumber('WS_RECONNECT_DELAY_MS', 3000),
    minTimeToExpiryHours: optionalNumber('MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS', 0),
    minSpread:            optionalNumber('MARKET_DISCOVERY_MIN_SPREAD', 0.02),
    minLiquidity:         optionalNumber('MARKET_DISCOVERY_MIN_LIQUIDITY', 100),
    maxMarkets:           optionalNumber('DATA_COLLECTION_MAX_MARKETS', 10),
    requiredKeywords:     parseKeywords('MARKET_DISCOVERY_REQUIRED_KEYWORDS'),
    anyOfKeywords:        parseKeywords('MARKET_DISCOVERY_ANY_OF_KEYWORDS'),
    excludedKeywords:     parseKeywords('MARKET_DISCOVERY_EXCLUDED_KEYWORDS'),
    marketScanPauseMs:    optionalNumber('MARKET_SCAN_PAUSE_MS', 30_000),
    outputDir:            optional('DATA_COLLECTION_OUTPUT_DIR', './data/snapshots'),
    sourceSubDir:         optional('DATA_COLLECTION_SOURCE_SUBDIR', 'polymarket'),
    cexConfig:            parseCexConfig(),
    compression:          parseCompression('DATA_COLLECTION_COMPRESSION'),
    bufferSize:           optionalNumber('DATA_COLLECTION_BUFFER_SIZE', 100),
    flushIntervalMs:      optionalNumber('DATA_COLLECTION_FLUSH_INTERVAL_MS', 10_000),
  };
}
