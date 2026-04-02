/**
 * Маршрутизатор стратегий — выбирает стратегию для рынка по правилам.
 *
 * @remarks
 * Поддерживает два режима:
 * - Одна стратегия: `config.strategy` + `config.strategyParams` (обратная совместимость)
 * - Мульти-стратегия: `config.strategyRules[]` — массив правил с фильтрами.
 *   Первое совпадение побеждает, рынок без совпадения пропускается (`null`).
 *
 * @example
 * ```typescript
 * const selection = selectStrategyForMarket(config, candidate, cryptoMeta);
 * if (!selection) {
 *   logger.debug('No strategy rule matches, skipping');
 *   return;
 * }
 * const strategy = createStrategy({ type: selection.strategy, params: selection.strategyParams });
 * ```
 */

import type { BotConfig, StrategyRule, StrategyType, AnyStrategyParams } from './config/BotConfig.js';

/**
 * Результат маршрутизации — выбранная стратегия для рынка.
 */
export interface StrategySelection {
  /** Тип стратегии */
  readonly strategy: StrategyType;
  /** Параметры стратегии */
  readonly strategyParams: AnyStrategyParams;
  /** Метка правила (для логов) */
  readonly ruleLabel: string;
}

/**
 * Минимальный набор данных о рынке для маршрутизации.
 *
 * @remarks
 * Не зависит от конкретных доменных типов (Timestamp, MarketId) —
 * принимает примитивы для упрощения вызова из разных контекстов.
 */
export interface MarketRouteInfo {
  /** Время начала события (epoch ms) */
  readonly eventStartMs?: number;
  /** Время окончания/экспирации (epoch ms) */
  readonly expiresAtMs: number;
  /** Текст вопроса рынка */
  readonly question?: string;
}

/**
 * Выбирает стратегию для рынка по правилам конфигурации.
 *
 * @param config - Конфигурация бота (содержит `strategyRules` или fallback `strategy`)
 * @param market - Информация о рынке (длительность, вопрос)
 * @returns Выбранная стратегия или `null` если ни одно правило не подошло
 *
 * @remarks
 * Если `strategyRules` не задан или пуст — возвращает top-level `strategy`/`strategyParams`.
 * Это обеспечивает полную обратную совместимость со старыми конфигами.
 */
export function selectStrategyForMarket(
  config: BotConfig,
  market: MarketRouteInfo,
): StrategySelection | null {
  // Нет правил → используем top-level (обратная совместимость)
  if (!config.strategyRules || config.strategyRules.length === 0) {
    return {
      strategy: config.strategy,
      strategyParams: config.strategyParams,
      ruleLabel: 'default',
    };
  }

  // Вычисляем длительность рынка в минутах
  const durationMinutes = market.eventStartMs && market.eventStartMs > 0
    ? (market.expiresAtMs - market.eventStartMs) / 60_000
    : undefined;

  for (const rule of config.strategyRules) {
    if (matchesRule(rule, durationMinutes, market.question)) {
      return {
        strategy: rule.strategy,
        strategyParams: rule.strategyParams,
        ruleLabel: rule.label,
      };
    }
  }

  return null; // Ни одно правило не подошло — пропускаем рынок
}

/**
 * Проверяет совпадение рынка с фильтром правила.
 *
 * @param rule - Правило маршрутизации
 * @param durationMinutes - Длительность рынка в минутах (undefined если неизвестна)
 * @param question - Текст вопроса рынка
 * @returns `true` если рынок матчит правило
 */
function matchesRule(
  rule: StrategyRule,
  durationMinutes: number | undefined,
  question: string | undefined,
): boolean {
  const m = rule.match;

  // Фильтр по длительности
  if (m.minDurationMinutes !== undefined || m.maxDurationMinutes !== undefined) {
    if (durationMinutes === undefined) return false;
    if (m.minDurationMinutes !== undefined && durationMinutes < m.minDurationMinutes) return false;
    if (m.maxDurationMinutes !== undefined && durationMinutes > m.maxDurationMinutes) return false;
  }

  // Фильтр по обязательным ключевым словам (все должны присутствовать)
  if (m.requiredKeywords?.length) {
    const q = (question ?? '').toLowerCase();
    if (!m.requiredKeywords.every(kw => q.includes(kw.toLowerCase()))) return false;
  }

  // Фильтр по альтернативным ключевым словам (хотя бы одно)
  if (m.anyOfKeywords?.length) {
    const q = (question ?? '').toLowerCase();
    if (!m.anyOfKeywords.some(kw => q.includes(kw.toLowerCase()))) return false;
  }

  return true;
}
