/**
 * Парсинг и валидация конфигурации бота.
 *
 * @remarks
 * ### Источники (приоритет высокий → низкий):
 * 1. ENV переменные: `MODE`, `STRATEGY`, `CONFIG`
 * 2. JSON файл (путь из `CONFIG` env или `./config.json`)
 * 3. Дефолтные значения (встроены в схему)
 *
 * ### Алгоритм:
 * 1. Читаем env: MODE (обязательно), STRATEGY (опц.), CONFIG (опц.)
 * 2. Читаем JSON файл по пути из CONFIG
 * 3. Применяем дефолты для отсутствующих полей
 * 4. Валидируем обязательные поля
 * 5. Возвращаем `{ mode, config }` или список ошибок
 *
 * @example
 * ```typescript
 * const result = parseConfig(process.env, './configs/dumb-paper.json');
 * if (!result.ok) {
 *   console.error('Config errors:', result.errors);
 *   process.exit(1);
 * }
 * const { mode, config } = result.value;
 * ```
 */

import { readFileSync, existsSync } from 'fs';
import Decimal from 'decimal.js';
import type {
  BotConfig,
  BotMode,
  StrategyType,
  PaperConfig,
  ResourcesConfig,
  AccountConfig,
} from './BotConfig.js';
import {
  DEFAULT_PAPER_CONFIG,
  DEFAULT_RESOURCES_CONFIG,
  DEFAULT_ACCOUNT_CONFIG,
} from './BotConfig.js';

// ── Результат парсинга ────────────────────────────────────────────────────────

/** Успешный результат парсинга */
export interface ParseConfigSuccess {
  readonly ok: true;
  readonly value: {
    readonly mode: BotMode;
    readonly config: BotConfig;
  };
}

/** Неудачный результат парсинга */
export interface ParseConfigFailure {
  readonly ok: false;
  readonly errors: string[];
}

export type ParseConfigResult = ParseConfigSuccess | ParseConfigFailure;

// ── Парсер ───────────────────────────────────────────────────────────────────

/**
 * Читает и валидирует конфигурацию бота.
 *
 * @param env - Словарь переменных окружения (обычно `process.env`)
 * @param defaultConfigPath - Путь к JSON файлу по умолчанию (если CONFIG не задан в env)
 * @returns Результат парсинга: успех с `{mode, config}` или список ошибок
 *
 * @throws Никогда — все ошибки возвращаются через Result
 */
export function parseConfig(
  env: NodeJS.ProcessEnv,
  defaultConfigPath = './config.json',
): ParseConfigResult {
  const errors: string[] = [];

  // ── Шаг 1: env переменные ─────────────────────────────────────────────────

  const modeRaw = env['MODE'];
  if (!modeRaw) {
    errors.push('MODE env variable is required (live | paper | backtest)');
  }
  const VALID_MODES: BotMode[] = ['live', 'paper', 'backtest'];
  const mode = modeRaw as BotMode | undefined;
  if (modeRaw && !VALID_MODES.includes(modeRaw as BotMode)) {
    errors.push(`Invalid MODE="${modeRaw}". Valid values: ${VALID_MODES.join(', ')}`);
  }

  const strategyFromEnv = env['STRATEGY'] as StrategyType | undefined;
  const VALID_STRATEGIES: StrategyType[] = ['dumb', 'market-maker', 'momentum'];
  if (strategyFromEnv && !VALID_STRATEGIES.includes(strategyFromEnv)) {
    errors.push(`Invalid STRATEGY="${strategyFromEnv}". Valid values: ${VALID_STRATEGIES.join(', ')}`);
  }

  const configPath = env['CONFIG'] ?? defaultConfigPath;

  // ── Шаг 2: чтение JSON файла ───────────────────────────────────────────────

  if (!existsSync(configPath)) {
    errors.push(`Config file not found: ${configPath}`);
    return { ok: false, errors };
  }

  let rawJson: Record<string, unknown>;
  try {
    const content = readFileSync(configPath, 'utf-8');
    rawJson = JSON.parse(content) as Record<string, unknown>;
  } catch (e) {
    errors.push(`Failed to parse config file "${configPath}": ${String(e)}`);
    return { ok: false, errors };
  }

  // ── Шаг 3: валидация стратегии ────────────────────────────────────────────

  const strategy = strategyFromEnv ?? (rawJson['strategy'] as StrategyType | undefined);
  if (!strategy) {
    errors.push('strategy is required (in config file or STRATEGY env)');
  } else if (!VALID_STRATEGIES.includes(strategy)) {
    errors.push(`Invalid strategy="${strategy}". Valid values: ${VALID_STRATEGIES.join(', ')}`);
  }

  // ── Шаг 4: валидация strategyParams ──────────────────────────────────────

  const rawParams = rawJson['strategyParams'] as Record<string, unknown> | undefined;
  if (!rawParams) {
    errors.push('strategyParams is required in config file');
  }
  const strategyParams = rawParams ? parseStrategyParams(strategy ?? 'dumb', rawParams, errors) : {};

  // ── Шаг 5: валидация market ───────────────────────────────────────────────

  const rawMarket = rawJson['market'] as Record<string, unknown> | undefined;
  if (!rawMarket) {
    errors.push('market is required in config file');
  }
  const market = rawMarket ? parseMarketConfig(rawMarket, errors, env) : undefined;

  // ── Шаг 6: resources (с дефолтами) ───────────────────────────────────────

  const rawResources = rawJson['resources'] as Partial<ResourcesConfig> | undefined;
  const resources = parseResources(rawResources ?? {}, errors);

  // ── Шаг 7: paper (с дефолтами) ───────────────────────────────────────────

  const rawPaper = rawJson['paper'] as Partial<PaperConfig> | undefined;
  const paper: PaperConfig = {
    fillOnBookCrossing: rawPaper?.fillOnBookCrossing ?? DEFAULT_PAPER_CONFIG.fillOnBookCrossing,
    fillOnTape: rawPaper?.fillOnTape ?? DEFAULT_PAPER_CONFIG.fillOnTape,
    fillAtOrderPrice: rawPaper?.fillAtOrderPrice ?? DEFAULT_PAPER_CONFIG.fillAtOrderPrice,
  };

  // ── Шаг 8: account (с дефолтами) ─────────────────────────────────────────

  const rawAccount = rawJson['account'] as Partial<AccountConfig> | undefined;
  const account: AccountConfig = {
    accountId: rawAccount?.accountId ?? DEFAULT_ACCOUNT_CONFIG.accountId,
  };

  // ── Шаг 9: итог ──────────────────────────────────────────────────────────

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      mode: mode!,
      config: {
        strategy: strategy!,
        strategyParams: strategyParams as unknown as BotConfig['strategyParams'],
        market: market!,
        resources,
        paper,
        account,
      },
    },
  };
}

// ── Вспомогательные парсеры ───────────────────────────────────────────────────

/**
 * Парсит параметры стратегии и конвертирует number в Decimal.
 *
 * @param strategyType - Тип стратегии
 * @param raw - Сырые параметры из JSON
 * @param errors - Массив для накопления ошибок
 * @returns Типизированные параметры стратегии
 */
function parseStrategyParams(
  strategyType: StrategyType,
  raw: Record<string, unknown>,
  errors: string[],
): Record<string, unknown> {
  // JSON числа → Decimal (все стратегии используют Decimal для цен/размеров)
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number') {
      // Числовые поля цен/размеров → Decimal
      result[key] = new Decimal(value);
    } else if (typeof value === 'string' && !isNaN(Number(value))) {
      result[key] = new Decimal(value);
    } else {
      result[key] = value;
    }
  }

  // Валидация обязательных полей по типу стратегии
  switch (strategyType) {
    case 'dumb':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for dumb strategy');
      if (!result['buyOffsetPct']) errors.push('strategyParams.buyOffsetPct is required for dumb strategy');
      if (!result['profitMarginPct']) errors.push('strategyParams.profitMarginPct is required for dumb strategy');
      if (result['repriceThreshold'] === undefined) errors.push('strategyParams.repriceThreshold is required for dumb strategy');
      break;
    case 'market-maker':
      if (!result['spreadOffset']) errors.push('strategyParams.spreadOffset is required for market-maker strategy');
      if (!result['minSpread']) errors.push('strategyParams.minSpread is required for market-maker strategy');
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for market-maker strategy');
      if (raw['exitThresholdMs'] === undefined) errors.push('strategyParams.exitThresholdMs is required for market-maker strategy');
      if (typeof raw['exitThresholdMs'] === 'number') {
        result['exitThresholdMs'] = raw['exitThresholdMs'];
      }
      break;
    case 'momentum':
      if (!result['entryThreshold']) errors.push('strategyParams.entryThreshold is required for momentum strategy');
      if (!result['exitThreshold']) errors.push('strategyParams.exitThreshold is required for momentum strategy');
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for momentum strategy');
      break;
  }

  return result;
}

/**
 * Разбирает строку ключевых слов из env-переменной.
 *
 * @remarks
 * Возвращает `undefined` если переменная не задана или пустая (фильтр не применяется).
 * Разделитель — запятая; результат в нижнем регистре и без пробелов.
 *
 * @param val - Значение env-переменной (или `undefined`)
 * @returns Массив ключевых слов или `undefined`
 */
function parseKeywords(val: string | undefined): string[] | undefined {
  if (!val || val.trim() === '') return undefined;
  return val.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Парсит конфигурацию источника рынка.
 *
 * @param raw - Сырые данные из JSON
 * @param errors - Массив для накопления ошибок
 * @param env - Переменные окружения (для переопределения discovery-фильтра)
 * @returns Конфигурация рынка
 *
 * @remarks
 * Для `source=discovery` env-переменные имеют приоритет над JSON-конфигом:
 * - `MARKET_DISCOVERY_REQUIRED_KEYWORDS` — обязательные слова (через запятую)
 * - `MARKET_DISCOVERY_ANY_OF_KEYWORDS`   — хотя бы одно слово (через запятую)
 * - `MARKET_DISCOVERY_EXCLUDED_KEYWORDS` — запрещённые слова (через запятую)
 * - `MARKET_DISCOVERY_MIN_LIQUIDITY`     — минимальная ликвидность (число)
 * - `MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS` — минимум часов до истечения (число)
 */
function parseMarketConfig(
  raw: Record<string, unknown>,
  errors: string[],
  env: NodeJS.ProcessEnv,
): BotConfig['market'] | undefined {
  const source = raw['source'] as string | undefined;

  if (!source) {
    errors.push('market.source is required (fixed | discovery | snapshots)');
    return undefined;
  }

  switch (source) {
    case 'fixed': {
      const marketId = raw['marketId'] as string | undefined;
      if (!marketId) errors.push('market.marketId is required when source=fixed');
      const outcomeIndex = (raw['outcomeIndex'] as number | undefined) ?? 0;
      if (outcomeIndex !== 0 && outcomeIndex !== 1) {
        errors.push('market.outcomeIndex must be 0 or 1');
      }
      return { source: 'fixed', marketId: marketId ?? '', outcomeIndex: outcomeIndex as 0 | 1 };
    }

    case 'discovery': {
      const filter = (raw['filter'] as Record<string, unknown> | undefined) ?? {};
      const scanPauseMs = (raw['scanPauseMs'] as number | undefined) ?? 30_000;
      const outcomeIndex = (raw['outcomeIndex'] as number | undefined) ?? 0;

      // ENV > JSON: env-переменные переопределяют значения из JSON-конфига
      const envMinLiquidity = env['MARKET_DISCOVERY_MIN_LIQUIDITY']
        ? Number(env['MARKET_DISCOVERY_MIN_LIQUIDITY'])
        : undefined;
      const envMinTimeToExpiry = env['MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS']
        ? Number(env['MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS'])
        : undefined;

      return {
        source: 'discovery',
        filter: {
          minLiquidity: envMinLiquidity ?? (filter['minLiquidity'] as number | undefined),
          minTimeToExpiryHours: envMinTimeToExpiry ?? (filter['minTimeToExpiryHours'] as number | undefined),
          requiredKeywords: parseKeywords(env['MARKET_DISCOVERY_REQUIRED_KEYWORDS']) ?? (filter['requiredKeywords'] as string[] | undefined),
          anyOfKeywords:    parseKeywords(env['MARKET_DISCOVERY_ANY_OF_KEYWORDS'])   ?? (filter['anyOfKeywords']    as string[] | undefined),
          excludedKeywords: parseKeywords(env['MARKET_DISCOVERY_EXCLUDED_KEYWORDS']) ?? (filter['excludedKeywords'] as string[] | undefined),
        },
        scanPauseMs,
        outcomeIndex: outcomeIndex as 0 | 1,
      };
    }

    case 'snapshots': {
      const paths = raw['paths'] as string[] | undefined;
      if (!paths || paths.length === 0) {
        errors.push('market.paths is required and must be non-empty when source=snapshots');
      }
      const rawOutcomeIdx = raw['outcomeIndex'] as number | undefined;
      const outcomeIndex = rawOutcomeIdx ?? 1;
      if (outcomeIndex !== 0 && outcomeIndex !== 1) {
        errors.push('market.outcomeIndex must be 0 or 1');
      }
      return { source: 'snapshots', paths: paths ?? [], outcomeIndex: outcomeIndex as 0 | 1 };
    }

    default:
      errors.push(`Invalid market.source="${source}". Valid values: fixed, discovery, snapshots`);
      return undefined;
  }
}

/**
 * Парсит конфигурацию ресурсов с дефолтами.
 *
 * @param raw - Сырые данные из JSON (могут быть частичными)
 * @param errors - Массив для накопления ошибок
 * @returns Конфигурация ресурсов
 */
function parseResources(
  raw: Partial<ResourcesConfig>,
  errors: string[],
): ResourcesConfig {
  const initialBalance = raw.initialBalance ?? DEFAULT_RESOURCES_CONFIG.initialBalance;
  const tradingBalanceRatio = raw.tradingBalanceRatio ?? DEFAULT_RESOURCES_CONFIG.tradingBalanceRatio;

  if (tradingBalanceRatio <= 0 || tradingBalanceRatio > 1) {
    errors.push('resources.tradingBalanceRatio must be between 0 and 1');
  }
  if (initialBalance <= 0) {
    errors.push('resources.initialBalance must be positive');
  }

  return {
    initialBalance,
    maxConcurrentMarkets: raw.maxConcurrentMarkets ?? DEFAULT_RESOURCES_CONFIG.maxConcurrentMarkets,
    minCapitalPerMarket: raw.minCapitalPerMarket ?? DEFAULT_RESOURCES_CONFIG.minCapitalPerMarket,
    tradingBalanceRatio,
  };
}
