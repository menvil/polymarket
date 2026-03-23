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
import { DumbStrategy } from './strategies/DumbStrategy.js';
import type { DumbStrategyConfig } from './strategies/DumbStrategy.js';
import { AvellanedaStoikovStrategy } from './strategies/AvellanedaStoikovStrategy.js';
import type { ASStrategyConfig } from './strategies/AvellanedaStoikovStrategy.js';

// ── Типы конфигурации ────────────────────────────────────────────────────────

/** Конфигурация для создания стратегии */
export type StrategyConfig =
  | { readonly type: 'dumb'; readonly id?: string; readonly params: DumbStrategyConfig }
  | { readonly type: 'avellaneda-stoikov'; readonly id?: string; readonly params: ASStrategyConfig };

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
export function createStrategy(config: StrategyConfig, logger?: ILogger): IStrategy {
  switch (config.type) {
    case 'dumb':
      return new DumbStrategy(config.params, config.id, logger);

    case 'avellaneda-stoikov':
      return new AvellanedaStoikovStrategy(config.params, config.id, logger);

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
  marketDuration: '5m',
};
