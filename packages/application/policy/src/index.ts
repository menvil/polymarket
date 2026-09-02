/**
 * @polymarket/policy — owner policy контура и её применение к universe.
 *
 * @remarks
 * Пакет отвечает на вопрос, которого НЕ знает Infrastructure:
 *
 * > какие из технически доступных рынков хочет конкретный consumer?
 *
 * ```text
 * MarketUniverse → MarketDiscoveryEntry[]
 *                        +
 *                     Policy
 *                        ↓
 *                  MarketFilter     ← подходит / не подходит
 *                        ↓
 *                  MarketScorer     ← порядок
 *                        ↓
 *                 ranked entries
 * ```
 *
 * ### Строгое разделение
 *
 * `MarketFilter` решает «подходит ли», `MarketScorer` — «в каком порядке».
 * Ни один не делает работу другого: скорер ничего не отбрасывает, фильтр
 * ничего не ранжирует. Смешение этих двух ответственностей — самый быстрый
 * способ получить «отбор», зависящий от порядка входа.
 *
 * ### Время всегда снаружи
 *
 * Ни одна функция пакета не читает часы. Момент оценки — параметр, потому
 * что вызывающий спрашивает разное: «действует ли policy сейчас», «будет ли
 * действовать в момент старта вот этого рынка», «действовала ли в момент из
 * архива».
 *
 * ### Две двери в policy, но один путь валидации
 *
 * Программный вызывающий собирает policy из canonical-типов и идёт в
 * `createPolymarketPolicy`/`createCexPolicy` напрямую. Конфигурационный
 * вызывающий (файл, env, JSON) идёт в `parsePolicyConfig` — тот переводит
 * примитивы в canonical-типы и вызывает ТЕ ЖЕ фабрики:
 *
 * ```text
 * PolicyConfig ──parsePolicyConfig()──┐
 *                                     ├──► create*Policy() ──► Policy
 * canonical-объект ───────────────────┘
 * ```
 *
 * Правила отбора (дедупликация, противоречия селекторов, окно, словари)
 * живут только в фабриках. Второй парсер конфигурации на стороне бота или
 * коллектора означал бы вторую систему валидации — и первое же расхождение
 * читалось бы как «через конфиг проходит, из кода нет».
 *
 * @example
 * ```typescript
 * const filtered = filter.filter(universe.getAll(), policy, now);
 * const ranked = scorer.rank(filtered);
 * const next = ranked[0];
 * ```
 *
 * @packageDocumentation
 */
export type { Policy } from './Policy.js';
export type {
  PolymarketPolicy,
  PolymarketPolicyTitleSelectors,
} from './PolymarketPolicy.js';
export { CEX_POLICY_MARKET_TYPE_VALUES, isCexPolicyMarketType } from './CexPolicy.js';
export type { CexPolicy, CexPolicyMarketType } from './CexPolicy.js';
export { isPolicyEffectiveAt } from './PolicyWindow.js';
export type { PolicyWindow } from './PolicyWindow.js';
export {
  PolicyValidationError,
  createCexPolicy,
  createPolymarketPolicy,
} from './createPolicy.js';
export type { CexPolicyInput } from './createPolicy.js';
export { POLICY_CONFIG_KIND_VALUES } from './PolicyConfig.js';
export type {
  CexPolicyConfig,
  PolicyConfig,
  PolicyConfigKind,
  PolymarketPolicyConfig,
} from './PolicyConfig.js';
export {
  parseCexPolicyConfig,
  parsePolicyConfig,
  parsePolymarketPolicyConfig,
} from './parsePolicyConfig.js';
export { MarketFilter } from './MarketFilter.js';
export { MarketScorer } from './MarketScorer.js';
