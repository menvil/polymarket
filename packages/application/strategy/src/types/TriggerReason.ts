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
export type TriggerReason =
  | 'BOOK'
  | 'TRADE'
  | 'FILL'
  | 'ORDER_UPDATE'
  | 'TIMER'
  | 'CRYPTO_PRICE'
  | 'CRYPTO_MARKET_DATA';

/**
 * Полный набор известных TriggerReason.
 *
 * @remarks
 * Используется runtime-валидацией `ScheduleConfig.priorityTriggers`:
 * значения вне этого набора (например, из caller-кода на `as any`)
 * приводят к `Err` регистрации, а не к молчаливо мёртвому триггеру.
 *
 * Readonly tuple, а НЕ `Set` — экземпляр `Set`, даже типизированный как
 * `ReadonlySet`, остаётся мутабельным объектом в рантайме
 * (`(KNOWN_TRIGGER_REASONS as Set<any>).add(...)` молча расширил бы разделяемый
 * singleton для всех caller-ов). Код, которому нужен `Set` для `.has()`,
 * строит собственную приватную копию из этого tuple.
 */
export const KNOWN_TRIGGER_REASONS: readonly TriggerReason[] = [
  'BOOK',
  'TRADE',
  'FILL',
  'ORDER_UPDATE',
  'TIMER',
  'CRYPTO_PRICE',
  'CRYPTO_MARKET_DATA',
] as const;
