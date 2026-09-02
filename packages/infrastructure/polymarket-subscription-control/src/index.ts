/**
 * @polymarket/polymarket-subscription-control — общие физические подписки
 * Polymarket под claim-ами владельцев.
 *
 * @remarks
 * ```text
 *                    APPLICATION
 * MarketUniverse → Policy → Subscription Planner → пригодные рынки
 *                              ↓ вызывающий выбирает нужные N
 * ──────────────────────────────────────────────────────────────
 *                  INFRASTRUCTURE
 * ownerKey + entry
 *      ↓
 * PolymarketSubscriptionController
 *      ├── claim-ы владельцев   → ОДНА подписка рынка
 *      ├── OPENING-резервация   → транзакция с откатом
 *      └── shared RTDS refs     → ref-count ПО РЫНКАМ
 *      ↓
 * PolymarketSource → ExternalMessageBus
 * ```
 *
 * ### Три правила, ради которых существует пакет
 *
 * 1. **ACQUISITION ≠ RETENTION.** Планировщик отвечает, какие рынки ещё
 *    можно ПРИОБРЕСТИ; контроллер удерживает УЖЕ приобретённые. Исчезновение
 *    рынка из плана (а он исчезает сразу после старта торгов) claim не
 *    снимает — только явный `release`;
 * 2. **новый владелец обязан успеть до старта**, даже если физическая
 *    подписка уже открыта чужим claim-ом; уже существующий владелец после
 *    старта остаётся владельцем;
 * 3. **полный физический bundle готов ДО старта**: строгая проверка
 *    повторяется после каждой асинхронной границы, и всё открытое
 *    откатывается, если рынок успел стартовать.
 *
 * @example
 * ```typescript
 * const controller = new PolymarketSubscriptionController({ discovery, source, clock, logger });
 *
 * const plan = planner.plan(universe.getAll(), policy, now);
 * for (const entry of plan.candidates.slice(0, desiredCount)) {
 *   await controller.acquire('strategy:btc-5m', entry);
 * }
 * ```
 *
 * @packageDocumentation
 */
export { PolymarketSubscriptionController } from './PolymarketSubscriptionController.js';
export type {
  PolymarketAcquireFailureStage,
  PolymarketAcquireRejection,
  PolymarketAcquireResult,
  PolymarketReleaseResult,
  PolymarketSharedRtdsFeedStat,
  PolymarketSubscriptionControllerDependencies,
  PolymarketSubscriptionControllerStats,
  PolymarketSubscriptionSnapshot,
  SubscriptionDiscovery,
  SubscriptionOwnerKey,
  SubscriptionSource,
} from './PolymarketSubscriptionTypes.js';
