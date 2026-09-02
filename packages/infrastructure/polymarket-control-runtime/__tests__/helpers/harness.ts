/**
 * Сборка рантайма для тестов: настоящий контур поверх поддельной
 * vendor-границы.
 *
 * @remarks
 * Ровно та композиция, которую позже соберёт composition root, — с одной
 * разницей: вместо сети стоит {@link FakeDiscovery} и {@link FakeSource}.
 * Universe, Policy, планировщик и контроллер настоящие, потому что
 * проверяемые правила формулируются именно в их терминах.
 *
 * ```text
 * FakeDiscovery ──refresh/getSnapshot──► MarketUniverse   (настоящий)
 *      │                                      ↓
 *      │                         PolymarketSubscriptionPlanner (настоящий)
 *      │                                      ↓
 *      └──prepareMarket──► PolymarketSubscriptionController (настоящий)
 *                                             ↓
 *                                        FakeSource
 * ```
 */
import { MarketUniverse } from '@polymarket/market-discovery';
import { PolymarketSubscriptionPlanner } from '@polymarket/subscription-planning';
import { PolymarketSubscriptionController } from '@polymarket/polymarket-subscription-control';
import { PolymarketControlRuntime } from '../../src/index.js';
import { CapturingLogger, FakeDiscovery, FakeSource, MutableClock } from './fakes.js';

/** Собранный контур одного теста. */
export interface RuntimeHarness {
  /** Поддельная vendor-граница каталога (обход + подготовка рынков). */
  readonly discovery: FakeDiscovery;
  /** Поддельный транспорт подписок. */
  readonly source: FakeSource;
  /** Настоящий universe. */
  readonly universe: MarketUniverse;
  /** Настоящий планировщик приобретения. */
  readonly planner: PolymarketSubscriptionPlanner;
  /** Настоящий контроллер подписок. */
  readonly controller: PolymarketSubscriptionController;
  /** Управляемые часы контура. */
  readonly clock: MutableClock;
  /** Логгер, накапливающий записи. */
  readonly logger: CapturingLogger;
  /** Тестируемый рантайм. */
  readonly runtime: PolymarketControlRuntime;
}

/**
 * Собирает контур на заданный момент.
 *
 * @param nowMs - Стартовый момент часов
 * @returns Все компоненты контура (часы и подделки доступны тесту)
 *
 * @remarks
 * Часы ОДНИ на весь контур — их читают и рантайм (момент решения тика), и
 * контроллер (последняя проверка перед физическим действием). Раздельные
 * часы позволили бы собрать мир, в котором эти двое расходятся во времени
 * не из-за проверяемого правила, а из-за фикстуры.
 *
 * Минимальный запас планировщика оставлен ДЕФОЛТНЫМ (2 минуты): сценарии
 * MR опираются на реальную границу приобретения, а не на её ослабление.
 *
 * @example
 * ```typescript
 * const h = makeHarness(AT_1757_MS);
 * h.discovery.stage([x, y], AT_1757_MS);
 * const result = await h.runtime.runOnce([demand]);
 * ```
 */
export function makeHarness(nowMs: number): RuntimeHarness {
  const clock = new MutableClock(nowMs);
  const logger = new CapturingLogger();
  const discovery = new FakeDiscovery();
  const source = new FakeSource();
  const universe = new MarketUniverse(clock);
  const planner = new PolymarketSubscriptionPlanner();
  const controller = new PolymarketSubscriptionController({ discovery, source, clock, logger });
  const runtime = new PolymarketControlRuntime({
    discovery,
    universe,
    planner,
    controller,
    clock,
    logger,
  });

  return { discovery, source, universe, planner, controller, clock, logger, runtime };
}
