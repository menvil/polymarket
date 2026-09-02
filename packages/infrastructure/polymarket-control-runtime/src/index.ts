/**
 * @polymarket/polymarket-control-runtime — прямая оркестрация control-plane
 * Polymarket: один детерминированный проход от каталога до подписок.
 *
 * @remarks
 * ```text
 *                     CONTROL PLANE
 *
 * current V2 Gamma
 *       ↓
 * PolymarketMarketDiscovery
 *       ↓ refresh()
 * MarketUniverse
 *       ↓
 * runtime demands
 * ├── strategy:A     + Policy + acquireLimit
 * ├── strategy:B     + Policy + acquireLimit
 * └── collector:raw  + Policy + acquireLimit
 *       ↓
 * PolymarketControlRuntime.runOnce()
 *       ↓
 * PolymarketSubscriptionPlanner
 *       ↓
 * PolymarketSubscriptionController.acquire()
 *       ↓
 * общие физические подписки
 * ```
 *
 * ### Пять правил, ради которых существует пакет
 *
 * 1. **`runOnce()` и никакого таймера.** Каденцию задаёт composition root;
 *    проход — детерминированный шаг, а не фоновый сервис;
 * 2. **`acquireLimit` считает КАНДИДАТОВ плана, а не claim-ы.** Уже
 *    начавшийся удерживаемый рынок не мешает приобрести следующий будущий —
 *    его просто нет в плане;
 * 3. **отсутствие спроса НЕ означает release.** Спрос описывает
 *    приобретение, а не полный desired-state; ни `release`, ни
 *    `releaseOwner` в пакете не вызываются вообще;
 * 4. **один `now` на весь проход** — иначе владельцы одного тика увидели бы
 *    разный мир на границе старта торгов;
 * 5. **отказ обхода каталога ≠ пустой universe.** `refresh() === false`
 *    оставляет last-good universe, и планирование по нему продолжается.
 *
 * ### Чего здесь нет
 *
 * Ни коллектора, ни рекордера, ни финализатора, ни стратегий, ни исполнения,
 * ни CEX, ни шины событий: рантайм соединяет control-plane и ничего больше.
 * Владельцем физических ресурсов остаётся контроллер, source of truth
 * владельцев — composition root.
 *
 * @example
 * ```typescript
 * const runtime = new PolymarketControlRuntime({
 *   discovery, universe, planner, controller, clock, logger,
 * });
 *
 * const result = await runtime.runOnce([
 *   { ownerKey: 'strategy:btc-5m', policy: btc5m, acquireLimit: 1 },
 * ]);
 * ```
 *
 * @packageDocumentation
 */
export { PolymarketControlRuntime } from './PolymarketControlRuntime.js';
export type {
  ControlRuntimeDiscovery,
  PolymarketControlRuntimeDependencies,
  PolymarketControlRuntimeResult,
  PolymarketOwnerPlanSummary,
  PolymarketOwnerRuntimeResult,
  PolymarketSubscriptionDemand,
} from './PolymarketControlRuntimeTypes.js';
