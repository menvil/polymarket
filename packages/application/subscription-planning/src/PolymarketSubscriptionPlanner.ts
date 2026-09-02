/**
 * Планировщик подписок Polymarket: какие рынки policy ещё можно ЗАКОННО
 * приобрести для будущей физической подписки.
 *
 * @remarks
 * ### Один вопрос control-plane
 *
 * ```text
 * MarketDiscoveryEntry[]  +  PolymarketPolicy  +  now
 *                    ↓
 *        PolymarketSubscriptionPlanner
 *                    ↓
 *      пригодные рынки в правильном порядке
 * ```
 *
 * Планировщик отвечает ровно на «какие рынки подходят и в каком порядке».
 * Он НЕ отвечает на «кто ими владеет», «какие claim-ы существуют», «открыт
 * ли сокет», «какие инструменты у рынка» и «как встать на поток данных»:
 * всё это принадлежит слою, у которого есть физический ресурс. Здесь нет ни
 * одного вызова, который что-то приобретает — только вычисление.
 *
 * ### Три ответственности, которые нельзя складывать в одну
 *
 * ```text
 * Policy          → что ХОЧЕТ consumer
 * MarketUniverse  → что ТЕХНИЧЕСКИ существует
 * Planner         → что из желаемого ещё МОЖНО приобрести
 * ```
 *
 * Отсюда и отдельный пакет: положи планировщик в `@polymarket/policy` — и
 * policy получит знание о жизненном цикле подписки; положи в discovery — и
 * драйвер площадки начнёт знать про вкусы потребителя.
 *
 * ### Порядок ворот (он же — порядок диагностики)
 *
 * ```text
 * 1. чужая площадка          → wrongVenue
 * 2. терминальное состояние  → inactive
 * 3. торги уже идут          → alreadyStarted
 * 4. запаса до старта нет    → insufficientLeadTime
 * 5. policy не подходит      → policyMismatch
 * 6.                         → eligible
 * ```
 *
 * Порядок зафиксирован, и это не вкусовщина. Во-первых, каждая запись
 * обязана попасть РОВНО в одну категорию — иначе диагностика перестаёт
 * отвечать на вопрос «по какой ПЕРВОЙ причине запись не дошла до плана», а
 * её арифметический инвариант перестаёт сходиться. Во-вторых, policy
 * проверяется ПОСЛЕДНЕЙ намеренно: уже начавшийся рынок нельзя приобрести
 * независимо от policy, и прогонять по нему ключевые слова и пороги
 * ликвидности — работа впустую ради ответа, который заведомо не изменится.
 *
 * ### Policy оценивается в `market.startsAt`, а НЕ в `now`
 *
 * Это главный инвариант планировщика.
 *
 * ```text
 * сейчас 17:59:30
 *
 * BTC-policy: действует до 18:00
 * XRP-policy: действует с 18:00
 *
 * рынок XRP 18:00–18:05
 * ```
 *
 * Подписаться на рынок 18:00 надо ЗАРАНЕЕ — в 17:59:30, когда XRP-policy
 * ещё не действует. Спроси мы `matches(entry, policy, now)`, XRP-policy не
 * увидела бы ни одного своего рынка до 18:00, а в 18:00 подписываться уже
 * поздно: рынок начался. Поэтому вопрос к policy звучит «будет ли она
 * действовать В МОМЕНТ СТАРТА этого рынка», и ответом на него policy может
 * строить план ДО собственного `effectiveFrom`.
 *
 * Обратная сторона того же правила: BTC-policy с `effectiveUntil = 18:00`
 * НЕ получит рынок, стартующий ровно в 18:00, — хотя прямо сейчас она
 * действует. Окно policy полуоткрыто, стык принадлежит следующей policy, и
 * рынок 18:00 — это уже рынок XRP-policy.
 *
 * ### Никакого fallback-старта
 *
 * Используется ТОЛЬКО `entry.market.startsAt`. Прежний контур, не имея
 * точного начала торгов, оценивал его как «истечение минус номинальная
 * длительность»; после перехода на canonical `Market` такой оценки больше
 * не существует — рынок вообще не превращается в canonical, пока точное
 * начало торгов не известно. Арифметики над сроком истечения здесь нет ни в
 * одной строке, и это проверяется структурным тестом пакета.
 *
 * ### Планировщик не читает часы и не хранит состояния
 *
 * `now` приходит аргументом: та же логика работает в live (часы рантайма),
 * в backtest (часы симуляции) и в тесте (фиксированный момент). Состояния
 * между вызовами нет вообще — в частности, нет кэша «отклонён по lead
 * time», который был у прежнего координатора. Он и не нужен: время до
 * старта монотонно убывает, поэтому рынок, отклонённый за нехватку запаса,
 * будет отклоняться и на всех следующих проходах сам по себе.
 */
import { ValidationError } from '@polymarket/errors';
import { KnownVenues } from '@polymarket/ids';
import { MarketFilter, MarketScorer } from '@polymarket/policy';
import type { PolymarketPolicy } from '@polymarket/policy';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import type { Timestamp } from '@polymarket/timestamp';
import type {
  PolymarketSubscriptionPlan,
  PolymarketSubscriptionPlanDiagnostics,
} from './PolymarketSubscriptionPlan.js';

/**
 * Минимальный запас до старта рынка по умолчанию: 2 минуты.
 *
 * @remarks
 * Parity с прежним координатором сбора (`MIN_TIME_TO_START_MS`) — значение
 * доказано живыми прогонами: за две минуты успевают и подготовка рынка, и
 * выход подписок на поток. Планировщик при этом координатор НЕ импортирует:
 * общая константа связала бы Application с Infrastructure ради одного
 * числа.
 */
export const DEFAULT_MIN_LEAD_TIME_MS = 120_000;

/**
 * Конфигурация планировщика.
 *
 * @remarks
 * Ровно один параметр, и он про жизненный цикл, а не про вкусы: «сколько
 * времени нужно, чтобы успеть». Всё остальное — активы, номиналы,
 * ликвидность, ключевые слова — живёт в policy и сюда не дублируется.
 *
 * Чего здесь СОЗНАТЕЛЬНО нет:
 *
 * - **горизонта планирования** (`planningHorizonMs`, `subscribeAheadMs`):
 *   вперёд universe уже ограничен окном discovery, и второй горизонт был бы
 *   преждевременным вторым ограничением поверх существующего;
 * - **лимита количества** (`maxMarkets`, `topN`): «сколько рынков держать»
 *   зависит от владельца (стратегии нужен один ближайший, коллектору —
 *   десять), а владельцев планировщик не знает;
 * - **fallback-длительности рынка**: точное начало торгов есть у каждого
 *   canonical рынка, оценивать его больше не из чего и незачем.
 */
export interface PolymarketSubscriptionPlannerConfig {
  /**
   * Минимальный запас времени до старта рынка, мс.
   *
   * @defaultValue {@link DEFAULT_MIN_LEAD_TIME_MS} (120 000 — 2 минуты)
   *
   * @remarks
   * Рынок пригоден при `startsAt - now >= minLeadTimeMs`. Ноль означает
   * «успеть до старта хотя бы на миллисекунду», а не «можно после старта»:
   * строгая проверка «торги ещё не начались» стоит ОТДЕЛЬНО и раньше.
   */
  readonly minLeadTimeMs?: number;
}

/**
 * Изменяемые счётчики одного прогона.
 *
 * @internal
 * @remarks
 * Существует только внутри `plan()`: наружу уезжает замороженная копия.
 * Публичный тип диагностики сделан `readonly` целиком, и накапливать в нём
 * значения пришлось бы кастом — то есть отменяя ровно ту гарантию, ради
 * которой он такой.
 */
interface PlanCounters {
  wrongVenue: number;
  inactive: number;
  alreadyStarted: number;
  insufficientLeadTime: number;
  policyMismatch: number;
}

/**
 * Проверяет минимальный запас времени при создании планировщика.
 *
 * @param value - Значение из конфигурации
 * @returns То же значение, если оно пригодно
 * @throws {ValidationError} Если значение не конечное, не целое или отрицательное
 *
 * @internal
 * @remarks
 * Fail-fast при создании, а не при планировании: `NaN` в сравнении даёт
 * `false` молча, и планировщик с таким запасом не отказал бы, а тихо
 * пропускал бы рынки, которые обязан отклонять. Дробные миллисекунды
 * отвергаются как заведомая опечатка настройки (`0.5` вместо `500`), а не
 * из-за арифметики: сравнение выдержало бы и их.
 *
 * Своей иерархии ошибок пакет не заводит — общий `ValidationError` контура
 * отвечает на вопрос «конфигурация собрана неверно» полностью.
 */
function assertValidLeadTime(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      'Subscription planner minLeadTimeMs must be a non-negative integer number of milliseconds',
      { context: { minLeadTimeMs: value } },
    );
  }
  return value;
}

/**
 * Планировщик подписок площадки Polymarket.
 *
 * @remarks
 * Stateless и детерминирован: сто вызовов с одинаковыми записями, policy и
 * моментом дают сто одинаковых планов. Один экземпляр безопасно разделять
 * между владельцами и policy — он ничего о них не помнит.
 *
 * `MarketFilter` и `MarketScorer` создаются внутри, а не инжектируются, и
 * это осознанно: оба — чистые функции без зависимостей и без состояния, а
 * возможность подменить их снаружи означала бы возможность применить к
 * рынкам ВТОРОЙ матчер policy или ВТОРОЙ порядок — то самое раздвоение
 * правил отбора, которого контур избегает.
 *
 * @example
 * ```typescript
 * const planner = new PolymarketSubscriptionPlanner();
 * const plan = planner.plan(universe.getAll(), policy, clock.nowTimestamp());
 *
 * for (const entry of plan.candidates) {
 *   // следующий слой: claim → prepare → физическая подписка
 * }
 * ```
 */
export class PolymarketSubscriptionPlanner {
  /** Минимальный запас времени до старта, мс (см. конфигурацию). */
  private readonly _minLeadTimeMs: number;
  /** Применение policy к записи — переиспользуется, а не переписывается. */
  private readonly _filter = new MarketFilter();
  /** Порядок пригодных рынков — тоже переиспользуется. */
  private readonly _scorer = new MarketScorer();

  /**
   * Создаёт планировщик.
   *
   * @param config - Конфигурация; по умолчанию запас {@link DEFAULT_MIN_LEAD_TIME_MS}
   * @throws {ValidationError} Если `minLeadTimeMs` не является неотрицательным целым
   *
   * @example
   * ```typescript
   * const planner = new PolymarketSubscriptionPlanner({ minLeadTimeMs: 30_000 });
   * ```
   */
  public constructor(config: PolymarketSubscriptionPlannerConfig = {}) {
    this._minLeadTimeMs = assertValidLeadTime(config.minLeadTimeMs ?? DEFAULT_MIN_LEAD_TIME_MS);
  }

  /**
   * Строит план подписок на момент `now`.
   *
   * @param entries - Записи universe (вход НЕ мутируется)
   * @param policy - Owner policy площадки Polymarket
   * @param now - Момент планирования; приходит от вызывающего, планировщик
   *   часов не читает
   * @returns Замороженный {@link PolymarketSubscriptionPlan}: пригодные
   *   рынки в порядке `MarketScorer` плюс разбор отказов
   * @throws Ничего не бросает: непригодная запись — это счётчик, а не отказ
   *
   * @remarks
   * Принимаются именно ЗАПИСИ, а не `MarketUniverse`: планировщику не нужно
   * знать, откуда они появились. Живой рантайм передаёт `universe.getAll()`,
   * тест — литеральный массив, backtest — записи из архива, и все трое
   * получают одну и ту же логику.
   *
   * Алгоритм — последовательность ворот в фиксированном порядке
   * (см. TSDoc класса): площадка → состояние → «торги ещё не начались» →
   * запас времени → policy В МОМЕНТ СТАРТА рынка. Прошедшие ранжируются
   * `MarketScorer`; поскольку начавшиеся рынки к этому моменту уже
   * исключены, `candidates[0]` — ближайший ДОСТУПНЫЙ будущий рынок.
   *
   * @example
   * ```typescript
   * const plan = planner.plan(entries, xrp5mPolicy, ts('17:57'));
   *
   * plan.candidates.map((e) => String(e.market.id)); // ['xrp-1800', 'xrp-1805']
   * plan.diagnostics.alreadyStarted;                 // рынки, к которым мы опоздали
   * ```
   */
  public plan(
    entries: readonly MarketDiscoveryEntry[],
    policy: PolymarketPolicy,
    now: Timestamp,
  ): PolymarketSubscriptionPlan {
    const counters: PlanCounters = {
      wrongVenue: 0,
      inactive: 0,
      alreadyStarted: 0,
      insufficientLeadTime: 0,
      policyMismatch: 0,
    };

    const eligible: MarketDiscoveryEntry[] = [];
    for (const entry of entries) {
      if (this._isEligible(entry, policy, now, counters)) {
        eligible.push(entry);
      }
    }

    const diagnostics: PolymarketSubscriptionPlanDiagnostics = Object.freeze({
      scanned: entries.length,
      wrongVenue: counters.wrongVenue,
      inactive: counters.inactive,
      alreadyStarted: counters.alreadyStarted,
      insufficientLeadTime: counters.insufficientLeadTime,
      policyMismatch: counters.policyMismatch,
      eligible: eligible.length,
    });

    return Object.freeze({
      plannedAt: now,
      // `rank()` по контракту возвращает НОВЫЙ массив: он принадлежит
      // плану, поэтому заморозка не трогает данные вызывающего.
      candidates: Object.freeze(this._scorer.rank(eligible)),
      diagnostics,
    });
  }

  /**
   * Пропускает запись через ворота пригодности, попутно считая отказы.
   *
   * @param entry - Запись universe
   * @param policy - Owner policy
   * @param now - Момент планирования
   * @param counters - Счётчики прогона (единственная мутация метода)
   * @returns `true`, если рынок можно приобрести для будущей подписки
   *
   * @internal
   * @remarks
   * Ворота идут строго в порядке, описанном в TSDoc класса, и первое
   * сработавшее завершает проверку: так каждая запись попадает ровно в один
   * счётчик, а сумма счётчиков сходится с числом просмотренных записей.
   */
  private _isEligible(
    entry: MarketDiscoveryEntry,
    policy: PolymarketPolicy,
    now: Timestamp,
    counters: PlanCounters,
  ): boolean {
    const market = entry.market;

    // 1. Площадка. Universe со временем станет мультиплощадочным, и
    //    совпавшие актив с номиналом серии не делают рынок чужой площадки
    //    нашим. Проверка явная, а не «сегодня в universe только мы».
    if (market.venueId !== KnownVenues.POLYMARKET) {
      counters.wrongVenue += 1;
      return false;
    }

    // 2. Состояние. Приобретать имеет смысл только рынок, чей жизненный
    //    цикл данных ещё впереди; подтверждённое закрытие и объявленный
    //    исход — терминальны. Состояние берётся КАК ЕСТЬ: планировщик
    //    домен не мутирует и переходов по времени не делает — истечение
    //    расписания само по себе состояния не меняет (инвариант `Market`).
    if (!market.isActive()) {
      counters.inactive += 1;
      return false;
    }

    // 3. Строгое «до старта»: `now < market.startsAt`. Равенство — уже
    //    поздно. Догонять начавшийся рынок новый рантайм не умеет и не
    //    должен: часть его данных уже прошла мимо, и подписка дала бы
    //    неполную картину, неотличимую по виду от полной.
    if (market.isStartedAt(now)) {
      counters.alreadyStarted += 1;
      return false;
    }

    // 4. Запас времени: `startsAt - now >= minLeadTimeMs`. Отклоняем при
    //    СТРОГОМ `<`, поэтому запас РОВНО в минимум ещё проходит.
    if (market.timeToStartAt(now).lessThan(this._minLeadTimeMs)) {
      counters.insufficientLeadTime += 1;
      return false;
    }

    // 5. Policy — в момент старта рынка, а не «сейчас» (см. TSDoc класса).
    if (!this._filter.matches(entry, policy, market.startsAt)) {
      counters.policyMismatch += 1;
      return false;
    }

    return true;
  }
}
