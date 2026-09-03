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
 * новых переменных. CEX-конфигурация превращается в НАБОР описаний ПРОФИЛЕЙ —
 * по одному на запись файла (policy + транспорт), чтобы точный список символов
 * не размывался декартовым произведением общей policy, транспорт остался
 * адресуемым парой `exchangeId + marketType`, а несколько профилей одной биржи
 * (`binance-spot`/`binance-futures`) давали РАЗНЫХ владельцев спроса.
 */
import { forkEnvironmentConfig } from '@polymarket/client';
import type { EnvironmentConfig } from '@polymarket/client';
import { parsePolicyConfig } from '@polymarket/policy';
import type { CexPolicy, CexPolicyMarketType, PolymarketPolicy } from '@polymarket/policy';
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
 * Транспортные параметры ОДНОГО физического пула (НЕ входят в `CexPolicy`).
 *
 * @remarks
 * `CexPolicy` описывает ПОТРЕБНОСТЬ (биржа/символы/потоки/глубина), а способ
 * получения стакана и интервал рестарта — свойства транспорта. Они приходят из
 * записи `cex-config.json` и адресуются парой `exchangeId + marketType`:
 * фабрика источников накладывает их на тот пул, для которого поднимает
 * источник. Общих на все биржи значений здесь нет — это молча ломало бы
 * конфигурации с РАЗНЫМИ `obMethod`/`restartIntervalMs`.
 */
export interface CexTransportConfig {
  /** Метод получения стакана (`watch`|`fetch`); не задан — дефолт `CexSource`. */
  readonly orderbookMethod?: 'watch' | 'fetch';
  /** Интервал планового рестарта транспорта (мс); не задан — дефолт `CexSource`. */
  readonly restartIntervalMs?: number;
}

/**
 * Описание одного ПРОФИЛЯ конфигурации: owner policy + его транспорт.
 *
 * @remarks
 * Профиль — это одна запись `cex-config.json`. Он НЕ равен бирже: одна биржа
 * законно описывается несколькими профилями с разными видами рынка
 * (`binance-spot` и `binance-futures`, оба с `exchangeId: "binance"`).
 * Поэтому идентичностей здесь три, и путать их нельзя:
 *
 * ```text
 * profileKey  — ключ записи конфигурации   → identity ВЛАДЕЛЬЦА спроса
 * exchangeId  — настоящая биржа            → identity транспорта
 * marketType  — вид рынка                  → вместе с exchangeId адресует пул
 * ```
 */
export interface CexExchangeConfig {
  /**
   * Ключ записи в `cex-config.json` — стабильная identity профиля.
   *
   * @remarks
   * Из него строится `ownerKey` спроса. Брать для этого `exchangeId` нельзя:
   * два профиля одной биржи дали бы ОДИН ownerKey, а CEX-контроллер запрещает
   * дубликат владельца в одном проходе и отверг бы весь спрос.
   */
  readonly profileKey: string;
  /** Идентификатор биржи (явный `exchangeId` записи либо ключ профиля). */
  readonly exchangeId: string;
  /**
   * Вид рынка профиля.
   *
   * @remarks
   * Часть адреса физического пула (`exchangeId + marketType + stream` —
   * так его ключует сам контроллер), поэтому транспорт адресуется парой
   * `exchangeId + marketType`, а не одной биржей.
   */
  readonly marketType: CexPolicyMarketType;
  /** Owner policy ровно этого профиля. */
  readonly policy: CexPolicy;
  /** Транспортные параметры физического пула этого профиля. */
  readonly transport: CexTransportConfig;
}

/**
 * Строит ключ адресации транспорта: биржа + вид рынка.
 *
 * @param exchangeId - Идентификатор биржи
 * @param marketType - Вид рынка
 * @returns Составной ключ physical-пула в части, определяющей транспорт
 *
 * @remarks
 * Контроллер ключует физический пул тройкой `exchangeId + marketType + stream`.
 * Транспорт (`obMethod`/`restartIntervalMs`) от потока не зависит, поэтому
 * ключ здесь — пара. Адресация ОДНОЙ биржей схлопывала бы spot и future
 * одного экземпляра биржи, и один транспорт молча затирал бы другой.
 */
export function cexTransportKey(exchangeId: string, marketType: string): string {
  return `${exchangeId}|${marketType}`;
}

/**
 * Параметры CEX-контура: описания бирж + политика окон записи.
 */
export interface CexCollectionConfig {
  /** Описания бирж (пустой список — CEX выключен). */
  readonly exchanges: readonly CexExchangeConfig[];
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
  /**
   * Окно обзора каталога discovery (мс) — ТОЛЬКО явный override.
   * @remarks
   * Отсутствие поля означает «параметр не передавать»: действует canonical
   * дефолт `PolymarketMarketDiscovery` (6ч). Дубля дефолта здесь нет.
   */
  readonly discoveryWindowMs?: number;
  /** Параметры control-цикла. */
  readonly control: ControlRuntimeConfig;
  /** Параметры CEX-контура (пустой `exchanges` — CEX выключен). */
  readonly cex: CexCollectionConfig;
}

/** Дефолтная пауза control-тика (мс). */
const DEFAULT_CONTROL_TICK_MS = 5_000;

/** Legacy-описание одной биржи в `cex-config.json`. */
interface CexConfigFileEntry {
  readonly exchangeId?: unknown;
  readonly type?: unknown;
  readonly symbols?: unknown;
  readonly orderbook?: unknown;
  readonly trades?: unknown;
  readonly obDepth?: unknown;
  readonly obMethod?: unknown;
  readonly restartIntervalMs?: unknown;
}

/**
 * Читает НЕОБЯЗАТЕЛЬНОЕ положительное число из внешней конфигурации.
 *
 * @param raw - Сырое значение
 * @param field - Имя поля (для сообщения об ошибке)
 * @param exchangeKey - Ключ биржи (для сообщения об ошибке)
 * @returns Число либо `undefined`, если поле не задано
 * @throws {Error} Если значение задано, но не является конечным числом > 0
 *
 * @remarks
 * Отсутствие значения — законно, а НЕВЕРНОЕ значение обязано ронять старт.
 * Молча отбросить нечисловой `obDepth` и подставить дефолт значило бы
 * превратить опечатку в тихо работающую конфигурацию.
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
 * Приводит legacy-написание вида рынка к словарю Application.
 *
 * @param raw - Значение поля `type` из `cex-config.json`
 * @returns Строка вида рынка для `parseCexPolicyConfig`
 *
 * @remarks
 * ЕДИНСТВЕННОЕ расхождение словарей — legacy `'futures'` против canonical
 * `'future'`; остальные значения совпадают. Формат `cex-config.json` сохранён
 * от прежнего коллектора, и тот нормализовал этот алиас, поэтому нормализация
 * остаётся здесь: иначе рабочий конфиг с `"type": "futures"` перестал бы
 * стартовать при переезде на owner policy.
 *
 * Прочие значения проходят БЕЗ изменений — их точную проверку и внятную
 * ошибку («допустимо вот это») делает `parseCexPolicyConfig`; вторая копия
 * словаря видов рынка здесь не заводится.
 */
function toPolicyMarketType(raw: unknown): string {
  return raw === 'futures' ? 'future' : String(raw);
}

/**
 * Разбирает внешнюю CEX-конфигурацию в НАБОР owner policy — по одной на биржу.
 *
 * @param json - Содержимое `cex-config.json` (или inline `CEX_CONFIG`)
 * @returns Описания бирж: policy + собственные транспортные параметры
 * @throws {Error} При невалидном JSON или невалидном описании биржи
 *
 * @remarks
 * Одна policy на биржу СОЗНАТЕЛЬНО: `CexPolicy` раскрывается декартовым
 * произведением `exchangeIds × marketTypes × symbols`, поэтому склеить
 * несколько бирж с РАЗНЫМИ списками символов в одну policy значило бы
 * подписать каждую биржу на объединённый набор — включая пары, которых у неё
 * нет. Отдельная policy на биржу сохраняет точный список символов; CEX-
 * контроллер всё равно агрегирует их claim-ы в общие физические пулы.
 *
 * Транспортные поля записи (`obMethod`, `restartIntervalMs`) в policy не
 * входят, но и НЕ теряются: они возвращаются рядом, по бирже, и фабрика
 * источников накладывает их по `exchangeId`. Прежний парсер переносил их в
 * `CexSourceConfig` именно по-биржево, и конфигурации с разными значениями у
 * разных бирж обязаны продолжать работать.
 *
 * Разделение проверок: сырые ТИПЫ значений (booleans, положительные числа,
 * словарь `obMethod`) проверяются здесь, потому что иначе неверный ввод молча
 * стал бы валидным (`"true"` → `false`, строковый `obDepth` → дефолт).
 * Смысловые правила policy (словарь видов рынка, непустые списки,
 * `orderbook || trades`, границы глубины) остаются за `parseCexPolicyConfig`.
 *
 * @example
 * ```typescript
 * const exchanges = parseCexExchangeConfigs('{"binance":{"type":"spot",' +
 *   '"symbols":["BTC/USDT"],"orderbook":true,"trades":true,"obDepth":10,' +
 *   '"obMethod":"watch","restartIntervalMs":1800000}}');
 * // → [{ exchangeId:'binance', policy:{...}, transport:{orderbookMethod:'watch', ...} }]
 * ```
 */
export function parseCexExchangeConfigs(json: string): readonly CexExchangeConfig[] {
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

  const exchanges: CexExchangeConfig[] = [];
  /** Транспорт, уже объявленный для физического пула (для проверки конфликта). */
  const transportByPool = new Map<string, { profileKey: string; transport: CexTransportConfig }>();
  for (const [exchangeKey, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      throw new Error(`Invalid CEX config for '${exchangeKey}': expected an object`);
    }
    const entry = rawEntry as CexConfigFileEntry;

    // Сырые значения проверяются ДО сборки policy: недопустимое значение
    // обязано ронять старт, а не превращаться в валидное (`"true"` → false,
    // строковый obDepth → дефолт). Смысловые правила (словарь видов рынка,
    // непустые списки, orderbook||trades, границы глубины) остаются за
    // `parseCexPolicyConfig` — второй копии этих правил здесь нет.
    if (!Array.isArray(entry.symbols)) {
      throw new Error(`Invalid CEX config for '${exchangeKey}': symbols must be an array`);
    }
    if (typeof entry.orderbook !== 'boolean' || typeof entry.trades !== 'boolean') {
      throw new Error(
        `Invalid CEX config for '${exchangeKey}': orderbook and trades must be booleans`,
      );
    }
    if (entry.obMethod !== undefined && entry.obMethod !== 'watch' && entry.obMethod !== 'fetch') {
      throw new Error(
        `Invalid CEX config for '${exchangeKey}': obMethod must be 'watch' | 'fetch', got ${JSON.stringify(entry.obMethod)}`,
      );
    }
    const orderbookDepth = optionalPositiveNumber(entry.obDepth, 'obDepth', exchangeKey);
    const restartIntervalMs = optionalPositiveNumber(
      entry.restartIntervalMs,
      'restartIntervalMs',
      exchangeKey,
    );
    // Явный `exchangeId` записи побеждает ключ словаря (поведение прежнего
    // парсера: ключ может быть человеческим именем профиля).
    const exchangeId =
      typeof entry.exchangeId === 'string' && entry.exchangeId.length > 0
        ? entry.exchangeId
        : exchangeKey;

    const policy = parsePolicyConfig({
      kind: 'CEX',
      exchangeIds: [exchangeId],
      // Legacy-алиас `futures` нормализуется; словарь видов рынка проверит
      // parseCexPolicyConfig.
      marketTypes: [toPolicyMarketType(entry.type)],
      symbols: entry.symbols as readonly string[],
      orderbook: entry.orderbook,
      trades: entry.trades,
      ...(orderbookDepth !== undefined ? { orderbookDepth } : {}),
    });
    if (policy.kind !== 'CEX') {
      throw new Error(`Invalid CEX config for '${exchangeKey}': expected a CEX policy`);
    }

    // Вид рынка берётся из УЖЕ проверенной policy: словарь Application там
    // сужен, и повторять его здесь нечем.
    const marketType = policy.marketTypes[0];
    if (marketType === undefined) {
      throw new Error(`Invalid CEX config for '${exchangeKey}': market type is missing`);
    }
    const transport: CexTransportConfig = {
      ...(entry.obMethod !== undefined ? { orderbookMethod: entry.obMethod } : {}),
      ...(restartIntervalMs !== undefined ? { restartIntervalMs } : {}),
    };

    // Один физический пул — один транспорт. Два профиля одной пары
    // `exchangeId + marketType` законны (контроллер объединит их символы), но
    // ДВА РАЗНЫХ `obMethod`/`restartIntervalMs` на один пул неразрешимы:
    // источник поднимается один. Молчаливый выбор одного из них означал бы,
    // что настройки профиля зависят от порядка ключей в JSON.
    const poolKey = cexTransportKey(exchangeId, marketType);
    const declared = transportByPool.get(poolKey);
    if (declared !== undefined && !sameTransport(declared.transport, transport)) {
      throw new Error(
        `Invalid CEX config: profiles '${declared.profileKey}' and '${exchangeKey}' both target ` +
          `${exchangeId}/${marketType} but declare different transport settings ` +
          `(obMethod/restartIntervalMs); one physical pool cannot have two`,
      );
    }
    transportByPool.set(poolKey, { profileKey: exchangeKey, transport });

    exchanges.push({
      profileKey: exchangeKey,
      exchangeId,
      marketType,
      policy,
      transport,
    });
  }
  return exchanges;
}

/**
 * Совпадают ли транспортные параметры двух профилей.
 *
 * @param left - Транспорт уже разобранного профиля
 * @param right - Транспорт текущего профиля
 * @returns `true`, если оба поля равны (включая «оба не заданы»)
 *
 * @remarks
 * Сравниваются именно ОБА поля: одинаковый `obMethod` при разных
 * `restartIntervalMs` — такой же конфликт, как и наоборот.
 */
function sameTransport(left: CexTransportConfig, right: CexTransportConfig): boolean {
  return (
    left.orderbookMethod === right.orderbookMethod &&
    left.restartIntervalMs === right.restartIntervalMs
  );
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
    // Окно обзора передаётся ТОЛЬКО как явный override. Не задано — параметр
    // не передаётся вовсе, и действует canonical дефолт самого
    // `PolymarketMarketDiscovery` (6ч, покрывает серии 5m/15m/1h/4h). Свой
    // дубль дефолта здесь молча сузил бы горизонт и лишил бы 4h-рынки шанса
    // быть приобретёнными до `startsAt`.
    ...(config.discoveryWindowHours !== undefined
      ? { discoveryWindowMs: config.discoveryWindowHours * 60 * 60_000 }
      : {}),
    control: {
      acquireLimit: config.maxMarkets,
      tickMs: config.controlTickMs > 0 ? config.controlTickMs : DEFAULT_CONTROL_TICK_MS,
    },
    cex: {
      exchanges: config.cexConfig === null ? [] : parseCexExchangeConfigs(config.cexConfig),
      bufferSize: config.cexBufferSize,
      flushIntervalMs: config.cexFlushIntervalMs,
      compression: config.compression,
      ...(config.cexWindowMinutes !== undefined ? { windowMinutes: config.cexWindowMinutes } : {}),
    },
  };
}
