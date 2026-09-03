/**
 * Конфигурация production-рантайма коллектора и boundary-конверсия из внешней
 * (env/JSON) конфигурации приложения в canonical owner policy контура.
 *
 * @remarks
 * После Collector-cutover отбор рынков — это owner policy, а не keyword-фильтр
 * discovery. Граница «внешняя конфигурация → canonical Policy» живёт ЗДЕСЬ:
 *
 * ```text
 * .env + cex-config.json  →  toDataCollectorConfig()  →  DataCollectorConfig
 *   (CollectorConfig)          parsePolicyConfig()        (canonical policies)
 * ```
 *
 * Discovery keyword-фильтр (`requiredKeywords`/`anyOfKeywords`/`excluded`)
 * переносится в `PolymarketPolicy.title`; `assets`/`durations` приходят из
 * новых переменных. CEX-конфигурация превращается в НАБОР `CexPolicy` — по
 * одной на биржу, чтобы точный список символов биржи не размывался декартовым
 * произведением одной общей policy.
 */
import { forkEnvironmentConfig } from '@polymarket/client';
import type { EnvironmentConfig } from '@polymarket/client';
import { parsePolicyConfig } from '@polymarket/policy';
import type { CexPolicy, PolymarketPolicy } from '@polymarket/policy';
import type { CollectorConfig } from '../config.js';

/**
 * Параметры записи Polymarket-датасетов (market-session policy рекордера).
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
  /** Окружение официального SDK (форк production, если эндпоинты переопределены). */
  readonly environment?: EnvironmentConfig;
}

/**
 * Транспортные параметры CEX-источников (НЕ входят в `CexPolicy`).
 *
 * @remarks
 * `CexPolicy` описывает ПОТРЕБНОСТЬ (биржа/символы/потоки/глубина), а способ
 * получения стакана и интервал рестарта — свойства транспорта. Их инъецирует
 * фабрика источников CEX-контроллера, не переписывая пользовательскую policy.
 */
export interface CexTransportConfig {
  /** Метод получения стакана (`watch`|`fetch`); не задан — дефолт `CexSource`. */
  readonly orderbookMethod?: 'watch' | 'fetch';
  /** Интервал планового рестарта транспорта (мс); не задан — дефолт `CexSource`. */
  readonly restartIntervalMs?: number;
}

/**
 * Параметры CEX-контура: набор owner policy (по бирже) + политика окон записи.
 */
export interface CexCollectionConfig {
  /** Owner policy по бирже (пустой список — CEX выключен). */
  readonly policies: readonly CexPolicy[];
  /** Транспортные параметры источников. */
  readonly transport: CexTransportConfig;
  /** Размер окна партиции (минуты); не задан — дефолт `CexWindowRecorder` (5). */
  readonly windowMinutes?: number;
  /** Записей в буфере окна до сброса. */
  readonly bufferSize: number;
  /** Интервал периодического сброса буферов окон (мс). */
  readonly flushIntervalMs: number;
  /** Сжатие завершённой партиции. */
  readonly compression: 'none' | 'gzip';
}

/**
 * Параметры control-цикла (что и как часто приобретать/сверять).
 */
export interface ControlRuntimeConfig {
  /**
   * Сколько первых кандидатов плана приобретать за тик (`acquireLimit`).
   * @remarks Считает КАНДИДАТОВ, а не удерживаемые рынки: уже начавшиеся
   * рынки в план не входят и лимит не расходуют.
   */
  readonly acquireLimit: number;
  /** Пауза между control-тиками (мс): один тик = `runOnce` + `reconcile`. */
  readonly tickMs: number;
}

/**
 * Полная конфигурация production-рантайма коллектора.
 */
export interface DataCollectorConfig {
  /** Корень датасетов, общий для обеих storage-политик. */
  readonly outputDir: string;
  /** Политика записи Polymarket-сессий. */
  readonly polymarket: PolymarketRecordingConfig;
  /** Owner policy площадки Polymarket: какие рынки собирает коллектор. */
  readonly polymarketPolicy: PolymarketPolicy;
  /** Окно обзора каталога discovery (мс); не задано — дефолт рантайма. */
  readonly discoveryWindowMs?: number;
  /** Параметры control-цикла. */
  readonly control: ControlRuntimeConfig;
  /** Параметры CEX-контура (пустой `policies` — CEX выключен). */
  readonly cex: CexCollectionConfig;
}

/** Дефолтная пауза control-тика (мс). */
const DEFAULT_CONTROL_TICK_MS = 5_000;
/** Дефолтное окно обзора каталога (2 часа). */
const DEFAULT_DISCOVERY_WINDOW_MS = 2 * 60 * 60_000;

/** Legacy-описание одной биржи в `cex-config.json`. */
interface CexConfigFileEntry {
  readonly type?: unknown;
  readonly symbols?: unknown;
  readonly orderbook?: unknown;
  readonly trades?: unknown;
  readonly obDepth?: unknown;
}

/**
 * Разбирает внешнюю CEX-конфигурацию в НАБОР owner policy — по одной на биржу.
 *
 * @param json - Содержимое `cex-config.json` (или inline `CEX_CONFIG`)
 * @returns Canonical `CexPolicy[]`, по одной на биржу
 * @throws {Error} При невалидном JSON или невалидном описании биржи
 *
 * @remarks
 * Одна policy на биржу СОЗНАТЕЛЬНО: `CexPolicy` раскрывается декартовым
 * произведением `exchangeIds × marketTypes × symbols`, поэтому склеить
 * несколько бирж с РАЗНЫМИ списками символов в одну policy значило бы
 * подписать каждую биржу на объединённый набор — включая пары, которых у неё
 * нет. Отдельная policy на биржу сохраняет точный список символов; CEX-
 * контроллер всё равно агрегирует их claim-ы в общие физические пулы.
 * Валидацию (словарь типов рынка, непустые списки, `orderbook || trades`,
 * глубина) выполняет `parseCexPolicyConfig` — второй копии правил здесь нет.
 *
 * @example
 * ```typescript
 * const policies = parseCexPolicies('{"binance":{"type":"spot",' +
 *   '"symbols":["BTC/USDT"],"orderbook":true,"trades":true,"obDepth":10}}');
 * // → [{ kind:'CEX', exchangeIds:['binance'], marketTypes:['spot'], ... }]
 * ```
 */
export function parseCexPolicies(json: string): readonly CexPolicy[] {
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

  const policies: CexPolicy[] = [];
  for (const [exchangeId, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      throw new Error(`Invalid CEX config for '${exchangeId}': expected an object`);
    }
    const entry = rawEntry as CexConfigFileEntry;
    const policy = parsePolicyConfig({
      kind: 'CEX',
      exchangeIds: [exchangeId],
      // `type` из файла проверит parseCexPolicyConfig по словарю Application.
      marketTypes: [String(entry.type)],
      symbols: Array.isArray(entry.symbols) ? (entry.symbols as string[]) : [],
      orderbook: entry.orderbook === true,
      trades: entry.trades === true,
      ...(typeof entry.obDepth === 'number' ? { orderbookDepth: entry.obDepth } : {}),
    });
    if (policy.kind !== 'CEX') {
      throw new Error(`Invalid CEX config for '${exchangeId}': expected a CEX policy`);
    }
    policies.push(policy);
  }
  return policies;
}

/** Production-значения эндпоинтов, при которых форк окружения не нужен. */
const DEFAULT_GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const DEFAULT_MARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/**
 * Собирает окружение SDK из заданных приложением эндпоинтов.
 *
 * @param config - Внешняя конфигурация приложения
 * @returns Форк production-окружения либо `undefined`, если переопределений нет
 */
function toEnvironmentConfig(config: CollectorConfig): EnvironmentConfig | undefined {
  const gammaOverridden = config.gammaApiBaseUrl !== DEFAULT_GAMMA_BASE_URL;
  const wsOverridden = config.wsUrl !== DEFAULT_MARKET_WS_URL;
  if (!gammaOverridden && !wsOverridden) {
    return undefined;
  }
  return forkEnvironmentConfig({
    name: 'collect-data',
    ...(gammaOverridden ? { gamma: { rest: config.gammaApiBaseUrl } } : {}),
    ...(wsOverridden ? { clob: { market: { ws: config.wsUrl } } } : {}),
  });
}

/**
 * Строит owner policy площадки Polymarket из внешней конфигурации.
 *
 * @param config - Загруженная `CollectorConfig`
 * @returns Canonical `PolymarketPolicy` семейства `CRYPTO_UP_DOWN`
 * @throws {Error} Если конфигурация не даёт policy площадки
 *
 * @remarks
 * Keyword-фильтры discovery переносятся в `title`-селекторы policy;
 * `minLiquidity`/`minSpread` — как есть. Семейство фиксировано `CRYPTO_UP_DOWN`
 * — контур собирает крипто-рынки up/down.
 */
function toPolymarketPolicy(config: CollectorConfig): PolymarketPolicy {
  const policy = parsePolicyConfig({
    kind: 'POLYMARKET',
    family: 'CRYPTO_UP_DOWN',
    ...(config.policyAssets.length > 0 ? { assets: [...config.policyAssets] } : {}),
    ...(config.policyDurations.length > 0 ? { durations: [...config.policyDurations] } : {}),
    ...(config.requiredKeywords.length > 0 ||
    config.anyOfKeywords.length > 0 ||
    config.excludedKeywords.length > 0
      ? {
          title: {
            ...(config.requiredKeywords.length > 0 ? { required: [...config.requiredKeywords] } : {}),
            ...(config.anyOfKeywords.length > 0 ? { anyOf: [...config.anyOfKeywords] } : {}),
            ...(config.excludedKeywords.length > 0 ? { excluded: [...config.excludedKeywords] } : {}),
          },
        }
      : {}),
    ...(config.minLiquidity > 0
      ? { minLiquidity: { amount: config.minLiquidity, currency: 'USDC' } }
      : {}),
    ...(config.minSpread > 0 ? { minSpread: config.minSpread } : {}),
  });
  if (policy.kind !== 'POLYMARKET') {
    throw new Error('Collector policy config must produce a Polymarket policy');
  }
  return policy;
}

/**
 * Превращает внешнюю конфигурацию приложения в конфигурацию V2-рантайма.
 *
 * @param config - Загруженная из окружения `CollectorConfig`
 * @returns Конфигурация рантайма, готовая для `createDataCollector`
 * @throws {Error} Если policy-конфигурация невалидна
 *
 * @remarks
 * Fail-fast: невалидная owner policy (в т.ч. `cex-config.json`) не даёт
 * процессу стартовать. Чтобы выключить CEX сознательно, достаточно не
 * задавать `CEX_CONFIG_FILE`/`CEX_CONFIG` (пустой набор policy).
 *
 * @example
 * ```typescript
 * const runtimeConfig = toDataCollectorConfig(loadConfig());
 * const { collector } = createDataCollector({ config: runtimeConfig, logger, clock });
 * ```
 */
export function toDataCollectorConfig(config: CollectorConfig): DataCollectorConfig {
  const environment = toEnvironmentConfig(config);
  return {
    outputDir: config.outputDir,
    polymarket: {
      sourceSubDir: config.sourceSubDir,
      bufferSize: config.bufferSize,
      flushIntervalMs: config.flushIntervalMs,
      compression: config.compression,
      ...(environment !== undefined ? { environment } : {}),
    },
    polymarketPolicy: toPolymarketPolicy(config),
    discoveryWindowMs:
      config.discoveryWindowHours !== undefined
        ? config.discoveryWindowHours * 60 * 60_000
        : DEFAULT_DISCOVERY_WINDOW_MS,
    control: {
      acquireLimit: config.maxMarkets,
      tickMs: config.controlTickMs > 0 ? config.controlTickMs : DEFAULT_CONTROL_TICK_MS,
    },
    cex: {
      policies: config.cexConfig === null ? [] : parseCexPolicies(config.cexConfig),
      transport: {
        ...(config.cexOrderbookMethod !== undefined
          ? { orderbookMethod: config.cexOrderbookMethod }
          : {}),
        ...(config.cexRestartIntervalMs !== undefined
          ? { restartIntervalMs: config.cexRestartIntervalMs }
          : {}),
      },
      bufferSize: config.cexBufferSize,
      flushIntervalMs: config.cexFlushIntervalMs,
      compression: config.compression,
      ...(config.cexWindowMinutes !== undefined ? { windowMinutes: config.cexWindowMinutes } : {}),
    },
  };
}
