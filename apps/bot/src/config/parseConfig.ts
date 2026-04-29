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
  StrategyRule,
  StrategyMatchFilter,
  PaperConfig,
  ResourcesConfig,
  AccountConfig,
  RecordingConfig,
  CexFeedConfig,
} from './BotConfig.js';
import {
  DEFAULT_PAPER_CONFIG,
  DEFAULT_RESOURCES_CONFIG,
  DEFAULT_ACCOUNT_CONFIG,
  DEFAULT_EXECUTION_CONFIG,
  DEFAULT_RECORDING_CONFIG,
  DEFAULT_CEX_FEED_CONFIG,
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
  const VALID_STRATEGIES: StrategyType[] = ['dumb', 'avellaneda-stoikov', 'cross-market-arb', 'prob-table', 'crypto-prob', 'selective-entry', 'oscillation-mm', 'momentum-scalp', 'smart-entry', 'adaptive-entry', 'fair-value-mm', 'binance-prob-mm', 'cex-lead-lag', 'calibration-rules', 'calibrated-crowd', 'calibrated-crowd-cex', 'paired-cex-crowd', 'baseline-paired-overlay'];
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

  // ── Шаг 3: strategyRules (мульти-стратегия, опционально) ──────────────────

  const rawRules = rawJson['strategyRules'] as unknown[] | undefined;
  let strategyRules: StrategyRule[] | undefined;
  if (rawRules && Array.isArray(rawRules) && rawRules.length > 0) {
    strategyRules = [];
    for (let i = 0; i < rawRules.length; i++) {
      const r = rawRules[i] as Record<string, unknown>;
      const ruleStrategy = r['strategy'] as StrategyType;
      if (!ruleStrategy || !VALID_STRATEGIES.includes(ruleStrategy)) {
        errors.push(`strategyRules[${i}].strategy is invalid: "${ruleStrategy}"`);
        continue;
      }
      const ruleRawParams = r['strategyParams'] as Record<string, unknown>;
      if (!ruleRawParams) {
        errors.push(`strategyRules[${i}].strategyParams is required`);
        continue;
      }
      const ruleParams = parseStrategyParams(ruleStrategy, ruleRawParams, errors);
      const rawMatch = (r['match'] as Record<string, unknown>) ?? {};
      const match: StrategyMatchFilter = {
        minDurationMinutes: typeof rawMatch['minDurationMinutes'] === 'number' ? rawMatch['minDurationMinutes'] : undefined,
        maxDurationMinutes: typeof rawMatch['maxDurationMinutes'] === 'number' ? rawMatch['maxDurationMinutes'] : undefined,
        anyOfKeywords: Array.isArray(rawMatch['anyOfKeywords']) ? rawMatch['anyOfKeywords'] as string[] : undefined,
        requiredKeywords: Array.isArray(rawMatch['requiredKeywords']) ? rawMatch['requiredKeywords'] as string[] : undefined,
      };
      strategyRules.push({
        label: (r['label'] as string) ?? `rule-${i}`,
        match,
        strategy: ruleStrategy,
        strategyParams: ruleParams as unknown as StrategyRule['strategyParams'],
      });
    }
  }

  const hasRules = strategyRules && strategyRules.length > 0;

  // ── Шаг 4: валидация стратегии ────────────────────────────────────────────

  const strategy = strategyFromEnv ?? (rawJson['strategy'] as StrategyType | undefined);
  if (!strategy && !hasRules) {
    errors.push('strategy is required (in config file, STRATEGY env, or strategyRules[])');
  } else if (strategy && !VALID_STRATEGIES.includes(strategy)) {
    errors.push(`Invalid strategy="${strategy}". Valid values: ${VALID_STRATEGIES.join(', ')}`);
  }

  // ── Шаг 5: валидация strategyParams ──────────────────────────────────────

  const rawParams = rawJson['strategyParams'] as Record<string, unknown> | undefined;
  if (!rawParams && !hasRules) {
    errors.push('strategyParams is required in config file (or use strategyRules[])');
  }
  const strategyParams = rawParams ? parseStrategyParams(strategy ?? 'dumb', rawParams, errors) : {};

  // ── Шаг 6: валидация market ───────────────────────────────────────────────

  const rawMarket = rawJson['market'] as Record<string, unknown> | undefined;
  if (!rawMarket) {
    errors.push('market is required in config file');
  }
  const market = rawMarket ? parseMarketConfig(rawMarket, errors, env) : undefined;

  // ── Шаг 7: resources (с дефолтами) ───────────────────────────────────────

  const rawResources = rawJson['resources'] as Partial<ResourcesConfig> | undefined;
  const resources = parseResources(rawResources ?? {}, errors);

  // ── Шаг 8: paper (с дефолтами) ───────────────────────────────────────────

  const rawPaper = rawJson['paper'] as Partial<PaperConfig> | undefined;
  const paper: PaperConfig = {
    fillOnBookCrossing: rawPaper?.fillOnBookCrossing ?? DEFAULT_PAPER_CONFIG.fillOnBookCrossing,
    fillOnTape: rawPaper?.fillOnTape ?? DEFAULT_PAPER_CONFIG.fillOnTape,
    fillAtOrderPrice: rawPaper?.fillAtOrderPrice ?? DEFAULT_PAPER_CONFIG.fillAtOrderPrice,
  };

  // ── Шаг 9: account (с дефолтами) ─────────────────────────────────────────

  const rawAccount = rawJson['account'] as Partial<AccountConfig> | undefined;
  const account: AccountConfig = {
    accountId: rawAccount?.accountId ?? DEFAULT_ACCOUNT_CONFIG.accountId,
  };

  // ── Шаг 10: execution (с дефолтами) ───────────────────────────────────────

  const rawExecution = rawJson['execution'] as Partial<{ postOnly: boolean }> | undefined;
  const execution = {
    postOnly: rawExecution?.postOnly ?? DEFAULT_EXECUTION_CONFIG.postOnly,
  };

  // ── Шаг 11: recording (с дефолтами) ───────────────────────────────────────

  const rawRecording = rawJson['recording'] as Partial<RecordingConfig> | undefined;
  const recording: RecordingConfig = {
    enabled: rawRecording?.enabled ?? DEFAULT_RECORDING_CONFIG.enabled,
    outputDir: rawRecording?.outputDir ?? DEFAULT_RECORDING_CONFIG.outputDir,
    journalDir: rawRecording?.journalDir ?? DEFAULT_RECORDING_CONFIG.journalDir,
    compression: rawRecording?.compression ?? DEFAULT_RECORDING_CONFIG.compression,
  };

  // ── Шаг 11.5: CEX feed (опционально) ─────────────────────────────────────

  const cex = parseCexFeed(rawJson['cex'] as Partial<CexFeedConfig> | undefined, errors);

  // ── Шаг 12: итог ─────────────────────────────────────────────────────────

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Fallback стратегия: первое правило если нет top-level
  const effectiveStrategy = strategy ?? (hasRules ? strategyRules![0]!.strategy : 'dumb');
  const effectiveParams = rawParams
    ? (strategyParams as unknown as BotConfig['strategyParams'])
    : (hasRules ? strategyRules![0]!.strategyParams : ({} as unknown as BotConfig['strategyParams']));

  return {
    ok: true,
    value: {
      mode: mode!,
      config: {
        strategy: effectiveStrategy,
        strategyParams: effectiveParams,
        ...(strategyRules && strategyRules.length > 0 ? { strategyRules } : {}),
        market: market!,
        resources,
        paper,
        account,
        execution,
        recording,
        ...(cex ? { cex } : {}),
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
    case 'avellaneda-stoikov':
      if (!result['gamma']) errors.push('strategyParams.gamma is required for avellaneda-stoikov strategy');
      if (raw['qMax'] === undefined) errors.push('strategyParams.qMax is required for avellaneda-stoikov strategy');
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for avellaneda-stoikov strategy');
      // qMax — целое число, не Decimal
      if (typeof raw['qMax'] === 'number') result['qMax'] = raw['qMax'];
      // Опциональные числовые поля — оставить как number, не Decimal
      // Probability table: string fields
      if (typeof raw['probTablePath'] === 'string') result['probTablePath'] = raw['probTablePath'];
      if (typeof raw['probTableMode'] === 'string') result['probTableMode'] = raw['probTableMode'];
      for (const numField of ['skewMult', 'ewmaAlpha', 'unwindSec', 'unwindMaxDiscountCents', 'stopLossCents', 'stopLossSpreadMult', 'minTradesForMid', 'regimeWindow', 'regimeTrendThreshold', 'regimeRangeThreshold', 'regimeTrendSpreadMult', 'regimeRangeSpreadMult', 'warmupSec', 'jumpThreshold', 'jumpWidenFactor', 'jumpCooldownTrades', 'profitHoldThreshold', 'profitHoldSkewReduction', 'dynGammaSlope', 'maxWarmupVolCents', 'minWarmupTradesPerSec', 'maxSpreadCents', 'maxWarmupImbalance', 'imbalanceSpreadFactor', 'depthSpreadFactor', 'ofiWindow', 'ofiWeight', 'conditionCheckSpreadCents', 'conditionCheckVolCents', 'conditionCheckMinDepth', 'conditionCheckCooldownSec', 'adaptiveScale', 'adaptiveMinOrderRatio', 'aasConsecutiveThreshold', 'ofiSkipThreshold', 'trailDistanceCents', 'trailTightCents', 'trailWideZoneCents', 'trailWideDistanceCents', 'trailHoldZoneCents', 'minBidZoneCents', 'maxBidZoneCents', 'dynSizeAlpha', 'dynSizeMinRatio', 'dynSizeMaxRatio', 'probTableMinEdge', 'probTableMinN', 'cryptoExitProbThreshold', 'cryptoExitDiscountCents', 'cryptoEntryMinEdge', 'cryptoEntryMinProb']) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      // dynamicQ — массив фаз {until, qMax}, передаём as-is (не конвертируем в Decimal)
      if (Array.isArray(raw['dynamicQ'])) {
        result['dynamicQ'] = raw['dynamicQ'];
      }
      break;

    case 'cross-market-arb':
      // Параметры для кросс-маркетного арбитража.
      // peerInstrumentId и strike'ы задаются динамически из discovery, не из конфига.
      // В конфиге только общие пороги.
      for (const numField of ['minSpreadAfterFees', 'maxPositionUnits']) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      break;

    case 'prob-table':
      if (typeof raw['probTablePath'] !== 'string') errors.push('strategyParams.probTablePath is required for prob-table strategy');
      else result['probTablePath'] = raw['probTablePath'];
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for prob-table strategy');
      if (raw['qMax'] === undefined) errors.push('strategyParams.qMax is required for prob-table strategy');
      if (typeof raw['qMax'] === 'number') result['qMax'] = raw['qMax'];
      for (const numField of ['entryEdge', 'exitEdge', 'stopEdge', 'exitTauSec', 'minN', 'warmupSec', 'ewmaAlpha', 'minTradesForMid']) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      break;

    case 'crypto-prob':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for crypto-prob strategy');
      if (raw['qMax'] === undefined) errors.push('strategyParams.qMax is required for crypto-prob strategy');
      if (typeof raw['qMax'] === 'number') result['qMax'] = raw['qMax'];
      for (const numField of ['entryProb', 'exitProb', 'minEdgeCents', 'exitTauSec', 'warmupSec', 'exitDiscountCents', 'minBidZoneCents', 'maxBidZoneCents', 'minDeltaPct', 'maxEntryTauSec', 'minEntryProb']) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      break;

    case 'selective-entry':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for selective-entry strategy');
      for (const numField of ['minZoneCents', 'maxZoneCents', 'minDeltaPct', 'maxDeltaPct', 'minTauSec', 'maxTauSec', 'maxSpreadCents', 'warmupSec', 'bidOffsetCents', 'minRiseCents', 'waitPct', 'compMaxDiscrepancyCents', 'minDeltaAccel', 'vetoRiseBelowCents', 'vetoCompDiscrepancyAboveCents', 'makerRepriceAfterSec']) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      if (raw['side'] === 'up' || raw['side'] === 'down' || raw['side'] === 'auto') result['side'] = raw['side'];
      if (raw['requireDeltaAccel'] === true || raw['requireDeltaAccel'] === false) result['requireDeltaAccel'] = raw['requireDeltaAccel'];
      if (raw['useBookAnchoredMakerPricing'] === true || raw['useBookAnchoredMakerPricing'] === false) {
        result['useBookAnchoredMakerPricing'] = raw['useBookAnchoredMakerPricing'];
      }
      if (raw['postOnly'] === true || raw['postOnly'] === false) result['postOnly'] = raw['postOnly'];
      break;

    case 'oscillation-mm':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for oscillation-mm strategy');
      for (const numField of ['entryOffsetCents', 'profitTargetCents', 'stopLossCents', 'maxHoldSec', 'cooldownSec', 'maxRoundTrips', 'minTauSec', 'warmupSec', 'ofiWindow', 'ofiEntryThreshold', 'ofiExitThreshold', 'aasThreshold', 'maxDropCents', 'dropWindowSec', 'confirmationSec', 'confirmStopCents', 'confirmOfiThreshold', 'confirmAasThreshold']) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      break;

    case 'momentum-scalp':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for momentum-scalp strategy');
      for (const numField of ['priceMinCents', 'priceMaxCents', 'maxTauSec', 'minTauSec', 'velocityMin', 'velocityMax', 'pressureMin', 'pressureMax', 'takeProfitCents', 'stopLossCents', 'tpTimeoutSec', 'warmupSec', 'maxEntries', 'cooldownSec']) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      break;

    case 'smart-entry':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for smart-entry strategy');
      for (const numField of ['waitPct', 'minEwmaCents', 'maxEwmaCentsForDown', 'minRiseCents', 'minFallCents', 'warmupTrades', 'bidOffsetCents', 'maxSpreadCents']) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      if (raw['mode'] === 'bullish' || raw['mode'] === 'bearish' || raw['mode'] === 'adaptive') result['mode'] = raw['mode'];
      break;

    case 'adaptive-entry':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for adaptive-entry strategy');
      for (const numField of ['waitPct', 'minEwmaCents', 'maxEwmaCents', 'minRiseCents', 'compMinRiseCents', 'warmupTrades', 'bidOffsetCents']) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      break;

    case 'fair-value-mm':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for fair-value-mm strategy');
      if (raw['qMax'] === undefined) errors.push('strategyParams.qMax is required for fair-value-mm strategy');
      if (typeof raw['qMax'] === 'number') result['qMax'] = raw['qMax'];
      for (const numField of [
        'sigmaAnnual', 'minEdgeCents', 'inventorySkew', 'baseSpreadCents',
        'maxSpreadCents', 'flowThreshold', 'jumpThresholdCents', 'warmupSec',
        'ewmaAlpha', 'minTradesForMid', 'unwindSec', 'dynSizeDecay', 'minFairCents',
      ]) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      break;

    case 'binance-prob-mm':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for binance-prob-mm strategy');
      if (raw['qMax'] === undefined) errors.push('strategyParams.qMax is required for binance-prob-mm strategy');
      if (typeof raw['qMax'] === 'number') result['qMax'] = raw['qMax'];
      if (typeof raw['binanceSymbol'] === 'string') result['binanceSymbol'] = raw['binanceSymbol'];
      if (typeof raw['binanceBaseUrl'] === 'string') result['binanceBaseUrl'] = raw['binanceBaseUrl'];
      for (const numField of [
        'lookbackDays', 'maxHorizonMinutes', 'minEdgeCents', 'baseSpreadCents',
        'maxSpreadCents', 'inventorySkew', 'unwindSec', 'warmupSec', 'ewmaAlpha',
        'minTradesForMid', 'minModelSamples',
      ]) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      if (raw['useDrift'] === true || raw['useDrift'] === false) result['useDrift'] = raw['useDrift'];
      break;

    case 'cex-lead-lag':
      if (!result['orderSize']) errors.push('strategyParams.orderSize is required for cex-lead-lag strategy');
      if (raw['qMax'] === undefined) errors.push('strategyParams.qMax is required for cex-lead-lag strategy');
      if (typeof raw['qMax'] === 'number') result['qMax'] = raw['qMax'];
      if (raw['side'] === 'up' || raw['side'] === 'down') result['side'] = raw['side'];
      if (raw['mode'] === 'defensive' || raw['mode'] === 'skewed' || raw['mode'] === 'hybrid') result['mode'] = raw['mode'];
      if (typeof raw['signalId'] === 'string') result['signalId'] = raw['signalId'];
      if (Array.isArray(raw['venues'])) result['venues'] = raw['venues'];
      if (raw['weights'] && typeof raw['weights'] === 'object') result['weights'] = raw['weights'];
      if (raw['basisByVenue'] && typeof raw['basisByVenue'] === 'object') result['basisByVenue'] = raw['basisByVenue'];
      if (raw['confidenceByScore'] && typeof raw['confidenceByScore'] === 'object') result['confidenceByScore'] = raw['confidenceByScore'];
      for (const numField of [
        'signalThresholdBps', 'signalLookbackMs', 'signalStaleMs', 'minVenueCount',
        'maxSpreadBps', 'minSignalStrength', 'minSignalConfidence', 'signalImpactCents',
        'maxSignalImpactCents', 'makerRepriceThresholdCents', 'chainlinkStaleMs',
        'sigmaAnnual',
        'minEdgeCents', 'exitEdgeCents', 'baseSpreadCents', 'exitDiscountCents',
        'emergencyExitSlippageCents', 'maxChaseAboveExitCents', 'stopLossCents',
        'stopLossCooldownMs', 'breakEvenTriggerCents', 'breakEvenOffsetCents',
        'trailingStartMultiplier', 'minTrailingDistanceCents',
        'tauTighteningStartSec', 'tauTighteningMinMultiplier',
        'signalTighteningMultiplier', 'trailingExitRatio',
        'signalExitGraceMs', 'signalExitMinProfitCents', 'signalExitRatio',
        'adverseExitGraceMs', 'adverseExitRatio',
        'warmupSec', 'ewmaAlpha', 'minTradesForMid', 'exitTauSec',
        'maxEntryTauSec', 'minSignalPersistenceMs', 'minFairCents', 'maxFairCents',
      ]) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      if (raw['requireSignalForEntry'] === true || raw['requireSignalForEntry'] === false) {
        result['requireSignalForEntry'] = raw['requireSignalForEntry'];
      }
      if (raw['allowTaker'] === true || raw['allowTaker'] === false) {
        result['allowTaker'] = raw['allowTaker'];
      }
      if (raw['signalTighteningOnCollapse'] === true || raw['signalTighteningOnCollapse'] === false) {
        result['signalTighteningOnCollapse'] = raw['signalTighteningOnCollapse'];
      }
      if (raw['signalTighteningOnAdverse'] === true || raw['signalTighteningOnAdverse'] === false) {
        result['signalTighteningOnAdverse'] = raw['signalTighteningOnAdverse'];
      }
      if (raw['profitProtectTrailingEnabled'] === true || raw['profitProtectTrailingEnabled'] === false) {
        result['profitProtectTrailingEnabled'] = raw['profitProtectTrailingEnabled'];
      }
      if (raw['signalExitEnabled'] === true || raw['signalExitEnabled'] === false) {
        result['signalExitEnabled'] = raw['signalExitEnabled'];
      }
      break;

    case 'calibration-rules':
      if (typeof raw['rulesTablePath'] !== 'string') {
        errors.push('strategyParams.rulesTablePath is required for calibration-rules strategy');
      } else {
        result['rulesTablePath'] = raw['rulesTablePath'];
      }
      if (typeof raw['orderShares'] !== 'number') {
        errors.push('strategyParams.orderShares is required for calibration-rules strategy');
      } else {
        result['orderShares'] = raw['orderShares'];
      }
      for (const numField of [
        'maxSpreadCents',
        'warmupSec',
        'bidOffsetCents',
        'makerRepriceAfterSec',
        'regimeMinPoints',
        'regimeThresholdPerMin',
        'regimeWindowMs',
      ]) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      if (typeof raw['useBookAnchoredMakerPricing'] === 'boolean') result['useBookAnchoredMakerPricing'] = raw['useBookAnchoredMakerPricing'];
      if (typeof raw['logEntries'] === 'boolean') result['logEntries'] = raw['logEntries'];
      if (typeof raw['postOnly'] === 'boolean') result['postOnly'] = raw['postOnly'];
      break;

    case 'calibrated-crowd':
    case 'calibrated-crowd-cex':
    case 'paired-cex-crowd':
    case 'baseline-paired-overlay':
      if (typeof raw['edgeTablePath'] !== 'string') {
        errors.push('strategyParams.edgeTablePath is required for calibrated-crowd strategy');
      } else {
        result['edgeTablePath'] = raw['edgeTablePath'];
      }
      for (const numField of [
        'relaxedMinN', 'relaxedMinEdge', 'relaxedMinCiEdge', 'orderShares',
        'minComposite', 'maxPositionFraction', 'maxSharesPerMarket', 'warmupSec',
        'regimeMinPoints', 'regimeThresholdPerMin', 'regimeWindowMs',
        'weightDropThreshold', 'exitTauSec', 'edgeClosureCents', 'panicTauSec',
        'cexThresholdBps', 'cexLookbackMs', 'cexStaleMs', 'cexMinVenueCount', 'cexMaxSpreadBps',
        'cexLinearInterceptUsd', 'minBasisSamples',
        'normalizeThresholdBps', 'maxSignalHoldMs', 'tokenAvailabilityDelayMs', 'minLockedProfitCents',
        'noFillDecisionMs', 'noFillDriftCents', 'oppositeEntryMinEdge', 'oppositeMaxImbalance',
        'fillAdversePenaltyCents', 'sameSideReentryCooldownMs', 'pairedLockMinProfitCents', 'pairedLockFeeBufferCents',
        'strongEntryCompositeMin', 'strongEntryCexBpsMin', 'mediumEntryCompositeMin', 'mediumEntryCexBpsMin',
        'strongEntryProtectMs', 'tierBDecayFactor', 'tierCDecayFactor', 'hardFlipBps', 'overlayPairedLockMinProfitCents',
      ]) {
        if (typeof raw[numField] === 'number') result[numField] = raw[numField];
      }
      for (const boolField of [
        'relaxedRequireOos',
        'exitOnRegimeFlip', 'exitOnWeightDrop', 'exitOnTauTimeout',
        'exitOnEdgeClosure', 'allowPanicTaker', 'cexRequireFresh', 'logEntries',
        'exitOnSignalStale', 'exitOnSignalFlip', 'hedgeWhenUnavailable', 'allowTierALock',
      ]) {
        if (raw[boolField] === true || raw[boolField] === false) {
          result[boolField] = raw[boolField];
        }
      }
      if (raw['crowdGate'] === 'strict' || raw['crowdGate'] === 'relaxed') {
        result['crowdGate'] = raw['crowdGate'];
      }
      if (
        raw['relaxedEntrySide'] === 'table' ||
        raw['relaxedEntrySide'] === 'up' ||
        raw['relaxedEntrySide'] === 'down' ||
        raw['relaxedEntrySide'] === 'both'
      ) {
        result['relaxedEntrySide'] = raw['relaxedEntrySide'];
      }
      if (raw['cexFilterMode'] === 'off' || raw['cexFilterMode'] === 'agree' || raw['cexFilterMode'] === 'not-adverse') {
        result['cexFilterMode'] = raw['cexFilterMode'];
      }
      if (raw['exitMode'] === 'hold' || raw['exitMode'] === 'signal-normalized') {
        result['exitMode'] = raw['exitMode'];
      }
      if (typeof raw['cexSignalId'] === 'string') result['cexSignalId'] = raw['cexSignalId'];
      if (Array.isArray(raw['cexVenues'])) result['cexVenues'] = raw['cexVenues'];
      if (raw['cexWeights'] && typeof raw['cexWeights'] === 'object') result['cexWeights'] = raw['cexWeights'];
      if (raw['cexBasisByVenue'] && typeof raw['cexBasisByVenue'] === 'object') result['cexBasisByVenue'] = raw['cexBasisByVenue'];
      if (raw['cexConfidenceByScore'] && typeof raw['cexConfidenceByScore'] === 'object') result['cexConfidenceByScore'] = raw['cexConfidenceByScore'];
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
      const paths = Array.isArray(raw['paths']) ? raw['paths'] as string[] : undefined;
      const scanPauseMs = (raw['scanPauseMs'] as number | undefined) ?? 30_000;
      const outcomeIndex = (raw['outcomeIndex'] as number | undefined) ?? 0;

      // ENV > JSON: env-переменные переопределяют значения из JSON-конфига
      const envMinLiquidity = env['MARKET_DISCOVERY_MIN_LIQUIDITY']
        ? Number(env['MARKET_DISCOVERY_MIN_LIQUIDITY'])
        : undefined;
      const envMinTimeToExpiry = env['MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS']
        ? Number(env['MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS'])
        : undefined;

      // Duration filter: env > JSON
      const envMinDuration = env['MARKET_DISCOVERY_MIN_DURATION_MINUTES']
        ? Number(env['MARKET_DISCOVERY_MIN_DURATION_MINUTES'])
        : undefined;
      const envMaxDuration = env['MARKET_DISCOVERY_MAX_DURATION_MINUTES']
        ? Number(env['MARKET_DISCOVERY_MAX_DURATION_MINUTES'])
        : undefined;

      return {
        source: 'discovery',
        ...(paths && paths.length > 0 ? { paths } : {}),
        filter: {
          minLiquidity: envMinLiquidity ?? (filter['minLiquidity'] as number | undefined),
          minTimeToExpiryHours: envMinTimeToExpiry ?? (filter['minTimeToExpiryHours'] as number | undefined),
          requiredKeywords: parseKeywords(env['MARKET_DISCOVERY_REQUIRED_KEYWORDS']) ?? (filter['requiredKeywords'] as string[] | undefined),
          anyOfKeywords:    parseKeywords(env['MARKET_DISCOVERY_ANY_OF_KEYWORDS'])   ?? (filter['anyOfKeywords']    as string[] | undefined),
          excludedKeywords: parseKeywords(env['MARKET_DISCOVERY_EXCLUDED_KEYWORDS']) ?? (filter['excludedKeywords'] as string[] | undefined),
          minDurationMinutes: envMinDuration ?? (filter['minDurationMinutes'] as number | undefined),
          maxDurationMinutes: envMaxDuration ?? (filter['maxDurationMinutes'] as number | undefined),
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
      const filter = (raw['filter'] as Record<string, unknown> | undefined) ?? {};
      const rawOutcomeIdx = raw['outcomeIndex'] as number | undefined;
      const outcomeIndex = rawOutcomeIdx ?? 1;
      if (outcomeIndex !== 0 && outcomeIndex !== 1) {
        errors.push('market.outcomeIndex must be 0 or 1');
      }
      return {
        source: 'snapshots',
        paths: paths ?? [],
        outcomeIndex: outcomeIndex as 0 | 1,
        filter: {
          minLiquidity: typeof filter['minLiquidity'] === 'number' ? filter['minLiquidity'] : undefined,
          minTimeToExpiryHours: typeof filter['minTimeToExpiryHours'] === 'number' ? filter['minTimeToExpiryHours'] : undefined,
          anyOfKeywords: Array.isArray(filter['anyOfKeywords']) ? filter['anyOfKeywords'] as string[] : undefined,
          requiredKeywords: Array.isArray(filter['requiredKeywords']) ? filter['requiredKeywords'] as string[] : undefined,
          excludedKeywords: Array.isArray(filter['excludedKeywords']) ? filter['excludedKeywords'] as string[] : undefined,
          minDurationMinutes: typeof filter['minDurationMinutes'] === 'number' ? filter['minDurationMinutes'] : undefined,
          maxDurationMinutes: typeof filter['maxDurationMinutes'] === 'number' ? filter['maxDurationMinutes'] : undefined,
        },
      };
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

function parseCexFeed(
  raw: Partial<CexFeedConfig> | undefined,
  errors: string[],
): CexFeedConfig | undefined {
  if (!raw) return undefined;

  const enabled = raw.enabled ?? DEFAULT_CEX_FEED_CONFIG.enabled;
  const exchanges = raw.exchanges ?? DEFAULT_CEX_FEED_CONFIG.exchanges;

  if (enabled && Object.keys(exchanges).length === 0) {
    errors.push('cex.exchanges must be non-empty when cex.enabled=true');
  }

  return {
    enabled,
    exchanges,
    outputDir: raw.outputDir,
    compression: raw.compression,
    windowMinutes: raw.windowMinutes,
    bufferSize: raw.bufferSize,
    flushIntervalMs: raw.flushIntervalMs,
  };
}
