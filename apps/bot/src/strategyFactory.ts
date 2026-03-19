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
 * const strategy = createStrategy({ type: 'market-maker', ... });
 * scheduler.register({ strategy, instrumentId, asset, accountId, market });
 * ```
 */
import Decimal from 'decimal.js';
import type { IStrategy } from '@polymarket/strategy';
import type { ILogger } from '@polymarket/logger';
import { SimpleMarketMaker } from './strategies/SimpleMarketMaker.js';
import type { SimpleMarketMakerConfig } from './strategies/SimpleMarketMaker.js';
import { MomentumStrategy } from './strategies/MomentumStrategy.js';
import type { MomentumStrategyConfig } from './strategies/MomentumStrategy.js';
import { DumbStrategy } from './strategies/DumbStrategy.js';
import type { DumbStrategyConfig } from './strategies/DumbStrategy.js';

// ── Типы конфигурации ────────────────────────────────────────────────────────

/** Конфигурация для создания стратегии */
export type StrategyConfig =
  | { readonly type: 'market-maker'; readonly id?: string; readonly params: SimpleMarketMakerConfig }
  | { readonly type: 'momentum'; readonly id?: string; readonly params: MomentumStrategyConfig }
  | { readonly type: 'dumb'; readonly id?: string; readonly params: DumbStrategyConfig };

// ── Фабрика ──────────────────────────────────────────────────────────────────

/**
 * Создаёт экземпляр стратегии по конфигурации.
 *
 * @param config - Конфигурация стратегии (type + params)
 * @returns Экземпляр IStrategy
 *
 * @throws {Error} Если тип стратегии неизвестен
 */
export function createStrategy(config: StrategyConfig, logger?: ILogger): IStrategy {
  switch (config.type) {
    case 'market-maker':
      return new SimpleMarketMaker(config.params, config.id);

    case 'momentum':
      return new MomentumStrategy(config.params, config.id);

    case 'dumb':
      return new DumbStrategy(config.params, config.id, logger);

    default:
      throw new Error(`Unknown strategy type: ${(config as { type: string }).type}`);
  }
}

// ── Дефолтные конфигурации ───────────────────────────────────────────────────

/**
 * Дефолтная конфигурация SimpleMarketMaker.
 *
 * @remarks
 * Консервативные параметры для начала работы:
 * - spreadOffset = 0.02 (2% от mid)
 * - minSpread = 0.01 (минимальный спред 1%)
 * - orderSize = 10 токенов
 * - exitThresholdMs = 60_000 (выход за 60с до экспирации)
 */
export const DEFAULT_MARKET_MAKER_CONFIG: SimpleMarketMakerConfig = {
  spreadOffset: new Decimal('0.02'),
  minSpread: new Decimal('0.01'),
  orderSize: new Decimal('10'),
  exitThresholdMs: 60_000,
};

/**
 * Дефолтная конфигурация MomentumStrategy.
 *
 * @remarks
 * Пороги:
 * - entryThreshold = 0.65 (вход при buyRatio > 65%)
 * - exitThreshold = 0.40 (выход при buyRatio < 40%)
 * - orderSize = 5 токенов (консервативный размер)
 */
export const DEFAULT_MOMENTUM_CONFIG: MomentumStrategyConfig = {
  entryThreshold: new Decimal('0.65'),
  exitThreshold: new Decimal('0.40'),
  orderSize: new Decimal('5'),
};

/**
 * Дефолтная конфигурация DumbStrategy.
 *
 * @remarks
 * Параметры для smoke-тестирования:
 * - orderSize = 5 токенов
 * - buyOffset = 0.08 (ставим BUY на 8 центов ниже refPrice)
 * - profitMargin = 0.05 (5 центов наценки на продажу)
 * - repriceThreshold = 0.08 (переставляем если рынок ушёл вверх на ≥ 8 центов)
 */
export const DEFAULT_DUMB_CONFIG: DumbStrategyConfig = {
  orderSize: new Decimal('5'),
  buyOffsetPct: new Decimal('10'),
  profitMarginPct: new Decimal('5'),
  repriceThreshold: new Decimal('0.08'),
};
