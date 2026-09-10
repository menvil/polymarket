/*
 * LEGACY REFERENCE ONLY.
 *
 * Historical implementation of the trading contour, preserved for the
 * new trading runtime.
 *
 * Not built.
 * Not linted.
 * Not runnable against the current repository.
 * Do not import from production code.
 *
 * Source: packages/application/strategy/src/types/TriggerReason.ts
 * Commit: abe9354e07501e87bf8a90fa53cccf6fa1b206a4
 *
 * See README.md for what was preserved and what was extracted to docs/.
 */
/**
 * Полный набор известных причин пересчёта стратегии.
 *
 * @remarks
 * `Object.freeze` — runtime immutability, а не только compile-time `readonly`:
 * экспортированный tuple (или `Set`, как было раньше) остаётся мутабельным
 * JS-объектом, если явно не заморожен — `(KNOWN_TRIGGER_REASONS as unknown
 * as string[]).push(...)` в обход типов молча расширил бы разделяемый
 * singleton для всех caller-ов. `Object.freeze` бросает в strict mode
 * (ESM-модули всегда strict) при попытке мутации.
 *
 * `TriggerReason` выводится ИЗ этого tuple (`typeof ...[number]`), а не
 * объявляется отдельно — единственный source of truth, tuple объявлен
 * первым, чтобы не образовалась circular type declaration.
 *
 * Используется runtime-валидацией `ScheduleConfig.priorityTriggers`:
 * значения вне этого набора (например, из caller-кода на `as any`)
 * приводят к `Err` регистрации, а не к молчаливо мёртвому триггеру.
 */
export const KNOWN_TRIGGER_REASONS = Object.freeze([
  'BOOK',
  'TRADE',
  'FILL',
  'ORDER_UPDATE',
  'TIMER',
  'CRYPTO_PRICE',
  'CRYPTO_MARKET_DATA',
] as const);

/**
 * Причина, по которой стратегия должна пересчитать.
 *
 * @remarks
 * Накапливаются во внутреннем dirty state StrategyScheduler между тиками стратегии.
 * Стратегия получает `ReadonlySet<TriggerReason>` в tick() и может
 * адаптировать решение в зависимости от того, что именно изменилось.
 *
 * - `'BOOK'` — обновился стакан (TopOfBook / BookDepth)
 * - `'TRADE'` — пришёл публичный трейд
 * - `'FILL'` — исполнение нашего ордера (priority trigger — bypass throttle)
 * - `'ORDER_UPDATE'` — изменился статус ордера (accept, cancel, expire)
 * - `'TIMER'` — heartbeat: maxIdleMs истёк без событий
 * - `'CRYPTO_PRICE'` — обновилась цена крипто-актива (из RTDS / backtest replay)
 * - `'CRYPTO_MARKET_DATA'` — обновились CEX книги/трейды или derived crypto market data
 */
export type TriggerReason = typeof KNOWN_TRIGGER_REASONS[number];
