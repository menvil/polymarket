/**
 * @polymarket/subscription-planning — какие рынки policy ещё можно
 * приобрести для будущей подписки.
 *
 * @remarks
 * Слой между «что хочет consumer» и «что физически подписано»:
 *
 * ```text
 * CONTROL PLANE
 *
 * Polymarket V2 Discovery
 *         ↓
 * MarketDiscoverySnapshot
 *         ↓
 * MarketUniverse ── getAll() ──┐
 *                              ├──► PolymarketSubscriptionPlanner ──► план
 * PolymarketPolicy ────────────┤
 * now ─────────────────────────┘
 *
 * DATA PLANE
 *
 * пока НЕ часть этого контура
 * ```
 *
 * ### Планировщик НИЧЕГО не подписывает
 *
 * Он возвращает упорядоченный список пригодных рынков и разбор отказов —
 * и всё. Ни подготовки рынка, ни постановки на поток данных, ни владельцев,
 * ни claim-ов, ни счётчиков ссылок здесь нет: физический ресурс появляется
 * слоем ниже, и там же появится всё, что им управляет.
 *
 * ### Три правила, ради которых существует пакет
 *
 * 1. **Policy оценивается в `market.startsAt`**, а не в «сейчас»: подписка
 *    на рынок 18:00 оформляется в 17:57, когда его policy ещё не действует;
 * 2. **рынок никогда не приобретается после старта** — строго
 *    `now < market.startsAt`, равенство означает «поздно»;
 * 3. **точное начало торгов — единственный источник расписания**: никаких
 *    оценок начала по сроку истечения и номиналу серии.
 *
 * @example
 * ```typescript
 * const planner = new PolymarketSubscriptionPlanner();
 * const plan = planner.plan(universe.getAll(), policy, now);
 *
 * const next = plan.candidates[0];                 // ближайший доступный рынок
 * const batch = plan.candidates.slice(0, 10);      // сколько брать — решает потребитель
 * plan.diagnostics.insufficientLeadTime;           // почему остальных нет в плане
 * ```
 *
 * @packageDocumentation
 */
export {
  DEFAULT_MIN_LEAD_TIME_MS,
  PolymarketSubscriptionPlanner,
} from './PolymarketSubscriptionPlanner.js';
export type { PolymarketSubscriptionPlannerConfig } from './PolymarketSubscriptionPlanner.js';
export type {
  PolymarketSubscriptionPlan,
  PolymarketSubscriptionPlanDiagnostics,
} from './PolymarketSubscriptionPlan.js';
