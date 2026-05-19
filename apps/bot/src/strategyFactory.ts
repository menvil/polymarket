/**
 * Фабрика стратегий — создаёт экземпляры стратегий по конфигурации.
 *
 * @remarks
 * Централизованное место для инстанцирования стратегий.
 * Позволяет переключать стратегии через переменные окружения
 * без изменения wiring-кода в main.ts.
 *
 * @example
 * ```typescript
 * const strategy = createStrategy({ type: 'avellaneda-stoikov', params: { gamma: new Decimal('0.05'), ... } });
 * scheduler.register({ strategy, instrumentId, asset, accountId, market });
 * ```
 */
import Decimal from 'decimal.js';
import type { IStrategy } from '@polymarket/strategy';
import type { ILogger } from '@polymarket/logger';
import type { IDecisionJournal } from '@polymarket/ports';
import { DumbStrategy } from './strategies/DumbStrategy.js';
import type { DumbStrategyConfig } from './strategies/DumbStrategy.js';
import { AvellanedaStoikovStrategy } from './strategies/AvellanedaStoikovStrategy.js';
import type { ASStrategyConfig } from './strategies/AvellanedaStoikovStrategy.js';
import { CrossMarketArbStrategy } from './strategies/CrossMarketArbStrategy.js';
import type { CrossMarketArbConfig, ITopOfBookReader } from './strategies/CrossMarketArbStrategy.js';
import { ProbTableStrategy } from './strategies/ProbTableStrategy.js';
import type { ProbTableConfig } from './strategies/ProbTableStrategy.js';
import { CryptoProbStrategy } from './strategies/CryptoProbStrategy.js';
import type { CryptoProbConfig } from './strategies/CryptoProbStrategy.js';
import { SelectiveEntryStrategy } from './strategies/SelectiveEntryStrategy.js';
import type { SelectiveEntryConfig } from './strategies/SelectiveEntryStrategy.js';
import { OscillationMMStrategy } from './strategies/OscillationMMStrategy.js';
import type { OscillationMMConfig } from './strategies/OscillationMMStrategy.js';
import { MomentumScalpStrategy } from './strategies/MomentumScalpStrategy.js';
import type { MomentumScalpConfig } from './strategies/MomentumScalpStrategy.js';
import { SmartEntryStrategy } from './strategies/SmartEntryStrategy.js';
import type { SmartEntryConfig } from './strategies/SmartEntryStrategy.js';
import { AdaptiveEntryStrategy } from './strategies/AdaptiveEntryStrategy.js';
import type { AdaptiveEntryConfig } from './strategies/AdaptiveEntryStrategy.js';
import { FairValueMMStrategy } from './strategies/FairValueMMStrategy.js';
import type { FairValueMMConfig } from './strategies/FairValueMMStrategy.js';
import { BinanceProbMMStrategy } from './strategies/BinanceProbMMStrategy.js';
import type { BinanceProbMMConfig } from './strategies/BinanceProbMMStrategy.js';
import { CexLeadLagStrategy } from './strategies/CexLeadLagStrategy.js';
import type { CexLeadLagConfig } from './strategies/CexLeadLagStrategy.js';
import { CexLeadLagExitPolicyStrategy } from './strategies/CexLeadLagExitPolicyStrategy.js';
import type { CexLeadLagExitPolicyConfig } from './strategies/CexLeadLagExitPolicyStrategy.js';
import { CexLeadLagRiskBudgetStrategy } from './strategies/CexLeadLagRiskBudgetStrategy.js';
import type { CexLeadLagRiskBudgetConfig } from './strategies/CexLeadLagRiskBudgetStrategy.js';
import { CalibrationRulesStrategy } from './strategies/CalibrationRulesStrategy.js';
import type { CalibrationRulesConfig } from './strategies/CalibrationRulesStrategy.js';
import { PairedCexCrowdStrategy } from './strategies/PairedCexCrowdStrategy.js';
import type { PairedCexCrowdConfig } from './strategies/PairedCexCrowdStrategy.js';
import { BaselinePairedOverlayStrategy } from './strategies/BaselinePairedOverlayStrategy.js';
import type { BaselinePairedOverlayConfig } from './strategies/BaselinePairedOverlayStrategy.js';
import { CalibratedCrowdStrategy, CexCrowdNotAdverseStrategy } from './strategies/calibrated-crowd/index.js';
import type { CalibratedCrowdConfig, CexCrowdNotAdverseConfig } from './strategies/calibrated-crowd/index.js';
import { OrderBookWallStrategy } from './strategies/order-book-wall/index.js';
import type { OrderBookWallConfig } from './strategies/order-book-wall/index.js';
import { CrowdDeviationStrategy } from './strategies/CrowdDeviationStrategy.js';
import type { CrowdDeviationConfig } from './strategies/CrowdDeviationStrategy.js';
import { CrowdDeviationTPSLStrategy } from './strategies/CrowdDeviationTPSLStrategy.js';
import type { CrowdDeviationTPSLConfig } from './strategies/CrowdDeviationTPSLStrategy.js';

// ── Типы конфигурации ────────────────────────────────────────────────────────

/** Конфигурация для создания стратегии */
export type StrategyConfig =
  | { readonly type: 'dumb'; readonly id?: string; readonly params: DumbStrategyConfig }
  | { readonly type: 'avellaneda-stoikov'; readonly id?: string; readonly params: ASStrategyConfig }
  | { readonly type: 'cross-market-arb'; readonly id?: string; readonly params: CrossMarketArbConfig; readonly reader: ITopOfBookReader }
  | { readonly type: 'prob-table'; readonly id?: string; readonly params: ProbTableConfig }
  | { readonly type: 'crypto-prob'; readonly id?: string; readonly params: CryptoProbConfig }
  | { readonly type: 'selective-entry'; readonly id?: string; readonly params: SelectiveEntryConfig }
  | { readonly type: 'oscillation-mm'; readonly id?: string; readonly params: OscillationMMConfig }
  | { readonly type: 'momentum-scalp'; readonly id?: string; readonly params: MomentumScalpConfig }
  | { readonly type: 'smart-entry'; readonly id?: string; readonly params: SmartEntryConfig }
  | { readonly type: 'adaptive-entry'; readonly id?: string; readonly params: AdaptiveEntryConfig }
  | { readonly type: 'fair-value-mm'; readonly id?: string; readonly params: FairValueMMConfig }
  | { readonly type: 'binance-prob-mm'; readonly id?: string; readonly params: BinanceProbMMConfig }
  | { readonly type: 'cex-lead-lag'; readonly id?: string; readonly params: CexLeadLagConfig }
  | { readonly type: 'cex-lead-lag-exit-policy'; readonly id?: string; readonly params: CexLeadLagExitPolicyConfig }
  | { readonly type: 'cex-lead-lag-risk-budget'; readonly id?: string; readonly params: CexLeadLagRiskBudgetConfig }
  | { readonly type: 'calibration-rules'; readonly id?: string; readonly params: CalibrationRulesConfig }
  | { readonly type: 'calibrated-crowd'; readonly id?: string; readonly params: CalibratedCrowdConfig }
  | { readonly type: 'calibrated-crowd-cex'; readonly id?: string; readonly params: CexCrowdNotAdverseConfig }
  | { readonly type: 'paired-cex-crowd'; readonly id?: string; readonly params: PairedCexCrowdConfig }
  | { readonly type: 'baseline-paired-overlay'; readonly id?: string; readonly params: BaselinePairedOverlayConfig }
  | { readonly type: 'order-book-wall'; readonly id?: string; readonly params: OrderBookWallConfig }
  | { readonly type: 'crowd-deviation'; readonly id?: string; readonly params: CrowdDeviationConfig }
  | { readonly type: 'crowd-deviation-tpsl'; readonly id?: string; readonly params: CrowdDeviationTPSLConfig };

export interface StrategyExecutionOverrides {
  readonly postOnly?: boolean;
}

// ── Фабрика ──────────────────────────────────────────────────────────────────

/**
 * Создаёт экземпляр стратегии по конфигурации.
 *
 * @param config - Конфигурация стратегии (type + params)
 * @param logger - Опциональный логгер для диагностики тиков
 * @returns Экземпляр IStrategy
 *
 * @throws {Error} Если тип стратегии неизвестен
 */
export function createStrategy(
  config: StrategyConfig,
  logger?: ILogger,
  journal?: IDecisionJournal,
  execution?: StrategyExecutionOverrides,
): IStrategy {
  switch (config.type) {
    case 'dumb':
      return new DumbStrategy(config.params, config.id, logger);

    case 'avellaneda-stoikov':
      return new AvellanedaStoikovStrategy(config.params, config.id, logger);

    case 'cross-market-arb':
      return new CrossMarketArbStrategy(config.params, config.reader, config.id, logger);

    case 'prob-table':
      return new ProbTableStrategy(config.params, config.id, logger);

    case 'crypto-prob':
      return new CryptoProbStrategy(config.params, config.id, logger);

    case 'selective-entry':
      return new SelectiveEntryStrategy(
        {
          ...config.params,
          postOnly: execution?.postOnly ?? config.params.postOnly,
        },
        config.id,
        logger,
        journal,
      );

    case 'oscillation-mm':
      return new OscillationMMStrategy(config.params, config.id, logger);

    case 'momentum-scalp':
      return new MomentumScalpStrategy(config.params, config.id, logger);

    case 'smart-entry':
      return new SmartEntryStrategy(config.params, config.id, logger);

    case 'adaptive-entry':
      return new AdaptiveEntryStrategy(config.params, config.id, logger, journal);

    case 'fair-value-mm':
      return new FairValueMMStrategy(config.params, config.id, logger);

    case 'binance-prob-mm':
      return new BinanceProbMMStrategy(config.params, config.id, logger);

    case 'cex-lead-lag':
      return new CexLeadLagStrategy(config.params, config.id, logger, journal);

    case 'cex-lead-lag-exit-policy':
      return new CexLeadLagExitPolicyStrategy(config.params, config.id, logger, journal);

    case 'cex-lead-lag-risk-budget':
      return new CexLeadLagRiskBudgetStrategy(config.params, config.id, logger, journal);

    case 'calibration-rules':
      return new CalibrationRulesStrategy(
        {
          ...config.params,
          postOnly: execution?.postOnly ?? config.params.postOnly,
        },
        config.id,
        logger,
        journal,
      );

    case 'calibrated-crowd':
      return new CalibratedCrowdStrategy(config.params, config.id, logger, journal);

    case 'calibrated-crowd-cex':
      return new CexCrowdNotAdverseStrategy(config.params, config.id, logger, journal);

    case 'paired-cex-crowd':
      return new PairedCexCrowdStrategy(config.params, config.id, logger, journal);

    case 'baseline-paired-overlay':
      return new BaselinePairedOverlayStrategy(config.params, config.id, logger, journal);

    case 'order-book-wall': {
      const obwId = config.id ?? `obw-${(config.params as any).side}-${Date.now()}`;
      return new OrderBookWallStrategy(obwId, config.params as any, logger);
    }

    case 'crowd-deviation':
      return new CrowdDeviationStrategy(
        {
          ...config.params,
          postOnly: execution?.postOnly ?? config.params.postOnly,
        },
        config.id,
        logger,
        journal,
      );

    case 'crowd-deviation-tpsl':
      return new CrowdDeviationTPSLStrategy(
        {
          ...config.params,
          postOnly: execution?.postOnly ?? config.params.postOnly,
        },
        config.id,
        logger,
        journal,
      );

    default:
      throw new Error(`Unknown strategy type: ${(config as { type: string }).type}`);
  }
}

// ── Дефолтные конфигурации ───────────────────────────────────────────────────

/**
 * Дефолтная конфигурация DumbStrategy.
 *
 * @remarks
 * Параметры для smoke-тестирования:
 * - orderSize = 5 токенов
 * - buyOffset = 10% (ставим BUY на 10% ниже refPrice)
 * - profitMargin = 5% (наценка на продажу)
 * - repriceThreshold = 0.08 (переставляем если рынок ушёл вверх на ≥ 8 центов)
 */
export const DEFAULT_DUMB_CONFIG: DumbStrategyConfig = {
  orderSize: new Decimal('5'),
  buyOffsetPct: new Decimal('10'),
  profitMarginPct: new Decimal('5'),
  repriceThreshold: new Decimal('0.08'),
};

/**
 * Дефолтная конфигурация AvellanedaStoikovStrategy.
 *
 * @remarks
 * Baseline параметры из исследования prediction-market-analysis:
 * - gamma = 0.05 (умеренный risk aversion)
 * - qMax = 5 (максимальная позиция ±5 × orderSize)
 * - orderSize = 10 токенов
 * - 5-минутные крипто-рынки (Bitcoin Up or Down)
 */
export const DEFAULT_AS_CONFIG: ASStrategyConfig = {
  gamma: new Decimal('0.05'),
  qMax: 5,
  orderSize: new Decimal('10'),
};
