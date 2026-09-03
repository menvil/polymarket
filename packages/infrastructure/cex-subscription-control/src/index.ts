/**
 * @polymarket/cex-subscription-control — общие физические CEX-потоки под
 * claim-ами владельцев.
 *
 * @remarks
 * ```text
 *                    APPLICATION
 * CexPolicy: биржи × типы рынков × символы × потоки × окно
 * ─────────────────────────────────────────────── ↓ ownerKey + policy
 *                  INFRASTRUCTURE
 * CexSubscriptionController.reconcile(demands, now)
 *      ├── logical claims   owner + exchange + marketType + symbol + stream
 *      ├── aggregate pools  exchange + marketType + stream
 *      └── immutable CexSource generations
 *      ↓
 * CexSource → ExternalMessageBus
 * ```
 *
 * ### Четыре правила, ради которых существует пакет
 *
 * 1. **несколько владельцев одного ресурса делят поток.** Два claim-а на
 *    `binance/swap/BTC/trades` — это ОДИН `CexSource`, а не два;
 * 2. **спрос авторитетен.** В отличие от Polymarket, где исчезновение
 *    рынка из плана claim не снимает, у CEX нет ни `startsAt`, ни
 *    expiry: пропавший из `demands` владелец теряет claim-ы, а никому не
 *    нужный ресурс закрывается;
 * 3. **пул = биржа + тип рынка + поток.** Символы агрегируются, глубина
 *    берётся максимумом — так сохраняется «один CCXT-инстанс на поток», и
 *    шина не получает дублей одной routing identity;
 * 4. **никогда не дублировать, допустим ограниченный разрыв.** Замена
 *    поколения полностью закрывает старый источник ДО запуска нового;
 *    при неизменной спецификации рестарта нет вовсе.
 *
 * ### Почему здесь нет `CexControlRuntime`
 *
 * У Polymarket над контроллером есть проход (discovery → universe →
 * planner → acquire), и ему нужен свой пакет. У CEX ничего этого нет:
 * `CexPolicy` уже содержит точные ресурсы, отбирать не из чего, rollover
 * отсутствует. `reconcile(demands, now)` и ЕСТЬ полный control-шаг CEX —
 * обёртка `runOnce()` вокруг него добавила бы имя, но не ответственность.
 *
 * @example
 * ```typescript
 * const controller = new CexSubscriptionController({
 *   sourceFactory: (config) => new CexSource({ config, bus, metadataGenerator, logger }),
 *   logger,
 * });
 *
 * // каденцию задаёт composition root, `now` читается один раз на тик
 * await controller.reconcile(currentCexDemands, Timestamp.now(clock));
 * ```
 *
 * @packageDocumentation
 */
export { CexSubscriptionController } from './CexSubscriptionController.js';
export type {
  CexPhysicalPoolSpec,
  CexPoolKey,
  CexPoolTransitionFailure,
  CexPoolTransitionStage,
  CexStreamKind,
  CexSubscriptionClaim,
  CexSubscriptionControllerDependencies,
  CexSubscriptionControllerStats,
  CexSubscriptionDemand,
  CexSubscriptionOwnerKey,
  CexSubscriptionPoolSnapshot,
  CexSubscriptionReconcileResult,
  CexSubscriptionSource,
  CexSubscriptionSourceFactory,
} from './CexSubscriptionTypes.js';
